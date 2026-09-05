const fs = require('fs');
const path = require('path');

// ============================================================
// 晚间静默（播报时段限制）
//
// 窗口 [QUIET_HOURS_START, QUIET_HOURS_END)（Asia/Shanghai，默认 02:00–09:00）
// 内，定时/自动播报不直接发送，统一积压到 end 整点冲刷补发。两种积压形态：
//   - task（gateTask）：可重扫的任务（每日汇总等）只登记名字+触发槽位，冲刷时
//     重新执行整个任务函数——以补发时刻的最新数据重查，夜里已了结的事不再播，
//     播报标记/提醒状态/轮次节流等时点逻辑都落在实际发送之后；
//   - payload（gatePayload）：一次性事件通知（多人单结束通告等）原样落盘载荷，
//     冲刷时按入队顺序原样补发（补发的是事件发生时刻的快照）。
//
// 时点逻辑的分工（「挤压要为挤压之后的事情负责」）：
//   - 每小时整点重扫类任务（超时检查/结单提醒/确认追问）不进积压：静默窗口内
//     整轮跳过（无任何副作用），09:00 整点那一轮天然就是冲刷，轮次与间隔节流
//     从 09:00 起算；
//   - 工单播报（broadcastTicket）静默期内直接顺延且不做任何副作用（不写播报
//     标记、不公示即绑定、不登记待接单），每分钟对账在 09:00 后第一个 tick
//     自然补播，播报前重查（已接单/节点推进）兜住夜间变化。
//
// 积压持久化到项目根 .quiet-backlog.json：重启不丢。启动时已过 end 整点则
// 立即补冲刷，否则调度到 end 整点。冲刷失败的单条保留重试（至多 3 次尝试），
// 超限丢弃并打错误日志。
//
// 不受限：对话回复（接单确认/指令回复）与人工当下主动触发（/test-*、手动补播
// 单条工单）——前者是交互回路，后者是操作者明确要求立即发送。
// ============================================================

const BACKLOG_FILE = path.join(__dirname, '..', '..', '.quiet-backlog.json');
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Shanghai 无夏令时，固定 UTC+8
const MAX_ATTEMPTS = 3;
const FLUSH_ROUNDS = 10;
const RETRY_DELAY_MS = 60 * 1000;

const settings = {
  enabled: process.env.QUIET_HOURS_DISABLED !== '1',
  start: clampHour(process.env.QUIET_HOURS_START, 2),
  end: clampHour(process.env.QUIET_HOURS_END, 9),
};

function clampHour(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(23, Math.max(0, Math.trunc(n)));
}

/** 上海墙上时钟 parts（用加 8 小时后的 UTC 取值读） */
function shanghaiParts(now = new Date()) {
  const shifted = new Date(now.getTime() + TZ_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth(),
    d: shifted.getUTCDate(),
    minutesOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function inQuietHours(now = new Date()) {
  if (!settings.enabled || settings.start === settings.end) return false;
  const m = shanghaiParts(now).minutesOfDay;
  const s = settings.start * 60;
  const e = settings.end * 60;
  // 支持跨午夜写法（start > end，如 23→6）
  return s < e ? (m >= s && m < e) : (m >= s || m < e);
}

/** 下一个 end 整点（上海）的绝对时间 */
function nextQuietEnd(now = new Date()) {
  const p = shanghaiParts(now);
  let target = Date.UTC(p.y, p.m, p.d, settings.end, 0, 0) - TZ_OFFSET_MS;
  if (target <= now.getTime()) target += 24 * 60 * 60 * 1000;
  return new Date(target);
}

function quietWindowDesc() {
  const fmt = (h) => `${String(h).padStart(2, '0')}:00`;
  return `${fmt(settings.start)}–${fmt(settings.end)}`;
}

/** 上海时区的 "YYYY-MM-DD HH:mm" 戳（cron 同槽位去重键用） */
function shanghaiStamp(now = new Date()) {
  const p = shanghaiParts(now);
  const shifted = new Date(now.getTime() + TZ_OFFSET_MS);
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  return `${p.y}-${String(p.m + 1).padStart(2, '0')}-${String(p.d).padStart(2, '0')} ${hh}:${mm}`;
}

// ---------- 积压队列（持久化） ----------

const runners = new Map(); // task 名 -> async 执行器（冲刷时重跑整个任务函数）
const payloadHandlers = {
  // 多人单结束通告卡：补发到原目标群（载荷在积压时已构建，原样补发）
  'card-to-targets': async (p) => {
    const { sendCardToTarget } = require('../feishu/bot');
    const targets = p.targets || [];
    let sent = 0;
    let lastErr = null;
    for (const target of targets) {
      try {
        await sendCardToTarget(target, p.card);
        sent++;
      } catch (err) {
        lastErr = err;
      }
    }
    if (sent === 0 && targets.length > 0) throw lastErr || new Error('全部目标群补发失败');
  },
};

let flushTimer = null;
let nextFlushAt = null;
let flushing = false;

function loadBacklog() {
  try {
    if (fs.existsSync(BACKLOG_FILE)) {
      const data = JSON.parse(fs.readFileSync(BACKLOG_FILE, 'utf-8'));
      return Array.isArray(data.items) ? data.items : [];
    }
  } catch (err) {
    console.warn('[晚间静默] 读取积压文件失败（按空处理）:', err.message);
  }
  return [];
}

function saveBacklog(items) {
  try {
    if (items.length === 0) {
      if (fs.existsSync(BACKLOG_FILE)) fs.unlinkSync(BACKLOG_FILE);
    } else {
      fs.writeFileSync(BACKLOG_FILE, JSON.stringify({ items }, null, 2));
    }
  } catch (err) {
    console.warn('[晚间静默] 写积压文件失败（仅影响重启恢复）:', err.message);
  }
}

function registerTask(name, fn) {
  runners.set(name, fn);
}

/**
 * 定时任务静默闸门：非静默直接执行；静默窗口内登记积压，冲刷时重跑整个 run。
 * @returns {Promise<{deferred: boolean}>} 实际结果或积压登记信息
 */
async function gateTask(name, fireKey, run, label = name) {
  if (!inQuietHours()) return run();

  const items = loadBacklog();
  if (items.some((it) => it.type === 'task' && it.name === name && it.fireKey === fireKey)) {
    console.log(`[晚间静默] ${label} 该槽位已积压，跳过重复登记`);
    return { deferred: true, note: '已积压' };
  }
  items.push({ type: 'task', name, fireKey, queuedAt: new Date().toISOString() });
  saveBacklog(items);
  scheduleFlushFromGate();
  console.log(`[晚间静默] ${label} 落入积压（共 ${items.length} 条），${nextQuietEnd().toLocaleString('zh-CN')} 统一补跑`);
  return { deferred: true };
}

/**
 * 一次性通知载荷闸门：非静默返回 false（调用方照常直接发送）；
 * 静默窗口内载荷落盘积压并返回 true（调用方跳过发送）。
 */
function gatePayload(name, payload, label = name) {
  if (!inQuietHours()) return false;
  const items = loadBacklog();
  items.push({ type: 'payload', name, payload, queuedAt: new Date().toISOString() });
  saveBacklog(items);
  scheduleFlushFromGate();
  console.log(`[晚间静默] ${label} 载荷落盘积压（共 ${items.length} 条），${nextQuietEnd().toLocaleString('zh-CN')} 统一补发`);
  return true;
}

async function runItem(item) {
  if (item.type === 'task') {
    const fn = runners.get(item.name);
    if (!fn) throw new Error(`任务「${item.name}」未注册冲刷执行器`);
    return fn();
  }
  const handler = payloadHandlers[item.name];
  if (!handler) throw new Error(`载荷「${item.name}」未注册补发处理器`);
  return handler(item.payload);
}

function describeItem(item) {
  if (item.type === 'task') return `${item.name}@${item.fireKey}`;
  return `${item.name}（${item.queuedAt}）`;
}

function scheduleFlush(delayMs) {
  if (flushTimer) clearTimeout(flushTimer);
  nextFlushAt = new Date(Date.now() + delayMs).toISOString();
  flushTimer = setTimeout(() => {
    flushTimer = null;
    nextFlushAt = null;
    runFlush().catch((err) => console.error('[晚间静默] 冲刷异常:', err.message));
  }, delayMs);
  if (flushTimer.unref) flushTimer.unref();
}

function scheduleFlushFromGate() {
  if (flushTimer) return; // 已有调度在等待，沿用
  scheduleFlush(Math.max(nextQuietEnd().getTime() - Date.now(), 1000));
}

async function runFlush() {
  if (flushing) return;
  flushing = true;
  try {
    for (let round = 0; round < FLUSH_ROUNDS; round++) {
      const items = loadBacklog();
      if (items.length === 0) return;

      console.log(`[晚间静默] 开始冲刷积压 ${items.length} 条...`);
      const remaining = [];
      for (const item of items) {
        try {
          await runItem(item);
          console.log(`[晚间静默] 积压补跑完成: ${describeItem(item)}`);
        } catch (err) {
          item.attempts = (item.attempts || 0) + 1;
          if (item.attempts >= MAX_ATTEMPTS) {
            console.error(`[晚间静默] 积压补跑连续 ${item.attempts} 次失败，放弃: ${describeItem(item)} — ${err.message}`);
          } else {
            remaining.push(item);
            console.error(`[晚间静默] 积压补跑失败（第 ${item.attempts} 次，保留重试）: ${describeItem(item)} — ${err.message}`);
          }
        }
      }
      saveBacklog(remaining);

      if (remaining.length > 0) {
        scheduleFlush(RETRY_DELAY_MS);
        return;
      }
      // 全部成功；冲刷期间新落进的积压由下一轮立刻处理
    }
    console.warn('[晚间静默] 冲刷轮次达上限，剩余积压留待下次调度');
  } finally {
    flushing = false;
  }
}

/** 启动时调用：有积压则按当前时点调度补冲刷（过点立即、未过点等到 end 整点） */
function initQuietHoursFlush() {
  const items = loadBacklog();
  if (!settings.enabled) {
    console.log('[晚间静默] 已通过 QUIET_HOURS_DISABLED=1 关闭');
    return;
  }
  if (items.length === 0) {
    console.log(`[晚间静默] 播报静默窗口 ${quietWindowDesc()}（Asia/Shanghai），当前无积压`);
    return;
  }
  if (inQuietHours() || shanghaiParts().minutesOfDay < settings.end * 60) {
    const end = nextQuietEnd();
    console.log(`[晚间静默] 启动时存在 ${items.length} 条积压，调度到 ${end.toLocaleString('zh-CN')} 补跑`);
    scheduleFlush(Math.max(end.getTime() - Date.now(), 1000));
  } else {
    console.log(`[晚间静默] 启动时存在 ${items.length} 条积压且已过补发时点，5 秒后立即补跑`);
    scheduleFlush(5000);
  }
}

function getStatus() {
  return {
    enabled: settings.enabled,
    window: quietWindowDesc(),
    inQuietHours: inQuietHours(),
    backlog: loadBacklog().length,
    nextFlushAt: nextFlushAt,
  };
}

module.exports = {
  inQuietHours,
  nextQuietEnd,
  quietWindowDesc,
  shanghaiStamp,
  gateTask,
  gatePayload,
  registerTask,
  initQuietHoursFlush,
  getStatus,
};
