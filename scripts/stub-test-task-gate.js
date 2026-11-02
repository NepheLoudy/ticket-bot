// 定时任务互斥闸门 + 看门狗 stub 测试（2026-11-03 对账卡死 48.8h 事故修复批）：
// 互斥标志防 tick 堆叠是原有行为；看门狗强制复位与令牌防误复位是本批新增行为——
// 一轮对账因出站请求悬挂永不 settle 时，reconcileRunning 恒 true 导致兜底补播停摆
// （11-01 00:04 至 11-03 01:18），看门狗按「单轮持续超阈值」强制放行。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createTaskGate } = require('../src/utils/taskGate');

// —— ① 空闲进入：返回令牌（数字，真值）——
const gate = createTaskGate('测试任务', 60 * 60 * 1000);
const t1 = gate.tryEnter();
assert.strictEqual(typeof t1, 'number', '① 空闲进入应返回数字令牌');
assert.ok(t1 > 0, '① 令牌应为正数（用 null 表示拒绝）');

// —— ② 运行中重入：拒绝（null）——
assert.strictEqual(gate.tryEnter(), null, '② 上一轮未结束时重入应返回 null');

// —— ③ 正常收尾：持令牌 leave 后可再进入——
gate.leave(t1);
const t2 = gate.tryEnter();
assert.strictEqual(typeof t2, 'number', '③ leave 后应可再次进入');
assert.notStrictEqual(t2, t1, '③ 新一轮令牌应递增，与旧令牌可区分');

// —— ④ 看门狗：超阈值强制复位放行——
const fast = createTaskGate('看门狗任务', 30); // 30ms 阈值，实等待触发
const t3 = fast.tryEnter();
assert.strictEqual(typeof t3, 'number', '④ 首次进入正常');
assert.strictEqual(fast.tryEnter(), null, '④ 运行中重入拒绝');
// 旧轮永不 leave（模拟悬挂），等阈值过去
const spin = Date.now();
while (Date.now() - spin < 60) { /* 忙等 60ms 越过 30ms 阈值 */ }
const t4 = fast.tryEnter();
assert.strictEqual(typeof t4, 'number', '④ 看门狗应在超阈值后强制复位放行新一轮');
assert.notStrictEqual(t4, t3, '④ 新令牌应区别于悬挂轮令牌');

// —— ⑤ 令牌防误复位：悬挂轮迟到 settle 的 leave 不影响新一轮——
fast.leave(t3); // 旧令牌
assert.strictEqual(fast.tryEnter(), null, '⑤ 旧令牌 leave 应被忽略，新一轮仍占用闸门');
fast.leave(t4); // 新令牌正常收尾
assert.strictEqual(typeof fast.tryEnter(), 'number', '⑤ 新令牌 leave 后闸门释放');

// —— ⑥ 出站 fetch 无裸奔：token 与 API 请求都必须挂 AbortSignal（事故根因封口，
//     防未来新增调用点回归成无界 fetch）——
const clientSrc = fs.readFileSync(path.join(__dirname, '../src/feishu/client.js'), 'utf8');
const fetchCount = (clientSrc.match(/await fetch\(/g) || []).length;
const signalCount = (clientSrc.match(/signal: AbortSignal\.timeout\(/g) || []).length;
assert.strictEqual(fetchCount, 2, '⑥ client.js 应恰有两处 fetch（token + requestAPI）');
assert.strictEqual(signalCount, 2, '⑥ client.js 两处 fetch 都必须挂 AbortSignal.timeout');
const botSrc = fs.readFileSync(path.join(__dirname, '../src/feishu/bot.js'), 'utf8');
assert.ok(/signal: AbortSignal\.timeout\(/.test(botSrc), '⑥ bot.js webhook fetch 必须挂 AbortSignal.timeout');

console.log('stub-test-task-gate: 6 组断言全过 ✓');
