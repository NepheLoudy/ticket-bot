const cron = require('node-cron');
const config = require('../config');
const ticketService = require('../services/ticketService');
const bitableApi = require('../feishu/bitable');
const {
  sendCardToTarget,
  sendTextToUser,
  describeTarget,
  buildDailySummaryCard,
  buildTimeoutReminderCard,
  buildReannounceCard,
} = require('../feishu/bot');
const { formatFieldValue } = require('../utils/fields');

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
 * 超时检查：查找超过 6 小时未结单的工单
 * 条件：
 *   - 申请状态 = "审批中"
 *   - 当前处理人 有值
 *   - 距离发起时间超过 6 小时
 */
async function checkTimeoutTickets() {
  console.log('[超时检查] 开始检查超时工单...');

  // 查询所有审批中的工单
  const filter = `CurrentValue.[申请状态] = "审批中"`;
  const records = await bitableApi.listAllRecords(
    config.bitable.sourceAppToken,
    config.bitable.sourceTableId,
    filter
  );

  console.log(`[超时检查] 找到 ${records.length} 条审批中的工单`);

  const now = Date.now();
  const timeoutMs = TIMEOUT_CONFIG.hours * 60 * 60 * 1000;
  const timeoutRecords = [];

  for (const record of records) {
    const fields = record.fields;

    // 检查当前处理人是否有值
    const currentHandler = fields['当前处理人']?.[0];
    if (!currentHandler || !currentHandler.id) {
      continue;
    }

    // 检查发起时间
    const createTime = fields['创建时间'] || fields['发起时间'] || fields['Created Time'];
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
      initiator: fields['发起人']?.[0] || null,
      assignValue: fields['是否指定人员负责'],
      groups: fields['面向组别'] || [],
      elapsedHours: Math.floor(elapsed / (60 * 60 * 1000)),
    });
  }

  console.log(`[超时检查] 发现 ${timeoutRecords.length} 条超时工单`);
  return timeoutRecords;
}

/**
 * 处理超时工单分支
 */
async function handleTimeoutTicket(ticketInfo) {
  const { record, currentHandler, initiator, assignValue, groups, elapsedHours } = ticketInfo;
  const recordId = record.record_id;
  const title = record.fields['申请编号'] || record.fields['需求'] || `工单-${recordId.slice(-6)}`;

  console.log(`[超时处理] 工单 ${recordId}: 当前处理人=${currentHandler.name}, 发起人=${initiator?.name || '未知'}, 超时=${elapsedHours}小时`);

  // 分支1：当前处理人 == 发起人
  if (initiator && currentHandler.id === initiator.id) {
    console.log(`[超时处理] 分支1: 当前处理人==发起人，私信询问是否结单`);

    try {
      await sendTextToUser(
        currentHandler.id,
        `📋 您的工单「${title}」已超时 ${elapsedHours} 小时未结单\n\n` +
        `请前往审批界面完成结单：\n` +
        `https://cquqianli.feishu.cn/base/${config.bitable.sourceAppToken}?table=${config.bitable.sourceTableId}&view=viewsAll&viewId=viewsAll&record=${recordId}\n\n` +
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

  // 2.1 有指定负责人：私信当前处理人
  if (assignValue === '是') {
    console.log(`[超时处理] 2.1: 有指定负责人，私信当前处理人`);

    try {
      await sendTextToUser(
        currentHandler.id,
        `📋 您负责的工单「${title}」已超时 ${elapsedHours} 小时未结单\n\n` +
        `请尽快处理并前往审批界面完成结单：\n` +
        `https://cquqianli.feishu.cn/base/${config.bitable.sourceAppToken}?table=${config.bitable.sourceTableId}&view=viewsAll&viewId=viewsAll&record=${recordId}\n\n` +
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
  console.log(`[超时处理] 2.2: 无指定负责人，重走公开问询流程`);

  const targets = ticketService.collectTargets(groups);
  if (targets.length === 0) {
    console.log(`[超时处理] 无可用播报目标，跳过`);
    return { branch: 'reannounce', success: false, error: '无播报目标' };
  }

  const results = [];
  for (const target of targets) {
    try {
      // 构建重问询卡片（强调还没人接单，@组长）
      const card = buildReannounceCard(record, elapsedHours, target.value);
      await sendCardToTarget(target, card);

      results.push({ target: describeTarget(target), success: true });
      console.log(`[超时处理] 重问询发送成功: ${describeTarget(target)}`);
    } catch (err) {
      console.error(`[超时处理] 重问询发送失败: ${describeTarget(target)}`, err.message);
      results.push({ target: describeTarget(target), success: false, error: err.message });
    }
  }

  broadcastHistory.unshift({
    time: new Date().toISOString(),
    type: 'timeout_reannounce',
    recordId,
    branch: 'reannounce',
    targets: results,
  });

  return { branch: 'reannounce', success: results.some(r => r.success), results };
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

function startCronJobs() {
  // 每日汇总任务
  if (config.cron.schedule) {
    if (summaryTask) {
      console.log('[定时任务] 每日汇总任务已存在，先停止旧任务');
      summaryTask.stop();
    }

    summaryTask = cron.schedule(config.cron.schedule, () => {
      console.log('[定时任务] 触发工单每日汇总');
      runSummaryWithRetry().catch(err => {
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
    console.log('[定时任务] 触发超时检查');
    runTimeoutCheck().catch(err => {
      console.error('[定时任务] 超时检查失败:', err.message);
    });
  }, {
    timezone: 'Asia/Shanghai',
  });

  console.log(`[定时任务] 超时检查已启动，调度规则: ${TIMEOUT_CONFIG.checkInterval} (Asia/Shanghai)`);
  console.log(`[定时任务] 当前时间: ${new Date().toLocaleString('zh-CN')}`);

  return { summaryTask, timeoutTask };
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
  getCronStatus,
  getSummaryHistory,
  getSummaryTargets,
  checkTimeoutTickets,
  handleTimeoutTicket,
};
