const cron = require('node-cron');
const config = require('../config');
const ticketService = require('../services/ticketService');
const bitableApi = require('../feishu/bitable');
const {
  sendCardToTarget,
  sendTextToUser,
  describeTarget,
  buildDailySummaryCard,
  buildReannounceCard,
} = require('../feishu/bot');
const { formatFieldValue, formatFieldText, getCreatedTime } = require('../utils/fields');
const { getTicketApprovalUrl } = require('../feishu/bot');
const quietHours = require('../utils/quietHours');

// 审批流原生字段名（审批表侧概念，无对应 env 配置；审批表改名需同步这里）
const FIELD_HANDLER = '当前处理人';
const FIELD_INITIATOR = '发起人';

const broadcastHistory = [];

const RETRY_CONFIG = {
  maxAttempts: 3,
  initialDelay: 30 * 1000,
  maxDelay: 5 * 60 * 1000,
};

// 超时检查配置
const TIMEOUT_CONFIG = {
  hours: 6, // 超时阈值：6小时
  checkInterval: '0 * * * *', // 每小时检查一次
};

// ============================================================
// 无人接单升级（超时检查的下辖分支）：同一工单第 2 轮超时提醒起，
// 私聊「面向组别」对应的组长（GROUP_LEADERS），提醒该群工单还没有组员接单。
//   - 轮次 = 超时检查（每小时）实际处理到该工单的次数：第 1 轮走既有分支
//     （私信发起人 / 群内重问询卡），第 2 轮起叠加组长私聊；
//   - 同一工单对组长的私聊间隔不小于 3 小时，避免每小时轰炸；
//   - 轮次/间隔状态在内存：重启清零，代价仅是升级推迟一轮（下个整点重新
//     计为第 1 轮），不涉及写库，故不落表。
// ============================================================
const TIMEOUT_LEADER_NUDGE = {
  startRound: 2,
  intervalMs: 3 * 60 * 60 * 1000,
  stateTtlMs: 48 * 60 * 60 * 1000,
};
const timeoutRoundState = new Map(); // recordId -> { rounds, timestamp }
const leaderNudgeState = new Map(); // recordId -> lastLeaderDmTs

// ============================================================
// 群内重问询节流（超时分支 2.2 专用）：公开问询从「每小时一次」改为
// 「每 6 小时一次、每单封顶 2 次」（≈发起后 6h、12h 各问询一次）。
// 封顶后群内不再重复问询，持续升级由「无人接单升级」的组长私聊承担。
//   - 多人单不受限：有人接单即合并写入补充负责人、天然退出本检查；续接窗口的
//     续接询问（ticketService 接单路径）与到期自动通过（对账路径）不经此处；
//   - 计数在内存：重启清零，代价是封顶计数重新开始（最多多问两轮），不落表。
// ============================================================
const TIMEOUT_REASK = {
  intervalMs: 6 * 60 * 60 * 1000,
  maxCount: 2,
  stateTtlMs: 48 * 60 * 60 * 1000,
};
const reaskState = new Map(); // recordId -> { count, lastTs }

function pruneReaskState() {
  const now = Date.now();
  for (const [key, st] of reaskState) {
    if (now - st.lastTs > TIMEOUT_REASK.stateTtlMs) reaskState.delete(key);
  }
}

/** 本轮是否允许群内问询（未封顶且距上次 ≥6h），只读不写 */
function reaskAllowed(recordId) {
  pruneReaskState();
  const st = reaskState.get(recordId);
  if (st && st.count >= TIMEOUT_REASK.maxCount) return false;
  if (st && st.lastTs && Date.now() - st.lastTs < TIMEOUT_REASK.intervalMs) return false;
  return true;
}

/** 群内问询实际发出（至少一群成功）后占用一次额度 */
function recordReask(recordId) {
  const st = reaskState.get(recordId) || { count: 0, lastTs: 0 };
  reaskState.set(recordId, { count: st.count + 1, lastTs: Date.now() });
}

function pruneStateMap(map, ttl) {
  const now = Date.now();
  for (const [key, value] of map) {
    const ts = typeof value === 'number' ? value : value?.timestamp || 0;
    if (now - ts > ttl) map.delete(key);
  }
}

function bumpTimeoutRound(recordId) {
  pruneStateMap(timeoutRoundState, TIMEOUT_LEADER_NUDGE.stateTtlMs);
  const rounds = (timeoutRoundState.get(recordId)?.rounds || 0) + 1;
  timeoutRoundState.set(recordId, { rounds, timestamp: Date.now() });
  return rounds;
}

/**
 * 组长标识 → open_id：GROUP_LEADERS 的值支持 open_id（ou_ 开头直通）
 * 或 user_id（经通讯录解析后缓存）；解析失败按跳过处理（fail-closed）
 */
const leaderOpenIdCache = new Map(); // 原始标识 -> openId | null

async function resolveLeaderOpenId(raw) {
  if (raw.startsWith('ou_')) return raw;
  if (leaderOpenIdCache.has(raw)) return leaderOpenIdCache.get(raw);
  let openId = null;
  try {
    const { requestAPI } = require('../feishu/client');
    const res = await requestAPI('GET', `/contact/v3/users/${raw}?user_id_type=user_id`);
    if (res.code === 0) openId = res.data?.user?.open_id || null;
  } catch (err) {
    console.warn(`[无人接单升级] 组长标识解析请求失败「${raw}」: ${err.message}`);
  }
  if (!openId) console.warn(`[无人接单升级] 组长标识「${raw}」未解析到 open_id（检查 GROUP_LEADERS 值与通讯录权限）`);
  leaderOpenIdCache.set(raw, openId);
  return openId;
}

/**
 * 私聊工单「面向组别」对应的组长（多组别工单的多个组长各收一条，
 * 同一组长名下多组合并为一条；同一工单对组长间隔不小于 3 小时）
 */
async function nudgeGroupLeaders({ record, title, groups, elapsedHours, round }) {
  pruneStateMap(leaderNudgeState, TIMEOUT_LEADER_NUDGE.stateTtlMs);
  const lastDm = leaderNudgeState.get(record.record_id);
  if (lastDm && Date.now() - lastDm < TIMEOUT_LEADER_NUDGE.intervalMs) return;

  // 面向组别 → GROUP_LEADERS 原始标识（按组长去重合并组名）
  const byLeader = new Map(); // rawId -> 组别名[]
  for (const group of groups || []) {
    const raw = config.groupLeaders?.get(String(group));
    if (raw) {
      if (!byLeader.has(raw)) byLeader.set(raw, []);
      byLeader.get(raw).push(String(group));
    }
  }
  if (byLeader.size === 0) {
    console.log('[无人接单升级] 面向组别未配置组长（GROUP_LEADERS），跳过私聊升级');
    return;
  }

  const approvalUrl = getTicketApprovalUrl(record.fields, record.record_id);
  let sent = 0;
  for (const [raw, groupNames] of byLeader) {
    const openId = await resolveLeaderOpenId(raw);
    if (!openId) continue;
    try {
      await sendTextToUser(
        openId,
        `🚨 工单无人接单提醒（第 ${round} 轮）\n\n` +
        `「${groupNames.join('、')}」的工单「${title}」已发布超过 ${elapsedHours} 小时，仍没有组员接单。\n\n` +
        `请关注组内安排：可由组员在群内 @${config.bot.name} 按工单卡片提示发送「接单N」接单（仅一张待接时发「接单」），或由你本人接单。\n` +
        `工单详情：${approvalUrl}`
      );
      sent++;
      console.log(`[无人接单升级] 已私聊组长（${groupNames.join('、')}）: ${record.record_id} 第 ${round} 轮`);
    } catch (err) {
      console.error(`[无人接单升级] 私聊组长失败（${groupNames.join('、')}） ${record.record_id}:`, err.message);
    }
  }
  if (sent > 0) leaderNudgeState.set(record.record_id, Date.now());
}

function isFrequencyLimitError(err) {
  if (!err) return false;
  const message = err.message || '';
  return message.includes('11232') || message.includes('frequency limited');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 获取每日汇总的播报目标：全部路由群 + 兜底群（去重）
 */
function getSummaryTargets() {
  const seen = new Set();
  const targets = [];
  for (const target of [...config.broadcast.routes, config.broadcast.defaultTarget].filter(Boolean)) {
    const key = target.webhookUrl || target.chatId;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  return targets;
}

/**
 * 执行一次每日汇总播报（发到所有配置的群）
 */
async function runSummary() {
  console.log('[每日汇总] 开始执行工单汇总播报...');

  const { total, statusCount } = await ticketService.getTicketStats();
  let pendingList = [];
  try {
    pendingList = await ticketService.getPendingTickets();
  } catch (err) {
    console.warn('[每日汇总] 获取待处理工单失败:', err.message);
  }

  console.log(`[每日汇总] 统计: 总计=${total} 待处理=${pendingList.length}`);

  const card = buildDailySummaryCard({ total, statusCount }, pendingList);
  const targets = getSummaryTargets();

  if (targets.length === 0) {
    console.log('[每日汇总] 未配置播报目标（GROUP_ROUTES/DEFAULT_CHAT_ID），跳过');
    return { total, pendingCount: pendingList.length, sent: 0 };
  }

  const results = [];
  for (const target of targets) {
    try {
      await sendCardToTarget(target, card);
      results.push({ target: describeTarget(target), success: true });
    } catch (err) {
      console.error(`[每日汇总] 播报到 ${describeTarget(target)} 失败:`, err.message);
      results.push({ target: describeTarget(target), success: false, error: err.message });
    }
  }

  broadcastHistory.unshift({ time: new Date().toISOString(), type: 'daily_summary', total, pendingCount: pendingList.length, targets: results });
  if (broadcastHistory.length > 50) broadcastHistory.length = 50;

  console.log('[每日汇总] 汇总播报完成');
  return { total, pendingCount: pendingList.length, sent: results.filter(r => r.success).length };
}

async function runSummaryWithRetry() {
  let attempt = 0;
  let lastError = null;

  while (attempt < RETRY_CONFIG.maxAttempts) {
    attempt++;
    try {
      return await runSummary();
    } catch (err) {
      lastError = err;
      if (isFrequencyLimitError(err)) {
        const delay = Math.min(RETRY_CONFIG.initialDelay * Math.pow(2, attempt - 1), RETRY_CONFIG.maxDelay);
        console.warn(`[每日汇总] 第 ${attempt} 次尝试失败，频率限制，将在 ${delay / 1000} 秒后重试...`);
        await sleep(delay);
      } else {
        console.error('[每日汇总] 汇总播报失败:', err);
        break;
      }
    }
  }

  broadcastHistory.unshift({
    time: new Date().toISOString(),
    type: 'daily_summary',
    success: false,
    attempts: attempt,
    error: lastError?.message || 'Unknown error',
  });
  if (broadcastHistory.length > 50) broadcastHistory.length = 50;

  throw lastError;
}

/**
 * 超时检查：查找超过 6 小时未接单的工单
 * 条件：
 *   - 审批节点处于任一触发节点（群内有组员接单后通过 / 负责人确认消息后通过）
 *   - 当前处理人 有值
 *   - 距离发起时间超过 6 小时
 */
async function checkTimeoutTickets() {
  console.log('[超时检查] 开始检查超时工单...');

  // 查询审批节点处于任一触发节点的工单（未指定负责人/指定负责人两种审批流）。
  // 全量拉取后本地过滤：节点字段值可能是并行分支多段拼接（「；」分隔），
  // 服务端等值过滤对不上，统一用 config.matchNodeValue 拆段匹配
  const records = (await bitableApi.listAllRecords(
    config.bitable.sourceAppToken,
    config.bitable.sourceTableId
  )).filter((r) => config.matchNodeValue(
    config.approvalNode.field ? r.fields[config.approvalNode.field] : '',
    config.approvalNode.acceptValues
  ));

  console.log(`[超时检查] 找到 ${records.length} 条处于触发节点（${config.approvalNode.acceptValues.join('，')}）的工单`);

  const now = Date.now();
  const timeoutMs = TIMEOUT_CONFIG.hours * 60 * 60 * 1000;
  const timeoutRecords = [];

  for (const record of records) {
    const fields = record.fields;

    // 已有人接单（补充负责人非空）→ 不再超时重问询。
    // 注意：指定负责人工单播报即绑定（补充负责人=指定负责人），绑定成功的天然被跳过，
    // 本检查实际只覆盖「公示后无人响应/绑定失败」的工单
    const supplement = fields[config.assign.supplementField];
    if (supplement && supplement.length > 0) continue;

    // 检查当前处理人是否有值
    const currentHandler = fields[FIELD_HANDLER]?.[0];
    if (!currentHandler || !currentHandler.id) {
      continue;
    }

    // 检查发起时间（发起时间缺失回退创建时间）
    const createTime = getCreatedTime(fields);
    if (!createTime) {
      console.warn(`[超时检查] 工单 ${record.record_id} 缺少发起时间字段，跳过`);
      continue;
    }

    const createTimestamp = new Date(createTime).getTime();
    if (isNaN(createTimestamp)) {
      console.warn(`[超时检查] 工单 ${record.record_id} 发起时间格式错误: ${createTime}`);
      continue;
    }

    // 检查是否超时
    const elapsed = now - createTimestamp;
    if (elapsed < timeoutMs) {
      continue; // 未超时
    }

    timeoutRecords.push({
      record: record,
      currentHandler,
      initiator: fields[FIELD_INITIATOR]?.[0] || null,
      assignValue: config.assign.field ? fields[config.assign.field] : '',
      groups: config.broadcast.routeField ? (fields[config.broadcast.routeField] || []) : [],
      elapsedHours: Math.floor(elapsed / (60 * 60 * 1000)),
      sourceRecords: records, // 本轮触发节点工单全集（接单排队推导复用，免重复拉表）
    });
  }

  console.log(`[超时检查] 发现 ${timeoutRecords.length} 条超时工单`);
  return timeoutRecords;
}

/**
 * 处理超时工单分支
 */
async function handleTimeoutTicket(ticketInfo) {
  const { record, currentHandler, initiator, assignValue, groups, elapsedHours, sourceRecords } = ticketInfo;
  const recordId = record.record_id;
  const title = formatFieldText(record.fields['申请编号']) || formatFieldValue(record.fields['需求1'] ?? record.fields['需求']) || `工单-${recordId.slice(-6)}`;

  console.log(`[超时处理] 工单 ${recordId}: 当前处理人=${currentHandler.name}, 发起人=${initiator?.name || '未知'}, 超时=${elapsedHours}小时`);

  // 无人接单升级（下辖分支）：第 2 轮超时提醒起，私聊面向组别对应的组长。
  // 先于当轮常规分支动作执行；失败不影响分支动作
  try {
    const round = bumpTimeoutRound(recordId);
    if (round >= TIMEOUT_LEADER_NUDGE.startRound) {
      await nudgeGroupLeaders({ record, title, groups, elapsedHours, round });
    }
  } catch (err) {
    console.error(`[超时处理] 组长升级提醒失败（不影响常规提醒） ${recordId}:`, err.message);
  }

  // 分支1：当前处理人 == 发起人
  // 此时工单多半还没人接单（候选工单处于触发节点且无补充负责人），
  // 文案按「无人接单」提示发起人，而不是误导其去「结单」
  if (initiator && currentHandler.id === initiator.id) {
    console.log(`[超时处理] 分支1: 当前处理人==发起人，私信询问工单是否仍需要`);

    try {
      await sendTextToUser(
        currentHandler.id,
        `📋 您发起的工单「${title}」已超过 ${elapsedHours} 小时无人接单\n\n` +
        `如仍需要处理，请留意对应工单群并联系组内同学响应；\n` +
        `如不再需要，请前往审批界面撤回或结单：\n` +
        `${getTicketApprovalUrl(record.fields, recordId)}\n\n` +
        `如有疑问请联系管理员。`
      );

      broadcastHistory.unshift({
        time: new Date().toISOString(),
        type: 'timeout_reminder',
        recordId,
        branch: 'self',
        userId: currentHandler.id,
        success: true,
      });

      return { branch: 'self', success: true };
    } catch (err) {
      console.error(`[超时处理] 私信失败:`, err.message);
      return { branch: 'self', success: false, error: err.message };
    }
  }

  // 分支2：当前处理人 != 发起人
  console.log(`[超时处理] 分支2: 当前处理人!=发起人`);

  // 2.1 有指定负责人：私信当前处理人。
  // 该分支只在「绑定失败/未绑定」的指定负责人工单上触达（绑定成功的已被补充负责人检查跳过），
  // 引导先完成接单确认而不是去结单
  if (assignValue === config.assign.yesValue) {
    console.log(`[超时处理] 2.1: 有指定负责人，私信当前处理人`);

    try {
      await sendTextToUser(
        currentHandler.id,
        `📋 工单「${title}」已指定负责人，超过 ${elapsedHours} 小时未确认接单\n\n` +
        `若该工单由您负责，可直接私聊本机器人回复「接单」完成确认（或在工单群 @${config.bot.name} 按工单卡片提示发送「接单N」，仅一张待接时发「接单」）；\n` +
        `确认后请尽快处理：\n` +
        `${getTicketApprovalUrl(record.fields, recordId)}\n\n` +
        `如有疑问请联系发起人或管理员。`
      );

      broadcastHistory.unshift({
        time: new Date().toISOString(),
        type: 'timeout_reminder',
        recordId,
        branch: 'assigned',
        userId: currentHandler.id,
        success: true,
      });

      return { branch: 'assigned', success: true };
    } catch (err) {
      console.error(`[超时处理] 私信失败:`, err.message);
      return { branch: 'assigned', success: false, error: err.message };
    }
  }

  // 2.2 无指定负责人：重走公开问询流程，强调还没人接单，@组长
  // 群内问询节流：每 6 小时一次、每单封顶 2 次；间隔未到或已达封顶则本轮跳过
  console.log(`[超时处理] 2.2: 无指定负责人，重走公开问询流程`);
  if (!reaskAllowed(recordId)) {
    console.log(`[超时处理] 2.2: 群内问询间隔未到或已达封顶（每 ${TIMEOUT_REASK.intervalMs / 3600000}h × ${TIMEOUT_REASK.maxCount} 次），本轮跳过`);
    return { branch: 'skipped', success: false, note: '群内问询间隔未到或已达上限' };
  }

  const targets = ticketService.collectTargets(groups);
  if (targets.length === 0) {
    console.log(`[超时处理] 无可用播报目标，跳过`);
    return { branch: 'reannounce', success: false, error: '无播报目标' };
  }

  // 接单排队：群内多张待接单工单时，问询卡的接单词带序号（与播报卡同源推导；
  // 本轮拉取的就是触发节点工单全集，覆盖排队候选，直接复用免重复拉表）
  let acceptQueues = new Map();
  try {
    acceptQueues = await ticketService.computeAcceptQueues(sourceRecords);
  } catch (err) {
    console.warn(`[超时处理] 接单队列推导失败（按「接单」问询）: ${err.message}`);
  }

  const results = [];
  for (const target of targets) {
    try {
      const member = target.chatId ? acceptQueues.get(target.chatId)?.find((q) => q.recordId === recordId) : null;
      const kw = member?.kw || '接单';
      // 构建重问询卡片（强调还没人接单，@组长）
      const card = buildReannounceCard(record, elapsedHours, target.value, kw);
      const sent = await sendCardToTarget(target, card);
      // 接单提示卡登记：后续队列变化按 message_id 改写提示行
      ticketService.rememberKeywordCard({
        chatId: target.chatId,
        recordId,
        messageId: sent?.message_id,
        kind: 'reannounce',
        ctx: { elapsedHours, groupName: target.value },
        kw,
      });

      results.push({ target: describeTarget(target), success: true });
      console.log(`[超时处理] 重问询发送成功: ${describeTarget(target)}`);
    } catch (err) {
      console.error(`[超时处理] 重问询发送失败: ${describeTarget(target)}`, err.message);
      results.push({ target: describeTarget(target), success: false, error: err.message });
    }
  }

  // 至少一群发送成功才占用问询额度（全失败不消耗，下轮重试）
  if (results.some(r => r.success)) recordReask(recordId);

  broadcastHistory.unshift({
    time: new Date().toISOString(),
    type: 'timeout_reannounce',
    recordId,
    branch: 'reannounce',
    targets: results,
  });

  return { branch: 'reannounce', success: results.some(r => r.success), results };
}

// ============================================================
// 结单提醒（理想结单时间过后 N 天，仅私聊当前处理人，无转群兜底）
//   私聊链路已跑通（用户裁定 2026-09-05），过 ideal 结单时间后私聊一次；
//   未结单工单的持续曝光由 pm-robot 每日 DDL 播报的「工单结单」分栏承担
// ============================================================
const closingRemindState = new Map(); // recordId -> { dmTime }

async function checkClosingTickets() {
  console.log('[结单提醒] 开始检查已过结单时间的工单...');

  // 全量拉取后本地过滤：节点字段值可能是并行分支多段拼接（「；」等分隔符），
  // 服务端等值过滤对不上会让多组别工单的结单提醒静默失效，
  // 统一用 config.matchNodeValue 拆段匹配（与确认追问/unclosed 结单分桶同款整改）
  const records = (await bitableApi.listAllRecords(
    config.bitable.sourceAppToken,
    config.bitable.sourceTableId
  )).filter((r) => config.matchNodeValue(
    config.approvalNode.field ? r.fields[config.approvalNode.field] : '',
    [config.approvalNode.closeValue]
  ));

  console.log(`[结单提醒] 找到 ${records.length} 条「${config.approvalNode.closeValue}」的工单`);

  const now = Date.now();
  const leadMs = config.closeReminder.leadDays * 24 * 60 * 60 * 1000;
  const dueRecords = [];

  for (const record of records) {
    const fields = record.fields;
    const handler = fields[FIELD_HANDLER]?.[0];
    if (!handler || !handler.id) continue;

    const deadline = fields[config.closeReminder.deadlineField];
    if (!deadline) continue;

    const deadlineTs = new Date(deadline).getTime();
    if (isNaN(deadlineTs)) continue;

    // 进入提醒窗口：理想结单时间过后 N 天（CLOSE_REMINDER_LEAD_DAYS）才开始提醒
    if (now < deadlineTs + leadMs) continue;

    dueRecords.push({ record, handler, deadlineTs });
  }

  console.log(`[结单提醒] 发现 ${dueRecords.length} 条已过结单时间的工单`);
  return dueRecords;
}

async function handleClosingTicket(ticketInfo) {
  const { record, handler } = ticketInfo;
  const recordId = record.record_id;
  const title = formatFieldText(record.fields['申请编号']) || formatFieldValue(record.fields['需求1'] ?? record.fields['需求']) || `工单-${recordId.slice(-6)}`;
  const approvalUrl = getTicketApprovalUrl(record.fields, recordId);

  // 只私聊：已私聊过则不再重复（重启会清状态重私聊一次）
  if (closingRemindState.has(recordId)) {
    return { branch: 'skip', success: false, note: '已私聊过' };
  }

  console.log(`[结单提醒] 私聊当前处理人: ${handler.name}(${handler.id})`);
  try {
    await sendTextToUser(
      handler.id,
      `⏰ 工单「${title}」已超过理想结单时间，请尽快完成结单\n\n` +
      `请前往审批界面确认结单：\n${approvalUrl}`
    );
    closingRemindState.set(recordId, { dmTime: Date.now() });
    return { branch: 'dm', success: true };
  } catch (err) {
    console.error(`[结单提醒] 私聊失败:`, err.message);
    return { branch: 'dm', success: false, error: err.message };
  }
}

async function runCloseReminderCheck() {
  console.log('[结单提醒] 开始执行结单提醒检查任务...');

  try {
    const dueTickets = await checkClosingTickets();
    if (dueTickets.length === 0) {
      console.log('[结单提醒] 无临近结单工单');
      return { checked: 0, due: 0, handled: 0 };
    }

    const results = [];
    for (const ticket of dueTickets) {
      try {
        const result = await handleClosingTicket(ticket);
        results.push({ recordId: ticket.record.record_id, ...result });
      } catch (err) {
        console.error(`[结单提醒] 处理工单 ${ticket.record.record_id} 失败:`, err.message);
        results.push({ recordId: ticket.record.record_id, success: false, error: err.message });
      }
    }

    const handled = results.filter(r => r.success).length;
    console.log(`[结单提醒] 完成: 检查=${dueTickets.length} 处理成功=${handled}`);
    return { checked: dueTickets.length, due: dueTickets.length, handled, results };
  } catch (err) {
    console.error('[结单提醒] 任务执行失败:', err.message);
    throw err;
  }
}

// ============================================================
// 指定负责人确认追问（公示即绑定后超过 N 小时未确认 → 私聊追问）
//   条件：节点仍在「负责人确认消息后通过」+ 已绑定（补充负责人==指定负责人）+
//         距发起时间超过 ASSIGN_NUDGE_HOURS
//   负责人私聊回复「接单」或群内 @机器人 发送「接单」均可完成确认
//   （确认判定与审批联动统一走 ticketService，追问只负责提醒）
// ============================================================
const assignNudgeState = new Map(); // recordId -> lastNudgeTs

async function checkUnconfirmedAssignedTickets() {
  const { assignField, yesValue, assigneeField, supplementField } = config.assign;
  const nodeField = config.approvalNode.field;
  const assignNode = config.approvalNode.assignAcceptValue;

  // 全量拉取后本地过滤：节点字段值可能是并行分支多段拼接（「；」分隔），
  // 服务端等值过滤对不上会让追问静默失效，统一用 config.matchNodeValue 拆段匹配
  // （与超时检查同款做法；均为小时级任务，全量拉取量级可接受）
  const records = (await bitableApi.listAllRecords(
    config.bitable.sourceAppToken,
    config.bitable.sourceTableId
  )).filter((r) => config.matchNodeValue(
    nodeField ? r.fields[nodeField] : '',
    [assignNode]
  ));

  const now = Date.now();
  const nudgeMs = config.assignNudge.hours * 60 * 60 * 1000;
  const due = [];

  for (const record of records) {
    const fields = record.fields;
    if (!assignField || fields[assignField] !== yesValue) continue;
    const assignee = assigneeField ? fields[assigneeField]?.[0] : null;
    if (!assignee?.id) continue;
    const sup = supplementField ? fields[supplementField] : null;
    if (!sup?.some((p) => p?.id === assignee.id)) continue; // 未绑定（对账会补绑定），不追问
    // 发起时间缺失/非数值一律跳过本轮（宁漏勿误）：NaN 与 nudgeMs 比较恒 false 会误判超时立即追问
    const created = Number(getCreatedTime(fields)) || 0;
    if (!created || !Number.isFinite(created) || now - created < nudgeMs) continue;
    due.push({ record, assignee });
  }

  // 状态清理：追问记录 7 天后淘汰
  for (const [key, ts] of assignNudgeState) {
    if (now - ts > 7 * 24 * 60 * 60 * 1000) assignNudgeState.delete(key);
  }

  console.log(`[确认追问] 找到 ${due.length} 条超 ${config.assignNudge.hours} 小时未确认的指定负责人工单`);
  return due;
}

async function handleAssigneeNudge({ record, assignee }) {
  const recordId = record.record_id;
  const title = formatFieldText(record.fields['申请编号']) || formatFieldValue(record.fields['需求1'] ?? record.fields['需求']) || `工单-${recordId.slice(-6)}`;

  // 同一工单追问间隔不小于 ASSIGN_NUDGE_HOURS，避免每小时重复打扰
  const last = assignNudgeState.get(recordId);
  if (last && Date.now() - last < config.assignNudge.hours * 60 * 60 * 1000) {
    return { nudged: false, note: '已追问过，间隔内跳过' };
  }

  try {
    await sendTextToUser(
      assignee.id,
      `📋 工单「${title}」已指派给你并公示到你的组别群，超过 ${config.assignNudge.hours} 小时未收到你的接单确认。\n\n` +
      `✅ 如已知悉：直接私聊本机器人回复「接单」即可完成确认（或在群内 @${config.bot.name} 按工单卡片提示发送「接单N」，仅一张待接时发「接单」）。\n` +
      `❓ 如该工单不应由你负责，请联系管理员调整。`
    );
    assignNudgeState.set(recordId, Date.now());
    broadcastHistory.unshift({ time: new Date().toISOString(), type: 'assignee_nudge', recordId, userId: assignee.id, success: true });
    if (broadcastHistory.length > 50) broadcastHistory.length = 50;
    console.log(`[确认追问] 已私聊负责人: ${assignee.name || ''}(${assignee.id}) ← ${recordId}`);
    return { nudged: true };
  } catch (err) {
    console.error(`[确认追问] 私聊失败 ${recordId}:`, err.message);
    return { nudged: false, error: err.message };
  }
}

async function runAssigneeNudgeCheck() {
  console.log('[确认追问] 开始执行指定负责人确认追问检查...');
  try {
    const due = await checkUnconfirmedAssignedTickets();
    if (due.length === 0) return { checked: 0, nudged: 0 };

    const results = [];
    for (const item of due) {
      try {
        results.push({ recordId: item.record.record_id, ...(await handleAssigneeNudge(item)) });
      } catch (err) {
        console.error(`[确认追问] 处理工单 ${item.record.record_id} 失败:`, err.message);
        results.push({ recordId: item.record.record_id, nudged: false, error: err.message });
      }
    }

    const nudged = results.filter((r) => r.nudged).length;
    console.log(`[确认追问] 完成: 检查=${due.length} 追问=${nudged}`);
    return { checked: due.length, nudged, results };
  } catch (err) {
    console.error('[确认追问] 任务执行失败:', err.message);
    throw err;
  }
}

/**
 * 执行超时检查任务
 */
async function runTimeoutCheck() {
  console.log('[超时检查] 开始执行超时检查任务...');

  try {
    const timeoutTickets = await checkTimeoutTickets();

    if (timeoutTickets.length === 0) {
      console.log('[超时检查] 无超时工单');
      return { checked: 0, timeout: 0, handled: 0 };
    }

    const results = [];
    for (const ticket of timeoutTickets) {
      try {
        const result = await handleTimeoutTicket(ticket);
        results.push({ recordId: ticket.record.record_id, ...result });
      } catch (err) {
        console.error(`[超时检查] 处理工单 ${ticket.record.record_id} 失败:`, err.message);
        results.push({ recordId: ticket.record.record_id, success: false, error: err.message });
      }
    }

    const handled = results.filter(r => r.success).length;
    console.log(`[超时检查] 完成: 检查=${timeoutTickets.length} 超时=${timeoutTickets.length} 处理成功=${handled}`);

    return { checked: timeoutTickets.length, timeout: timeoutTickets.length, handled, results };
  } catch (err) {
    console.error('[超时检查] 任务执行失败:', err.message);
    throw err;
  }
}

let summaryTask = null;
let timeoutTask = null;
let closeReminderTask = null;
let assignNudgeTask = null;
let reconcileTask = null;

function startCronJobs() {
  // 每日汇总任务
  if (config.cron.schedule) {
    if (summaryTask) {
      console.log('[定时任务] 每日汇总任务已存在，先停止旧任务');
      summaryTask.stop();
    }

    summaryTask = cron.schedule(config.cron.schedule, () => {
      console.log('[定时任务] 触发工单每日汇总');
      // 晚间静默：窗口内积压到窗口结束整点，重跑整个汇总任务（以补发时刻数据为准）
      quietHours.gateTask('daily_summary', quietHours.shanghaiStamp(), runSummaryWithRetry, '工单每日汇总').catch(err => {
        console.error('[定时任务] 工单每日汇总失败:', err.message);
      });
    }, {
      timezone: 'Asia/Shanghai',
    });

    console.log(`[定时任务] 工单每日汇总已启动，调度规则: ${config.cron.schedule} (Asia/Shanghai)`);
  } else {
    console.log('[定时任务] 未配置 CRON_SCHEDULE，不启用每日汇总播报');
  }

  // 超时检查任务（每小时执行一次）
  if (timeoutTask) {
    console.log('[定时任务] 超时检查任务已存在，先停止旧任务');
    timeoutTask.stop();
  }

  timeoutTask = cron.schedule(TIMEOUT_CONFIG.checkInterval, () => {
    // 晚间静默：整轮跳过（不计轮次/不写提醒状态），09:00 整点轮次天然完成补跑
    if (quietHours.inQuietHours()) {
      console.log(`[定时任务] 晚间静默（${quietHours.quietWindowDesc()}），超时检查本轮顺延至下个整点`);
      return;
    }
    console.log('[定时任务] 触发超时检查');
    runTimeoutCheck().catch(err => {
      console.error('[定时任务] 超时检查失败:', err.message);
    });
  }, {
    timezone: 'Asia/Shanghai',
  });

  console.log(`[定时任务] 超时检查已启动，调度规则: ${TIMEOUT_CONFIG.checkInterval} (Asia/Shanghai)`);

  // 结单提醒任务（每小时执行一次）
  if (closeReminderTask) {
    console.log('[定时任务] 结单提醒任务已存在，先停止旧任务');
    closeReminderTask.stop();
  }

  closeReminderTask = cron.schedule(TIMEOUT_CONFIG.checkInterval, () => {
    // 晚间静默：整轮跳过（不写私聊状态），09:00 整点轮次天然完成补跑
    if (quietHours.inQuietHours()) {
      console.log(`[定时任务] 晚间静默（${quietHours.quietWindowDesc()}），结单提醒本轮顺延至下个整点`);
      return;
    }
    console.log('[定时任务] 触发结单提醒检查');
    runCloseReminderCheck().catch(err => {
      console.error('[定时任务] 结单提醒检查失败:', err.message);
    });
  }, {
    timezone: 'Asia/Shanghai',
  });

  console.log(`[定时任务] 结单提醒已启动，调度规则: ${TIMEOUT_CONFIG.checkInterval} (Asia/Shanghai)`);

  // 指定负责人确认追问任务（每小时执行一次）
  if (assignNudgeTask) {
    console.log('[定时任务] 确认追问任务已存在，先停止旧任务');
    assignNudgeTask.stop();
  }

  assignNudgeTask = cron.schedule(TIMEOUT_CONFIG.checkInterval, () => {
    // 晚间静默：整轮跳过（不写追问节流状态），09:00 整点轮次天然完成补跑
    if (quietHours.inQuietHours()) {
      console.log(`[定时任务] 晚间静默（${quietHours.quietWindowDesc()}），确认追问本轮顺延至下个整点`);
      return;
    }
    console.log('[定时任务] 触发指定负责人确认追问检查');
    runAssigneeNudgeCheck().catch(err => {
      console.error('[定时任务] 确认追问检查失败:', err.message);
    });
  }, {
    timezone: 'Asia/Shanghai',
  });

  console.log(`[定时任务] 确认追问已启动，调度规则: ${TIMEOUT_CONFIG.checkInterval} (Asia/Shanghai)`);

  // 播报对账任务（每分钟执行一次）
  // 长连接事件会被共用应用的其他连接随机抢走，对账兜底保证漏播工单最终补播/补搬运
  if (reconcileTask) {
    console.log('[定时任务] 播报对账任务已存在，先停止旧任务');
    reconcileTask.stop();
  }

  reconcileTask = cron.schedule('* * * * *', () => {
    console.log('[定时任务] 触发播报对账');
    ticketService.reconcileBroadcasts().catch(err => {
      console.error('[定时任务] 播报对账失败:', err.message);
    });
  }, {
    timezone: 'Asia/Shanghai',
  });

  console.log('[定时任务] 播报对账已启动，调度规则: 每分钟 (Asia/Shanghai)');

  // 晚间静默：注册积压任务的冲刷执行器，并按启动时点调度积压补跑（有积压才调度）
  quietHours.registerTask('daily_summary', runSummaryWithRetry);
  quietHours.initQuietHoursFlush();

  console.log(`[定时任务] 当前时间: ${new Date().toLocaleString('zh-CN')}`);

  return { summaryTask, timeoutTask, closeReminderTask, reconcileTask };
}

function stopCronJobs() {
  if (summaryTask) {
    summaryTask.stop();
    summaryTask = null;
    console.log('[定时任务] 每日汇总已停止');
  }
  if (timeoutTask) {
    timeoutTask.stop();
    timeoutTask = null;
    console.log('[定时任务] 超时检查已停止');
  }
  if (closeReminderTask) {
    closeReminderTask.stop();
    closeReminderTask = null;
    console.log('[定时任务] 结单提醒已停止');
  }
  if (assignNudgeTask) {
    assignNudgeTask.stop();
    assignNudgeTask = null;
    console.log('[定时任务] 确认追问已停止');
  }
  if (reconcileTask) {
    reconcileTask.stop();
    reconcileTask = null;
    console.log('[定时任务] 播报对账已停止');
  }
}

function getCronStatus() {
  return {
    summary: {
      running: !!summaryTask,
      schedule: config.cron.schedule || '(未启用)',
    },
    timeout: {
      running: !!timeoutTask,
      schedule: TIMEOUT_CONFIG.checkInterval,
      config: `超时阈值: ${TIMEOUT_CONFIG.hours} 小时`,
    },
    closeReminder: {
      running: !!closeReminderTask,
      schedule: TIMEOUT_CONFIG.checkInterval,
      config: `理想结单时间过后 ${config.closeReminder.leadDays} 天提醒结单`,
    },
    assignNudge: {
      running: !!assignNudgeTask,
      schedule: TIMEOUT_CONFIG.checkInterval,
      config: `指定负责人超 ${config.assignNudge.hours} 小时未确认时私聊追问`,
    },
    reconcile: {
      running: !!reconcileTask,
      schedule: '* * * * *',
      config: '每分钟扫描触发节点工单，漏播补播/漏搬补搬',
    },
    quietHours: quietHours.getStatus(),
  };
}

function getSummaryHistory() {
  return broadcastHistory;
}

module.exports = {
  startCronJobs,
  stopCronJobs,
  runSummary: runSummaryWithRetry,
  runTimeoutCheck,
  runCloseReminderCheck,
  runAssigneeNudgeCheck,
  getCronStatus,
  getSummaryHistory,
  getSummaryTargets,
  checkTimeoutTickets,
  handleTimeoutTicket,
  checkClosingTickets,
  handleClosingTicket,
};
