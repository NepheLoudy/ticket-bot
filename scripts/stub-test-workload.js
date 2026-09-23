// 桩测试：未结单工单按人展开（/api/tickets/workload-by-person 主链路）——
// 按人摊派/指定∪补充去重/无负责人单不挂人/多人摊薄计数/负载视角不丢无路由工单
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

const { getWorkloadByPerson } = require('../src/services/unclosedService');

config.broadcast.routeField = '面向组别';
config.broadcast.routes = [
  { value: '装配区', chatId: 'oc_zp' },
  { value: '工位区', chatId: 'oc_gw' },
]; // 注意：不配「管理层」路由——负载视角必须不因无路由丢单
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
    // 指定负责人 ou_a + 结单时间明天 → urgent，摊到张三
    rec({
      '审批节点': '回执单：是否结单',
      '指定负责人': [{ id: 'ou_a', name: '张三' }],
      '理想结单时间': now + 1 * DAY_MS,
      '发起时间': now - 3 * DAY_MS,
      '申请编号': 'GD-001',
      '需求': '装配区急单',
    }, 'recU1'),
    // 指定 ou_a + 补充 ou_b → 两人各挂一单、shareCount=2（消费侧按人数摊薄）
    rec({
      '审批节点': '回执单：是否结单',
      '指定负责人': [{ id: 'ou_a', name: '张三' }],
      '补充负责人': [{ id: 'ou_b', name: '李四' }],
      '理想结单时间': now + 5 * DAY_MS,
      '发起时间': now - 2 * DAY_MS,
      '需求': '双人协作单',
    }, 'recShare'),
    // 同一人同时出现在指定+补充两字段 → 按 id 去重，只挂一次、shareCount=1
    rec({
      '审批节点': '回执单：是否结单',
      '指定负责人': [{ id: 'ou_a', name: '张三' }],
      '补充负责人': [{ id: 'ou_a', name: '张三' }],
      '理想结单时间': now + 1 * DAY_MS,
      '发起时间': now - 1 * DAY_MS,
      '需求': '公示即绑定的指定单',
    }, 'recDup'),
    // 回执节点 + 无负责人 → 不挂人，进 orphanTickets（带面向组别）
    rec({
      '审批节点': '回执单：是否结单',
      '面向组别': ['工位区'],
      '发起时间': now - 1 * DAY_MS,
      '需求': '无负责人的回执单',
    }, 'recOrphan'),
    // 面向组别=管理层（播报路由不存在）+ 负责人 ou_c → 负载视角必须保留
    rec({
      '审批节点': '回执单：是否结单',
      '面向组别': ['管理层'],
      '指定负责人': [{ id: 'ou_c', name: '王五' }],
      '理想结单时间': now + 6 * DAY_MS,
      '发起时间': now - 1 * DAY_MS,
      '需求': '管理层工单（播报视角不进 DDL 分栏）',
    }, 'recMgnt'),
    // 触发节点 + 无人接单 + 已发布 8h → unclaimed 单列（不挂人）
    rec({
      '审批节点': '有组员接单后通过',
      '面向组别': ['装配区'],
      '发起时间': now - 8 * 60 * 60 * 1000,
      '申请编号': 'GD-002',
    }, 'recUn1'),
    // 回执节点 + 有负责人 + 未填结单时间 → waiting 桶
    rec({
      '审批节点': '回执单：是否结单',
      '指定负责人': [{ id: 'ou_b', name: '李四' }],
      '发起时间': now - 4 * DAY_MS,
      '需求': '未填结单时间工单',
    }, 'recWait3'),
  ];

  const { persons, orphanTickets, unclaimed } = await getWorkloadByPerson();

  // —— 按人展开与去重 ——
  const zs = persons['ou_a'];
  ok(zs && zs.name === '张三', '按人展开：张三条目在');
  ok(zs.tickets.length === 3 && zs.tickets.every((t) => ['recU1', 'recShare', 'recDup'].includes(t.recordId)),
    '指定∪补充去重：recDup 同人不重复挂、共 3 单');
  ok(zs.tickets.find((t) => t.recordId === 'recDup').shareCount === 1, '去重后 shareCount=1（摊薄按实际人数）');
  ok(zs.tickets.find((t) => t.recordId === 'recShare').shareCount === 2, '多人单 shareCount=2（消费侧摊薄依据）');

  // —— 分桶判定与播报视角一致 ——
  ok(zs.tickets.find((t) => t.recordId === 'recU1').bucket === 'urgent', '分桶：1 日内 → urgent');
  ok(zs.tickets.find((t) => t.recordId === 'recShare').bucket === 'week', '分桶：5 日 → week');
  const ls = persons['ou_b'];
  ok(ls.tickets.find((t) => t.recordId === 'recWait3').bucket === 'waiting', '分桶：未填结单时间 → waiting');
  ok(ls.tickets.find((t) => t.recordId === 'recWait3').daysLeft === null && ls.tickets.find((t) => t.recordId === 'recWait3').deadlineMs === null,
    '未填结单时间：daysLeft/deadlineMs 为 null');

  // —— 负载视角不丢无路由工单（与播报视角的口径差异） ——
  const ww = persons['ou_c'];
  ok(ww && ww.tickets.some((t) => t.recordId === 'recMgnt'), '管理层工单（无播报路由）：负载视角保留负责人 ou_c');
  ok(ww.groups.length === 0, '通讯录/手动映射都解不出时组别为空（不硬造）');

  // —— 无负责人/无人接单不挂人 ——
  ok(orphanTickets.length === 1 && orphanTickets[0].recordId === 'recOrphan', '无负责人回执单：进 orphanTickets 不挂人');
  ok(Array.isArray(orphanTickets[0].groups) && orphanTickets[0].groups.includes('工位区'), 'orphan 携带面向组别');
  ok(!('ou_x' in persons), '无人接单单不产生人条目');
  ok(unclaimed.length === 1 && unclaimed[0].recordId === 'recUn1' && unclaimed[0].groups.includes('装配区'),
    'unclaimed 单列（带面向组别，供组别待接压力）');

  // —— 组别解析与时效原料 ——
  ok(zs.groups.includes('装配区') && ls.groups.includes('工位区'), '每人输出组别（resolvePersonGroups 解析）');
  ok(zs.tickets.find((t) => t.recordId === 'recU1').createdMs > 0, '时效原料透传（createdMs 在场）');
  ok(unclaimed[0].elapsedHours >= 8 && unclaimed[0].createdMs > 0, 'unclaimed 带发起时间与滞留时长');
  ok(zs.tickets.find((t) => t.recordId === 'recU1').deadlineMs > now, 'deadlineMs 毫秒值透传（消费侧时效计算原料）');

  console.log(`\n结果：${pass} 通过 / 0 失败`);
  process.exit(0);
})().catch((err) => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
