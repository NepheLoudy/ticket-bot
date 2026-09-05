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

// 播报历史（内存，供 API 查询）
const broadcastHistory = [];

// 已播报的工单 recordId（跨创建/发布事件去重，避免同一工单重复播报）
const broadcastedRecords = new Set();

// 播报触发节点：审批节点命中任一值时触发播报
//   - 群内有组员接单后通过：未指定负责人工单的审批节点
//   - 负责人确认消息后通过：指定负责人工单的审批节点
const ACTIVATION_NODE_VALUES = new Set(config.approvalNode.acceptValues);

function isActivationNode(node) {
  return node !== null && node !== undefined && node !== '' && ACTIVATION_NODE_VALUES.has(String(node));
}

// 指定负责人工单的触发节点（「公示即绑定」只作用于该节点）
function isAssignAcceptNode(node) {
  return node !== null && node !== undefined && String(node) === config.approvalNode.assignAcceptValue;
}

// 待接单工单映射：chat_id → [{ recordId, sourceRecordId, title, expectedAssigneeId }]
// 用于接单确认时查找对应工单；expectedAssigneeId 非空表示该工单仅限指定负责人本人确认
const pendingOrdersByChat = new Map();

/**
 * 登记待接单工单（播报成功的群各记一条，供接单确认匹配）
 * @param {Array<{chatId: string, webhookUrl: string}>} targets 播报目标
 * @param {string} recordId 源表记录 ID
 * @param {string} title 工单标题
 * @param {string|null} expectedAssigneeId 指定负责人 open_id（无指定负责人时为 null）
 */
function registerPendingOrders(targets, recordId, title, expectedAssigneeId = null) {
  for (const target of targets) {
    const chatKey = target.chatId || target.webhookUrl;
    if (!chatKey) continue;
    if (!pendingOrdersByChat.has(chatKey)) {
      pendingOrdersByChat.set(chatKey, []);
    }
    pendingOrdersByChat.get(chatKey).push({
      recordId,
      sourceRecordId: recordId,
      title,
      expectedAssigneeId,
      time: Date.now(),
    });
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
  if (config.broadcast.on.includes('create')) {
    const nodeField = config.approvalNode.field;
    const node = nodeField ? record.fields[nodeField] : '';
    if (isActivationNode(node)) {
      broadcastResult = await broadcastTicket(record, 'create');
    } else {
      console.log(`[工单事件] 创建时审批节点为「${node}」，暂不播报（等待进入「${[...ACTIVATION_NODE_VALUES].join('」/「')}」）`);
    }
  }

  return { ...broadcastResult, sync: syncResult };
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

    // 记录待接单工单（任一组员可确认）
    registerPendingOrders(targets, recordId, getTicketTitle(f, recordId));
  } else if (assignValue === config.assign.yesValue) {
    // 已指定负责人 → 查询其所属组别，在对应群聊 @本人 公示
    const assignee = config.assign.assigneeField ? (f[config.assign.assigneeField]?.[0] || null) : null;
    const groupNames = await resolveAssigneeGroups(record, assignee);
    targets = collectTargets(groupNames);
    card = buildTicketAssignCard(record, assignee);

    // 记录待接单工单（仅限指定负责人本人 @机器人 确认，确认后代理通过「负责人确认消息后通过」节点）
    registerPendingOrders(targets, recordId, getTicketTitle(f, recordId), assignee?.id || null);
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
  let bindResult = null;
  if (results.some((r) => r.success)) {
    broadcastedRecords.add(recordId);
    await markBroadcast(recordId, scene);

    // 指定负责人工单「公示即绑定」：写补充负责人 + 看板人员字段（幂等）
    // 状态推进与「负责人确认消息后通过」审批仍由本人 @机器人 接单确认触发
    if (assignValue === config.assign.yesValue) {
      bindResult = await bindAssignedTicket(record, scene);
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

  console.log(`[对账] 扫描 ${all.length} 条，补播 ${broadcast}，补搬运 ${synced}，补绑定 ${bound}，跳过 ${skipped}`);
  pushHistory({ type: 'reconcile', checked: all.length, broadcast, synced, bound, skipped });

  return { checked: all.length, broadcast, synced, bound, skipped };
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
  if (config.broadcast.on.includes('create')) {
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

  // 查找该群的待接单工单（查到即挂回映射，回退匹配结果对后续消息持久生效）
  const chatKey = chatId;
  let pendingList = pendingOrdersByChat.get(chatKey);
  if (!pendingList) {
    pendingList = [];
    pendingOrdersByChat.set(chatKey, pendingList);
  }

  if (pendingList.length === 0) {
    // 内存映射重启后清空：回退查询源表——触发节点/回执单节点 + 补充负责人为空 + 面向组别匹配该群的最新工单
    // 注意一个群可承载多个组别（如电控/硬件共群），必须收集该 chatId 对应的全部组别，
    // 只取第一个会导致第二组别的工单匹配不到、接单误判"无待接单工单"
    const groupsOfChat = config.broadcast.routes
      .filter((r) => r.chatId === chatId)
      .map((r) => r.value)
      .filter(Boolean);
    if (groupsOfChat.length > 0) {
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
            if (sup && sup.length > 0) {
              // 指定即绑定：补充负责人 == 指定负责人 视为「已绑定未确认」，仍可由本人确认
              const assignee = config.assign.assigneeField ? (f[config.assign.assigneeField]?.[0] || null) : null;
              if (!(assignee?.id && sup.length === 1 && sup[0]?.id === assignee.id)) return false;
            }
            return true;
          })
          .sort((a, b) => ((b.fields['发起时间'] || 0)) - ((a.fields['发起时间'] || 0)));

        // 首选：面向组别覆盖该群的工单（一个群可承载多个组别，如电控/硬件共群）
        let matched = candidates.find((r) => {
          const groups = r.fields[config.broadcast.routeField];
          const groupList = Array.isArray(groups) ? groups.map(String) : groups ? [String(groups)] : [];
          return groupList.some((g) => groupsOfChat.includes(g));
        });

        // 补充：指定负责人工单的播报群来自「负责人组别解析」（USER_GROUPS → 通讯录），
        // 可能不在工单「面向组别」里——按负责人所属组别与该群组别求交集匹配
        if (!matched) {
          for (const r of candidates) {
            const assignee = config.assign.assigneeField ? (r.fields[config.assign.assigneeField]?.[0] || null) : null;
            if (!assignee?.id) continue;
            const routeGroups = config.broadcast.routeField ? r.fields[config.broadcast.routeField] : null;
            const groups = await resolvePersonGroups(routeGroups, assignee);
            if (groups.some((g) => groupsOfChat.includes(g))) {
              matched = r;
              break;
            }
          }
        }

        const latest = matched;
        if (latest) {
          const assigneeId = config.assign.assigneeField
            ? (latest.fields[config.assign.assigneeField]?.[0]?.id || null)
            : null;
          pendingList.push({
            recordId: latest.record_id,
            sourceRecordId: latest.record_id,
            title: getTicketTitle(latest.fields, latest.record_id),
            expectedAssigneeId: assigneeId,
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

  // 取最新的待接单工单：指定负责人工单仅匹配本人（expectedAssigneeId 非空且不是发送者时跳过）
  let latestIdx = -1;
  for (let i = pendingList.length - 1; i >= 0; i--) {
    const expected = pendingList[i].expectedAssigneeId;
    if (!expected || expected === userId) {
      latestIdx = i;
      break;
    }
  }
  if (latestIdx === -1) {
    console.log(`[接单确认] 该群待接单工单均为指定其他负责人，拒绝 ${userName || userId} 确认`);
    return { success: false, reason: '待接单工单已指定其他负责人，仅限本人确认' };
  }
  const latest = pendingList[latestIdx];
  const { recordId, sourceRecordId, title } = latest;

  console.log(`[接单确认] 匹配到工单: ${title} (${recordId})`);

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
    const role = isAssignTicket ? '负责人' : '组员';

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

    // 3. 从待接单列表中移除
    pendingList.splice(latestIdx, 1);
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

    // 5. 审批联动：自动通过对应触发节点（未指定负责人→「群内有组员接单后通过」；
    //    指定负责人→「负责人确认消息后通过」，仅本人确认会走到这里；尽力而为，不影响接单结果）
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
    .sort((a, b) => ((b.fields['发起时间'] || 0)) - ((a.fields['发起时间'] || 0)));

  const latest = candidates[0];
  if (!latest) return { success: false, reason: 'no-pending' };

  const assignee = latest.fields[config.assign.assigneeField]?.[0] || null;
  const routeGroups = config.broadcast.routeField ? latest.fields[config.broadcast.routeField] : null;
  const groupNames = await resolvePersonGroups(routeGroups, assignee);
  const chatId = collectTargets(groupNames).find((t) => t.chatId)?.chatId;
  if (!chatId) return { success: false, reason: '未找到工单公示群，请在对应工单群 @机器人 发送「接单」' };

  registerPendingOrders([{ chatId }], latest.record_id, getTicketTitle(latest.fields, latest.record_id), userId);
  console.log(`[接单确认] 私聊确认命中工单: ${latest.record_id} → 公示群 ${chatId}`);
  return handleAcceptOrder(chatId, userId, userName, '接单');
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
  handleAssigneeDmConfirm,
  rebroadcastRecord,
  reconcileBroadcasts,
  getAllTickets,
  getPendingTickets,
  getTicketStats,
  getBroadcastHistory,
  collectTargets,
  resolveAssigneeGroups,
};
