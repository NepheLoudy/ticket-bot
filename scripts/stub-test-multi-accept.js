/**
 * 离线桩测试 · 多人接单窗口与指定负责人确认（v59 事故的回归测试）：
 *   覆盖 截止字段写入/解析、对账到期自动通过、截止缺失自愈、写入失败降级、
 *   指定负责人本人确认放行与短窗重复拦截、接单队列到期出队。
 * 全部外部依赖走桩，不读表/不写表/不发真实消息；需本地 .env（GROUP_ROUTES 路由用于断言通告群）。
 * 用法：node scripts/stub-test-multi-accept.js（全通过退出码 0）
 */
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

// ---- 桩：飞书 API / 卡 / 审批联动 / 静默闸门 / 人员组别 ----
const calls = { updates: [], cards: [], approves: [] };
let listRecords = [];
let updateShouldFail = false;

const stubs = {
  [path.join(ROOT, 'src/feishu/bitable.js')]: {
    listAllRecords: async () => listRecords,
    getRecord: async (appToken, tableId, id) => {
      const rec = listRecords.find((r) => r.record_id === id);
      if (!rec) throw new Error(`记录不存在: ${id}`);
      return rec;
    },
    updateRecord: async (appToken, tableId, id, fields) => {
      if (updateShouldFail) throw new Error('更新记录失败: TextFieldConvFail (code: 1254060)');
      calls.updates.push({ id, fields });
    },
    createField: async () => ({}),
  },
  [path.join(ROOT, 'src/services/syncService.js')]: {
    updateProjectStatus: async () => {},
    findTargetRecordByKey: async () => null,
    syncRecord: async () => ({ action: 'update', targetRecordId: 't1' }),
  },
  [path.join(ROOT, 'src/feishu/bot.js')]: {
    sendCardToTarget: async (target, card) => { calls.cards.push({ target, card }); return { message_id: 'om_test' }; },
    describeTarget: (t) => t.chatId || '(target)',
    buildTicketOpenCard: () => ({}),
    buildTicketAssignCard: () => ({}),
    buildReannounceCard: () => ({}),
    updateCardToChat: async () => ({}),
  },
  [path.join(ROOT, 'src/services/approvalLinkService.js')]: {
    autoApproveForTicket: async (record, name, role, comment) => {
      calls.approves.push({ id: record.record_id, name, role, comment });
      return { done: true, approved: 1 };
    },
  },
  [path.join(ROOT, 'src/utils/quietHours.js')]: { gateTask: () => false, gatePayload: () => false },
  [path.join(ROOT, 'src/utils/personFields.js')]: {
    resolvePersonGroups: async (routeGroups) => (Array.isArray(routeGroups) ? routeGroups : [routeGroups]).filter(Boolean),
    buildPersonFieldsByGroups: () => ({}),
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

const ticketService = require(path.join(ROOT, 'src/services/ticketService.js'));

const NODE_ACCEPT = '有组员接单后通过';
const NODE_ASSIGN_ACCEPT = '负责人确认消息后通过';
const ME = { id: 'ou_me', name: '张郭浩' };
const OTHER = { id: 'ou_other', name: '王义辰' };

function baseRecord(id, over = {}) {
  return {
    record_id: id,
    fields: {
      工单标题: `测试单 ${id}`,
      申请编号: `2026${id}`,
      审批节点: NODE_ACCEPT,
      是否指定人员负责: '否',
      指定负责人: [],
      补充负责人: [],
      面向组别: '机械组',
      创建时间: Date.now(),
      已播报: '2026/9/8 17:18:16 reconcile',
      ...over,
    },
  };
}

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}
function reset() { calls.updates.length = 0; calls.cards.length = 0; calls.approves.length = 0; updateShouldFail = false; }

(async () => {
  console.log('\n== 1. 对账：多人单窗口已到期（ISO 文本）→ 自动通过 + 结束通告 ==');
  reset();
  const past = formatWindowDeadlineStub(Date.now() - 60 * 60 * 1000);
  listRecords = [baseRecord('r-multi', { 是否允许多人接单: '是', 补充负责人: [ME], 多人接单截止: past })];
  let res = await ticketService.reconcileBroadcasts();
  check('审批自动通过被调用（多人单）', calls.approves.length === 1 && calls.approves[0].role === '多人单', JSON.stringify(calls.approves));
  check('发出「多人接单结束」卡', calls.cards.some((c) => c.card?.header?.title?.content === '✅ 多人接单结束'), JSON.stringify(calls.cards.map((c) => c.card?.header?.title?.content)));
  check('计数 multiClosed=1', res.multiClosed === 1, JSON.stringify(res));

  console.log('\n== 2. 对账：多人单截止缺失 → 重新计时（写 ISO 字符串），不误通过 ==');
  reset();
  listRecords = [baseRecord('r-multi-miss', { 是否允许多人接单: '是', 补充负责人: [ME], 多人接单截止: null })];
  res = await ticketService.reconcileBroadcasts();
  const wrote = calls.updates.find((u) => u.fields['多人接单截止']);
  check('回写截止字段', !!wrote, JSON.stringify(calls.updates));
  check('写入值为字符串且可解析（≈now+6h）', !!wrote && typeof wrote.fields['多人接单截止'] === 'string' && Math.abs(Date.parse(wrote.fields['多人接单截止']) - (Date.now() + 6 * 3600 * 1000)) < 120000, String(wrote?.fields['多人接单截止']));
  check('未触发自动通过', calls.approves.length === 0);

  console.log('\n== 3. 对账：多人单窗口未到期 → 不动作 ==');
  reset();
  const future = formatWindowDeadlineStub(Date.now() + 3 * 3600 * 1000);
  listRecords = [baseRecord('r-multi-open', { 是否允许多人接单: '是', 补充负责人: [ME], 多人接单截止: future })];
  res = await ticketService.reconcileBroadcasts();
  check('未触发自动通过', calls.approves.length === 0);
  check('未回写截止', calls.updates.length === 0, JSON.stringify(calls.updates));

  console.log('\n== 4. 接单确认：指定负责人本人（公示即绑定态）→ 允许确认并自动通过 ==');
  reset();
  listRecords = [baseRecord('r-spec', { 审批节点: NODE_ASSIGN_ACCEPT, 是否指定人员负责: '是', 指定负责人: [ME], 补充负责人: [ME] })];
  let r = await ticketService.handleAcceptOrder('oc_4994e3f0ca73f76b1243b38622637f47', ME.id, ME.name, '接单');
  check('确认成功', r.success === true, JSON.stringify(r));
  check('审批联动以「负责人」角色调用', calls.approves.length === 1 && calls.approves[0].role === '负责人', JSON.stringify(calls.approves));

  console.log('\n== 5. 接单确认：指定负责人短窗内重复确认 → 拒绝 ==');
  r = await ticketService.handleAcceptOrder('oc_4994e3f0ca73f76b1243b38622637f47', ME.id, ME.name, '接单');
  check('重复被拒', r.success === false && /已确认过/.test(r.reason || ''), JSON.stringify(r));

  console.log('\n== 6. 接单确认：多人单 → 窗口截止以 ISO 文本落库，不即时通过 ==');
  reset();
  listRecords = [baseRecord('r-multi-acc', { 是否允许多人接单: '是' })];
  r = await ticketService.handleAcceptOrder('oc_4994e3f0ca73f76b1243b38622637f47', OTHER.id, OTHER.name, '接单');
  check('确认成功', r.success === true, JSON.stringify(r));
  const w = calls.updates.find((u) => u.fields['多人接单截止']);
  check('截止以字符串写入（≈now+6h）', !!w && typeof w.fields['多人接单截止'] === 'string' && Math.abs(Date.parse(w.fields['多人接单截止']) - (Date.now() + 6 * 3600 * 1000)) < 120000, String(w?.fields['多人接单截止']));
  check('发出「多人接单进行中」卡', calls.cards.some((c) => c.card?.header?.title?.content === '👥 多人接单进行中'));
  check('未即时自动通过', calls.approves.length === 0);

  console.log('\n== 7. 接单确认：多人单窗口写入失败 → 降级为接单即自动通过 ==');
  reset();
  listRecords = [baseRecord('r-multi-fail', { 是否允许多人接单: '是' })];
  updateShouldFail = true;
  r = await ticketService.handleAcceptOrder('oc_4994e3f0ca73f76b1243b38622637f47', OTHER.id, OTHER.name, '接单');
  check('确认仍成功（不阻断接单）', r.success === true, JSON.stringify(r));
  check('降级触发自动通过', calls.approves.length === 1, JSON.stringify(calls.approves));
  check('未发续接询问卡', !calls.cards.some((c) => c.card?.header?.title?.content === '👥 多人接单进行中'));

  console.log('\n== 8. 接单队列：多人单到期出队 / 未到期与缺截止在队 ==');
  reset();
  listRecords = [
    baseRecord('r1', { 是否允许多人接单: '是', 补充负责人: [ME], 多人接单截止: past }),
    baseRecord('r2', { 是否允许多人接单: '是', 补充负责人: [ME], 多人接单截止: future }),
    baseRecord('r3', { 是否允许多人接单: '是', 补充负责人: [ME], 多人接单截止: null }),
  ];
  const queues = await ticketService.computeAcceptQueues();
  const ids = (queues.get('oc_4994e3f0ca73f76b1243b38622637f47') || []).map((m) => m.recordId);
  check('到期单 r1 已出队', !ids.includes('r1'), JSON.stringify(ids));
  check('未到期 r2 / 缺截止 r3 在队', ids.includes('r2') && ids.includes('r3'), JSON.stringify(ids));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('桩测试异常:', e); process.exit(1); });

// 本地复刻 formatWindowDeadline（与实现同式），用于构造 ISO 文本
function formatWindowDeadlineStub(ts) {
  const shifted = new Date(Number(ts) + 8 * 3600 * 1000);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}
