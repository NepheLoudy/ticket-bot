const config = require('../config');
const bitableApi = require('../feishu/bitable');
const { toDateOnlyTimestamp } = require('../utils/fields');
const { resolvePersonGroups, buildPersonFieldsByGroups, mergePersonFields } = require('../utils/personFields');

/**
 * 同步服务：将工单记录搬运到项目看板
 * - category 有值时触发
 * - name 字段值作为父项目名称，在项目看板中查找匹配记录作为 parentId
 * - 人员字段一律来自「补充负责人」全员（2026-09-13 口径：指定负责人公示时即写入补充负责人，
 *   专项搬运废止；机械→owner，电控/硬件→dkyjcontributers，视觉→sjcontributers，宣运→xycontributers）
 */

// ============================================================
// 状态映射：工单申请状态 → 项目看板 status
// 已通过=发起人已结单 → completed；已拒绝/撤回等 → died
// 审批中按审批节点推进：
//   - 触发节点（群内有组员接单后通过/负责人确认消息后通过）→ waiting（等待接单/等待负责人确认）
//   - 回执单节点（负责人已确认接单）→ in_progress
// ============================================================
const STATUS_MAPPING = {
  '已通过': 'completed',
  '已删除': 'died',
  '已拒绝': 'died',
  '已取消': 'died',
  '已终止': 'died',
  '已撤回': 'died',
};

function statusRank(s) {
  return { pending: 0, waiting: 1, in_progress: 2, completed: 3, died: 4 }[s] ?? 0;
}

/**
 * status 只向前推进，防止对账 upsert 把业务事件（接单确认→in_progress）重置回 waiting
 * completed/died 为终态直接覆盖
 */
function shouldOverrideStatus(current, target) {
  if (target === 'completed' || target === 'died') return true;
  return statusRank(target) >= statusRank(current);
}

function mapStatus(applyStatus, approvalNode) {
  if (!applyStatus) return 'pending';
  if (STATUS_MAPPING[applyStatus]) return STATUS_MAPPING[applyStatus];

  // 审批中：按审批节点推进（节点值可能为并行分支多段拼接，统一拆段匹配）
  if (approvalNode) {
    if (config.matchNodeValue(approvalNode, [config.approvalNode.closeValue])) return 'in_progress';
    if (config.matchNodeValue(approvalNode, config.approvalNode.acceptValues)) return 'waiting';
  }
  return 'pending';
}

// 过滤公式值转义：项目名/记录键含双引号或反斜杠时，裸拼接会让过滤永久报错
//（报错路径 = findParentProject 返回 null → 该行永久缺 parentId），故统一转义
function escapeFilterValue(v) {
  return String(v).replace(/(["\\])/g, '\\$1');
}

/** 字段值归一化（供 diff 门控比较：person/关联数组、文本对象、标量各归到可比较形态） */
function normalizeFieldValue(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Array.isArray(v)) {
    return JSON.stringify(v.flatMap((x) => {
      if (x && typeof x === 'object') {
        // 关联字段（parentId）读回形态是 {record_ids:[...], text:...}——必须摊平成 record id
        // 再比，否则与补丁侧的裸 id 数组永不相等，diff 门控被击穿 → 每分钟重写看板行
        // （共享 base 被自家写满 → 1254607/查父项目 15s 超时风暴，2026-09-23 事故）
        if (Array.isArray(x.record_ids)) return x.record_ids.map(String);
        return [String(x.record_id || x.id || x.text || x.en_us || JSON.stringify(x))];
      }
      return [String(x)];
    }).sort());
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** patch 中任一字段与现有行不同（或现有行缺失该字段值）即为有差异 */
function fieldsDiffer(existingFields, patch) {
  return Object.entries(patch).some(([k, v]) => {
    if (v === undefined) return false;
    return normalizeFieldValue(existingFields && existingFields[k]) !== normalizeFieldValue(v);
  });
}

/**
 * 在项目看板中查找父项目（根据 name 字段值匹配）
 * @param {string} parentName 父项目名称
 * @returns {Promise<string|null>} 父项目 record_id，未找到返回 null
 */
async function findParentProject(parentName) {
  if (!parentName) return null;

  try {
    // 查询项目看板中 name 字段匹配的记录
    const filter = `CurrentValue.[name] = "${escapeFilterValue(parentName)}"`;
    const records = await bitableApi.listAllRecords(
      config.bitable.targetAppToken,
      config.bitable.targetTableId,
      filter
    );

    if (records && records.length > 0) {
      return records[0].record_id;
    }

    console.warn(`[同步服务] 未找到父项目: ${parentName}`);
    return null;
  } catch (err) {
    console.error(`[同步服务] 查找父项目失败: ${parentName}`, err.message);
    return null;
  }
}

/**
 * category 门控：配置了 CATEGORY_FIELD 时，仅该字段有值的记录参与搬运
 */
function hasCategory(fields) {
  if (!config.sync.categoryField) return true;
  const v = fields[config.sync.categoryField];
  return !(v === null || v === undefined || v === '');
}

/**
 * 构造目标表字段（完整映射逻辑）
 * @param {object} sourceFields 工单字段
 * @param {string} sourceRecordId 工单 record_id
 * @param {string|null} parentRecordId 父项目 record_id
 * @returns {object} 项目看板字段
 */
async function buildTargetFields(sourceFields, sourceRecordId, parentRecordId) {
  const targetFields = {};

  // 1. 源记录ID（查重依据）
  targetFields[config.sync.syncKeyField] = sourceRecordId;

  // 2. category
  if (sourceFields['category']) {
    targetFields['category'] = sourceFields['category'];
  }

  // 3. ddl（理想结单时间，去掉时分秒；字段名走 DEADLINE_FIELD 配置）
  if (sourceFields[config.closeReminder.deadlineField]) {
    targetFields['ddl'] = toDateOnlyTimestamp(sourceFields[config.closeReminder.deadlineField]);
  }

  // 4. fileToken（需求）
  if (sourceFields['需求'] || sourceFields['需求1']) {
    targetFields['fileToken'] = sourceFields['需求'] || sourceFields['需求1'];
  }

  // 5. priority 默认 low（仅创建时写入；update 路径在 syncRecord 中剔除，
  //    避免每分钟对账把人工/pm-robot 的优先级编辑打回默认值）
  targetFields['priority'] = 'low';

  // 6. status（申请状态 + 审批节点推进：已通过→completed，等待接单/确认→waiting，回执单→in_progress）
  //    字段名走 STATUS_FIELD 配置（未配置回落历史字段名，保持旧行为）
  const applyStatus = sourceFields[config.broadcast.statusField || '申请状态'];
  const approvalNode = config.approvalNode.field ? sourceFields[config.approvalNode.field] : '';
  targetFields['status'] = mapStatus(applyStatus, approvalNode);

  // 7. parentId（父项目关联）
  if (parentRecordId) {
    targetFields['parentId'] = [parentRecordId];
  }

  // 8. 人员字段：一律来自「补充负责人」（见 syncRecord 3.5，指定负责人专项搬运已废止）

  // 9. name：支持项目统一命名「（category支持项目）」；category 为空时回退申请编号/需求
  const category = sourceFields['category'];
  if (category) {
    targetFields['name'] = `（${category}支持项目）`;
  } else {
    const title = sourceFields['申请编号'] || sourceFields['需求'] || sourceFields['需求1'] || `工单-${sourceRecordId.slice(-6)}`;
    targetFields['name'] = typeof title === 'string' ? title : (title.text || title.link || `工单-${sourceRecordId.slice(-6)}`);
  }

  return targetFields;
}

/**
 * 在目标表中按「源记录ID」查找已有记录
 */
async function findTargetRecordByKey(sourceRecordId) {
  const filter = `CurrentValue.[${config.sync.syncKeyField}] = "${escapeFilterValue(sourceRecordId)}"`;
  const records = await bitableApi.listAllRecords(
    config.bitable.targetAppToken,
    config.bitable.targetTableId,
    filter
  );
  return records[0] || null;
}

/**
 * 确保目标表存在「源记录ID」查重字段（缺失时创建，仅尝试一次）
 */
let keyFieldReady = false;
async function ensureKeyField({ force = false } = {}) {
  if (keyFieldReady && !force) return;
  try {
    await bitableApi.createField(
      config.bitable.targetAppToken,
      config.bitable.targetTableId,
      config.sync.syncKeyField
    );
    console.log(`[同步服务] 已在目标表创建查重字段「${config.sync.syncKeyField}」`);
  } catch (err) {
    // 字段已存在等场景视作就绪；真正的写入失败会在 syncRecord 的 key 落库校验暴露并重试
    //（force 路径 = key 未落库后的补救，失败不再静默闩死）
    if (force) console.error(`[同步服务] 补建查重字段「${config.sync.syncKeyField}」失败:`, err.message);
  }
  if (!force) keyFieldReady = true;
}

/**
 * 收养无 key 孤儿行：同名（（category支持项目））且「源记录ID」为空的历史行，
 * 再按 ddl/fileToken/category/父项目严格匹配确认是同一工单的遗留（防止认错行）。
 * 背景：2026-09-15 前后看板上出现过建行时 key 未落库的孤儿行——查重永远查不到它，
 * 之后的每次同步都会再建一条（李妍基建支持工单即此：正行 completed、孤儿行永卡 waiting，
 * 还卡住 pm-robot「children 全完成→父项目收尾」判定）。收养=补上 key，不再造重复行。
 */
async function findUnkeyedTwin(sourceFields, parentRecordId) {
  const category = sourceFields['category'];
  if (!category) return null;
  const name = `（${category}支持项目）`;
  const filter = `CurrentValue.[name] = "${escapeFilterValue(name)}"`;
  const records = await bitableApi.listAllRecords(
    config.bitable.targetAppToken,
    config.bitable.targetTableId,
    filter
  );

  const sourceDdl = sourceFields[config.closeReminder.deadlineField]
    ? Number(toDateOnlyTimestamp(sourceFields[config.closeReminder.deadlineField]))
    : null;
  const sourceToken = sourceFields['需求'] || sourceFields['需求1'] || null;

  const twins = (records || []).filter((r) => {
    const f = r.fields;
    if (f[config.sync.syncKeyField]) return false; // 已有 key 的行不是孤儿
    if (normalizeFieldValue(f['category']) !== normalizeFieldValue(category)) return false;
    if (sourceDdl !== null && Number(f['ddl']) !== sourceDdl) return false;
    if (sourceDdl === null && f['ddl']) return false;
    if (normalizeFieldValue(f['fileToken']) !== normalizeFieldValue(sourceToken)) return false;
    const parentIds = Array.isArray(f['parentId']) ? f['parentId'].flatMap((p) => {
      if (p && typeof p === 'object') return (p.record_ids || [p.record_id || p.id].filter(Boolean)).map(String);
      return [String(p)];
    }) : [];
    if (parentRecordId && !parentIds.includes(String(parentRecordId))) return false;
    return true;
  });
  return twins[0] || null;
}

/**
 * 同步单条工单记录到项目看板
 * @param {{record_id: string, fields: object}} sourceRecord
 * @returns {Promise<{action: 'created'|'updated'|'adopted', targetRecordId: string, parentRecordId: string|null}>}
 */
async function syncRecord(sourceRecord) {
  await ensureKeyField();

  const { record_id, fields } = sourceRecord;

  // 1. 查重先行（旧流程先查父项目——已挂对父项目的行也被每分钟对账重查+重写，
  //    而查父项目正是超时/限频重灾区，还白烧共享应用配额）
  const existing = await findTargetRecordByKey(record_id);

  // 2. 父项目查找：仅建行 / 行缺 parentId / 已挂父项目与源 name 不符（父项目改名）时执行；
  //    已挂对的行不重查也不重写
  const sourceParentName = fields['name'] !== null && fields['name'] !== undefined ? String(fields['name']) : '';
  const rawParent = Array.isArray(existing?.fields?.parentId) ? existing.fields.parentId[0] : null;
  const existingParentId = rawParent === null || rawParent === undefined
    ? null
    : (typeof rawParent === 'string'
      ? rawParent
      : (Array.isArray(rawParent.record_ids) ? rawParent.record_ids[0] : (rawParent.record_id || rawParent.id || null)));
  const existingParentText = rawParent && typeof rawParent === 'object' ? String(rawParent.text || '') : '';
  let parentRecordId = null;
  if (
    !existing
    || !existingParentId
    || (existingParentText && sourceParentName && existingParentText !== sourceParentName)
  ) {
    parentRecordId = await findParentProject(sourceParentName);
  }

  // 3. 构造目标字段（2026-09-13 口径：指定负责人公示时即写入「补充负责人」，专项搬运废止，
  //    看板人员一律来自补充负责人；项目性质（category）门控在 syncIfAllowed 已判，此处不重复）
  //    面向组别走 ROUTE_FIELD 配置（未配置回落历史字段名，保持旧行为）
  const routeGroups = fields[config.broadcast.routeField || '面向组别'] || null;
  const targetFields = await buildTargetFields(fields, record_id, parentRecordId);

  // 3.5 补充负责人全员（公示即绑定的指定负责人 + 所有接单人）按各自所属组别并入人员字段；
  //     同字段多人用 mergePersonFields 并集（buildPersonFieldsByGroups 单人产物直接 Object.assign 会互覆）
  //     字段名走 SUPPLEMENT_ASSIGNEE_FIELD 配置（config 默认即「补充负责人」）
  const supplements = Array.isArray(fields[config.assign.supplementField]) ? fields[config.assign.supplementField] : [];
  let supplementFields = {};
  for (const person of supplements) {
    if (!person?.id) continue;
    const groups = await resolvePersonGroups(routeGroups, person);
    supplementFields = mergePersonFields(supplementFields, buildPersonFieldsByGroups(groups, person.id));
  }
  Object.assign(targetFields, supplementFields);

  // 4. 查重 upsert（status 只向前推进，防止把业务事件状态重置回 waiting；
  //     人员字段与看板已有值合并，避免对账把接单写入的人冲掉）
  if (existing) {
    // priority 仅创建时写默认 low：update 不重提，人工/pm-robot 的优先级编辑不被每分钟对账打回
    // （与 ddl/fileToken/category「有值才带」同款处理；新单默认值仍由 buildTargetFields 提供）
    delete targetFields.priority;

    const currentStatus = existing.fields['status'];
    const targetStatus = targetFields['status'];
    if (currentStatus && targetStatus && !shouldOverrideStatus(currentStatus, targetStatus)) {
      console.log(`[同步服务] status 防倒退: ${record_id} 保持 ${currentStatus}（目标 ${targetStatus}）`);
      delete targetFields['status'];
    }

    // 人员字段合并已有（update 只提交携带字段，但同字段多人须保留先前写入的人）
    const personFieldNames = ['owner', 'dkyjcontributers', 'sjcontributers', 'xycontributers'];
    const personPatch = {};
    for (const fname of personFieldNames) {
      if (targetFields[fname]) {
        personPatch[fname] = mergePersonFields(existing.fields, { [fname]: targetFields[fname] })[fname];
      }
    }
    Object.assign(targetFields, personPatch);

    // 对账 diff 门控（2026-09-20）：字段无实质变化时跳过 update——每分钟对账此前对
    // 全部活跃工单无条件重写目标行，白烧共用应用写配额、加剧整点限频（1254290/查找超时）。
    // 归一化比较偏保守：形状对不上即视为有差异照常写，最坏退回原行为。
    if (!fieldsDiffer(existing.fields, targetFields)) {
      return { action: 'unchanged', targetRecordId: existing.record_id, parentRecordId };
    }

    await bitableApi.updateRecord(
      config.bitable.targetAppToken,
      config.bitable.targetTableId,
      existing.record_id,
      targetFields
    );
    return { action: 'updated', targetRecordId: existing.record_id, parentRecordId };
  }

  // 5. 建行前先找「无 key 孤儿行」收养：同一工单此前建行时 key 未落库的话，
  //    查重永远查不到它，直接 create 会再长一条重复行——补上 key 收编旧行
  const twin = await findUnkeyedTwin(fields, parentRecordId);
  if (twin) {
    await bitableApi.updateRecord(
      config.bitable.targetAppToken,
      config.bitable.targetTableId,
      twin.record_id,
      { [config.sync.syncKeyField]: record_id }
    );
    console.log(`[同步服务] 收养无 key 孤儿行: ${record_id} → ${twin.record_id}（补写查重 key，不再新建）`);
    // 收养后立刻按最新源数据补一次字段（孤儿行停在历史状态，如永卡 waiting）
    // priority 与 update 路径同口径剔除（照 :313 的 update 处理）：不把人工/
    // pm-robot 对孤儿行的优先级编辑打回默认 low
    delete targetFields.priority;
    await bitableApi.updateRecord(
      config.bitable.targetAppToken,
      config.bitable.targetTableId,
      twin.record_id,
      targetFields
    );
    return { action: 'adopted', targetRecordId: twin.record_id, parentRecordId };
  }

  const created = await bitableApi.createRecord(
    config.bitable.targetAppToken,
    config.bitable.targetTableId,
    targetFields
  );

  // 6. key 落库校验：任何原因（字段缺失/权限/环境快照旧值）没写上 = 该行从此对查重不可见，
  //    下一轮同步必再建一条重复行（2026-09-15 前后孤儿行的事故形态）——当场补建字段+补写并大声报警
  const createdKey = created?.fields?.[config.sync.syncKeyField];
  if (createdKey === undefined || createdKey === null || String(createdKey) !== record_id) {
    console.error(`[同步服务] ⚠️ 新建行 ${created?.record_id} 的查重 key「${config.sync.syncKeyField}」未落库（读回 ${JSON.stringify(createdKey ?? null)}），尝试补写: ${record_id}`);
    await ensureKeyField({ force: true });
    await bitableApi.updateRecord(
      config.bitable.targetAppToken,
      config.bitable.targetTableId,
      created.record_id,
      { [config.sync.syncKeyField]: record_id }
    );
  }
  return { action: 'created', targetRecordId: created.record_id, parentRecordId };
}

/**
 * 全量同步工单表 → 项目看板（category 门控）
 */
async function syncAll() {
  console.log('[同步服务] 开始全量同步 工单表 → 项目看板...');

  const allRecords = await bitableApi.listAllRecords(
    config.bitable.sourceAppToken,
    config.bitable.sourceTableId
  );

  // category 门控：仅搬运满足条件的记录
  const records = allRecords.filter(rec => hasCategory(rec.fields));

  const result = {
    total: allRecords.length,
    matched: records.length,
    created: 0,
    updated: 0,
    adopted: 0,
    unchanged: 0,
    failed: 0,
    errors: [],
  };

  for (const record of records) {
    try {
      const r = await syncRecord(record);
      result[r.action]++;
    } catch (err) {
      result.failed++;
      result.errors.push({ recordId: record.record_id, message: err.message });
      console.error(`[同步服务] 同步记录失败 ${record.record_id}:`, err.message);
    }
  }

  console.log(
    `[同步服务] 全量同步完成: 总计=${result.total} 匹配=${result.matched} 新建=${result.created} 更新=${result.updated} 失败=${result.failed}`
  );
  return result;
}

/**
 * 缺行修补（2026-09-17）：已播报工单的搬运依赖单次事件（首播 reconcile / 更新事件），
 * 事件在重启窗口/网关抖动中丢失即永久漏搬（recvvdsjSTQoKl 事故）。每小时对 category
 * 门控记录做一次「看板缺行/缺父项目」巡检（2026-09-20 扩展：行在但 parentId 空——
 * 查找父项目超时恰发生在最后一次同步时该关联会长期缺失——也补跑 syncRecord）。
 * 已齐全的行不重写，避免自身写表触发更新事件形成回环。
 */
async function repairMissingTargets() {
  const allRecords = await bitableApi.listAllRecords(
    config.bitable.sourceAppToken,
    config.bitable.sourceTableId
  );
  const gated = allRecords.filter(rec => hasCategory(rec.fields));
  const repaired = [];
  const failed = [];
  for (const rec of gated) {
    try {
      const existing = await findTargetRecordByKey(rec.record_id);
      const hasParent = existing && Array.isArray(existing.fields.parentId) && existing.fields.parentId.length > 0;
      if (existing && hasParent) continue;
      const r = await syncRecord(rec);
      repaired.push({ recordId: rec.record_id, action: r.action, targetRecordId: r.targetRecordId });
      console.log(`[同步服务] 缺行修补: ${rec.record_id} → ${r.targetRecordId}${existing && !hasParent ? '（补 parentId）' : ''}`);
    } catch (err) {
      failed.push({ recordId: rec.record_id, message: err.message });
      console.error(`[同步服务] 缺行修补失败 ${rec.record_id}:`, err.message);
    }
  }
  console.log(`[同步服务] 缺行修补完成: 扫描 ${gated.length} 条，补建 ${repaired.length} 条${failed.length ? `，失败 ${failed.length} 条` : ''}`);
  return { scanned: gated.length, repaired: repaired.length, items: repaired, failed };
}

/**
 * 更新项目状态（用于接单确认和审批状态变化）
 * @param {string} sourceRecordId 工单 record_id
 * @param {string} status 新状态
 */
async function updateProjectStatus(sourceRecordId, status) {
  const existing = await findTargetRecordByKey(sourceRecordId);
  if (!existing) {
    throw new Error(`未找到对应项目记录: ${sourceRecordId}`);
  }

  await bitableApi.updateRecord(
    config.bitable.targetAppToken,
    config.bitable.targetTableId,
    existing.record_id,
    { status }
  );

  console.log(`[同步服务] 更新项目状态: ${sourceRecordId} → ${status}`);
  return existing.record_id;
}

module.exports = {
  hasCategory,
  buildTargetFields,
  findTargetRecordByKey,
  findParentProject,
  syncRecord,
  syncAll,
  repairMissingTargets,
  updateProjectStatus,
  mapStatus,
  shouldOverrideStatus,
};
