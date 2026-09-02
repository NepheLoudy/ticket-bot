const config = require('../config');
const bitableApi = require('../feishu/bitable');
const syncService = require('./syncService');
const {
  sendCardToTarget,
  describeTarget,
  buildTicketOpenCard,
  buildTicketAssignCard,
} = require('../feishu/bot');
const { formatFieldValue, formatFieldText } = require('../utils/fields');
const { resolvePersonGroups, buildPersonFieldsByGroups } = require('../utils/personFields');

// ============================================================
// 工单事件处理：
//   创建时 → category 门控搬运 + 按是否指定负责人分支播报
//   更新时 → 仅当申请状态变化时更新项目状态
//
// 接单确认机制：
//   无指定负责人 → 群聊公开询问"@机器人确认接单"
//   机器人监听群聊消息 → 收到 @ 后更新项目状态 waiting → in_progress
// ============================================================
const NOTIFY_DEDUP_TTL = 10 * 60 * 1000;
const recentCreateEvents = new Map(); // record_id -> timestamp

// 播报历史（内存，供 API 查询）
const broadcastHistory = [];

// 已播报的工单 recordId（跨创建/发布事件去重，避免同一工单重复播报）
const broadcastedRecords = new Set();

// 播报触发节点：审批节点命中任一值时触发播报
//   - 有组员接单后通过：未指定负责人工单的审批节点
//   - 负责人确认消息后通过：指定负责人工单的审批节点
const ACTIVATION_NODE_VALUES = new Set(config.approvalNode.acceptValues);

function isActivationNode(node) {
  return node !== null && node !== undefined && node !== '' && ACTIVATION_NODE_VALUES.has(String(node));
}

// 待接单工单映射：chat_id → [{ recordId, sourceRecordId, title }]
// 用于接单确认时查找对应工单
const pendingOrdersByChat = new Map();

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

  // category 有值时搬运到项目看板
  // 播报不在事件里触发（审批提交/通过都不即时播）——统一由每分钟定时对账播报
  const syncResult = await syncIfCategoryPresent(record, 'create');

  return { broadcast: 0, sync: syncResult };
}

/**
 * 播报工单（按「是否指定人员负责」分支）
 * @param {object} record 源记录 { record_id, fields }
 * @param {string} scene 场景标识（create/publish）
 */
async function broadcastTicket(record, scene) {
  const recordId = record.record_id;
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
  let card;

  if (assignValue === config.assign.noValue) {
    // 未指定负责人 → 按「面向组别」并行分支，询问是否有人接单
    targets = collectTargets(config.broadcast.routeField ? f[config.broadcast.routeField] : '');
    card = buildTicketOpenCard(record);

    // 记录待接单工单（用于接单确认）
    const title = getTicketTitle(f, recordId);
    for (const target of targets) {
      const chatKey = target.chatId || target.webhookUrl;
      if (!pendingOrdersByChat.has(chatKey)) {
        pendingOrdersByChat.set(chatKey, []);
      }
      pendingOrdersByChat.get(chatKey).push({
        recordId,
        sourceRecordId: recordId,
        title,
        time: Date.now(),
      });
    }
  } else if (assignValue === config.assign.yesValue) {
    // 已指定负责人 → 查询其所属组别，在对应群聊 @本人
    const assignee = config.assign.assigneeField ? (f[config.assign.assigneeField]?.[0] || null) : null;
    const groupNames = await resolveAssigneeGroups(record, assignee);
    targets = collectTargets(groupNames);
    card = buildTicketAssignCard(record, assignee);
  } else {
    console.log(`[工单事件] 「${config.assign.field}」值「${assignValue}」无法识别，跳过播报`);
    return { broadcast: 0, note: '未识别是否指定负责人' };
  }

  if (targets.length === 0) {
    console.log('[工单事件] 无可用播报目标，跳过播报');
    pushHistory({ type: scene, recordId, broadcast: 0, note: '无播报目标' });
    return { broadcast: 0, note: '无播报目标' };
  }

  const results = [];
  for (const target of targets) {
    try {
      await sendCardToTarget(target, card);
      results.push({ target: describeTarget(target), success: true });
    } catch (err) {
      console.error(`[工单事件] 播报到 ${describeTarget(target)} 失败:`, err.message);
      results.push({ target: describeTarget(target), success: false, error: err.message });
    }
  }

  // 至少一个群播报成功才标记已播报，失败时允许下次重试
  if (results.some((r) => r.success)) {
    broadcastedRecords.add(recordId);
    await markBroadcast(recordId, scene);
  }
  pushHistory({ type: scene, recordId, assignValue, targets: results });

  console.log(`[工单事件] ${scene} 播报完成: ${results.filter((r) => r.success).length}/${results.length} 个群`);
  return { broadcast: results.filter((r) => r.success).length };
}

/**
 * 手动补播指定工单（用于漏播修复，走同一去重集合保证幂等）
 * @param {string} recordId 源表记录 ID
 */
async function rebroadcastRecord(recordId) {
  const record = await loadRecord(recordId);
  const node = config.approvalNode.field ? record.fields[config.approvalNode.field] : '';
  if (!isActivationNode(node)) {
    return { broadcast: 0, note: `审批节点「${node || '(空)'}」不在触发范围` };
  }
  return broadcastTicket(record, 'rebroadcast');
}

/**
 * 拉取群聊里 @机器人 的用户消息（IM 消息列表 API）
 * @param {string} chatId 群 chat_id
 * @param {number} sinceSeconds 起始时间（10 位秒级时间戳）
 * @returns {Promise<Array<{senderId, senderName, text}>>}
 */
async function listBotMentions(chatId, sinceSeconds) {
  const { requestAPI } = require('../feishu/client');
  const now = Math.floor(Date.now() / 1000);
  const res = await requestAPI(
    'GET',
    `/im/v1/messages?container_id_type=chat&container_id=${chatId}&start_time=${sinceSeconds}&end_time=${now}&sort=ByCreateTimeAsc&page_size=50`
  );
  if (res.code !== 0) throw new Error(`拉取群消息失败: ${res.msg} (code: ${res.code})`);

  const result = [];
  for (const item of res.data?.items || []) {
    if (item.msg_type !== 'text') continue;
    if (item.sender?.sender_type !== 'user') continue; // 跳过应用自己发的
    const mentions = item.mentions || [];
    const botMention = mentions.find((m) => m.name === config.bot.name);
    if (!botMention) continue;
    let text = '';
    try { text = String(JSON.parse(item.body?.content || '{}').text || ''); } catch (e) { /* ignore */ }
    result.push({ senderId: item.sender.id, senderName: '', text: text.replace(/@_user_\d+/g, '').trim() });
  }
  return result;
}

/**
 * 补录接单：对已播报、无人接单的工单，回扫对应群里的 @机器人 消息。
 * 背景：@消息与表格事件同走长连接，共用应用的多条连接会随机抢走消息，
 * 被抢走的接单 @ 不会触发事件——由每分钟对账回扫兜底补录。
 */
async function backfillAccepts() {
  const markField = config.broadcast.markField;
  const nodeField = config.approvalNode.field;
  const supplementField = config.assign.supplementField;

  const all = await bitableApi.listAllRecords(
    config.bitable.sourceAppToken,
    config.bitable.sourceTableId
  );

  const nowSec = Math.floor(Date.now() / 1000);

  for (const record of all) {
    const f = record.fields;
    const node = nodeField ? f[nodeField] : '';
    if (!isActivationNode(node) && node !== config.approvalNode.closeValue) continue; // 不在流程中
    if (markField && !f[markField]) continue; // 未播报过（未播报的不需要补录 @）
    const supplement = f[supplementField];
    if (supplement && supplement.length > 0) continue; // 已有接单人

    // 定位该工单面向组别对应的群
    const routeGroups = config.broadcast.routeField ? f[config.broadcast.routeField] : null;
    const targets = collectTargets(routeGroups).filter((t) => t.chatId);
    if (targets.length === 0) continue;

    // 回扫窗口：工单发起时间之后（秒级）
    const createdSec = Math.floor((f['发起时间'] || 0) / 1000) || nowSec - 24 * 3600;

    for (const target of targets) {
      try {
        const mentions = await listBotMentions(target.chatId, createdSec);
        if (mentions.length === 0) continue;

        // 取最早的 @机器人 消息发送者作为接单人
        const first = mentions[0];
        // 解析姓名（尽力而为）
        let senderName = first.senderId;
        try {
          const { requestAPI } = require('../feishu/client');
          const u = await requestAPI('GET', `/contact/v3/users/${first.senderId}?user_id_type=open_id`);
          if (u.code === 0) senderName = u.data?.user?.name || senderName;
        } catch (e) { /* ignore */ }

        console.log(`[接单补录] 回扫发现 @机器人 消息，补录接单: ${senderName}(${first.senderId}) → ${record.record_id}`);
        await handleAcceptOrder(target.chatId, first.senderId, senderName, first.text);
        break; // 该工单已补录，不再扫其他群
      } catch (err) {
        console.error(`[接单补录] 回扫失败 ${record.record_id} (${describeTarget(target)}):`, err.message);
      }
    }
  }
}

/**
 * 轮询对账：扫描源表所有处于触发节点/回执单节点的工单
 *   - 触发节点：漏播的补播、漏搬的补搬（「已播报」标记防重复）
 *   - 回执单节点：负责人已确认接单，推进看板状态（waiting → in_progress）
 * 背景：飞书长连接同一应用多条连接随机分发事件，事件链路只是快速触发，
 * 漏掉的部分由本函数（每分钟执行）兜底。
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
  let skipped = 0;

  for (const record of all) {
    const f = record.fields;
    const node = nodeField ? f[nodeField] : '';
    const inAcceptNode = isActivationNode(node); // 等待接单/等待负责人确认
    const inCloseNode = node === closeValue; // 负责人已确认接单（回执单）
    if (!inAcceptNode && !inCloseNode) continue;

    // 补搬运/状态推进（category 门控，与播报标记无关，upsert 幂等）
    try {
      const syncResult = await syncIfCategoryPresent(record, 'reconcile');
      if (syncResult) synced++;
    } catch (err) {
      console.error(`[对账] 补搬运失败 ${record.record_id}:`, err.message);
    }

    // 补播报（仅触发节点且未播报过；回执单节点不播报）
    if (!inAcceptNode) continue;
    if (markField && f[markField]) continue;
    try {
      const r = await broadcastTicket(record, 'reconcile');
      if (r.broadcast > 0) broadcast++;
      else skipped++;
    } catch (err) {
      console.error(`[对账] 补播失败 ${record.record_id}:`, err.message);
      skipped++;
    }
  }

  console.log(`[对账] 扫描 ${all.length} 条，补播 ${broadcast}，补搬运 ${synced}，跳过 ${skipped}`);
  pushHistory({ type: 'reconcile', checked: all.length, broadcast, synced, skipped });

  // 回扫群 @消息补录被分流的接单（在状态对账后执行）
  try {
    await backfillAccepts();
  } catch (err) {
    console.error('[对账] 接单补录失败:', err.message);
  }

  return { checked: all.length, broadcast, synced, skipped };
}

/**
 * 处理工单更新事件：category 门控搬运 + 申请状态进入「审批中」时播报
 */
async function handleRecordUpdate(recordId, fields, oldFields) {
  const record = await loadRecord(recordId, fields);
  console.log(`[工单事件] 工单更新: ${recordId}`);

  // category 有值时搬运到项目看板（同步映射字段，含 status）
  // 播报不在事件里触发（审批提交/通过都不即时播）——统一由每分钟定时对账播报
  const syncResult = await syncIfCategoryPresent(record, 'update');

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
 * 处理接单确认（群聊消息中 @机器人）
 * @param {string} chatId 群聊 ID
 * @param {string} userId 发送者 open_id
 * @param {string} userName 发送者姓名
 * @param {string} message 消息内容
 */
async function handleAcceptOrder(chatId, userId, userName, message) {
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

  // 查找该群的待接单工单
  const chatKey = chatId;
  const pendingList = pendingOrdersByChat.get(chatKey) || [];

  if (pendingList.length === 0) {
    // 内存映射重启后清空：回退查询源表——触发节点/回执单节点 + 补充负责人为空 + 面向组别匹配该群的最新工单
    const route = config.broadcast.routes.find((r) => r.chatId === chatId);
    const group = route?.value;
    if (group) {
      try {
        const all = await bitableApi.listAllRecords(
          config.bitable.sourceAppToken,
          config.bitable.sourceTableId
        );
        const nodeField = config.approvalNode.field;
        const closeValue = config.approvalNode.closeValue;
        const supplementField = config.assign.supplementField;
        const candidates = all
          .filter((r) => {
            const f = r.fields;
            const node = nodeField ? f[nodeField] : '';
            if (!isActivationNode(node) && node !== closeValue) return false;
            const sup = f[supplementField];
            if (sup && sup.length > 0) return false;
            const groups = f[config.broadcast.routeField];
            const groupList = Array.isArray(groups) ? groups.map(String) : groups ? [String(groups)] : [];
            return groupList.includes(group);
          })
          .sort((a, b) => ((b.fields['发起时间'] || 0)) - ((a.fields['发起时间'] || 0)));
        const latest = candidates[0];
        if (latest) {
          pendingList.push({
            recordId: latest.record_id,
            sourceRecordId: latest.record_id,
            title: getTicketTitle(latest.fields, latest.record_id),
            time: Date.now(),
          });
          console.log(`[接单确认] 内存映射为空，已回退匹配到工单: ${pendingList[0].title} (${pendingList[0].recordId})`);
        }
      } catch (err) {
        console.error(`[接单确认] 回退查询待接单工单失败:`, err.message);
      }
    }
  }

  if (pendingList.length === 0) {
    console.log(`[接单确认] 该群无待接单工单`);
    return { success: false, reason: '无待接单工单' };
  }

  // 取最新的待接单工单
  const latest = pendingList[pendingList.length - 1];
  const { recordId, sourceRecordId, title } = latest;

  console.log(`[接单确认] 匹配到工单: ${title} (${recordId})`);

  try {
    // 1. 更新项目状态为 in_progress（搬运时已是 waiting，确认接单才开始执行）
    await syncService.updateProjectStatus(sourceRecordId, 'in_progress');
    console.log(`[接单确认] 项目状态更新为 in_progress`);

    // 2.5 写入「补充负责人」字段（接单人，尽力而为）
    const supplementField = config.assign.supplementField;
    if (supplementField) {
      try {
        await bitableApi.updateRecord(
          config.bitable.sourceAppToken,
          config.bitable.sourceTableId,
          sourceRecordId,
          { [supplementField]: [{ id: userId }] }
        );
        console.log(`[接单确认] 已写入补充负责人: ${userName}(${userId})`);
      } catch (supplementErr) {
        console.error(`[接单确认] 写入补充负责人失败:`, supplementErr.message);
      }
    }

    // 2.6 按接单人所属组别写入看板人员字段（机械→owner，电控/硬件→dkyjcontributers，
    //     视觉→sjcontributers，宣运→xycontributers；组别解析：USER_GROUPS → 通讯录 → 工单面向组别兜底）
    try {
      const srcRecord = await bitableApi.getRecord(
        config.bitable.sourceAppToken,
        config.bitable.sourceTableId,
        sourceRecordId
      );
      const routeGroups = config.broadcast.routeField ? srcRecord.fields[config.broadcast.routeField] : null;
      const groups = await resolvePersonGroups(routeGroups, { id: userId, name: userName });
      const personFields = buildPersonFieldsByGroups(groups, userId);
      const target = await syncService.findTargetRecordByKey(sourceRecordId);
      if (target) {
        await bitableApi.updateRecord(
          config.bitable.targetAppToken,
          config.bitable.targetTableId,
          target.record_id,
          personFields
        );
        console.log(`[接单确认] 已按组别（${groups.join('/') || '(未识别，默认owner)'}）写入看板人员字段: ${userName}`);
      } else {
        console.warn(`[接单确认] 看板无对应记录，跳过人员字段写入: ${sourceRecordId}`);
      }
    } catch (personErr) {
      console.error(`[接单确认] 写入看板人员字段失败:`, personErr.message);
    }

    // 3. 从待接单列表中移除
    pendingList.pop();
    if (pendingList.length === 0) {
      pendingOrdersByChat.delete(chatKey);
    }

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

    pushHistory({ type: 'accept', recordId, userId, userName, title });
    return { success: true, recordId, title };
  } catch (err) {
    console.error(`[接单确认] 处理失败:`, err.message);
    return { success: false, reason: err.message };
  }
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
  rebroadcastRecord,
  reconcileBroadcasts,
  getAllTickets,
  getPendingTickets,
  getTicketStats,
  getBroadcastHistory,
  collectTargets,
  resolveAssigneeGroups,
};
