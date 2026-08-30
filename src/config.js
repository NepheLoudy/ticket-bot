const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

/**
 * 解析 "源字段:目标字段,源字段2:目标字段2" 为映射对象
 */
function parseMapConfig(value) {
  if (!value) return {};
  const map = {};
  for (const pair of value.split(',')) {
    const p = pair.trim();
    if (!p) continue;
    const idx = p.indexOf(':');
    if (idx <= 0) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (k && v) map[k] = v;
  }
  return map;
}

/**
 * 解析路由目标 "值=chat_id|webhook_url"（逗号分隔）
 * 新格式：组别名=chat_id|webhook_url（chat_id 用于 @人，webhook_url 用于发消息）
 * @returns {Array<{value: string, chatId: string, webhookUrl: string}>}
 */
function parseRouteTargets(value) {
  if (!value) return [];
  const targets = [];
  for (const item of value.split(',')) {
    const p = item.trim();
    if (!p) continue;
    const idx = p.indexOf('=');
    if (idx <= 0) continue;
    const val = p.slice(0, idx).trim();
    const target = p.slice(idx + 1).trim();
    if (!val || !target) continue;

    // 新格式：chat_id|webhook_url
    const pipeIdx = target.indexOf('|');
    if (pipeIdx > 0) {
      const chatId = target.slice(0, pipeIdx).trim();
      const webhookUrl = target.slice(pipeIdx + 1).trim();
      targets.push({ value: val, chatId, webhookUrl });
    } else if (target.startsWith('webhook:')) {
      // 兼容旧格式：webhook:URL
      targets.push({ value: val, chatId: '', webhookUrl: target.slice('webhook:'.length).trim() });
    } else {
      // 兼容旧格式：仅 chat_id
      targets.push({ value: val, chatId: target, webhookUrl: '' });
    }
  }
  return targets;
}

/**
 * 解析人员组别映射 "姓名或open_id:组别名,..."（用于「指定负责人」所属组别查询的第一优先级）
 * @returns {Map<string, string>}
 */
function parseUserGroups(value) {
  const map = new Map();
  if (!value) return map;
  for (const item of value.split(',')) {
    const p = item.trim();
    if (!p) continue;
    const idx = p.indexOf(':');
    if (idx <= 0) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (k && v) map.set(k, v);
  }
  return map;
}

/**
 * 解析组长映射 "组别名:组长open_id或姓名,..."
 * @returns {Map<string, string>}
 */
function parseGroupLeaders(value) {
  const map = new Map();
  if (!value) return map;
  for (const item of value.split(',')) {
    const p = item.trim();
    if (!p) continue;
    const idx = p.indexOf(':');
    if (idx <= 0) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (k && v) map.set(k, v);
  }
  return map;
}

function parseListConfig(value) {
  if (!value) return [];
  return value.split(',').map(v => v.trim()).filter(v => v);
}

const fieldMapping = parseMapConfig(process.env.FIELD_MAPPING);
const routeField = process.env.ROUTE_FIELD || '';
const statusField = process.env.STATUS_FIELD || '';

const config = {
  port: process.env.PORT || 3003,

  feishu: {
    appId: process.env.APP_ID || '',
    appSecret: process.env.APP_SECRET || '',
  },

  bitable: {
    // 源表（工单录入表）
    sourceAppToken: process.env.BITABLE_APP_TOKEN || '',
    sourceTableId: process.env.SOURCE_TABLE_ID || '',
    // 目标表（项目看板），app_token 留空则与源表同一个多维表格
    targetAppToken: process.env.TARGET_BITABLE_APP_TOKEN || process.env.BITABLE_APP_TOKEN || '',
    targetTableId: process.env.TARGET_TABLE_ID || '',
  },

  sync: {
    fieldMapping,
    syncKeyField: process.env.SYNC_KEY_FIELD || '源记录ID',
    // 门控字段：仅当该字段有值时才搬运到目标表（如 category）
    categoryField: process.env.CATEGORY_FIELD || '',
  },

  broadcast: {
    // 路由字段（面向组别，多选 → 一条工单并行分发到多个组群）
    routeField,
    routes: parseRouteTargets(process.env.GROUP_ROUTES),
    // 兜底群：chat_id 或 webhook:URL
    defaultTarget: parseRouteTargets(process.env.DEFAULT_CHAT_ID)[0] || null,
    titleField: process.env.TITLE_FIELD || '',
    statusField,
    pendingStatus: process.env.PENDING_STATUS || '',
    // 播报卡片展示字段（留空则使用监听字段集合）
    displayFields: parseListConfig(process.env.DISPLAY_FIELDS),
    watchedFields: parseListConfig(process.env.WATCHED_FIELDS),
    on: parseListConfig(process.env.BROADCAST_ON || 'create'),
    // 播报标记字段（写回源表，跨重启防重播；长连接事件被共用应用的其他连接抢走时由轮询对账兜底）
    markField: process.env.BROADCAST_MARK_FIELD === '' ? '' : (process.env.BROADCAST_MARK_FIELD || '已播报'),
  },

  // 「是否指定人员负责」分支
  assign: {
    field: process.env.ASSIGN_FIELD || '',
    yesValue: process.env.ASSIGN_YES_VALUE || '是',
    noValue: process.env.ASSIGN_NO_VALUE || '否',
    // 指定负责人字段（人员类型）
    assigneeField: process.env.ASSIGNEE_FIELD || '',
    // 接单确认后，将接单人写入源表该字段（人员类型）
    supplementField: process.env.SUPPLEMENT_ASSIGNEE_FIELD || '补充负责人',
    // 人员所属组别映射（姓名或open_id:组别名），优先级最高
    userGroups: parseUserGroups(process.env.USER_GROUPS),
  },

  // 审批节点监听（替代「申请状态」作为播报与超时判断依据）
  approvalNode: {
    field: process.env.APPROVAL_NODE_FIELD || '审批节点',
    // 触发播报 / 6小时未接单判断的节点值（逗号分隔多个，支持不同审批流的节点名）
    acceptValues: parseListConfig(
      process.env.APPROVAL_NODE_ACCEPT_VALUE || '有组员接单后通过,负责人确认消息后通过'
    ),
    // 触发结单提醒的节点值
    closeValue: process.env.APPROVAL_NODE_CLOSE_VALUE || '回执单：是否结单',
  },

  // 结单提醒（临近理想结单时间时，应用机器人先私聊，未结单再转群引导）
  closeReminder: {
    deadlineField: process.env.DEADLINE_FIELD || '理想结单时间',
    leadDays: Number(process.env.CLOSE_REMINDER_LEAD_DAYS || 1),
  },

  // 组长映射（组别名:组长open_id或姓名）
  groupLeaders: parseGroupLeaders(process.env.GROUP_LEADERS),

  feishuEvent: {
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || '',
    encryptKey: process.env.FEISHU_ENCRYPT_KEY || '',
    useLongConnection: process.env.FEISHU_USE_LONG_CONNECTION !== 'false',
  },

  bot: {
    name: process.env.BOT_NAME || '工单机器人',
  },

  cron: {
    schedule: process.env.CRON_SCHEDULE || '',
  },
};

/**
 * 实际被监听的字段集合：显式配置的 WATCHED_FIELDS ∪ 映射源字段 ∪ 状态字段 ∪ 路由字段
 */
function getWatchedFieldNames() {
  const set = new Set(config.broadcast.watchedFields);
  for (const src of Object.keys(config.sync.fieldMapping)) set.add(src);
  if (config.broadcast.statusField) set.add(config.broadcast.statusField);
  if (config.broadcast.routeField) set.add(config.broadcast.routeField);
  return Array.from(set);
}

/**
 * 播报卡片展示字段：优先 DISPLAY_FIELDS，否则回退监听字段集合
 */
function getDisplayFieldNames() {
  return config.broadcast.displayFields.length > 0
    ? config.broadcast.displayFields
    : getWatchedFieldNames();
}

module.exports = {
  ...config,
  getWatchedFieldNames,
  getDisplayFieldNames,
};
