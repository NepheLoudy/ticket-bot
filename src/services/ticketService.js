const config = require('../config');
const bitableApi = require('../feishu/bitable');
const syncService = require('./syncService');
const {
  sendCardToTarget,
  describeTarget,
  buildTicketOpenCard,
  buildTicketAssignCard,
} = require('../feishu/bot');
const { formatFieldValue } = require('../utils/fields');

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

// 工单生效状态：申请状态变为该值时触发播报（对应项目看板 in_progress）
const ACTIVATION_STATUS = '审批中';

// 待接单工单映射：chat_id → [{ recordId, sourceRecordId, title }]
// 用于接单确认时查找对应工单
const pendingOrdersByChat = new Map();

// ============================================================
// 人员所属组别查询（带缓存）
// ============================================================
const userDeptCache = new Map();
const deptNameCache = new Map();

function pushHistory(entry) {
  broadcastHistory.unshift({ time: new Date().toISOString(), ...entry });
  if (broadcastHistory.length > 50) broadcastHistory.length = 50;
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
 * 通过飞书通讯录查询人员的部门名称
 */
async function getUserGroupsFromContact(openId) {
  if (!openId) return [];
  if (userDeptCache.has(openId)) return userDeptCache.get(openId);

  try {
    const { requestAPI } = require('../feishu/client');
    const u = await requestAPI(
      'GET',
      `/contact/v3/users/${openId}?user_id_type=open_id&department_id_type=department_id`
    );
    if (u.code !== 0) throw new Error(`${u.msg} (code: ${u.code})`);

    const deptIds = u.data?.user?.department_ids || [];
    const groupNames = [];
    for (const deptId of deptIds) {
      let deptName = deptNameCache.get(deptId);
      if (deptName === undefined) {
        const d = await requestAPI('GET', `/contact/v3/departments/${deptId}?department_id_type=department_id`);
        if (d.code !== 0) throw new Error(`${d.msg} (code: ${d.code})`);
        deptName = d.data?.department?.name || '';
        deptNameCache.set(deptId, deptName);
      }
      if (deptName) groupNames.push(deptName);
    }

    userDeptCache.set(openId, groupNames);
    return groupNames;
  } catch (err) {
    console.warn(`[工单事件] 通过通讯录查询人员组别失败: ${err.message}`);
    userDeptCache.set(openId, []);
    return [];
  }
}

/**
 * 查询指定负责人所属组别
 */
async function resolveAssigneeGroups(record, assignee) {
  const groups = [];

  // 1. USER_GROUPS 手动映射
  if (assignee) {
    for (const key of [assignee.id, assignee.name]) {
      if (key && config.assign.userGroups.has(key)) {
        groups.push(config.assign.userGroups.get(key));
        break;
      }
    }
  }

  // 2. 飞书通讯录部门
  if (groups.length === 0 && assignee?.id) {
    const contactGroups = await getUserGroupsFromContact(assignee.id);
    groups.push(...contactGroups);
  }

  // 3. 兜底：工单的「面向组别」
  if (groups.length === 0 && config.broadcast.routeField) {
    const routeValue = record.fields[config.broadcast.routeField];
    if (Array.isArray(routeValue)) groups.push(...routeValue.map(String));
    else if (routeValue) groups.push(String(routeValue));
  }

  return groups;
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

  // 2. 申请状态为「审批中」时播报
  let broadcastResult = { broadcast: 0 };
  if (config.broadcast.on.includes('create')) {
    const statusField = config.broadcast.statusField;
    const status = statusField ? record.fields[statusField] : '';
    if (status === ACTIVATION_STATUS) {
      broadcastResult = await broadcastTicket(record, 'create');
    } else {
      console.log(`[工单事件] 创建时申请状态为「${status}」，暂不播报（等待进入「审批中」）`);
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
  }
  pushHistory({ type: scene, recordId, assignValue, targets: results });

  console.log(`[工单事件] ${scene} 播报完成: ${results.filter((r) => r.success).length}/${results.length} 个群`);
  return { broadcast: results.filter((r) => r.success).length };
}

/**
 * 处理工单更新事件：category 门控搬运 + 申请状态进入「审批中」时播报
 */
async function handleRecordUpdate(recordId, fields, oldFields) {
  const record = await loadRecord(recordId, fields);
  console.log(`[工单事件] 工单更新: ${recordId}`);

  // 1. category 有值时搬运到项目看板（同步映射字段，含 status）
  const syncResult = await syncIfCategoryPresent(record, 'update');

  // 2. 申请状态为「审批中」时触发播报（去重保证只播一次）
  if (config.broadcast.on.includes('create')) {
    const statusField = config.broadcast.statusField;
    const status = statusField ? record.fields[statusField] : '';
    if (status === ACTIVATION_STATUS) {
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
  console.log(`[接单确认] 收到消息: ${userName}(${userId}) 在群 ${chatId}: ${message}`);

  // 查找该群的待接单工单
  const chatKey = chatId;
  const pendingList = pendingOrdersByChat.get(chatKey) || [];
  if (pendingList.length === 0) {
    console.log(`[接单确认] 该群无待接单工单`);
    return { success: false, reason: '无待接单工单' };
  }

  // 取最新的待接单工单
  const latest = pendingList[pendingList.length - 1];
  const { recordId, sourceRecordId, title } = latest;

  console.log(`[接单确认] 匹配到工单: ${title} (${recordId})`);

  try {
    // 1. 更新项目状态为 waiting（接单确认）
    await syncService.updateProjectStatus(sourceRecordId, 'waiting');
    console.log(`[接单确认] 项目状态更新为 waiting`);

    // 2. 更新项目状态为 in_progress（开始执行）
    await syncService.updateProjectStatus(sourceRecordId, 'in_progress');
    console.log(`[接单确认] 项目状态更新为 in_progress`);

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
  const title = config.broadcast.titleField ? formatFieldValue(fields[config.broadcast.titleField]) : '';
  if (title) return title;

  const demand = formatFieldValue(fields['需求'] ?? fields['需求1']);
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
  getAllTickets,
  getPendingTickets,
  getTicketStats,
  getBroadcastHistory,
  collectTargets,
  resolveAssigneeGroups,
};
