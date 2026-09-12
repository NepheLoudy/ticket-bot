/**
 * 离线桩测试 · 工单搬运人员口径（2026-09-13 变更的回归测试）：
 *   指定负责人专项搬运废止——看板人员一律来自「补充负责人」全员（同组多人并集、跨组分字段），
 *   指定负责人本身不再直接入看板；category（项目性质）门控保留。
 * 全部外部依赖走桩，不读表/不写表；用法：node scripts/stub-test-sync.js（全通过退出码 0）
 */
process.env.PLAZA_BITABLE_TABLE_ID = ''; // 测试禁用动态广场写表（防污染生产表）
process.env.CATEGORY_FIELD = 'category'; // 与生产 .env 一致：门控字段即源表 category
process.env.USER_GROUPS = '测试员甲:机械组,测试员乙:机械组,测试员丙:电控组';

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

// ---- 桩：多维表格（内存目标表，写后可见） ----
const targetRecords = []; // 看板表内存镜像
const createdCalls = [];
const updatedCalls = [];

const stubs = {
  [path.join(ROOT, 'src/feishu/bitable.js')]: {
    listAllRecords: async (appToken, tableId, filter) => {
      if (typeof filter === 'string' && filter.includes('源记录ID')) {
        // 查重过滤：CurrentValue.[源记录ID] = "xxx"
        return targetRecords.filter((r) => {
          const key = r.fields['源记录ID'];
          return key && filter.includes(`"${key}"`);
        });
      }
      return targetRecords.map((r) => ({ ...r }));
    },
    getRecord: async (appToken, tableId, id) => {
      const rec = targetRecords.find((r) => r.record_id === id);
      if (!rec) throw new Error(`记录不存在: ${id}`);
      return rec;
    },
    createRecord: async (appToken, tableId, fields) => {
      const id = `t${targetRecords.length + 1}`;
      const rec = { record_id: id, fields: { ...fields } };
      targetRecords.push(rec);
      createdCalls.push(rec);
      return { record_id: id };
    },
    updateRecord: async (appToken, tableId, id, fields) => {
      const rec = targetRecords.find((r) => r.record_id === id);
      if (rec) rec.fields = { ...rec.fields, ...fields };
      updatedCalls.push({ id, fields });
      return { code: 0 };
    },
    createField: async () => ({}),
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

const syncService = require(path.join(ROOT, 'src/services/syncService.js'));

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}
function personIds(fields, name) {
  return (fields[name] || []).map((p) => p.id);
}

const LEADER = { id: 'ou_leader', name: '组长甲' }; // 指定负责人（不在 USER_GROUPS，不应入看板）
const A = { id: 'ou_me', name: '测试员甲' };         // 机械组 → owner
const B = { id: 'ou_other', name: '测试员乙' };      // 机械组 → owner
const C = { id: 'ou_c', name: '测试员丙' };          // 电控组 → dkyjcontributers

function baseFields(over = {}) {
  return {
    name: '测试项目',
    申请编号: '202609130001',
    审批节点: '有组员接单后通过',
    category: '支持项目',
    面向组别: ['机械组'],
    指定负责人: [],
    补充负责人: [],
    ...over,
  };
}

(async () => {
  console.log('\n== 1. 指定负责人单：只搬补充负责人全员，指定负责人不入看板 ==');
  {
    const rec = { record_id: 'r1', fields: baseFields({ 指定负责人: [LEADER], 补充负责人: [A, B] }) };
    const res = await syncService.syncRecord(rec);
    check('搬运成功（新建）', res.action === 'created', JSON.stringify(res));
    const board = createdCalls[0].fields;
    const owner = personIds(board, 'owner');
    check('owner 含补充负责人两人（同组并集）', owner.includes('ou_me') && owner.includes('ou_other'), JSON.stringify(board.owner));
    check('指定负责人未入看板', !owner.includes('ou_leader') && !personIds(board, 'dkyjcontributers').includes('ou_leader'), JSON.stringify({ owner, dkyj: board.dkyjcontributers }));
    check('category 门控字段照搬（项目性质）', board.category === '支持项目', JSON.stringify(board.category));
  }

  console.log('\n== 2. 跨组补充负责人：各自归组字段 ==');
  {
    createdCalls.length = 0;
    const rec = { record_id: 'r2', fields: baseFields({ 补充负责人: [A, C] }) };
    await syncService.syncRecord(rec);
    const board = createdCalls[0].fields;
    check('机械组人归 owner', personIds(board, 'owner').includes('ou_me'), JSON.stringify(board.owner));
    check('电控组人归 dkyjcontributers', personIds(board, 'dkyjcontributers').includes('ou_c'), JSON.stringify(board.dkyjcontributers));
  }

  console.log('\n== 3. 更新路径：看板已有人员与新增并集，不互覆不清空 ==');
  {
    // 预置看板已有一条（含历史人员 ou_old）+ 源记录ID 关联
    targetRecords.length = 0;
    targetRecords.push({ record_id: 't-pre', fields: { '源记录ID': 'r3', owner: [{ id: 'ou_old' }] } });
    updatedCalls.length = 0;
    const rec = { record_id: 'r3', fields: baseFields({ 补充负责人: [A, B] }) };
    const res = await syncService.syncRecord(rec);
    check('走更新路径', res.action === 'updated', JSON.stringify(res));
    const board = targetRecords.find((r) => r.record_id === 't-pre').fields;
    const owner = personIds(board, 'owner');
    check('历史人员保留', owner.includes('ou_old'), JSON.stringify(board.owner));
    check('新增补充负责人两人并入', owner.includes('ou_me') && owner.includes('ou_other'), JSON.stringify(board.owner));
  }

  console.log('\n== 4. category 门控：项目性质为空不参与搬运判定 ==');
  {
    check('hasCategory：有值 → true', syncService.hasCategory({ category: '支持项目' }) === true);
    check('hasCategory：空串 → false', syncService.hasCategory({ category: '' }) === false);
    check('hasCategory：缺字段 → false', syncService.hasCategory({}) === false);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
