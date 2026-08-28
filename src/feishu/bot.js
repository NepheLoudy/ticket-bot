const config = require('../config');
const { requestAPI } = require('./client');
const { formatFieldValue } = require('../utils/fields');

// ============================================================
// 消息发送：支持两种目标
//   - chat_id：通过飞书 IM API 以应用机器人身份发到群（机器人需在群内）
//   - webhook:URL：通过群自定义机器人 Webhook 发送
// ============================================================

async function sendCardToChat(chatId, cardContent) {
  const res = await requestAPI(
    'POST',
    '/im/v1/messages?receive_id_type=chat_id',
    {
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(cardContent),
    }
  );

  if (res.code !== 0) {
    throw new Error(`发送群卡片消息失败: ${res.msg} (code: ${res.code})`);
  }

  return res.data;
}

async function sendCardToWebhook(webhookUrl, cardContent) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msg_type: 'interactive',
      card: cardContent,
    }),
  });

  const data = await res.json();
  if (data.code !== 0 && data.StatusCode !== 0) {
    throw new Error(`发送 Webhook 消息失败: ${JSON.stringify(data)}`);
  }

  return data;
}

async function sendTextToChat(chatId, text) {
  const res = await requestAPI(
    'POST',
    '/im/v1/messages?receive_id_type=chat_id',
    {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }
  );

  if (res.code !== 0) {
    throw new Error(`发送群消息失败: ${res.msg} (code: ${res.code})`);
  }

  return res.data;
}

async function sendTextToUser(openId, text) {
  const res = await requestAPI(
    'POST',
    '/im/v1/messages?receive_id_type=open_id',
    {
      receive_id: openId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }
  );

  if (res.code !== 0) {
    throw new Error(`发送私聊消息失败: ${res.msg} (code: ${res.code})`);
  }

  return res.data;
}

/**
 * 按 target（{chatId, webhookUrl}）发送卡片
 */
async function sendCardToTarget(target, cardContent) {
  if (!target) throw new Error('未指定发送目标');
  if (target.webhookUrl) {
    return sendCardToWebhook(target.webhookUrl, cardContent);
  }
  if (target.chatId) {
    return sendCardToChat(target.chatId, cardContent);
  }
  throw new Error('发送目标缺少 chatId/webhookUrl');
}

function describeTarget(target) {
  if (!target) return '(无)';
  if (target.webhookUrl) return `webhook:${target.webhookUrl.slice(-8)}`;
  return target.chatId;
}

// ============================================================
// 卡片构建
// ============================================================

function buildAtTag(userId) {
  if (!userId) return '';
  return `<at id="${userId}"></at>`;
}

/**
 * 工单标题：TITLE_FIELD 有值则用，否则用「需求」摘要
 */
function getTicketTitle(fields, recordId) {
  const title = config.broadcast.titleField ? formatFieldValue(fields[config.broadcast.titleField]) : '';
  if (title) return title;

  const demand = formatFieldValue(fields['需求'] ?? fields['需求1']);
  if (demand) return demand.length > 30 ? `${demand.slice(0, 30)}…` : demand;

  return `工单 ${recordId.slice(-6)}`;
}

/**
 * 工单内容字段行（按 DISPLAY_FIELDS 顺序展示；长文本截断）
 */
function buildTicketFieldLines(fields, exclude = []) {
  const excludeSet = new Set(exclude);
  const names = config.getDisplayFieldNames().filter(n => !excludeSet.has(n));

  const lines = [];
  for (const name of names) {
    let text = formatFieldValue(fields[name]);
    if (!text) continue;
    if (text.length > 200) text = `${text.slice(0, 200)}…`;
    lines.push(`**${name}**: ${text}`);
  }
  // 最多展示 15 行，避免卡片过长
  return lines.slice(0, 15);
}

/**
 * 未指定负责人：面向组别的群聊里发布「询问是否有人接单」的公布消息
 * 包含接单确认提醒：@机器人确认接单
 */
function buildTicketOpenCard(record) {
  const { record_id, fields } = record;
  const title = getTicketTitle(fields, record_id);

  const elements = [
    { tag: 'markdown', content: `**${title}**` },
    { tag: 'hr' },
    ...buildTicketFieldLines(fields, [config.broadcast.titleField]),
    { tag: 'hr' },
    { tag: 'markdown', content: '🙋 此工单暂未指定负责人，**有兴趣接单的同学请在群内响应**' },
    { tag: 'markdown', content: '💡 **接单方式**：在群内发送消息 **@机器人** 即可确认接单' },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '机器人会自动更新项目状态为"进行中"' }] },
  ];

  return {
    config: { wide_screen_mode: true, enable_forward: true },
    elements,
    header: {
      template: 'orange',
      title: { content: '🆕 新工单待接单', tag: 'plain_text' },
    },
  };
}

/**
 * 已指定负责人：在其所属组别的群聊中 @本人 提醒有工单发布
 * @param {object} record 源表记录
 * @param {{id: string, name: string}|null} assignee 指定负责人
 */
function buildTicketAssignCard(record, assignee) {
  const { record_id, fields } = record;
  const title = getTicketTitle(fields, record_id);
  const at = buildAtTag(assignee?.id);

  const elements = [
    { tag: 'markdown', content: `**${title}**` },
    { tag: 'hr' },
    { tag: 'markdown', content: `📬 ${at} **${assignee?.name || ''}** 有新工单发布，请及时跟进` },
    ...buildTicketFieldLines(fields, [config.broadcast.titleField]),
  ];

  return {
    config: { wide_screen_mode: true, enable_forward: true },
    elements,
    header: {
      template: 'blue',
      title: { content: '📬 新工单提醒', tag: 'plain_text' },
    },
  };
}

/**
 * 每日汇总卡片
 * @param {object} stats { total, statusCount: {状态: 数量} }
 * @param {Array} pendingList 待处理工单记录
 */
function buildDailySummaryCard(stats, pendingList) {
  const date = new Date().toLocaleDateString('zh-CN');

  const statusLines = Object.entries(stats.statusCount)
    .map(([status, count]) => `- ${status || '(未填写)'}: ${count} 条`)
    .join('\n');

  const elements = [
    { tag: 'markdown', content: `**📊 工单每日汇总**\n${date}` },
    { tag: 'hr' },
    { tag: 'markdown', content: `**工单总数**: ${stats.total} 条` },
  ];

  if (statusLines) {
    elements.push({ tag: 'markdown', content: `**状态分布**\n${statusLines}` });
  }

  if (pendingList && pendingList.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: `**⏳ 待处理工单（${pendingList.length}条）**`,
    });
    const lines = pendingList.slice(0, 10).map((item, index) => {
      const title = getTicketTitle(item.fields, item.record_id);
      return `${index + 1}. ${title}`;
    });
    elements.push({ tag: 'markdown', content: lines.join('\n') });
  }

  return {
    config: { wide_screen_mode: true, enable_forward: true },
    elements,
    header: {
      template: (pendingList?.length || 0) > 0 ? 'orange' : 'green',
      title: { content: '📋 工单播报', tag: 'plain_text' },
    },
  };
}

/**
 * 超时重问询卡片（无指定负责人时，强调还没人接单，@组长）
 * @param {object} record 工单记录
 * @param {number} elapsedHours 超时小时数
 * @param {string} groupName 组别名称（用于查找组长）
 */
function buildReannounceCard(record, elapsedHours, groupName) {
  const { record_id, fields } = record;
  const title = getTicketTitle(fields, record_id);

  // 查找组长
  const leaderId = config.groupLeaders?.get(groupName);
  const atLeader = leaderId ? buildAtTag(leaderId) : '';

  const elements = [
    { tag: 'markdown', content: `**${title}**` },
    { tag: 'hr' },
    { tag: 'markdown', content: `⚠️ **此工单已超时 ${elapsedHours} 小时，目前仍无人接单**` },
    { tag: 'markdown', content: '🚨 **紧急提醒**：请组内成员尽快响应！' },
    ...buildTicketFieldLines(fields, [config.broadcast.titleField]),
    { tag: 'hr' },
    { tag: 'markdown', content: '🙋 **有兴趣接单的同学请在群内响应**' },
    { tag: 'markdown', content: '💡 **接单方式**：在群内发送消息 **@机器人** 即可确认接单' },
  ];

  // @组长
  if (atLeader) {
    elements.push({ tag: 'markdown', content: `📢 ${atLeader} 请关注此工单进度` });
  }

  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: '机器人会自动更新项目状态为"进行中"' }],
  });

  return {
    config: { wide_screen_mode: true, enable_forward: true },
    elements,
    header: {
      template: 'red',
      title: { content: '🚨 超时工单待接单', tag: 'plain_text' },
    },
  };
}

module.exports = {
  sendCardToChat,
  sendCardToWebhook,
  sendCardToTarget,
  sendTextToChat,
  sendTextToUser,
  describeTarget,
  buildTicketOpenCard,
  buildTicketAssignCard,
  buildDailySummaryCard,
  buildReannounceCard,
};
