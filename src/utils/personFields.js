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
    console.warn(`[人员组别] 通过通讯录查询人员组别失败: ${err.message}`);
    userDeptCache.set(openId, []);
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
 * @param {string[]} groups 人员所属组别
 * @param {string} personId 人员 open_id
 * @returns {object} 人员字段对象
 */
function buildPersonFieldsByGroups(groups, personId) {
  const personFields = {
    owner: [],
    dkyjcontributers: [],
    sjcontributers: [],
    xycontributers: [],
  };

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

module.exports = {
  GROUP_TO_PERSON_FIELD,
  getUserGroupsFromContact,
  resolvePersonGroups,
  buildPersonFieldsByGroups,
};
