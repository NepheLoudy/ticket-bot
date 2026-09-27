/**
 * 离线桩测试 · 工单终态联动撤回接单提醒（2026-09-27）：
 * 申请状态命中死亡终态（已撤回/已拒绝等，口径同 syncService.STATUS_MAPPING）时：
 *   ①事件路径：handleRecordUpdate 即时撤回各群登记的提醒卡（幂等）
 *   ②播报守卫：终态单不再补播（防止「撤了提醒又冒出新卡」）
 *   ③对账补偿：事件被网关漏掉时，每分钟对账兜底撤回
 *   ④队列剔除：终态单不进接单队列、不占「接单N」序号
 *   ⑤失败分支：消息不存在(230020)清登记不重试；瞬时失败保留登记由对账重试
 * 全部外部依赖走桩；用法：node scripts/stub-test-revoke.js
 */
process.env.CATEGORY_FIELD = '分类'; // 测试记录不带该字段 → 搬运全程跳过
process.env.DEFAULT_CHAT_ID = 'oc_test1'; // 播报兜底群（桩只认这个 chatId）
process.env.ASSIGN_FIELD = '是否指定人员负责'; // 与生产同构：未指定（「否」）才走组别播报
process.env.PLAZA_BITABLE_TABLE_ID = '';
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

// ---- 桩数据表：bitableApi 读写的数据源 ----
const TABLE = [];
const rec = (record_id, fields) => ({ record_id, fields });

// ---- 桩：feishu/bot.js（发送/撤回全部记录调用，行为可按 messageId 配置）----
const sentCards = [];
const deletedMsgs = [];
const deleteBehavior = {}; // messageId -> 'fail'（瞬时失败）| 'gone'（230020）
const botStub = {
  sendCardToTarget: async (target, card) => {
    sentCards.push({ chatId: target.chatId, card });
    return { message_id: `om_${sentCards.length}` };
  },
  describeTarget: (t) => t.chatId || '(target)',
  updateCardToChat: async () => ({}),
  deleteMessage: async (messageId) => {
    deletedMsgs.push(messageId);
    const b = deleteBehavior[messageId];
    if (b === 'fail') throw new Error('模拟瞬时网络错误');
    if (b === 'gone') throw new Error('消息不存在 (code: 230020)');
    return {};
  },
  buildTicketOpenCard: (record, kw) => ({ stub: 'open', kw }),
  buildTicketAssignCard: () => ({ stub: 'assign' }),
  buildReannounceCard: () => ({ stub: 'reannounce' }),
};

// ---- 桩：feishu/bitable.js（真实导出五个方法的内存版）----
const bitableStub = {
  listAllRecords: async () => TABLE.map((r) => ({ ...r, fields: { ...r.fields } })),
  getRecord: async (appToken, tableId, recordId) => {
    const r = TABLE.find((x) => x.record_id === recordId);
    if (!r) throw new Error(`record not found: ${recordId}`);
    return { ...r, fields: { ...r.fields } };
  },
  createRecord: async () => ({}),
  updateRecord: async () => ({}),
  createField: async () => ({}),
};

// ---- 桩：plaza.js（停写开关语义一致：append 不外发）----
const plazaStub = { append: () => {}, PLAZA_ENABLED: false };

const stubs = {
  [path.join(ROOT, 'src/feishu/bot.js')]: botStub,
  [path.join(ROOT, 'src/feishu/bitable.js')]: bitableStub,
  [path.join(ROOT, 'src/services/plaza.js')]: plazaStub,
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

const ticketService = require(path.join(ROOT, 'src/services/ticketService.js'));
const syncService = require(path.join(ROOT, 'src/services/syncService.js'));

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}
const ACCEPT = '群内有组员接单后通过';

(async () => {
  console.log('\n== 1. 事件路径：撤回工单 → 提醒卡即时撤回（幂等） ==');
  TABLE.length = 0;
  TABLE.push(rec('recA', { '审批节点': ACCEPT, '申请状态': '审批中', '是否指定人员负责': '否' }));
  await ticketService.handleRecordCreate('recA', TABLE[0].fields); // 触发真播报 → 登记 oc_test1 卡
  check('播报已发生且登记（前置）', sentCards.length === 1);
  await ticketService.handleRecordUpdate('recA', { ...TABLE[0].fields, '申请状态': '已撤回' });
  check('撤回事件触发了提醒卡撤回', deletedMsgs.length === 1 && deletedMsgs[0] === 'om_1', JSON.stringify(deletedMsgs));
  await ticketService.handleRecordUpdate('recA', { ...TABLE[0].fields, '申请状态': '已撤回' });
  check('重复撤回事件幂等（不再二次撤回）', deletedMsgs.length === 1);

  console.log('\n== 2. 播报守卫：终态单即使节点仍是触发值也不补播 ==');
  TABLE.push(rec('recB', { '审批节点': ACCEPT, '申请状态': '已拒绝' }));
  const before = sentCards.length;
  await ticketService.handleRecordUpdate('recB', null); // 走 getRecord 回查路径
  check('终态单播报被拦截', sentCards.length === before);

  console.log('\n== 3. 对账补偿：事件漏掉后对账兜底撤回 ==');
  TABLE.push(rec('recC', { '审批节点': ACCEPT, '申请状态': '已撤回', '已播报': 'x' }));
  ticketService.rememberKeywordCard({ chatId: 'oc_g1', recordId: 'recC', messageId: 'om_c1', kind: 'open' });
  const r3 = await ticketService.reconcileBroadcasts();
  check('对账撤回登记的提醒卡', deletedMsgs.includes('om_c1'), JSON.stringify(deletedMsgs));
  check('对账返回 revoked=1', r3.revoked === 1, JSON.stringify(r3));
  check('终态单未被补播', sentCards.length === before);

  console.log('\n== 4. 队列剔除：终态单不占「接单N」序号 ==');
  TABLE.length = 0;
  TABLE.push(rec('recD1', { '审批节点': ACCEPT, '申请状态': '审批中' }));
  TABLE.push(rec('recD2', { '审批节点': ACCEPT, '申请状态': '已撤回' }));
  const queues = await ticketService.computeAcceptQueues();
  const d1 = (queues.get('oc_test1') || []).map((m) => m.recordId);
  check('队列只含正常单', d1.length === 1 && d1[0] === 'recD1', JSON.stringify([...queues.entries()]));
  check('唯一待接单 kw 回落「接单」', queues.get('oc_test1')?.[0]?.kw === '接单');

  console.log('\n== 5. 失败分支：230020 清登记不重试；瞬时失败保留待对账重试 ==');
  TABLE.length = 0;
  TABLE.push(rec('recE', { '审批节点': ACCEPT, '申请状态': '已撤回', '已播报': 'x' }));
  ticketService.rememberKeywordCard({ chatId: 'oc_g2', recordId: 'recE', messageId: 'om_fail', kind: 'open' });
  ticketService.rememberKeywordCard({ chatId: 'oc_g3', recordId: 'recE', messageId: 'om_gone', kind: 'open' });
  deleteBehavior.om_fail = 'fail';
  deleteBehavior.om_gone = 'gone';
  await ticketService.handleRecordUpdate('recE', null);
  check('消息不存在(230020)：立即清登记且只试一次', deletedMsgs.filter((m) => m === 'om_gone').length === 1);
  check('瞬时失败：登记保留（本轮未成功）', deletedMsgs.filter((m) => m === 'om_fail').length === 1);
  deleteBehavior.om_fail = 'ok'; // 下一轮对账恢复
  await ticketService.reconcileBroadcasts();
  check('对账补偿重试成功撤回', deletedMsgs.filter((m) => m === 'om_fail').length === 2, JSON.stringify(deletedMsgs));

  console.log('\n== 6. 口径一致性：isDiedStatus 与 STATUS_MAPPING 同源 ==');
  for (const s of ['已撤回', '已拒绝', '已取消', '已终止', '已删除']) {
    check(`「${s}」命中死亡终态`, syncService.isDiedStatus(s) === true);
  }
  check('「审批中/已通过」不命中', syncService.isDiedStatus('审批中') === false && syncService.isDiedStatus('已通过') === false);
  check('空值不命中', syncService.isDiedStatus('') === false && syncService.isDiedStatus(undefined) === false);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
