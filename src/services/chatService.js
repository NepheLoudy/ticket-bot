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
 * 私聊指令白名单：sender open_id 与 p2p chat_id 任一命中即可
 */
function isP2pCommandAllowed(senderId, chatId) {
  const allow = config.p2pCommandAllow;
  return (
    (!!senderId && allow.openIds.includes(senderId)) ||
    (!!chatId && allow.chatIds.includes(chatId))
  );
}

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

// 消息去重（网关重启窗口内飞书可能重复投递同一事件；@触发对话与接单回执由网关独占路由分立，
// 本服务只处理工单域消息，此处兜底防同一条消息触发两次接单/回执）
const processedMessages = new Map(); // message_id -> timestamp
const MSG_DEDUP_TTL = 5 * 60 * 1000;

function pruneProcessedMessages() {
  const now = Date.now();
  for (const [key, ts] of processedMessages) {
    if (now - ts > MSG_DEDUP_TTL) processedMessages.delete(key);
  }
}

/**
 * 严格判断 @ 的是本项目机器人（对话型本体），避免把 @ 其它机器人含「接单」的消息当接单
 * （网关的 mention 判定较宽，这里是本服务的二次校验）。
 * name 比对只作兜底：共用应用下机器人在群里的实际显示名可能与配置名不一致
 * （与 pm-robot 同套放宽规则），mentioned_type=app/bot 即认定 @ 的是本应用机器人
 */
function isSelfMention(data) {
  const mentions = data?.message?.mentions || [];
  return mentions.some((m) => {
    if (!m) return false;
    if (m.mentioned_type === 'app' || m.id === 'self') return true;
    if (m.mentioned_type === 'bot') return true;
    return m.name === config.bot.name;
  });
}

/**
 * 接单确认文本匹配：
 * - 网关按「含接单且 @机器人 / p2p 含接单」宽口径路由，本服务只认去空白后
 *   全等的「接单 / 确认接单」及带排队序号的「接单N / 确认接单N」，避免
 *   「还没人接单吗」「我不想接单」这类消息被误当成接单确认
 *   （误触发会写补充负责人、推进状态并自动通过审批）；
 *   序号词用于同群多张待接单工单的区分（见 ticketService 接单排队）
 */
function isAcceptRelatedText(text) {
  return (text || '').replace(/\s+/g, '').includes('接单');
}

function isExactAcceptText(text) {
  return /^(?:确认接单|接单)\d*$/.test((text || '').replace(/\s+/g, ''));
}

/**
 * 处理收到的聊天消息事件（网关转发的 im.message.receive_v1）
 * 两条路径：接单确认（@对话型 + 「接单」）与 /ticket-* 指令
 */
async function processChatMessage(data) {
  const message = data?.message;
  if (!message) return;

  pruneProcessedMessages();
  const messageId = message.message_id;
  if (messageId && processedMessages.has(messageId)) {
    console.log(`[聊天服务] 重复消息跳过: ${messageId}`);
    return;
  }
  if (messageId) processedMessages.set(messageId, Date.now());

  const text = extractText(data);
  const chatId = message.chat_id;
  const userId = data?.sender?.sender_id?.open_id;
  const userName = data?.sender?.sender_id?.name || '';
  const chatType = message.chat_type || message.chatMode || '';

  // 忽略群（如审批群）不参与接单与指令处理，避免抢走其专属对话能力
  if (chatId && config.ignoreChatIds.includes(chatId)) {
    console.log(`[聊天服务] 跳过被忽略群的消息: ${chatId}`);
    return;
  }

  // 接单确认：群内 @对话型机器人 发送「接单」（网关把含「接单」且 @机器人 的消息秒级路由到本项目）
  if (chatType === 'group' && isAcceptRelatedText(text) && isSelfMention(data)) {
    // 无单群不监听（2026-09-13 口径）：该群当前没有可接单工单时静默忽略——
    // 非工单群里聊到「接单」不再收到「无待接单工单」/使用提示等噪音回复；
    // 指定负责人的 p2p 私聊确认链路不受影响
    if (!(await ticketService.hasPendingAcceptInGroup(chatId))) {
      console.log(`[聊天服务] 群 ${chatId} 当前无可接单工单，接单类消息静默忽略: ${userName || userId}`);
      return;
    }
    if (!isExactAcceptText(text)) {
      console.log(`[聊天服务] 含「接单」但非精确指令，提示后忽略: ${userName || userId} 在群 ${chatId}`);
      await sendTextToChat(chatId, '💡 接单确认请单独发送「接单」（群内有多张待接单工单时，按各工单卡片提示发送「接单1」「接单2」…指定要接的单），刚才的消息不会触发接单');
      return;
    }
    console.log(`[聊天服务] 收到接单确认: ${userName || userId} 在群 ${chatId}`);
    const result = await ticketService.handleAcceptOrder(chatId, userId, userName, text);
    if (!result?.success && result?.reason) {
      await sendTextToChat(chatId, `⚠️ ${result.reason}`);
    }
    return;
  }

  // 指定负责人的私聊确认：负责人在 24h 追问私信中回复「接单」（网关按 p2p+接单 路由到本服务）
  if (chatType !== 'group' && !text.startsWith('/') && isAcceptRelatedText(text)) {
    if (!isExactAcceptText(text)) {
      console.log(`[聊天服务] 私聊含「接单」但非精确指令，提示后忽略: ${userName || userId}`);
      await sendTextToUser(userId, '💡 如需确认接单，请直接回复「接单」，刚才的消息不会触发确认');
      return;
    }
    console.log(`[聊天服务] 收到私聊接单确认: ${userName || userId}`);
    const result = await ticketService.handleAssigneeDmConfirm(userId, userName);
    if (result?.success) {
      await sendTextToUser(userId, `✅ 已确认接单：${result.title}`);
    } else if (result?.reason === 'no-pending') {
      await sendTextToUser(userId, '当前没有待你确认的指定负责人工单；如需接单请到对应工单群 @机器人 按工单卡片提示发送「接单N」（仅一张待接时发「接单」）');
    } else {
      await sendTextToUser(userId, `⚠️ 确认未完成：${result?.reason || '未知原因'}`);
    }
    return;
  }

  if (!text) return;

  const [cmd] = text.split(/\s+/);
  const handler = COMMANDS[cmd];
  if (!handler) return;

  // 指令仅群内触发并回复到对应群；私聊指令仅白名单账号/会话可用（与 hub 同套规则）
  if (chatType !== 'group' && !isP2pCommandAllowed(userId, chatId)) {
    console.log(`[聊天服务] 拒绝私聊指令 ${cmd} - sender: ${userId || '未知'} chat_id: ${chatId}`);
    if (chatId) {
      await sendTextToChat(chatId, '⚠️ 工单指令仅支持在群聊中使用，私聊指令暂未开放');
    } else if (userId) {
      await sendTextToUser(userId, '⚠️ 工单指令仅支持在群聊中使用，私聊指令暂未开放');
    }
    return;
  }

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
  isSelfMention,
};
