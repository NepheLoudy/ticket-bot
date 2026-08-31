const config = require('../config');
const ticketService = require('./ticketService');
const syncService = require('./syncService');
const { sendTextToChat, sendTextToUser } = require('../feishu/bot');
const { formatFieldValue } = require('../utils/fields');

const COMMANDS = {
  '/ticket-help': showHelp,
  '/ticket-list': showList,
  '/ticket-pending': showPending,
  '/ticket-status': showStatus,
  '/ticket-sync': syncAllTickets,
};

/**
 * 从消息事件中提取纯文本指令，去掉 @机器人 占位符
 */
function extractText(data) {
  const message = data?.message || {};
  if (message.message_type !== 'text') return '';

  let text = '';
  try {
    const content = typeof message.content === 'string'
      ? JSON.parse(message.content)
      : message.content;
    text = content?.text || '';
  } catch (e) {
    return '';
  }

  // 去掉 @_user_1 这类 @机器人 占位符
  return text.replace(/@_user_\d+/g, '').trim();
}

/**
 * 检测消息是否 @机器人
 */
function isMentionBot(data) {
  const message = data?.message || {};
  const mentions = message.mentions || [];

  // 检查 mentions 字段
  for (const mention of mentions) {
    if (mention?.id?.open_id === config.feishu.appId || mention?.key === 'all') {
      return true;
    }
  }

  // 检查消息内容中的 @_user_ 占位符
  try {
    const content = typeof message.content === 'string'
      ? JSON.parse(message.content)
      : message.content;
    const text = content?.text || '';
    if (/@_user_\d+/.test(text)) {
      return true;
    }
  } catch (e) {
    // ignore
  }

  return false;
}

/**
 * 处理收到的聊天消息事件（长连接 / HTTP 回调通用）
 */
async function processChatMessage(data) {
  const message = data?.message;
  if (!message) return;

  const text = extractText(data);
  const chatId = message.chat_id;
  const userId = data?.sender?.sender_id?.open_id;
  const userName = data?.sender?.sender_id?.name || '';

  // 忽略群（如审批群）不参与接单与指令处理，避免抢走其专属对话能力
  if (chatId && config.ignoreChatIds.includes(chatId)) {
    console.log(`[聊天服务] 跳过被忽略群的消息: ${chatId}`);
    return;
  }

  // 检测是否 @机器人（接单确认）
  if (isMentionBot(data)) {
    console.log(`[聊天服务] 检测到 @机器人: ${userName}(${userId}) 在群 ${chatId}`);
    const result = await ticketService.handleAcceptOrder(chatId, userId, userName, text);
    if (result.success) {
      // 接单确认成功，不再处理其他指令
      return;
    }
    // 接单确认失败，继续处理其他逻辑
  }

  if (!text) return;

  const [cmd] = text.split(/\s+/);
  const handler = COMMANDS[cmd];
  if (!handler) return;

  let replyText;
  try {
    replyText = await handler();
  } catch (err) {
    replyText = `❌ 指令执行失败: ${err.message}`;
  }

  // 优先回群聊，其次私聊
  if (chatId) {
    await sendTextToChat(chatId, replyText);
  } else {
    if (userId) await sendTextToUser(userId, replyText);
  }
}

function ticketBrief(item, index) {
  const title = config.broadcast.titleField
    ? formatFieldValue(item.fields[config.broadcast.titleField]) || '未命名'
    : '未命名';
  const status = config.broadcast.statusField
    ? formatFieldValue(item.fields[config.broadcast.statusField])
    : '';
  const route = config.broadcast.routeField
    ? formatFieldValue(item.fields[config.broadcast.routeField])
    : '';
  const parts = [`${index + 1}. ${title}`];
  if (route) parts.push(`[${route}]`);
  if (status) parts.push(`(${status})`);
  return parts.join(' ');
}

async function showHelp() {
  return [
    `📋 ${config.bot.name}指令:`,
    '/ticket-help - 显示本帮助',
    '/ticket-list - 查看全部工单',
    '/ticket-pending - 查看待处理工单',
    '/ticket-status - 查看工单统计',
    '/ticket-sync - 手动全量同步到目标表',
  ].join('\n');
}

async function showList() {
  const list = await ticketService.getAllTickets();
  if (!list.length) return '暂无工单记录';

  const lines = list.slice(0, 30).map((item, i) => ticketBrief(item, i));
  const more = list.length > 30 ? `\n... 共 ${list.length} 条` : '';
  return ['📋 全部工单:', ...lines, more].filter(Boolean).join('\n');
}

async function showPending() {
  if (!config.broadcast.pendingStatus) {
    return '未配置 PENDING_STATUS，无法查询待处理工单';
  }

  const list = await ticketService.getPendingTickets();
  if (!list.length) return `✅ 暂无「${config.broadcast.pendingStatus}」的工单`;

  const lines = list.slice(0, 30).map((item, i) => ticketBrief(item, i));
  const more = list.length > 30 ? `\n... 共 ${list.length} 条` : '';
  return [`⏳ 待处理工单:`, ...lines, more].filter(Boolean).join('\n');
}

async function showStatus() {
  const { total, statusCount } = await ticketService.getTicketStats();
  const lines = Object.entries(statusCount).map(([status, count]) => `- ${status || '(未填写)'}: ${count} 条`);
  return ['📊 工单统计:', `总计: ${total} 条`, ...lines].join('\n');
}

async function syncAllTickets() {
  const result = await syncService.syncAll();
  const errors = result.failed > 0 ? `\n失败明细: ${result.errors.map(e => `${e.recordId}: ${e.message}`).join('; ')}` : '';
  return [
    '🔄 全量同步完成:',
    `总计: ${result.total} 条`,
    `匹配: ${result.matched} 条`,
    `新建: ${result.created} 条`,
    `更新: ${result.updated} 条`,
    `失败: ${result.failed} 条${errors}`,
  ].join('\n');
}

module.exports = {
  processChatMessage,
};
