const config = require('../config');
const { requestAPI } = require('../feishu/client');

// ============================================================
// 人员组别 → 项目看板人员字段映射
// 机械组 → owner；电控/硬件 → dkyjcontributers；
// 视觉组 → sjcontributers；宣运组 → xycontributers；管理层 → owner
// ============================================================
const GROUP_TO_PERSON_FIELD = {
  '机械组': 'owner',
  '电控组': 'dkyjcontributers',
  '硬件组': 'dkyjcontributers',
  '视觉组': 'sjcontributers',
  '宣运组': 'xycontributers',
  '管理层': 'owner',
};

// 通讯录部门查询缓存
const userDeptCache = new Map();
const deptNameCache = new Map();

/**
 * 通过飞书通讯录查询人员的部门名称
 */
async function getUserGroupsFromContact(openId) {
  if (!openId) return [];
  if (userDeptCache.has(openId)) return userDeptCache.get(openId);

  try {
    const u = await requestAPI(
      'GET',
      `/contact/v3/users/${openId}?user_id_type=open_id&department_id_type=department_id`
    );
    if (u.code !== 0) throw new Error(`${u.msg} (code: ${u.code})`);

    const deptIds = u.data?.user?.department_ids || [];
    const groupNames = [];
    for (const deptId of deptIds) {
      let deptName = deptNameCache.get(deptId);
      if (deptName === undefined) {
        const d = await requestAPI('GET', `/contact/v3/departments/${deptId}?department_id_type=department_id`);
        if (d.code !== 0) throw new Error(`${d.msg} (code: ${d.code})`);
        deptName = d.data?.department?.name || '';
        deptNameCache.set(deptId, deptName);
      }
      if (deptName) groupNames.push(deptName);
    }

    userDeptCache.set(openId, groupNames);
    return groupNames;
  } catch (err) {
    // 失败不写缓存（2026-09-13）：瞬时 API 抖动的负缓存会让该成员整个进程生命周期
    // 组别解析退化到兜底列（接单/搬运把人写错看板人员列）——与 approvalLinkService 的
    // 「失败不缓存」口径对齐
    console.warn(`[人员组别] 通过通讯录查询人员组别失败（不缓存，下次重试）: ${err.message}`);
    return [];
  }
}

/**
 * 解析人员所属组别（优先级：USER_GROUPS 手动映射 → 飞书通讯录部门 → 工单「面向组别」兜底）
 * @param {Array|string|null} routeGroups 工单「面向组别」（兜底）
 * @param {{id: string, name: string}|null} person 人员
 * @returns {Promise<string[]>}
 */
async function resolvePersonGroups(routeGroups, person) {
  const groups = [];

  // 1. USER_GROUPS 手动映射
  if (person) {
    for (const key of [person.id, person.name]) {
      if (key && config.assign.userGroups.has(key)) {
        groups.push(config.assign.userGroups.get(key));
        break;
      }
    }
  }

  // 2. 飞书通讯录部门
  if (groups.length === 0 && person?.id) {
    const contactGroups = await getUserGroupsFromContact(person.id);
    groups.push(...contactGroups);
  }

  // 3. 兜底：工单「面向组别」
  if (groups.length === 0 && routeGroups) {
    if (Array.isArray(routeGroups)) groups.push(...routeGroups.map(String));
    else groups.push(String(routeGroups));
  }

  return groups;
}

/**
 * 按组别构造看板人员字段（机械→owner，电控/硬件→dkyjcontributers，
 * 视觉→sjcontributers，宣运→xycontributers；未识别组别默认归 owner）
 *
 * 只返回命中的字段（不含空数组）——飞书 update 只提交携带的字段，
 * 空数组会把其它组别的已有人员清空，接单/搬运共用时必须避免互踩。
 * @param {string[]} groups 人员所属组别
 * @param {string} personId 人员 open_id
 * @returns {object} 人员字段对象（仅命中字段）
 */
function buildPersonFieldsByGroups(groups, personId) {
  const personFields = {};

  if (!personId) return personFields;

  const assignedFields = new Set();
  for (const group of groups || []) {
    const fieldName = GROUP_TO_PERSON_FIELD[group];
    if (fieldName && !assignedFields.has(fieldName)) {
      personFields[fieldName] = [{ id: personId }];
      assignedFields.add(fieldName);
    }
  }

  // 组别未识别时默认归到 owner
  if (assignedFields.size === 0) {
    personFields.owner = [{ id: personId }];
  }

  return personFields;
}

/**
 * 合并看板已有人员字段与新增人员（同字段多人并存、按 id 去重，不清空已有组别）
 * @param {object} existingFields 目标表当前记录 fields（或用于折叠的累积结果）
 * @param {object} newPersonFields buildPersonFieldsByGroups 的产物
 * @returns {object} 合并后的人员字段（涉及字段 + 既有人员字段原样回带）
 */
function mergePersonFields(existingFields, newPersonFields) {
  const merged = {};
  for (const [field, persons] of Object.entries(newPersonFields || {})) {
    const existing = Array.isArray(existingFields?.[field]) ? existingFields[field] : [];
    const seen = new Set(existing.map((p) => p?.id).filter(Boolean));
    const list = [...existing];
    for (const p of persons || []) {
      if (p?.id && !seen.has(p.id)) {
        list.push(p);
        seen.add(p.id);
      }
    }
    merged[field] = list;
  }
  // 回带既有人员字段（仅人员字段；existingFields 可能是整条记录 fields，非人员字段不碰）。
  // 不回带会让「折叠多人的累积结果」在下一轮合并时丢失只存在于累积侧的组别字段
  //（2026-09-13 修复：跨组多补充负责人折叠时 owner 被丢弃）
  for (const field of new Set(Object.values(GROUP_TO_PERSON_FIELD))) {
    if (!(field in merged) && Array.isArray(existingFields?.[field])) {
      merged[field] = existingFields[field];
    }
  }
  return merged;
}

module.exports = {
  GROUP_TO_PERSON_FIELD,
  getUserGroupsFromContact,
  resolvePersonGroups,
  buildPersonFieldsByGroups,
  mergePersonFields,
};
