// 桩测试：未结单分组接口（/api/tickets/unclosed-by-group 主链路）——
// 标题口径（需求优先/编号作 code）/三桶判定/组别路由/排序/降级字段
// 全离线：stub 掉多维表格全量拉取与人员组别解析
// （接入 push.js 部署前测试闸门，行为改动必须过本套件）
const assert = require('assert/strict');
const config = require('../src/config');

const bitable = require('../src/feishu/bitable');
const personFields = require('../src/utils/personFields');

// ---- 测试桩：记录仓 + 组别解析（必须在 require unclosedService 之前打桩——
// 服务模块在加载时解构捕获这两个引用，后打桩不生效） ----
const DAY_MS = 24 * 60 * 60 * 1000;
let fakeRecords = [];

bitable.listAllRecords = async () => fakeRecords;
personFields.resolvePersonGroups = async (routeGroups, person) => {
  if (person.id === 'ou_a') return ['装配区'];
  if (person.id === 'ou_b') return ['工位区'];
  return [];
};

const { getUnclosedByGroup } = require('../src/services/unclosedService');

// 面向组别 → 群路由（测试专用最小映射）
config.broadcast.routeField = '面向组别';
config.broadcast.routes = [
  { value: '装配区', chatId: 'oc_zp' },
  { value: '工位区', chatId: 'oc_gw' },
];
config.assign.assigneeField = '指定负责人';
config.assign.supplementField = '补充负责人';

function rec(fields, id) {
  return { record_id: id || `rec${Math.random().toString(36).slice(2, 8)}`, fields };
}

(async () => {
  let pass = 0;
  const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log(`  ✅ ${label}`); };

  const now = Date.now();
  fakeRecords = [
    // 已接单 + 理想结单时间明天 → urgent（装配区群）；需求文本应有标题、编号进 code
    rec({
      '审批节点': '回执单：是否结单',
      '指定负责人': [{ id: 'ou_a', name: '张三' }],
      '理想结单时间': now + 1 * DAY_MS,
      '申请编号': 'GD-20260917-001',
      '需求': '装配区3D打印件上色处理',
    }, 'recU1'),
    // 已接单 + 5 天后结单 → week（工位区群）；无编号 → code 空、标题=需求
    rec({
      '审批节点': '回执单：是否结单',
      '补充负责人': [{ id: 'ou_b', name: '李四' }],
      '理想结单时间': now + 5 * DAY_MS,
      '需求1': '工位区工具柜补装层板',
    }, 'recW1'),
    // 触发节点 + 无人接单 + 已发布 8h → unclaimed（面向组别直分装配区群）
    rec({
      '审批节点': '有组员接单后通过',
      '面向组别': ['装配区'],
      '发起时间': now - 8 * 60 * 60 * 1000,
      '申请编号': 'GD-20260917-002',
    }, 'recUn1'),
    // 触发节点但刚发布 1h → 不播（宁漏勿误）
    rec({
      '审批节点': '有组员接单后通过',
      '面向组别': ['装配区'],
      '发起时间': now - 1 * 60 * 60 * 1000,
    }, 'recFresh'),
    // 已超理想结单时间 2 天 → urgent（负 daysLeft 保留，前端已超期标注）
    rec({
      '审批节点': '回执单：是否结单',
      '指定负责人': [{ id: 'ou_a', name: '张三' }],
      '理想结单时间': now - 2 * DAY_MS,
      '需求': '过期仍需曝光的工单',
    }, 'recOver'),
  ];

  const result = await getUnclosedByGroup();
  const zp = result['oc_zp'] || { urgent: [], week: [], unclaimed: [] };
  const gw = result['oc_gw'] || { urgent: [], week: [], unclaimed: [] };

  ok(zp.urgent.length === 2 && gw.week.length === 1, '分桶：urgent 2 条进装配区群、week 1 条进工位区群');
  ok(zp.week.length === 0 && gw.urgent.length === 0, '分桶：组别群互不串栏');

  const u1 = zp.urgent.find((t) => t.recordId === 'recU1');
  ok(u1 && u1.title === '装配区3D打印件上色处理' && u1.code === 'GD-20260917-001', '标题口径：需求优先、编号作 code（修复只显示编号）');
  ok(u1.handlerName === '张三' && u1.deadlineFormatted, '结单分栏：负责人与理想结单日期落字段');

  const w1 = gw.week[0];
  ok(w1.title === '工位区工具柜补装层板' && !w1.code, '标题口径：无编号时 code 为空、标题=需求1');

  const over = zp.urgent.find((t) => t.recordId === 'recOver');
  ok(over && over.daysLeft < 0, '超期工单：负 daysLeft 保留进 urgent（卡片已超期标注）');

  const un1 = zp.unclaimed.find((t) => t.recordId === 'recUn1');
  ok(un1 && un1.title === 'GD-20260917-002' && un1.code === 'GD-20260917-002', '无人接单：无需求文本时编号兜底标题');
  ok(Array.isArray(un1.groups) && un1.groups.includes('装配区'), '无人接单：面向组别透传 groups（卡片组别标注）');
  ok(un1.elapsedHours >= 8, '无人接单：已发布时长计算');

  ok(!result['oc_zp'].unclaimed.some((t) => t.recordId === 'recFresh'), '刚发布 1h 工单：不进无人接单分栏（6h 阈值）');

  // 长需求截断 40 字
  fakeRecords = [
    rec({
      '审批节点': '回执单：是否结单',
      '指定负责人': [{ id: 'ou_a', name: '张三' }],
      '理想结单时间': now + DAY_MS,
      '需求': 'X'.repeat(80),
    }, 'recLong'),
  ];
  const r2 = await getUnclosedByGroup();
  const long = r2['oc_zp'].urgent[0];
  ok(long.title.length === 41 && long.title.endsWith('…'), '长需求：截断 40 字 + 省略号');

  console.log(`\n结果：${pass} 通过 / 0 失败`);
  process.exit(0);
})().catch((err) => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
