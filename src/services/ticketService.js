const config = require('../config');
const bitableApi = require('../feishu/bitable');
const syncService = require('./syncService');
const plaza = require('./plaza');
const {
  sendCardToTarget,
  describeTarget,
  buildTicketOpenCard,
  buildTicketAssignCard,
  buildReannounceCard,
  updateCardToChat,
} = require('../feishu/bot');
const { formatFieldValue, formatFieldText, getCreatedTime } = require('../utils/fields');
const { resolvePersonGroups, buildPersonFieldsByGroups } = require('../utils/personFields');
const quietHours = require('../utils/quietHours');

// ============================================================
// 工单事件处理：
//   创建时 → category 门控搬运 + 按是否指定负责人分支播报
//   更新时 → 仅当申请状态变化时更新项目状态
//
// 播报通道：应用机器人（对话型）IM API 优先，webhook 兜底——
//   接单确认依赖 @应用机器人 的消息事件（网关秒级转发），webhook 收不到事件。
//
// 接单确认机制（事件驱动，无轮询）：
//   群内 @对话型机器人 发送「接单」→ 网关路由到本服务 → handleAcceptOrder
//   未指定负责人：任一组员可确认
//   已指定负责人：公示即绑定（写补充负责人 + 看板人员字段），
//                 确认仅限本人，确认后推进状态并通过「负责人确认消息后通过」审批
// ============================================================
const NOTIFY_DEDUP_TTL = 10 * 60 * 1000;
const recentCreateEvents = new Map(); // record_id -> timestamp
const quietDeferredLogged = new Set(); // 静默顺延日志只打一次（实际播报成功后移除）

// 播报历史（内存，供 API 查询）
const broadcastHistory = [];

// 已播报的工单 recordId（跨创建/发布事件去重，避免同一工单重复播报）
const broadcastedRecords = new Set();

// 播报触发节点：审批节点命中任一值时触发播报
//   - 群内有组员接单后通过：未指定负责人工单的审批节点
//   - 负责人确认消息后通过：指定负责人工单的审批节点
// 匹配走 config.matchNodeValue：按组别并行的审批流会把多个分支节点名以「；」
// 拼接写入同一字段（多组别工单），整串精确比对会对不上导致漏播报
function isActivationNode(node) {
  return config.matchNodeValue(node, config.approvalNode.acceptValues);
}

/**
 * 播报总开关：BROADCAST_ON 含「create」即开启播报。
 * 历史语义：create（记录新建）与 update（节点进入触发值）两条事件路径共用此开关，
 * 没有独立的 update 开关——两边都必须用本函数判断，别写裸 includes('create')
 */
function isBroadcastEnabled() {
  return config.broadcast.on.includes('create');
}

// ============================================================
// 多人接单（无指定负责人工单，config.multiAccept）
// 「是否允许多人接单」=是：首人接单不即时通过审批，开启工单级续接窗口
// （面向多组别共享同一计时器）；窗口内再有人接单 → 合并补充负责人、
// 在本次接单发生的群发续接询问并重置计时（"再次播报再来6小时"）；
// 到期无人续接 → 自动通过全部触发节点审批。
// 窗口截止写回源表字段（自动创建，文本型），跨重启恢复；到期检查挂在每分钟对账上。
// ============================================================

function isMultiAcceptTicket(fields) {
  const { field, yesValue } = config.multiAccept;
  if (!field) return false;
  const raw = fields?.[field];
  const value = Array.isArray(raw) ? String(raw[0] ?? '') : String(raw ?? '');
  return value === yesValue;
}

/**
 * 「多人接单截止」是文本型字段（ensureWindowField 以默认文本型创建）：
 * 写入带 +08:00 偏移的 ISO 文本——毫秒数字写文本列会被飞书拒收
 * （TextFieldConvFail 1254060，窗口截止从未落库、到期永不触发的根因），
 * ISO 文本在表格里也可直接读。
 */
function formatWindowDeadline(ts) {
  const shifted = new Date(Number(ts) + 8 * 3600 * 1000); // 固定 +08:00（与全仓 Asia/Shanghai 口径一致）
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

/** 读「多人接单截止」：兼容 ISO 文本（现行）与数字串（历史），解析失败返回 0 */
function parseWindowDeadline(value) {
  if (value === null || value === undefined || value === '') return 0;
  const raw = Array.isArray(value) ? value[0] : value; // 富文本段兜底
  const text = raw && typeof raw === 'object' ? String(raw.text || '') : String(raw);
  const num = Number(text);
  if (Number.isFinite(num) && num > 0) return num;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

let windowFieldReady = false;

async function ensureWindowField() {
  if (windowFieldReady || !config.multiAccept.windowField) return;
  try {
    await bitableApi.createField(
      config.bitable.sourceAppToken,
      config.bitable.sourceTableId,
      config.multiAccept.windowField
    );
    console.log(`[多人接单] 已在源表创建窗口截止字段「${config.multiAccept.windowField}」`);
  } catch (err) {
    // 字段已存在等场景视作就绪；真正的写入失败会在 writeMultiWindowDeadline 日志暴露
  }
  windowFieldReady = true;
}

/**
 * 写窗口截止（源表文本字段，值为 ISO 文本）。
 * @returns {Promise<boolean>} 是否写入成功——失败时调用方必须降级（窗口不存在，
 * 若仍按多人单流程走，对账永远判不出到期，工单会卡在触发节点）
 */
async function writeMultiWindowDeadline(recordId, ts) {
  const field = config.multiAccept.windowField;
  if (!field) return false;
  await ensureWindowField();
  try {
    await bitableApi.updateRecord(
      config.bitable.sourceAppToken,
      config.bitable.sourceTableId,
      recordId,
      { [field]: formatWindowDeadline(ts) }
    );
    return true;
  } catch (err) {
    console.error(`[多人接单] 写窗口截止失败 ${recordId}:`, err.message);
    return false;
  }
}

function formatMultiNames(acceptors) {
  return (acceptors || []).map((p) => p?.name || p?.id).filter(Boolean).join('、');
}

/**
 * 多人单「窗口结束」通告目标群：各接单人组别映射到播报群。
 * （续接询问已改只在接单发生群发，不走本函数——组别解析失败会回退
 * 「面向组别」，把询问广播到全部组；结束通告是收尾知会，保留组别口径）
 */
async function collectMultiNoticeTargets(fields, acceptors, extraChatId) {
  const chatIds = new Set(extraChatId ? [extraChatId] : []);
  const routeGroups = config.broadcast.routeField ? fields[config.broadcast.routeField] : null;
  for (const person of acceptors || []) {
    if (!person?.id) continue;
    const groups = await resolvePersonGroups(routeGroups, person);
    for (const group of groups) {
      const route = config.broadcast.routes.find((r) => r.value === group);
      if (route?.chatId) chatIds.add(route.chatId);
    }
  }
  return [...chatIds].map((id) => config.broadcast.routes.find((r) => r.chatId === id) || { chatId: id });
}

function buildMultiAcceptCard({ title, acceptors, windowUntil, kw = '接单' }) {
  const deadline = new Date(windowUntil).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  return {
    config: { wide_screen_mode: true },
    elements: [
      { tag: 'markdown', content: `**${title}**` },
      { tag: 'markdown', content: `👥 本工单**允许多人接单**，当前已接单 ${acceptors.length} 人：${formatMultiNames(acceptors) || '（未知）'}` },
      { tag: 'markdown', content: `⏳ 开放续接至 **${deadline}**，期间在群内 **@${config.bot.name}** 发送「${kw}」即可加入；到期未再有人接单，审批将自动通过` },
    ],
    header: { template: 'blue', title: { content: '👥 多人接单进行中', tag: 'plain_text' } },
  };
}

function buildMultiAcceptClosedCard({ title, acceptors }) {
  return {
    config: { wide_screen_mode: true },
    elements: [
      { tag: 'markdown', content: `**${title}**` },
      { tag: 'markdown', content: `⏰ 多人接单窗口已结束，共 ${acceptors.length} 人接单：${formatMultiNames(acceptors) || '（无）'}` },
      { tag: 'markdown', content: `✅ 审批已自动通过，感谢各位接力` },
    ],
    header: { template: 'green', title: { content: '✅ 多人接单结束', tag: 'plain_text' } },
  };
}

async function sendCardToTargets(targets, card) {
  for (const target of targets) {
    try {
      await sendCardToTarget(target, card);
    } catch (err) {
      console.error(`[多人接单] 通知 ${describeTarget(target)} 失败:`, err.message);
    }
  }
}

// 窗口到期/接单后审批补通过的尝试节流（recordId -> lastAttemptTs，1h 淘汰）
const multiApproveAttempts = new Map();

// 指定负责人本人确认的短窗重复拦截（`recordId:userId` -> ts，10 分钟淘汰）：
// 「公示即绑定」使补负含本人无法再作「已确认」判据，这里只兜本人连点/重发；
// TTL 短，确认后审批联动偶发失败时本人仍可稍后再试（对账不代通过指定负责人单）
const assigneeConfirmState = new Map();
const ASSIGNEE_CONFIRM_TTL = 10 * 60 * 1000;

/**
 * 每分钟对账挂载的审批联动补偿：
 *   - 多人单：窗口到期 → 自动通过全部触发节点任务，并在已接单的群发结束通告
 *   - 非多人单（无指定负责人）：接单时的自动通过可能因审批任务未到达等失败，这里补通过
 * 指定负责人工单不代通过（公示即绑定会写补充负责人，必须等本人确认）。
 * @returns {Promise<'multi-closed'|'approved'|null>}
 */
async function maybeAutoApproveOnReconcile(record) {
  const f = record.fields;
  const nodeField = config.approvalNode.field;
  const node = nodeField ? f[nodeField] : '';
  if (!isActivationNode(node)) return null;

  const supplement = config.assign.supplementField ? (f[config.assign.supplementField] || []) : [];
  if (supplement.length === 0) return null; // 还没人接单，不涉及审批联动

  const assignValue = config.assign.field ? f[config.assign.field] : '';
  const assignee = config.assign.assigneeField ? (f[config.assign.assigneeField]?.[0] || null) : null;
  const isSpec = assignValue === config.assign.yesValue && !!assignee?.id;
  if (isSpec) return null;

  pruneExpired(multiApproveAttempts, 60 * 60 * 1000);
  const last = multiApproveAttempts.get(record.record_id);
  if (last && Date.now() - last < 10 * 60 * 1000) return null;
  multiApproveAttempts.set(record.record_id, Date.now());

  const { autoApproveForTicket } = require('./approvalLinkService');

  if (isMultiAcceptTicket(f)) {
    const deadlineTs = parseWindowDeadline(f[config.multiAccept.windowField]);
    if (!deadlineTs) {
      // 截止缺失（本修复前的写入失败存量单 / 字段被清）：没有「到期」可判，
      // 重新计时兜底，保证窗口最终闭合（写入再失败下轮重试，不会永久卡单）
      const retire = Date.now() + config.multiAccept.windowHours * 60 * 60 * 1000;
      const ok = await writeMultiWindowDeadline(record.record_id, retire);
      console.warn(
        `[多人接单] 窗口截止缺失，已重新计时至 ${formatWindowDeadline(retire)}${ok ? '' : '（写入仍失败，本单将继续重试）'}: ${record.record_id}`
      );
      return null;
    }
    if (Date.now() <= deadlineTs) return null; // 窗口未到期
    const result = await autoApproveForTicket(
      record,
      '',
      '多人单',
      `多人接单窗口结束（共 ${supplement.length} 人：${formatMultiNames(supplement)}），自动通过`
    );
    if (!result.done) {
      console.log(`[多人接单] 窗口到期自动通过未完成（下轮重试）: ${result.reason || ''}`);
      return null;
    }
    const targets = await collectMultiNoticeTargets(f, supplement, null);
    const closedCard = buildMultiAcceptClosedCard({
      title: getTicketTitle(f, record.record_id),
      acceptors: supplement,
    });
    // 晚间静默：结束通告是群播报，静默窗口内载荷落盘积压，窗口结束统一补发
    // （审批自动通过本身不延迟，已在上面完成）
    if (quietHours.gatePayload('card-to-targets', { targets, card: closedCard }, `多人单结束通告 ${record.record_id}`)) {
      console.log(`[多人接单] 窗口结束，审批已自动通过；结束通告随晚间静默积压，目标 ${targets.length} 个群: ${record.record_id}`);
      return 'multi-closed';
    }
    await sendCardToTargets(targets, closedCard);
    console.log(`[多人接单] 窗口结束，审批已自动通过并通知 ${targets.length} 个群: ${record.record_id}`);
    return 'multi-closed';
  }

  const result = await autoApproveForTicket(
    record,
    '（对账补偿）',
    '组员',
    '接单人已在群内确认接单，审批自动通过（对账补偿）'
  );
  if (result.done) {
    console.log(`[对账] 接单后审批补通过: ${record.record_id}`);
    return 'approved';
  }
  return null;
}

// 指定负责人工单的触发节点（「公示即绑定」只作用于该节点；同样走拆段匹配）
function isAssignAcceptNode(node) {
  return config.matchNodeValue(node, [config.approvalNode.assignAcceptValue]);
}

// ============================================================
// 接单排队（同群多张待接单工单的关键词区分）：
//   群内同时存在多张「等待接单关键词」的工单（无人接单、多人单等待续接、
//   指定负责人待本人确认）时，固定一个「接单」词会撞车——按排队规则改为
//   「接单1」「接单2」…（最新播报的为「接单1」），仅剩一张时回落「接单」。
//   序号不落库：按源表数据（创建时间倒序）实时推导，跨重启稳定一致；
//   队列变化（新播报入队/接单出队/多人单窗口结束/节点推进）后整队重排，
//   已发卡片的接单提示行通过卡片更新接口同步改写（keywordCardRegistry
//   记录各群各工单最近一张带接单提示的卡片，webhook 发送无 message_id 不登记）。
//   面向多组别的工单按群独立编号：只有复数工单并存的群才用序号词。
// ============================================================

/**
 * 工单是否处于「等待接单关键词」状态（与接单确认的候选口径一致）：
 *   触发节点 + （无人接单 | 指定负责人已绑定未确认 | 多人单续接窗口内）
 */
function isTicketAwaitingKeyword(fields) {
  const nodeField = config.approvalNode.field;
  const node = nodeField ? fields[nodeField] : '';
  if (!isActivationNode(node)) return false;
  const sup = config.assign.supplementField ? fields[config.assign.supplementField] : null;
  if (!sup || sup.length === 0) return true;
  const assignee = config.assign.assigneeField ? (fields[config.assign.assigneeField]?.[0] || null) : null;
  const boundSpec = !!(assignee?.id && sup.length === 1 && sup.some((p) => p?.id === assignee.id));
  const isSpec = !!(config.assign.field && fields[config.assign.field] === config.assign.yesValue && assignee?.id);
  if (boundSpec) return true;
  if (isMultiAcceptTicket(fields) && !isSpec) {
    // 多人单：窗口内候接（截止缺失视为窗口仍开，由对账重新计时）；
    // 到期后立即出队——卡片不再提示接单，避免已关闭的窗口继续收人
    const deadlineTs = parseWindowDeadline(fields[config.multiAccept.windowField]);
    return deadlineTs === 0 || Date.now() <= deadlineTs;
  }
  return false;
}

/**
 * 推导各群接单队列：chatId → [成员]，成员按创建时间倒序（最新在前），
 * 每个成员含 { record, recordId, title, expectedAssigneeId, kw }；
 * 群内仅一张时 kw=「接单」，多张时按位置为「接单N」（1 号最新）。
 * 指定负责人工单的播报群来自负责人组别解析，可能不在「面向组别」里，
 * 与播报同口径用 resolvePersonGroups → collectTargets 推导。
 * @param {Array<{record_id, fields}>|null} records 预加载的源表全量记录（不传则现查）
 */
async function computeAcceptQueues(records = null) {
  const all = records || await bitableApi.listAllRecords(
    config.bitable.sourceAppToken,
    config.bitable.sourceTableId
  );

  const awaiting = all.filter((r) => isTicketAwaitingKeyword(r.fields));
  // 最新在前（接单词「接单1」= 最新播报）；创建时间相同按 recordId 倒序保证确定性
  awaiting.sort((a, b) => {
    const diff = (getCreatedTime(b.fields) || 0) - (getCreatedTime(a.fields) || 0);
    return diff !== 0 ? diff : (a.record_id < b.record_id ? 1 : -1);
  });

  const queues = new Map();
  for (const r of awaiting) {
    const f = r.fields;
    const assignee = config.assign.assigneeField ? (f[config.assign.assigneeField]?.[0] || null) : null;
    const isSpec = !!(config.assign.field && f[config.assign.field] === config.assign.yesValue && assignee?.id);
    let targets;
    if (isSpec) {
      const routeGroups = config.broadcast.routeField ? f[config.broadcast.routeField] : null;
      targets = collectTargets(await resolvePersonGroups(routeGroups, assignee));
    } else {
      targets = collectTargets(config.broadcast.routeField ? f[config.broadcast.routeField] : '');
    }
    const member = {
      record: r,
      recordId: r.record_id,
      title: getTicketTitle(f, r.record_id),
      expectedAssigneeId: isSpec ? assignee.id : null,
    };
    for (const target of targets) {
      if (!target.chatId) continue; // webhook-only 群收不到消息事件，无接单链路
      if (!queues.has(target.chatId)) queues.set(target.chatId, []);
      // 同一工单面向多群时各群排队独立（序号可不同），按群克隆成员（record 只读共享）
      queues.get(target.chatId).push({ ...member });
    }
  }

  // 按位置派生接单词：唯一一张 = 「接单」；复数张 = 「接单N」（跟排队一样，
  // 有人接单后剩余工单序号前移，仅剩一张时回落「接单」）
  for (const list of queues.values()) {
    list.forEach((m, idx) => {
      m.kw = list.length > 1 ? `接单${idx + 1}` : '接单';
    });
  }
  return queues;
}

// 接单提示卡片登记：`${chatId}:${recordId}` → 最近一张带接单提示的卡片
// （播报卡/多人单续接询问卡/超时重问询卡），供队列变化后改写提示行
const keywordCardRegistry = new Map();
const KEYWORD_CARD_MAX_FAILS = 5; // 连续更新失败上限（消息被删等不可恢复场景放弃该卡片）

/**
 * 登记带接单提示的卡片（仅 IM API 发送的卡片有 message_id，webhook 卡片不可更新）
 */
function rememberKeywordCard({ chatId, recordId, messageId, kind, ctx = {}, kw = '接单' }) {
  if (!chatId || !recordId || !messageId) return;
  keywordCardRegistry.set(`${chatId}:${recordId}`, { messageId, kind, ctx, kw, fails: 0 });
}

/**
 * 按登记类型整卡重建（接单词换成 newKw；构建函数以源表记录为输入）
 */
function rebuildKeywordCard(entry, newKw, record) {
  const f = record.fields;
  switch (entry.kind) {
    case 'open':
      return buildTicketOpenCard(record, newKw);
    case 'assign': {
      const assignee = config.assign.assigneeField ? (f[config.assign.assigneeField]?.[0] || null) : null;
      return buildTicketAssignCard(record, assignee, newKw);
    }
    case 'multi': {
      const acceptors = Array.isArray(f[config.assign.supplementField])
        ? f[config.assign.supplementField].filter((p) => p?.id)
        : [];
      const windowUntil = parseWindowDeadline(f[config.multiAccept.windowField])
        || Date.now() + config.multiAccept.windowHours * 60 * 60 * 1000;
      return buildMultiAcceptCard({ title: getTicketTitle(f, record.record_id), acceptors, windowUntil, kw: newKw });
    }
    case 'reannounce':
      return buildReannounceCard(record, entry.ctx.elapsedHours, entry.ctx.groupName, newKw);
    default:
      return null;
  }
}

/**
 * 接单词卡片刷新：重推各群队列，登记卡片的新旧接单词不一致时改写
 * （群内只剩一张 → 「接单N」回落「接单」；有新单入队 → 原有工单序号后移）。
 * 幂等：无变化零写操作；失败保留旧 kw 由每分钟对账重试，连续失败放弃该卡片。
 * @param {Array<string>|null} chatIds 只刷新这些群（null = 全部登记卡片）
 * @param {Array<{record_id, fields}>|null} records 预加载的源表全量记录
 */
async function refreshAcceptKeywordCards(chatIds = null, records = null) {
  if (keywordCardRegistry.size === 0) return;
  let queues;
  try {
    queues = await computeAcceptQueues(records);
  } catch (err) {
    console.warn(`[接单排队] 队列推导失败，本轮卡片刷新跳过: ${err.message}`);
    return;
  }

  for (const [key, entry] of [...keywordCardRegistry]) {
    const sep = key.indexOf(':');
    const chatId = key.slice(0, sep);
    const recordId = key.slice(sep + 1);
    if (chatIds && !chatIds.includes(chatId)) continue;

    const member = queues.get(chatId)?.find((m) => m.recordId === recordId);
    if (!member) {
      // 已离开队列（接单/窗口结束/节点推进）：卡片停止维护，登记移除
      keywordCardRegistry.delete(key);
      continue;
    }
    if (member.kw === entry.kw) continue;

    const card = rebuildKeywordCard(entry, member.kw, member.record);
    if (!card) continue;
    const prevKw = entry.kw;
    try {
      await updateCardToChat(chatId, entry.messageId, card);
      entry.kw = member.kw;
      entry.fails = 0;
      console.log(`[接单排队] 卡片接单词已更新 ${prevKw} → ${member.kw}: ${member.title} @ ${chatId}`);
    } catch (err) {
      entry.fails += 1;
      if (entry.fails >= KEYWORD_CARD_MAX_FAILS) {
        console.warn(`[接单排队] 卡片接单词连续更新失败 ${entry.fails} 次，放弃该卡片: ${member.title} @ ${chatId}`);
        keywordCardRegistry.delete(key);
      } else {
        console.warn(`[接单排队] 卡片接单词更新失败（对账重试）: ${member.title} @ ${chatId}: ${err.message}`);
      }
    }
  }
}

function pushHistory(entry) {
  broadcastHistory.unshift({ time: new Date().toISOString(), ...entry });
  if (broadcastHistory.length > 50) broadcastHistory.length = 50;
}

// ============================================================
// 播报标记（写回源表，跨重启防重播）
// 背景：飞书长连接同一应用多条连接随机分发事件，机器人仅能收到
// 约 1/N 的事件；漏掉的部分由每分钟轮询对账兜底，标记保证不重播。
// ============================================================
let markFieldReady = false;

async function ensureMarkField() {
  if (markFieldReady || !config.broadcast.markField) return;
  try {
    await bitableApi.createField(
      config.bitable.sourceAppToken,
      config.bitable.sourceTableId,
      config.broadcast.markField
    );
    console.log(`[工单事件] 已在源表创建播报标记字段「${config.broadcast.markField}」`);
  } catch (err) {
    // 字段已存在等场景视作就绪；真正的写入失败会在 markBroadcast 日志暴露
  }
  markFieldReady = true;
}

async function markBroadcast(recordId, scene) {
  const markField = config.broadcast.markField;
  if (!markField) return;
  await ensureMarkField();
  try {
    const stamp = `${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} ${scene}`;
    await bitableApi.updateRecord(
      config.bitable.sourceAppToken,
      config.bitable.sourceTableId,
      recordId,
      { [markField]: stamp }
    );
  } catch (err) {
    console.error(`[工单事件] 写入播报标记失败 ${recordId}:`, err.message);
  }
}

function pruneExpired(map, ttl) {
  const now = Date.now();
  for (const [key, value] of map) {
    const ts = typeof value === 'number' ? value : value.timestamp;
    if (now - ts > ttl) map.delete(key);
  }
}

/**
 * 加载完整源记录（事件未携带 fields 时回查）
 */
async function loadRecord(recordId, fields) {
  if (fields) return { record_id: recordId, fields };
  return bitableApi.getRecord(
    config.bitable.sourceAppToken,
    config.bitable.sourceTableId,
    recordId
  );
}

/**
 * 组别值 → 播报目标群集合（支持多选并行分发）
 */
function collectTargets(routeValue) {
  const values = Array.isArray(routeValue)
    ? routeValue
    : (routeValue === null || routeValue === undefined || routeValue === '' ? [] : [routeValue]);

  const seen = new Set();
  const targets = [];
  for (const val of values) {
    for (const route of config.broadcast.routes) {
      if (route.value !== String(val)) continue;
      const key = route.webhookUrl || route.chatId;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      targets.push(route);
    }
  }

  if (targets.length === 0 && config.broadcast.defaultTarget) {
    targets.push(config.broadcast.defaultTarget);
  }
  return targets;
}

/**
 * 查询指定负责人所属组别（USER_GROUPS → 通讯录 → 面向组别兜底，见 utils/personFields）
 */
async function resolveAssigneeGroups(record, assignee) {
  const routeGroups = config.broadcast.routeField ? record.fields[config.broadcast.routeField] : null;
  return resolvePersonGroups(routeGroups, assignee);
}

/**
 * 处理工单创建事件
 */
async function handleRecordCreate(recordId, fields) {
  pruneExpired(recentCreateEvents, NOTIFY_DEDUP_TTL);
  if (recentCreateEvents.has(recordId)) {
    console.log(`[工单事件] 跳过重复的新建事件: ${recordId}`);
    return null;
  }
  recentCreateEvents.set(recordId, Date.now());

  const record = await loadRecord(recordId, fields);
  console.log(`[工单事件] 新建工单: ${recordId}`);

  // 1. category 有值时搬运到项目看板
  const syncResult = await syncIfCategoryPresent(record, 'create');

  // 2. 审批节点进入触发值时播报（新建时已处于触发节点也直接播报）
  let broadcastResult = { broadcast: 0 };
  if (isBroadcastEnabled()) {
    const nodeField = config.approvalNode.field;
    const node = nodeField ? record.fields[nodeField] : '';
    if (isActivationNode(node)) {
      broadcastResult = await broadcastTicket(record, 'create');
    } else {
      console.log(`[工单事件] 创建时审批节点为「${node}」，暂不播报（等待进入「${config.approvalNode.acceptValues.join('」/「')}」）`);
    }
  }

  return { ...broadcastResult, sync: syncResult };
}

/**
 * 播报工单（按「是否指定人员负责」分支）
 * @param {object} record 源记录 { record_id, fields }
 * @param {string} scene 场景标识（create/publish）
 * @param {{bypassQuiet?: boolean}} options bypassQuiet=true 跳过晚间静默
 *        （仅人工单条补播用；静默窗口内顺延不播，09:00 后由对账自然补播）
 */
async function broadcastTicket(record, scene, options = {}) {
  const recordId = record.record_id;

  // 晚间静默：窗口内不发送也不做任何副作用（不写播报标记、不公示即绑定、
  // 不登记待接单），记录保持「无标记」状态由每分钟对账在窗口结束后自然补播；
  // 补播走 broadcastTicket 同一入口，播报前重查会兜住夜间已接单/节点推进的变化
  if (!options.bypassQuiet && quietHours.inQuietHours()) {
    if (!quietDeferredLogged.has(recordId)) {
      quietDeferredLogged.add(recordId);
      console.log(`[工单事件] 晚间静默（${quietHours.quietWindowDesc()}），工单 ${recordId} 播报顺延（对账将在窗口结束后补播）`);
    }
    return { broadcast: 0, note: 'quiet-deferred' };
  }

  if (broadcastedRecords.has(recordId)) {
    console.log(`[工单事件] 工单 ${recordId} 已播报过，跳过重复播报`);
    return { broadcast: 0, note: '已播报过' };
  }

  // 源表标记去重（事件触发时读到已标记记录则跳过；跨重启防重播）
  const markField = config.broadcast.markField;
  if (markField && record.fields[markField]) {
    console.log(`[工单事件] 工单 ${recordId} 已有播报标记「${record.fields[markField]}」，跳过`);
    return { broadcast: 0, note: '已播报过(标记)' };
  }

  // 发送前重查最新状态：已有人接单 / 审批节点已推进（如已到回执单）则不再播报「无人接单」
  try {
    const fresh = await loadRecord(recordId);
    const freshNode = config.approvalNode.field ? fresh.fields[config.approvalNode.field] : '';
    const supplement = fresh.fields[config.assign.supplementField];
    if (supplement && supplement.length > 0) {
      console.log(`[工单事件] 工单 ${recordId} 已有补充负责人，跳过播报`);
      return { broadcast: 0, note: '已有人接单' };
    }
    if (!isActivationNode(freshNode)) {
      console.log(`[工单事件] 工单 ${recordId} 审批节点已推进为「${freshNode || '(空)'}」，跳过播报`);
      return { broadcast: 0, note: '节点已推进' };
    }
  } catch (err) {
    console.warn(`[工单事件] 播报前重查失败（继续按原记录播报）: ${err.message}`);
  }

  const { fields: f } = record;
  const assignValue = config.assign.field ? f[config.assign.field] : '';
  let targets = [];
  let assignee = null;

  if (assignValue === config.assign.noValue) {
    // 未指定负责人 → 按「面向组别」并行分支，询问是否有人接单
    targets = collectTargets(config.broadcast.routeField ? f[config.broadcast.routeField] : '');
  } else if (assignValue === config.assign.yesValue) {
    // 已指定负责人 → 查询其所属组别，在对应群聊 @本人 公示
    assignee = config.assign.assigneeField ? (f[config.assign.assigneeField]?.[0] || null) : null;
    const groupNames = await resolveAssigneeGroups(record, assignee);
    targets = collectTargets(groupNames);
  } else {
    console.log(`[工单事件] 「${config.assign.field}」值「${assignValue}」无法识别，跳过播报`);
    return { broadcast: 0, note: '未识别是否指定负责人' };
  }

  if (targets.length === 0) {
    console.log('[工单事件] 无可用播报目标，跳过播报');
    pushHistory({ type: scene, recordId, broadcast: 0, note: '无播报目标' });
    return { broadcast: 0, note: '无播报目标' };
  }

  // 接单排队：发送前推导各群接单词——群内已有多张待接单工单时，
  // 本单与同群其它工单的卡片提示都用带序号的「接单N」（推导失败按「接单」播报）
  let acceptQueues = new Map();
  let queueRecords = null;
  try {
    queueRecords = await bitableApi.listAllRecords(
      config.bitable.sourceAppToken,
      config.bitable.sourceTableId
    );
    acceptQueues = await computeAcceptQueues(queueRecords);
  } catch (err) {
    console.warn(`[工单事件] 接单队列推导失败（按「接单」播报）: ${err.message}`);
  }

  const results = [];
  const sentChatIds = [];
  for (const target of targets) {
    const isAssignCard = assignValue === config.assign.yesValue;
    const member = target.chatId ? acceptQueues.get(target.chatId)?.find((q) => q.recordId === recordId) : null;
    const kw = member?.kw || '接单';
    const card = isAssignCard
      ? buildTicketAssignCard(record, assignee, kw)
      : buildTicketOpenCard(record, kw);
    try {
      const sent = await sendCardToTarget(target, card);
      if (target.chatId) {
        sentChatIds.push(target.chatId);
        // 接单提示卡登记：后续队列变化按 message_id 改写提示行（webhook 卡片无 message_id 不登记）
        rememberKeywordCard({
          chatId: target.chatId,
          recordId,
          messageId: sent?.message_id,
          kind: isAssignCard ? 'assign' : 'open',
          kw,
        });
      }
      results.push({ target: describeTarget(target), success: true });
    } catch (err) {
      console.error(`[工单事件] 播报到 ${describeTarget(target)} 失败:`, err.message);
      results.push({ target: describeTarget(target), success: false, error: err.message });
    }
  }

  // 至少一个群播报成功才标记已播报，失败时允许下次重试
  let bindResult = null;
  if (results.some((r) => r.success)) {
    broadcastedRecords.add(recordId);
    quietDeferredLogged.delete(recordId);
    await markBroadcast(recordId, scene);
    plaza.append({ event: '工单播报', title: `${scene}：工单 …${recordId.slice(-6)} 已播报至 ${sentChatIds.size} 个群` });

    // 指定负责人工单「公示即绑定」：写补充负责人 + 看板人员字段（幂等）
    // 状态推进与「负责人确认消息后通过」审批仍由本人 @机器人 接单确认触发
    if (assignValue === config.assign.yesValue) {
      bindResult = await bindAssignedTicket(record, scene);
    }

    // 本单入队会改变同群其它待接单工单的排队序号，刷新那些卡片的接单提示行
    // （复用首轮拉取的全量记录，免二次全表拉表；首轮失败时为 null 走现查）
    try {
      await refreshAcceptKeywordCards([...new Set(sentChatIds)], queueRecords);
    } catch (err) {
      console.warn(`[工单事件] 接单词卡片刷新失败（对账重试）: ${err.message}`);
    }
  }
  pushHistory({ type: scene, recordId, assignValue, targets: results });

  console.log(`[工单事件] ${scene} 播报完成: ${results.filter((r) => r.success).length}/${results.length} 个群`);
  return { broadcast: results.filter((r) => r.success).length, bind: bindResult };
}

/**
 * 指定负责人工单「公示即绑定」：把指定负责人写为补充负责人（绑定接单人），
 * 并按其所属组别合并写看板人员字段。只做绑定——项目状态推进与审批自动通过
 * 等待本人 @机器人 接单确认后由 handleAcceptOrder 触发。
 * @param {object} record 源表记录 {record_id, fields}
 * @param {string} scene 场景标识（broadcast/reconcile）
 */
async function bindAssignedTicket(record, scene) {
  const f = record.fields;
  const assignee = config.assign.assigneeField ? (f[config.assign.assigneeField]?.[0] || null) : null;
  if (!assignee?.id) return { done: false, reason: '无指定负责人' };

  const recordId = record.record_id;
  const supplementField = config.assign.supplementField;

  // 1. 写「补充负责人」= 指定负责人（绑定接单人，幂等）
  if (supplementField) {
    try {
      await bitableApi.updateRecord(
        config.bitable.sourceAppToken,
        config.bitable.sourceTableId,
        recordId,
        { [supplementField]: [{ id: assignee.id }] }
      );
      console.log(`[公示即绑定] 已写补充负责人: ${assignee.name || ''}(${assignee.id}) ← ${recordId} (${scene})`);
    } catch (err) {
      console.error(`[公示即绑定] 写补充负责人失败 ${recordId}:`, err.message);
      return { done: false, reason: err.message };
    }
  }

  // 2. 看板人员字段按负责人组别合并写入（与搬运/接单写入合并语义一致，不清空其它组别）
  try {
    const routeGroups = config.broadcast.routeField ? f[config.broadcast.routeField] : null;
    const groups = await resolvePersonGroups(routeGroups, assignee);
    const personFields = buildPersonFieldsByGroups(groups, assignee.id);
    const target = await syncService.findTargetRecordByKey(recordId);
    if (target && Object.keys(personFields).length > 0) {
      const { mergePersonFields } = require('../utils/personFields');
      const merged = mergePersonFields(target.fields, personFields);
      await bitableApi.updateRecord(
        config.bitable.targetAppToken,
        config.bitable.targetTableId,
        target.record_id,
        merged
      );
      console.log(`[公示即绑定] 已按组别（${groups.join('/') || '默认owner'}）写看板人员字段: ${assignee.name || assignee.id}`);
    }
  } catch (err) {
    console.warn(`[公示即绑定] 看板人员字段写入失败（不影响绑定） ${recordId}:`, err.message);
  }

  pushHistory({ type: 'bind', recordId, assigneeId: assignee.id, scene });
  return { done: true };
}

/**
 * 手动补播指定工单（用于漏播修复，走同一去重集合保证幂等）
 * 人工当下主动触发，跳过晚间静默立即发送
 * @param {string} recordId 源表记录 ID
 */
async function rebroadcastRecord(recordId) {
  const record = await loadRecord(recordId);
  const node = config.approvalNode.field ? record.fields[config.approvalNode.field] : '';
  if (!isActivationNode(node)) {
    return { broadcast: 0, note: `审批节点「${node || '(空)'}」不在触发范围` };
  }
  return broadcastTicket(record, 'rebroadcast', { bypassQuiet: true });
}

/**
 * 轮询对账：扫描源表所有处于触发节点/回执单节点的工单
 *   - 触发节点：漏播的补播、漏搬的补搬（「已播报」标记防重复）
 *   - 触发节点（指定负责人）：公示即绑定的补偿绑定（写补充负责人 + 看板人员字段）
 *   - 回执单节点：负责人已确认接单，推进看板状态（waiting → in_progress）
 * 背景：网关不可用期间的事件由本函数（每分钟执行）兜底；
 * 接单确认走事件驱动（@对话型+「接单」网关秒级转发），不再做消息回扫。
 */
async function reconcileBroadcasts() {
  const markField = config.broadcast.markField;
  const nodeField = config.approvalNode.field;
  const closeValue = config.approvalNode.closeValue;

  const all = await bitableApi.listAllRecords(
    config.bitable.sourceAppToken,
    config.bitable.sourceTableId
  );

  let broadcast = 0;
  let synced = 0;
  let bound = 0;
  let multiClosed = 0;
  let reapproved = 0;
  let skipped = 0;

  for (const record of all) {
    const f = record.fields;
    const node = nodeField ? f[nodeField] : '';
    const inAcceptNode = isActivationNode(node); // 等待接单/等待负责人确认
    // 拼接节点值拆段匹配：多组别工单的「回执单：是否结单」是并行分支多段拼接，整串比对永远不等
    const inCloseNode = config.matchNodeValue(node, [closeValue]);
    if (!inAcceptNode && !inCloseNode) continue;

    // 补搬运/状态推进（category 门控，与播报标记无关，upsert 幂等）
    try {
      const syncResult = await syncIfCategoryPresent(record, 'reconcile');
      if (syncResult) synced++;
    } catch (err) {
      console.error(`[对账] 补搬运失败 ${record.record_id}:`, err.message);
    }

    // 接单后审批联动补偿：多人单窗口到期自动通过（+结束通告）、
    // 非多人单接单时通过失败的补通过（指定负责人工单不代通过）
    if (inAcceptNode) {
      try {
        const approved = await maybeAutoApproveOnReconcile(record);
        if (approved === 'multi-closed') {
          multiClosed++;
          plaza.append({ event: '工单结单', title: `多人单窗口到期，审批自动通过（工单 …${record.record_id.slice(-6)}）` });
        } else if (approved === 'approved') {
          reapproved++;
          plaza.append({ event: '审批自动通过', title: `对账补通过审批（工单 …${record.record_id.slice(-6)}）` });
        }
      } catch (err) {
        console.error(`[对账] 接单审批联动处理失败 ${record.record_id}:`, err.message);
      }
    }

    // 补播报/补绑定（仅触发节点；回执单节点不播报）
    if (!inAcceptNode) continue;
    if (markField && f[markField]) {
      // 已播报：指定负责人工单做「公示即绑定」补偿（绑定失败的兜底；
      // 状态推进与审批仍由本人 @机器人 确认触发，这里不碰）
      if (isAssignAcceptNode(node)) {
        const assignee = config.assign.assigneeField ? (f[config.assign.assigneeField]?.[0] || null) : null;
        const supplement = config.assign.supplementField ? f[config.assign.supplementField] : null;
        const alreadyBound = !!(assignee?.id && supplement?.some((p) => p?.id === assignee.id));
        if (assignee?.id && !alreadyBound) {
          try {
            await bindAssignedTicket(record, 'reconcile');
            bound++;
          } catch (err) {
            console.error(`[对账] 公示即绑定补偿失败 ${record.record_id}:`, err.message);
            skipped++;
          }
        }
      }
      continue;
    }
    try {
      const r = await broadcastTicket(record, 'reconcile');
      if (r.broadcast > 0) broadcast++;
      else skipped++;
    } catch (err) {
      console.error(`[对账] 补播失败 ${record.record_id}:`, err.message);
      skipped++;
    }
  }

  // 接单词排队对账：队列变化（接单出队/多人单窗口结束/节点推进/补播入队）
  // 后，已发卡片的接单提示行与最新序号不一致时改写（幂等，无变化零写操作）
  try {
    await refreshAcceptKeywordCards(null, all);
  } catch (err) {
    console.warn(`[对账] 接单词卡片刷新失败: ${err.message}`);
  }

  console.log(`[对账] 扫描 ${all.length} 条，补播 ${broadcast}，补搬运 ${synced}，补绑定 ${bound}，多人单窗口关闭 ${multiClosed}，审批补通过 ${reapproved}，跳过 ${skipped}`);
  pushHistory({ type: 'reconcile', checked: all.length, broadcast, synced, bound, multiClosed, reapproved, skipped });

  return { checked: all.length, broadcast, synced, bound, multiClosed, reapproved, skipped };
}

/**
 * 处理工单更新事件：category 门控搬运 + 申请状态进入「审批中」时播报
 */
async function handleRecordUpdate(recordId, fields, oldFields) {
  const record = await loadRecord(recordId, fields);
  console.log(`[工单事件] 工单更新: ${recordId}`);

  // 1. category 有值时搬运到项目看板（同步映射字段，含 status）
  const syncResult = await syncIfCategoryPresent(record, 'update');

  // 2. 审批节点进入触发值时触发播报（去重保证只播一次）
  if (isBroadcastEnabled()) {
    const nodeField = config.approvalNode.field;
    const node = nodeField ? record.fields[nodeField] : '';
    if (isActivationNode(node)) {
      await broadcastTicket(record, 'publish');
    }
  }

  return { broadcast: 0, sync: syncResult };
}

/**
 * category 门控搬运
 */
async function syncIfCategoryPresent(record, scene) {
  if (!config.sync.categoryField) {
    return doSync(record, scene);
  }

  const categoryValue = record.fields[config.sync.categoryField];
  const hasCategory = !(categoryValue === null || categoryValue === undefined || categoryValue === '');
  if (!hasCategory) {
    console.log(`[工单事件] ${scene}: category 为空，跳过搬运`);
    return null;
  }

  return doSync(record, scene);
}

async function doSync(record, scene) {
  try {
    const result = await syncService.syncRecord(record);
    console.log(`[工单事件] ${scene}: 已搬运到项目看板 (${result.action}) ${result.targetRecordId}`);
    return result;
  } catch (err) {
    console.error(`[工单事件] ${scene}: 搬运到项目看板失败:`, err.message);
    pushHistory({ type: 'sync', recordId: record.record_id, success: false, error: err.message });
    return null;
  }
}

/**
 * 该群当前是否存在可接单工单（2026-09-13 口径：无单的群不监听接单及其变式，
 * 群内接单类消息静默忽略——非工单群不再收到「无待接单工单」/使用提示等噪音回复）
 * @returns {Promise<boolean>}
 */
async function hasPendingAcceptInGroup(chatId) {
  if (!chatId) return false;
  const queues = await computeAcceptQueues();
  return (queues.get(chatId) || []).length > 0;
}

/**
 * 处理接单确认（群聊消息中 @机器人 / 指定负责人私聊确认）
 * @param {string} chatId 群聊 ID
 * @param {string} userId 发送者 open_id
 * @param {string} userName 发送者姓名
 * @param {string} message 消息内容（「接单/确认接单」或带排队序号的「接单N/确认接单N」）
 * @param {string|null} explicitRecordId 私聊确认链路直接指定的工单 ID（跳过序号匹配）
 */
function handleAcceptOrder(chatId, userId, userName, message, explicitRecordId = null) {
  return withAcceptLock(chatId, () => handleAcceptOrderLocked(chatId, userId, userName, message, explicitRecordId));
}

// 接单是「读全量记录 → 合并写补充负责人」的读改写链路，两个并发接单若同时读到同一底版，
// 后写会覆盖先写（丢人）。按群 chatId 串行化整个接单流程（含队列推导），并发消息排队执行。
// 飞书表格无条件写（CAS），进程内串行是当前部署形态（单实例）下完备的解法。
const acceptLocks = new Map(); // chatId -> 正在执行的接单 Promise（串行链尾）
function withAcceptLock(chatId, fn) {
  const prev = acceptLocks.get(chatId) || Promise.resolve();
  const task = prev.then(fn, fn);
  acceptLocks.set(chatId, task);
  const cleanup = () => { if (acceptLocks.get(chatId) === task) acceptLocks.delete(chatId); };
  task.then(cleanup, cleanup);
  return task;
}

async function handleAcceptOrderLocked(chatId, userId, userName, message, explicitRecordId = null) {
  // 事件体不携带发送者姓名，为空时通过通讯录解析（回执卡片与日志要用）
  if (!userName && userId) {
    try {
      const { requestAPI } = require('../feishu/client');
      const u = await requestAPI('GET', `/contact/v3/users/${userId}?user_id_type=open_id`);
      if (u.code === 0) userName = u.data?.user?.name || '';
    } catch (err) {
      console.warn(`[接单确认] 通讯录解析姓名失败: ${err.message}`);
    }
  }
  console.log(`[接单确认] 收到消息: ${userName || '(未知)'}(${userId}) 在群 ${chatId}: ${message}`);

  // 推导该群接单队列（按源表实时计算：无人接单/多人单续接/指定负责人待确认，
  // 最新在前；复数张时接单词为「接单N」，唯一一张为「接单」）
  let queue = [];
  try {
    queue = (await computeAcceptQueues()).get(chatId) || [];
  } catch (err) {
    console.error(`[接单确认] 接单队列推导失败: ${err.message}`);
  }

  // 接单词解析：「接单 / 确认接单」与带排队序号的「接单N / 确认接单N」
  const kwMatch = String(message || '').replace(/\s+/g, '').match(/^(?:确认接单|接单)(\d+)?$/);
  const wantedNo = kwMatch?.[1] ? Number(kwMatch[1]) : null;

  // 定位目标工单：私聊确认链路直接指定；群内按序号或唯一工单匹配。
  // 与旧内存映射「从队尾取最新、非本人单静默顺延」不同——序号直指工单，
  // 接不了会明确拒绝，不再悄悄落到别的工单上（同群多单撞听的根因）
  let member = null;
  if (explicitRecordId) {
    member = queue.find((q) => q.recordId === explicitRecordId) || null;
    if (!member) {
      // 队列推导可能因组别解析失败漏掉该单（私聊链路已自校验候选资格），直查兜底
      try {
        const record = await loadRecord(explicitRecordId);
        member = {
          record,
          recordId: explicitRecordId,
          title: getTicketTitle(record.fields, explicitRecordId),
          kw: '接单',
        };
      } catch (err) {
        console.error(`[接单确认] 私聊确认目标工单读取失败: ${err.message}`);
      }
    }
  } else if (wantedNo !== null) {
    member = queue[wantedNo - 1] || null;
    if (!member) {
      const reason = queue.length === 0
        ? '该群当前没有待接单工单'
        : `「接单${wantedNo}」不存在：该群当前共 ${queue.length} 张待接单工单`;
      console.log(`[接单确认] 序号未命中: 接单${wantedNo} @ ${chatId}`);
      return { success: false, reason };
    }
  } else if (queue.length === 0) {
    console.log(`[接单确认] 该群无待接单工单`);
    return { success: false, reason: '无待接单工单' };
  } else if (queue.length > 1) {
    // 复数张时不猜：固定「接单」词在多单并存时语义不明（撞听根因），提示按序号接单
    console.log(`[接单确认] 该群有 ${queue.length} 张待接单工单，提示按序号接单`);
    return {
      success: false,
      reason: `该群有多张待接单工单，请按各工单卡片提示发送「接单1」~「接单${queue.length}」指定要接的单（「接单1」为最新播报）`,
    };
  } else {
    member = queue[0];
  }

  if (!member) {
    console.log(`[接单确认] 目标工单未找到: ${explicitRecordId || '(无显式指定)'} @ ${chatId}`);
    return { success: false, reason: '未找到待确认的工单，请到工单群按卡片提示发送接单词' };
  }

  const { recordId, title, kw } = member;
  const sourceRecordId = recordId; // 队列成员即源表记录，两 ID 同源（沿用既有流程命名）

  console.log(`[接单确认] 匹配到工单: ${title} (${recordId})${kw !== '接单' ? `，接单词「${kw}」` : ''}`);

  try {
    // 0. 重查最新记录（以源表为准，播报后的指派变更不误判）：
    //    指定负责人工单仅限本人 @机器人 确认（授权门禁，记录拉取失败按拒绝处理，等下轮回扫重试）
    const fresh = await bitableApi.getRecord(
      config.bitable.sourceAppToken,
      config.bitable.sourceTableId,
      sourceRecordId
    );
    const assignValue = config.assign.field ? fresh.fields[config.assign.field] : '';
    const assignee = config.assign.assigneeField ? (fresh.fields[config.assign.assigneeField]?.[0] || null) : null;
    const isAssignTicket = assignValue === config.assign.yesValue && !!assignee?.id;
    if (isAssignTicket && assignee.id !== userId) {
      console.log(
        `[接单确认] 指定负责人工单拒绝他人确认: ${userName || userId} ≠ 指定负责人 ${assignee.name || ''}(${assignee.id})`
      );
      return { success: false, reason: '该工单已指定负责人，仅限本人 @机器人 确认接单' };
    }

    // 陈旧条目守卫（跨群并行登记/重复消息）：以源表最新状态为准，
    // 节点已推进或已有人确认过的一律拒绝，防止虚假接单回执与重复写表
    const nodeNow = config.approvalNode.field ? fresh.fields[config.approvalNode.field] : '';
    if (!isActivationNode(nodeNow)) {
      console.log(`[接单确认] 审批节点已推进（${nodeNow || '(空)'}），拒绝接单: ${sourceRecordId}`);
      return { success: false, reason: '该工单审批已推进，无需再接单' };
    }
    const supNow = Array.isArray(fresh.fields[config.assign.supplementField])
      ? fresh.fields[config.assign.supplementField].filter((p) => p?.id)
      : [];
    // 指定负责人单的「公示即绑定」会先写补充负责人（=指定负责人本人），
    // 「补负含本人」≠「已确认」——本人来确认正是该链路的既定动作；
    // 不加区分地按已确认拒绝会把本人挡在门外，工单永远停在触发节点（202609100003事故）。
    // 本人的重复消息用短窗内存标记拦截（确认成功才登记，见下方收尾）
    const boundAssigneeSelf = isAssignTicket && supNow.some((p) => p.id === userId);
    if (!boundAssigneeSelf && supNow.some((p) => p.id === userId)) {
      console.log(`[接单确认] ${userName || userId} 已确认过该工单，拒绝重复确认: ${sourceRecordId}`);
      return { success: false, reason: '你已确认过该工单' };
    }
    if (boundAssigneeSelf) {
      pruneExpired(assigneeConfirmState, ASSIGNEE_CONFIRM_TTL);
      if (assigneeConfirmState.has(`${sourceRecordId}:${userId}`)) {
        console.log(`[接单确认] 指定负责人 ${userName || userId} 短窗内重复确认，忽略: ${sourceRecordId}`);
        return { success: false, reason: '你已确认过该工单' };
      }
    }
    if (!isAssignTicket && !isMultiAcceptTicket(fresh.fields) && supNow.length > 0) {
      console.log(
        `[接单确认] 工单已被 ${formatMultiNames(supNow)} 接单，拒绝重复确认: ${userName || userId}`
      );
      return { success: false, reason: '该工单已有人接单' };
    }
    const role = isAssignTicket ? '负责人' : '组员';

    // 1. 更新项目状态为 in_progress（搬运时已是 waiting，确认接单才开始执行）
    //    看板更新是派生视图维护，不作为接单前置条件：搬运走 category 门控，
    //    category 为空的工单本来就不进看板，这里 throw 会中止整个接单
    //    （补充负责人写不上 → 超时检查持续对所有面向组别播报，recvulRfoRHhsI 事故）
    try {
      await syncService.updateProjectStatus(sourceRecordId, 'in_progress');
      console.log(`[接单确认] 项目状态更新为 in_progress`);
    } catch (statusErr) {
      console.warn(`[接单确认] 看板状态更新失败（不阻断接单）: ${statusErr.message}`);
    }

    // 2.5 写入「补充负责人」字段：合并写入（多人单窗口期内会陆续多人接单，不能覆盖）
    const supplementField = config.assign.supplementField;
    let acceptors = [];
    if (supplementField) {
      try {
        const existing = Array.isArray(fresh.fields[supplementField])
          ? fresh.fields[supplementField].filter((p) => p?.id)
          : [];
        acceptors = existing.some((p) => p.id === userId)
          ? existing
          : [...existing, { id: userId, name: userName }];
        await bitableApi.updateRecord(
          config.bitable.sourceAppToken,
          config.bitable.sourceTableId,
          sourceRecordId,
          { [supplementField]: acceptors.map((p) => ({ id: p.id })) }
        );
        console.log(`[接单确认] 已合并写入补充负责人: ${formatMultiNames(acceptors)}`);
      } catch (supplementErr) {
        console.error(`[接单确认] 写入补充负责人失败:`, supplementErr.message);
      }
    }

    // 2.6 按接单人所属组别写入看板人员字段（机械→owner，电控/硬件→dkyjcontributers，
    //     视觉→sjcontributers，宣运→xycontributers；组别解析：USER_GROUPS → 通讯录 → 工单面向组别兜底）
    //     与看板已有人员合并（同字段多人并存），不清空其它组别
    try {
      const routeGroups = config.broadcast.routeField ? fresh.fields[config.broadcast.routeField] : null;
      const groups = await resolvePersonGroups(routeGroups, { id: userId, name: userName });
      const personFields = buildPersonFieldsByGroups(groups, userId);
      const target = await syncService.findTargetRecordByKey(sourceRecordId);
      if (target) {
        const { mergePersonFields } = require('../utils/personFields');
        const merged = mergePersonFields(target.fields, personFields);
        await bitableApi.updateRecord(
          config.bitable.targetAppToken,
          config.bitable.targetTableId,
          target.record_id,
          merged
        );
        console.log(`[接单确认] 已按组别（${groups.join('/') || '(未识别，默认owner)'}）写入看板人员字段: ${userName}`);
      } else {
        console.warn(`[接单确认] 看板无对应记录，跳过人员字段写入: ${sourceRecordId}`);
      }
    } catch (personErr) {
      console.error(`[接单确认] 写入看板人员字段失败:`, personErr.message);
    }

    // 3.（原内存待接单列表移除已废弃）队列按源表实时推导，本单出队由
    //    补充负责人/审批节点字段变化自然反映，无需内存维护

    // 4. 发送确认消息
    const { sendCardToTarget } = require('../feishu/bot');
    const target = config.broadcast.routes.find(r => r.chatId === chatId) || config.broadcast.defaultTarget;
    if (target) {
      const confirmCard = {
        config: { wide_screen_mode: true },
        elements: [
          { tag: 'markdown', content: `✅ **${userName}** 已确认接单` },
          { tag: 'markdown', content: `**工单**: ${title}` },
          { tag: 'markdown', content: `**状态**: 进行中` },
        ],
        header: {
          template: 'green',
          title: { content: '📋 接单确认', tag: 'plain_text' },
        },
      };
      await sendCardToTarget(target, confirmCard);
    }

    // 5. 审批联动 / 多人接单分支：
    //    - 多人单（无指定负责人 + 「是否允许多人接单」=是）：不即时通过审批；
    //      写窗口截止（now + N 小时，窗口内再有人接单会重新计时），
    //      并在本次接单的群发续接询问；到期由每分钟对账自动通过
    //    - 其余（含指定负责人、未开多人的普通单）：接单即自动通过全部并行触发节点任务
    //      （尽力而为，不影响接单结果；失败由对账补偿）
    let multiWindowOpen = false;
    if (!isAssignTicket && isMultiAcceptTicket(fresh.fields)) {
      const windowUntil = Date.now() + config.multiAccept.windowHours * 60 * 60 * 1000;
      // 截止必须落库才算窗口成立（对账按它判到期）；写失败不发续接询问、
      // 直接降级为普通单接单即通过——窗口是假的，绝不能据此卡住工单
      multiWindowOpen = await writeMultiWindowDeadline(sourceRecordId, windowUntil);
      if (multiWindowOpen) {
        try {
          // 续接询问只发本次接单发生的群（用户裁定 2026-09-06）：不做组别解析映射——
          // resolvePersonGroups 解析失败会回退到工单「面向组别」，等于广播全部组；
          // 接单词带本群当前排队序号（群内还有其它待接单工单时为「接单N」）并登记卡片
          const successorKw = kw || '接单';
          const sent = await sendCardToTarget(
            { chatId },
            buildMultiAcceptCard({ title, acceptors, windowUntil, kw: successorKw })
          );
          rememberKeywordCard({
            chatId,
            recordId,
            messageId: sent?.message_id,
            kind: 'multi',
            kw: successorKw,
          });
          const deadlineText = new Date(windowUntil).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
          console.log(`[接单确认] 多人单续接窗口开启至 ${deadlineText}，续接询问已发至接单群 ${chatId}（接单词「${successorKw}」）`);
        } catch (err) {
          console.warn('[接单确认] 多人单续接通知失败(不影响接单):', err.message);
        }
      } else {
        console.warn('[接单确认] 多人单窗口截止写入失败 → 降级为接单即自动通过（不发续接询问）');
      }
    }
    plaza.append({ event: '工单接单', title: `${userName || '队员'} 确认接单${role ? `（${role}）` : ''}` });
    if (!multiWindowOpen) {
      try {
        const { autoApproveForTicket } = require('./approvalLinkService');
        const approveResult = await autoApproveForTicket(fresh, userName, role);
        if (approveResult.done) {
          console.log('[接单确认] 审批联动: 已自动通过审批节点');
        } else if (approveResult.reason) {
          console.log(`[接单确认] 审批联动未执行: ${approveResult.reason}`);
        }
      } catch (err) {
        console.warn('[接单确认] 审批联动失败(不影响接单):', err.message);
      }
    }

    // 6. 队列重排（跟排队一样）：本单出队后，同群剩余待接单工单的序号前移
    //    （接单2→接单1，仅剩一张回落「接单」），已发卡片的接单提示行同步改写
    try {
      await refreshAcceptKeywordCards([chatId]);
    } catch (err) {
      console.warn(`[接单确认] 接单词卡片刷新失败（对账重试）: ${err.message}`);
    }

    if (boundAssigneeSelf) assigneeConfirmState.set(`${sourceRecordId}:${userId}`, Date.now());
    pushHistory({ type: 'accept', recordId, userId, userName, title });
    return { success: true, recordId, title };
  } catch (err) {
    console.error(`[接单确认] 处理失败:`, err.message);
    return { success: false, reason: err.message };
  }
}

/**
 * 指定负责人私聊确认：负责人在 24h 追问私信中回复「接单」→ 定位其「已绑定未确认」的
 * 工单（节点仍在「负责人确认消息后通过」+ 补充负责人==本人），登记到公示群待接单映射，
 * 复用群接单链路完成状态推进、群内回执与审批联动（本人校验仍由 handleAcceptOrder 把关）
 * @param {string} userId 负责人 open_id
 * @param {string} userName 负责人姓名
 */
async function handleAssigneeDmConfirm(userId, userName) {
  if (!userId) return { success: false, reason: '无法识别发送者' };

  const nodeField = config.approvalNode.field;
  const all = await bitableApi.listAllRecords(
    config.bitable.sourceAppToken,
    config.bitable.sourceTableId
  );
  const candidates = all
    .filter((r) => {
      const f = r.fields;
      const node = nodeField ? f[nodeField] : '';
      if (!isAssignAcceptNode(node)) return false;
      const assignee = config.assign.assigneeField ? (f[config.assign.assigneeField]?.[0] || null) : null;
      if (assignee?.id !== userId) return false;
      const sup = config.assign.supplementField ? f[config.assign.supplementField] : null;
      return !!sup?.some((p) => p?.id === userId); // 已绑定未确认
    })
    .sort((a, b) => (getCreatedTime(b.fields) || 0) - (getCreatedTime(a.fields) || 0));

  const latest = candidates[0];
  if (!latest) return { success: false, reason: 'no-pending' };

  const assignee = latest.fields[config.assign.assigneeField]?.[0] || null;
  const routeGroups = config.broadcast.routeField ? latest.fields[config.broadcast.routeField] : null;
  const groupNames = await resolvePersonGroups(routeGroups, assignee);
  const chatId = collectTargets(groupNames).find((t) => t.chatId)?.chatId;
  if (!chatId) return { success: false, reason: '未找到工单公示群，请在对应工单群 @机器人 发送「接单」' };

  console.log(`[接单确认] 私聊确认命中工单: ${latest.record_id} → 公示群 ${chatId}`);
  // 直接指定工单走群内确认链路（私聊语境无歧义，不受群内排队序号影响）
  return handleAcceptOrder(chatId, userId, userName, '接单', latest.record_id);
}

/**
 * 获取工单标题
 */
function getTicketTitle(fields, recordId) {
  const raw = config.broadcast.titleField ? fields[config.broadcast.titleField] : '';
  const title = raw ? formatFieldText(raw) : '';
  if (title) return title;

  const demand = formatFieldValue(fields['需求1'] ?? fields['需求']);
  if (demand) return demand.length > 30 ? `${demand.slice(0, 30)}…` : demand;

  return `工单 ${recordId.slice(-6)}`;
}

/**
 * 获取全部工单
 */
async function getAllTickets() {
  return bitableApi.listAllRecords(config.bitable.sourceAppToken, config.bitable.sourceTableId);
}

/**
 * 获取待处理工单
 */
async function getPendingTickets() {
  if (!config.broadcast.pendingStatus) {
    return [];
  }
  const filter = `CurrentValue.[${config.broadcast.statusField}] = "${config.broadcast.pendingStatus}"`;
  return bitableApi.listAllRecords(config.bitable.sourceAppToken, config.bitable.sourceTableId, filter);
}

/**
 * 按状态字段统计工单分布
 */
async function getTicketStats() {
  const all = await getAllTickets();
  const statusCount = {};
  for (const item of all) {
    const status = config.broadcast.statusField
      ? formatFieldValue(item.fields[config.broadcast.statusField])
      : '';
    statusCount[status] = (statusCount[status] || 0) + 1;
  }
  return { total: all.length, statusCount, all };
}

function getBroadcastHistory() {
  return broadcastHistory;
}

module.exports = {
  handleRecordCreate,
  handleRecordUpdate,
  handleAcceptOrder,
  hasPendingAcceptInGroup,
  handleAssigneeDmConfirm,
  rebroadcastRecord,
  reconcileBroadcasts,
  getAllTickets,
  getPendingTickets,
  getTicketStats,
  getBroadcastHistory,
  collectTargets,
  resolveAssigneeGroups,
  computeAcceptQueues,
  rememberKeywordCard,
};
