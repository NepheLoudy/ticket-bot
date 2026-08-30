const config = require('../config');
const bitableApi = require('../feishu/bitable');
const { normalizeForWrite, toDateOnlyTimestamp } = require('../utils/fields');
const { resolvePersonGroups, buildPersonFieldsByGroups } = require('../utils/personFields');

/**
 * 同步服务：将工单记录搬运到项目看板
 * - category 有值时触发
 * - name 字段值作为父项目名称，在项目看板中查找匹配记录作为 parentId
 * - 指定负责人按其所属组别填到对应人员字段（机械→owner，电控/硬件→dkyjcontributers，视觉→sjcontributers，宣运→xycontributers）
 */

// ============================================================
// 状态映射：工单申请状态 → 项目看板 status
// 已通过=发起人已结单 → completed；已拒绝/撤回等 → died
// 审批中按审批节点推进：
//   - 触发节点（有组员接单后通过/负责人确认消息后通过）→ waiting（等待接单/等待负责人确认）
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

  // 审批中：按审批节点推进
  if (approvalNode) {
    if (approvalNode === config.approvalNode.closeValue) return 'in_progress';
    if (config.approvalNode.acceptValues.includes(approvalNode)) return 'waiting';
  }
  return 'pending';
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
    const filter = `CurrentValue.[name] = "${parentName}"`;
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
 * @param {string[]|null} assigneeGroups 指定负责人所属组别（已解析，空则不填人员字段）
 * @returns {object} 项目看板字段
 */
async function buildTargetFields(sourceFields, sourceRecordId, parentRecordId, assigneeGroups = null) {
  const targetFields = {};

  // 1. 源记录ID（查重依据）
  targetFields[config.sync.syncKeyField] = sourceRecordId;

  // 2. category
  if (sourceFields['category']) {
    targetFields['category'] = sourceFields['category'];
  }

  // 3. ddl（理想结单时间，去掉时分秒）
  if (sourceFields['理想结单时间']) {
    targetFields['ddl'] = toDateOnlyTimestamp(sourceFields['理想结单时间']);
  }

  // 4. fileToken（需求）
  if (sourceFields['需求'] || sourceFields['需求1']) {
    targetFields['fileToken'] = sourceFields['需求'] || sourceFields['需求1'];
  }

  // 5. priority 默认 low
  targetFields['priority'] = 'low';

  // 6. status（申请状态 + 审批节点推进：已通过→completed，等待接单/确认→waiting，回执单→in_progress）
  const applyStatus = sourceFields['申请状态'];
  const approvalNode = config.approvalNode.field ? sourceFields[config.approvalNode.field] : '';
  targetFields['status'] = mapStatus(applyStatus, approvalNode);

  // 7. parentId（父项目关联）
  if (parentRecordId) {
    targetFields['parentId'] = [parentRecordId];
  }

  // 8. 人员字段（指定负责人按其所属组别填）
  const assignee = sourceFields['指定负责人']?.[0] || null;
  if (assignee?.id) {
    const groups = assigneeGroups && assigneeGroups.length > 0
      ? assigneeGroups
      : (sourceFields['面向组别'] || []).map(String);
    Object.assign(targetFields, buildPersonFieldsByGroups(groups, assignee.id));
  }

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
  const filter = `CurrentValue.[${config.sync.syncKeyField}] = "${sourceRecordId}"`;
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
async function ensureKeyField() {
  if (keyFieldReady) return;
  try {
    await bitableApi.createField(
      config.bitable.targetAppToken,
      config.bitable.targetTableId,
      config.sync.syncKeyField
    );
    console.log(`[同步服务] 已在目标表创建查重字段「${config.sync.syncKeyField}」`);
  } catch (err) {
    // 字段已存在或创建失败：不阻断后续同步（已存在时 upsert 依赖的字段可用）
  }
  keyFieldReady = true;
}

/**
 * 同步单条工单记录到项目看板
 * @param {{record_id: string, fields: object}} sourceRecord
 * @returns {Promise<{action: 'created'|'updated', targetRecordId: string, parentRecordId: string|null}>}
 */
async function syncRecord(sourceRecord) {
  await ensureKeyField();

  const { record_id, fields } = sourceRecord;

  // 1. 查找父项目（name 字段值）
  const parentName = fields['name'];
  const parentRecordId = await findParentProject(parentName);

  // 2. 指定负责人按其所属组别解析（USER_GROUPS → 通讯录 → 面向组别兜底）
  const assignee = fields['指定负责人']?.[0] || null;
  const routeGroups = config.broadcast.routeField ? fields[config.broadcast.routeField] : null;
  const assigneeGroups = assignee ? await resolvePersonGroups(routeGroups, assignee) : null;

  // 3. 构造目标字段
  const targetFields = await buildTargetFields(fields, record_id, parentRecordId, assigneeGroups);

  // 3. 查重 upsert（status 只向前推进，防止把业务事件状态重置回 waiting）
  const existing = await findTargetRecordByKey(record_id);
  if (existing) {
    const currentStatus = existing.fields['status'];
    const targetStatus = targetFields['status'];
    if (currentStatus && targetStatus && !shouldOverrideStatus(currentStatus, targetStatus)) {
      console.log(`[同步服务] status 防倒退: ${record_id} 保持 ${currentStatus}（目标 ${targetStatus}）`);
      delete targetFields['status'];
    }

    await bitableApi.updateRecord(
      config.bitable.targetAppToken,
      config.bitable.targetTableId,
      existing.record_id,
      targetFields
    );
    return { action: 'updated', targetRecordId: existing.record_id, parentRecordId };
  }

  const created = await bitableApi.createRecord(
    config.bitable.targetAppToken,
    config.bitable.targetTableId,
    targetFields
  );
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
  updateProjectStatus,
  mapStatus,
  shouldOverrideStatus,
};
