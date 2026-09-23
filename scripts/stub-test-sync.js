/**
 * 离线桩测试 · 工单搬运人员口径（2026-09-13 变更的回归测试）：
 *   指定负责人专项搬运废止——看板人员一律来自「补充负责人」全员（同组多人并集、跨组分字段），
 *   指定负责人本身不再直接入看板；category（项目性质）门控保留。
 * 全部外部依赖走桩，不读表/不写表；用法：node scripts/stub-test-sync.js（全通过退出码 0）
 */
process.env.PLAZA_BITABLE_TABLE_ID = ''; // 测试禁用动态广场写表（防污染生产表）
process.env.CATEGORY_FIELD = 'category'; // 与生产 .env 一致：门控字段即源表 category
process.env.USER_GROUPS = '测试员甲:机械组,测试员乙:机械组,测试员丙:电控组';
process.env.SOURCE_TABLE_ID = 'src'; // 源表/目标表分流（缺行修补用例需要）
process.env.TARGET_TABLE_ID = 'tgt';

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

// ---- 桩：多维表格（内存目标表，写后可见） ----
const targetRecords = []; // 看板表内存镜像
let sourceRecords = []; // 工单源表内存镜像（缺行修补用例）
const createdCalls = [];
const updatedCalls = [];
const parentLookups = []; // findParentProject 的 name 过滤调用记录（对账压力断言用）
let createDropKey = false; // 模拟建行时 key 未落库（返回体剔除 key）

const stubs = {
  [path.join(ROOT, 'src/feishu/bitable.js')]: {
    listAllRecords: async (appToken, tableId, filter) => {
      if (tableId === 'src') return sourceRecords.map((r) => ({ ...r }));
      if (typeof filter === 'string' && filter.includes('源记录ID')) {
        // 查重过滤：CurrentValue.[源记录ID] = "xxx"
        return targetRecords.filter((r) => {
          const key = r.fields['源记录ID'];
          return key && filter.includes(`"${key}"`);
        });
      }
      if (typeof filter === 'string' && filter.includes('CurrentValue.[name]')) {
        // 父项目/孤儿行过滤：CurrentValue.[name] = "xxx"（findParentProject 语义）
        parentLookups.push(filter);
        const m = filter.match(/CurrentValue\.\[name\] = "((?:[^"\\]|\\.)*)"/);
        const wanted = m ? m[1].replace(/\\(["\\])/g, '$1') : null;
        return targetRecords.filter((r) => r.fields.name !== undefined && String(r.fields.name) === wanted);
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
      const stored = { ...fields };
      const returned = { ...fields };
      if (createDropKey) {
        delete returned['源记录ID']; // 模拟 key 未落库（读回体里没有）
        delete stored['源记录ID'];
      }
      const rec = { record_id: id, fields: stored };
      targetRecords.push(rec);
      createdCalls.push(rec);
      return { record_id: id, fields: returned };
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

  console.log('\n== 5. 缺行修补（事件丢失兜底 2026-09-17；缺 parentId 修补 2026-09-20）==');
  {
    // 源表三条 category 门控记录：r1 行在且 parentId 齐全、rP 行在但缺 parentId、rY 从未搬运
    targetRecords.length = 0;
    targetRecords.push({ record_id: 'tpar', fields: { name: '测试项目' } }); // 父项目行（name 过滤命中）
    targetRecords.push({ record_id: 't-pre1', fields: { '源记录ID': 'r1', parentId: ['t-pre1'] } });
    targetRecords.push({ record_id: 't-pre2', fields: { '源记录ID': 'rP' } });
    updatedCalls.length = 0;
    createdCalls.length = 0;
    sourceRecords = [
      { record_id: 'r1', fields: baseFields() },
      { record_id: 'rP', fields: baseFields({ 申请编号: '202609200002' }) },
      { record_id: 'rY', fields: baseFields({ 申请编号: '202609170001', 补充负责人: [A] }) },
    ];
    const rep = await syncService.repairMissingTargets();
    check('修补：扫描条数 = 门控记录数', rep.scanned === 3, JSON.stringify(rep));
    check('修补：补建/补挂共 2 条（1 建 1 更）', rep.repaired === 2 && createdCalls.length === 1 && updatedCalls.length === 1, JSON.stringify(rep.items));
    check('修补：补建的是缺行那条 rY', rep.items.some((i) => i.recordId === 'rY' && i.action === 'created'), JSON.stringify(rep.items));
    check('修补：行在缺 parentId 的 rP 被补挂', rep.items.some((i) => i.recordId === 'rP' && i.action === 'updated'), JSON.stringify(rep.items));
    check('修补：parentId 齐全的 r1 不被重写', updatedCalls.filter((u) => u.id === 't-pre1').length === 0);
    const rep2 = await syncService.repairMissingTargets();
    check('修补：幂等（第二轮零补建）', rep2.repaired === 0, JSON.stringify(rep2));
  }

  console.log('\n== 6. parentId diff 门控修复（2026-09-23：每分钟重写风暴回归）==');
  {
    // 真实 API 读回形态：parentId 是 {record_ids:[...], text:...} 对象数组——
    // 旧归一化拿 text 与补丁侧裸 record id 比，永不相等 → 每分钟无条件重写看板行
    targetRecords.length = 0;
    targetRecords.push({ record_id: 'tpar6', fields: { name: '测试项目' } });
    targetRecords.push({
      record_id: 't-r6',
      fields: {
        '源记录ID': 'r6',
        name: '（支持项目支持项目）',
        category: '支持项目',
        status: 'waiting',
        priority: 'low',
        parentId: [{ record_ids: ['tpar6'], text: '测试项目', table_id: 'tgt', type: 'text' }],
        owner: [{ id: 'ou_me' }],
      },
    });
    updatedCalls.length = 0;
    createdCalls.length = 0;
    parentLookups.length = 0;
    const rec6 = { record_id: 'r6', fields: baseFields({ 补充负责人: [A] }) };
    const res6 = await syncService.syncRecord(rec6);
    check('已挂对父项目的行 → unchanged（diff 门控不再被 parentId 击穿）', res6.action === 'unchanged', JSON.stringify(res6));
    check('不再重查父项目（每分钟对账的 API 压力主源）', parentLookups.length === 0, JSON.stringify(parentLookups));
    check('零写操作（每分钟重写风暴修复）', updatedCalls.length === 0 && createdCalls.length === 0, JSON.stringify(updatedCalls));

    // 父项目改名：已挂父项目 text 与源 name 不符 → 重查并重挂
    targetRecords.push({ record_id: 'tpar6b', fields: { name: '测试项目2' } });
    const rec6b = { record_id: 'r6', fields: baseFields({ name: '测试项目2', 补充负责人: [A] }) };
    const res6b = await syncService.syncRecord(rec6b);
    const reParent = updatedCalls.find((u) => u.id === 't-r6');
    check('父项目名变了 → 重查并重挂新父项目', res6b.action === 'updated' && String(reParent?.fields?.parentId?.[0]) === 'tpar6b', JSON.stringify(reParent));
  }

  console.log('\n== 7. 建行 key 落库校验（2026-09-23：孤儿行根治）==');
  {
    targetRecords.length = 0;
    createdCalls.length = 0;
    updatedCalls.length = 0;
    createDropKey = true; // 模拟建行时 key 未落库（字段缺失/权限抖动/环境快照旧值）
    const rec7 = { record_id: 'r7', fields: baseFields({ category: '基建', 需求: '需求文本7', 理想结单时间: 1790179200000 }) };
    const res7 = await syncService.syncRecord(rec7);
    check('建行成功', res7.action === 'created', JSON.stringify(res7));
    const backfill = updatedCalls.find((u) => u.id === res7.targetRecordId && u.fields['源记录ID'] === 'r7');
    check('检测到 key 未落库并当场补写', !!backfill, JSON.stringify(updatedCalls));
    const row7 = targetRecords.find((t) => t.record_id === res7.targetRecordId);
    check('最终 key 已落库（下一轮可查重）', row7?.fields['源记录ID'] === 'r7', JSON.stringify(row7?.fields));
    createDropKey = false;
    const res7b = await syncService.syncRecord(rec7);
    check('下一轮同步查重命中（不再建重复行）', (res7b.action === 'updated' || res7b.action === 'unchanged') && res7b.targetRecordId === res7.targetRecordId, JSON.stringify(res7b));
  }

  console.log('\n== 8. 无 key 孤儿行收养（2026-09-23：存量孤儿不再繁衍重复行）==');
  {
    targetRecords.length = 0;
    targetRecords.push({ record_id: 'tpar8', fields: { name: '测试项目' } });
    targetRecords.push({
      record_id: 't-orphan',
      fields: {
        name: '（基建支持项目）', category: '基建', status: 'waiting',
        ddl: 1790179200000, fileToken: '需求文本9',
        parentId: [{ record_ids: ['tpar8'], text: '测试项目', table_id: 'tgt', type: 'text' }],
      },
    });
    createdCalls.length = 0;
    updatedCalls.length = 0;
    const rec8 = { record_id: 'r9', fields: baseFields({ category: '基建', 需求: '需求文本9', 理想结单时间: 1790179200000, 补充负责人: [A] }) };
    const res8 = await syncService.syncRecord(rec8);
    check('同工单遗留孤儿行 → adopted 不新建', res8.action === 'adopted' && createdCalls.length === 0, JSON.stringify({ res: res8, created: createdCalls.length }));
    check('孤儿行已补查重 key', targetRecords.find((t) => t.record_id === 't-orphan')?.fields['源记录ID'] === 'r9');
    const adopted = targetRecords.find((t) => t.record_id === 't-orphan');
    check('收养后按最新源数据补字段（人员并入）', personIds(adopted.fields, 'owner').includes('ou_me'), JSON.stringify(adopted.fields));

    // 严格匹配不认错行：fileToken 不同 → 不收养，照常新建
    targetRecords.push({
      record_id: 't-orphan2',
      fields: { name: '（基建支持项目）', category: '基建', ddl: 1790179200000, fileToken: '别的需求', parentId: ['tpar8'] },
    });
    const rec8b = { record_id: 'r9b', fields: baseFields({ category: '基建', 需求: '需求文本9b', 理想结单时间: 1790179200000 }) };
    const res8b = await syncService.syncRecord(rec8b);
    check('严格匹配不认错行：fileToken 不同 → 照常新建', res8b.action === 'created', JSON.stringify(res8b));
  }

  console.log('\n== 9. syncAll 计数带 adopted 桶 ==');
  {
    targetRecords.length = 0;
    targetRecords.push({ record_id: 'tpar9', fields: { name: '测试项目' } });
    targetRecords.push({
      record_id: 't-orphan9',
      fields: { name: '（基建支持项目）', category: '基建', ddl: 1790179200000, fileToken: '别的需求', parentId: ['tpar9'] },
    });
    sourceRecords = [
      { record_id: 'r10', fields: baseFields({ category: '基建', 需求: '别的需求', 理想结单时间: 1790179200000 }) },
    ];
    const all = await syncService.syncAll();
    check('syncAll 计数含 adopted=1', all.adopted === 1, JSON.stringify(all));
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
