/**
 * 离线桩测试 · 晚间静默冲刷竞态（2026-09-27 整改回归）：
 *   runFlush 收尾若直接 saveBacklog(remaining) 会以「本轮快照-已结算」覆盖整个
 *   积压文件，把冲刷期间新落盘的载荷静默丢掉。验证：
 *     ①冲刷期间新落盘的积压不被覆盖丢失，且在本轮循环内继续补发；
 *     ②失败保留项照常回写（attempts 自增落盘），退避调度不丢条目。
 * 全部外部依赖走桩，积压文件指向临时目录；用法：node scripts/stub-test-quiet-flush.js
 */
process.env.PLAZA_BITABLE_TABLE_ID = '';
const os = require('os');
const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const BACKLOG_FILE = path.join(os.tmpdir(), `quiet-backlog-test-${Date.now()}.json`);
process.env.QUIET_BACKLOG_FILE = BACKLOG_FILE; // 必须在 require quietHours 前设置

// ---- 桩：payloadHandlers['card-to-targets'] 冲刷时惰性 require 的发送通道 ----
const sentCards = [];
let onSendCard = null; // 钩子：第一次补发时注入「冲刷期间新落盘」的模拟
const stubs = {
  [path.join(ROOT, 'src/feishu/bot.js')]: {
    sendCardToTarget: async (target, card) => {
      if (target.chatId === 'oc_C') throw new Error('模拟补发失败'); // 构造失败保留项
      sentCards.push({ target, card });
      if (onSendCard) { const fn = onSendCard; onSendCard = null; fn(); }
      return { message_id: 'om_stub' };
    },
    describeTarget: (t) => t.chatId || '(target)',
  },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith('.') && parent?.filename) {
    const abs = path.resolve(path.dirname(parent.filename), request);
    for (const key of Object.keys(stubs)) {
      if (abs === key || abs === key.replace(/\.js$/, '')) return key;
    }
  }
  return origResolve.call(this, request, parent, ...rest);
};
for (const [key, value] of Object.entries(stubs)) {
  require.cache[key] = new Module(key, null);
  require.cache[key].exports = value;
  require.cache[key].loaded = true;
}

const quietHours = require(path.join(ROOT, 'src/utils/quietHours.js'));

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

function writeBacklog(items) {
  fs.writeFileSync(BACKLOG_FILE, JSON.stringify({ items }, null, 2));
}
function readBacklog() {
  try {
    if (!fs.existsSync(BACKLOG_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(BACKLOG_FILE, 'utf-8'));
    return Array.isArray(data.items) ? data.items : [];
  } catch { return []; }
}
const payloadCard = (id) => ({
  type: 'payload', name: 'card-to-targets', queuedAt: new Date().toISOString(),
  payload: { targets: [{ chatId: `oc_${id}` }], card: { stub: id } },
});

(async () => {
  console.log('\n== 1. 冲刷期间新落盘的积压不被收尾保存覆盖 ==');
  fs.rmSync(BACKLOG_FILE, { force: true });
  writeBacklog([payloadCard('A')]);
  // 模拟：条目 A 补发时，另一个 gatePayload 并发落盘了条目 B（直写文件 = gate 的 load+push+save）
  onSendCard = () => writeBacklog([...readBacklog(), payloadCard('B')]);
  await quietHours.runFlush();
  check('A、B 两条都被补发（旧实现 B 会被覆盖丢失，只发 1 条）', sentCards.length === 2, JSON.stringify(sentCards.map((c) => c.card.stub)));
  check('冲刷结束后积压文件清空（无条目残留或丢失）', readBacklog().length === 0, JSON.stringify(readBacklog().length));

  console.log('\n== 2. 失败保留项照常回写（attempts 自增），不被新落盘条目挤掉 ==');
  fs.rmSync(BACKLOG_FILE, { force: true });
  sentCards.length = 0;
  const bad = payloadCard('C'); // 目标 oc_C 的补发在桩里抛错 → 失败保留
  const good = payloadCard('D');
  writeBacklog([bad, good]);
  // D 补发成功时新落盘条目 E（验证失败退避路径下新条目同样不丢）
  onSendCard = () => writeBacklog([...readBacklog(), payloadCard('E')]);
  await quietHours.runFlush();
  const backlogAfter = readBacklog();
  check('成功的 D 已结算移除', !backlogAfter.some((it) => it.payload?.card?.stub === 'D'), JSON.stringify(backlogAfter.map((it) => it.payload?.card?.stub)));
  check('失败的 C 保留且 attempts=1', backlogAfter.some((it) => it.payload?.card?.stub === 'C' && it.attempts === 1), JSON.stringify(backlogAfter.map((it) => ({ id: it.payload?.card?.stub, attempts: it.attempts }))));
  check('冲刷期间落盘的 E 同样保留（未被覆盖）', backlogAfter.some((it) => it.payload?.card?.stub === 'E'), JSON.stringify(backlogAfter.map((it) => it.payload?.card?.stub)));

  fs.rmSync(BACKLOG_FILE, { force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('桩测试异常:', e); process.exit(1); });
