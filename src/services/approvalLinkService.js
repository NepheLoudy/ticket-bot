const config = require('../config');
const { requestAPI } = require('../feishu/client');
const { formatFieldText } = require('../utils/fields');

// ============================================================
// 工单审批联动：群内接单 → 自动通过对应触发节点的审批任务
//
// 覆盖两条工单分支（节点名互斥，同一实例同时只会有一个待审任务）：
//   - 未指定负责人：群内有组员接单后通过（任一组员 @机器人 接单即通过）
//   - 已指定负责人：负责人确认消息后通过（仅指定负责人本人确认后通过）
//
// 无指定负责人分支的审批流按「面向组别」并行展开（机械/电控/硬件/视觉/管理层/宣运
// 各有一个「XX有组员接单后通过」节点）：面向复数组别的工单会同时存在多个待审任务，
// 必须全部通过流程才能汇合流转——因此缓存与通过都按任务集合处理（批量通过）。
//
// 链路：审批任务事件（approval_task，秒级）→ 按「审批人 == 配置的工单审批人」过滤并缓存
//       {申请编号 → {taskId → {instanceId, taskId, approverId}}}
//       群内 @机器人 接单成功 → 以各任务审批人身份逐个调同意 API，
//       审批流自动流转（节点审批人可全部配置为同一个人）。
// 事件/接单之间有时差：缓存优先，缓存缺失时按申请编号反查实例兜底。
// task_list 的审批人是 user_id 格式，统一经通讯录归一成 open_id 后再对白名单/调同意。
// 两层防误同：缓存层按审批人白名单过滤（事件不带节点名）；
//             同意层校验工单「审批节点」必须处于触发节点，
//             防止实例推进到回执单等节点后误通过新节点的任务。
// ============================================================

// 申请编号 → 待审任务集合（并行分支下同一实例可有多个待审任务）
const pendingTasks = new Map(); // applicationNo -> Map(taskId -> task)

function upsertPendingTask(applicationNo, task) {
  if (!pendingTasks.has(applicationNo)) {
    pendingTasks.set(applicationNo, new Map());
  }
  pendingTasks.get(applicationNo).set(task.taskId, task);
}

function removePendingTask(applicationNo, taskId) {
  const tasks = pendingTasks.get(applicationNo);
  if (!tasks) return;
  tasks.delete(taskId);
  if (tasks.size === 0) pendingTasks.delete(applicationNo);
}

/** 联动审批人白名单（单值 + 多值配置取并集） */
function getAutoApproverIds() {
  return new Set([config.approval.autoApproverId, ...config.approval.autoApproverIds].filter(Boolean));
}

/** 拉取审批实例详情
 *  注意：响应体本身就是实例对象（data 顶层即 task_list/form），不是 data.instance；
 *  locale 传 zh_cn（下划线）会 99992402 参数校验失败，不要加 */
async function getInstanceDetail(instanceId) {
  const res = await requestAPI(
    'GET',
    `/approval/v4/instances/${instanceId}?user_id_type=open_id`
  );
  if (res.code !== 0) {
    throw new Error(`获取审批实例失败: ${res.msg} (code: ${res.code})`);
  }
  return res.data?.instance || res.data || null;
}

/** 实例表单 → 工单联动信息（申请编号 + 面向组别），标题关键词自适应
 *  详情接口的 form 是 JSON 字符串（事件路径同款），先反序列化再迭代 */
function extractLinkInfo(form) {
  let items = form;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch (e) { items = []; }
  }
  if (!Array.isArray(items)) items = [];
  const info = { applicationNo: '', groups: [] };
  for (const item of items) {
    const title = String(item.title || item.custom_key || '');
    const value = typeof item.value === 'string' ? item.value : String(item.value || '');
    if (!info.applicationNo && /编号/.test(title)) {
      info.applicationNo = value;
    } else if (/面向组别|组别/.test(title)) {
      info.groups = value.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean);
    }
  }
  return info;
}

// 审批人 ID 归一：task_list 的审批人是 user_id 格式（如 778a737g，user_id_type=open_id
// 也不改变），而白名单与 approve 接口（user_id_type=open_id）都用 open_id——
// 非 ou_ 开头的一律经通讯录解析（成功映射长期缓存；失败的 null 不缓存，见函数内注释）
const approverOpenIdCache = new Map(); // user_id -> openId（仅成功解析）

async function resolveToOpenId(raw) {
  if (!raw) return '';
  const id = String(raw);
  if (id.startsWith('ou_')) return id;
  if (approverOpenIdCache.has(id)) return approverOpenIdCache.get(id);
  let openId = null;
  try {
    const res = await requestAPI('GET', `/contact/v3/users/${id}?user_id_type=user_id`);
    if (res.code === 0) openId = res.data?.user?.open_id || null;
  } catch (err) {
    console.warn(`[审批联动] 审批人 user_id 解析 open_id 失败 ${id}: ${err.message}`);
  }
  // 失败的 null 不缓存：缓存住会让该审批人的任务在事件缓存与反查兜底两路同时
  // fail-closed，对账补偿也无法自愈（工单卡在触发节点直到重启）；瞬时失败留给
  // 下个审批事件/下轮对账重试
  if (openId) approverOpenIdCache.set(id, openId);
  return openId;
}

/**
 * 处理 approval_task 事件：待审任务到达 → 按「审批人 == 配置的工单审批人」过滤并缓存
 */
async function handleApprovalTaskEvent(event) {
  const evt = event.event && event.event.instance_id ? event.event : event;
  const instanceId = evt.instance_id;
  const taskId = evt.task_id;
  if (!instanceId || !taskId) return;

  const configuredCode = config.approval.approvalCode;
  if (configuredCode && evt.approval_code && evt.approval_code !== configuredCode) return;

  const approverAllow = getAutoApproverIds();
  // 名单全空时联动关闭：误通过「回执单」等其它节点的任务会打乱审批流。
  // 关闭状态下仍记录到达任务的审批人 open_id——首次部署时用它完成配置激活。
  if (approverAllow.size === 0) {
    try {
      const inst = await getInstanceDetail(instanceId);
      const t = (inst.task_list || []).find((x) => x.id === taskId || x.task_id === taskId);
      console.log(
        `[审批联动] 未激活（待配 APPROVAL_AUTO_APPROVER_ID）: 实例 ${instanceId} task ${taskId}` +
        ` 审批人 user_id=${t ? (t.user_id || t.approver_id || '?') : '?'} 状态=${t ? t.status : '?'}`
      );
    } catch (err) {
      console.warn('[审批联动] 未激活，记录事件失败:', err.message);
    }
    return;
  }

  let instance;
  try {
    instance = await getInstanceDetail(instanceId);
  } catch (err) {
    console.warn(`[审批联动] 拉取实例详情失败 ${instanceId}: ${err.message}`);
    return;
  }
  if (!instance) return;

  // 在任务清单里定位该任务与审批人
  const task = (instance.task_list || []).find((t) => t.id === taskId || t.task_id === taskId);
  if (!task) return;
  const taskStatus = String(task.status || '').toUpperCase();
  const link = extractLinkInfo(instance.form);
  if (!link.applicationNo) return; // 找不到申请编号，无法与工单关联

  if (['DONE', 'APPROVED', 'REJECTED', 'CANCELED'].includes(taskStatus)) {
    removePendingTask(link.applicationNo, taskId);
    return;
  }

  // task_list 的审批人是 user_id 格式，先归一成 open_id 再对白名单
  const approverId = await resolveToOpenId(task.user_id || task.approver_id || '');
  if (!approverId) {
    console.log(`[审批联动] 任务 ${taskId} 审批人无法解析为 open_id，跳过: ${link.applicationNo}`);
    return;
  }
  // 只联动白名单审批人名下的任务（触发节点的审批人）；名单外的任务到达时留痕，
  // 便于核对 APPROVAL_AUTO_APPROVER_ID 是否配错（如审批人 open_id 变动）
  if (!approverAllow.has(approverId)) {
    console.log(
      `[审批联动] 跳过非联动审批人的任务: ${link.applicationNo} task ${taskId} 审批人 open_id=${approverId}`
    );
    return;
  }

  upsertPendingTask(link.applicationNo, {
    instanceId,
    taskId,
    approverId,
    approvalCode: instance.approval_id || evt.approval_code || '',
    groups: link.groups,
    cachedAt: Date.now(),
  });
  console.log(`[审批联动] 已缓存待审任务: ${link.applicationNo} (task ${taskId}, approver ${approverId}，当前缓存 ${pendingTasks.get(link.applicationNo).size} 个)`);
}

/**
 * 缓存缺失兜底：按申请编号在审批定义近期的实例中定位待审任务
 * （服务重启丢缓存 / 审批任务事件先于部署到达时使用）。
 * 并行分支下同一实例可能有多个待审任务，全部返回。
 *
 * 实测口径（2026-09-06 二分定位，勿回退）：
 *  - 旧「批量获取实例ID」POST /approval/v4/instances 对本应用恒 99992402（参数怎么换都一样），
 *    必须用实例搜索接口 POST /approval/v4/instances/query，且 approval_code 传字符串（数组报 9499）；
 *  - 搜索结果按 serial_id（审批编号 == 工单申请编号）匹配，免逐实例解析表单；
 *  - task_list 审批人是 user_id 格式，入库前统一 resolveToOpenId 归一并对白名单。
 *
 * @param {string} applicationNo 申请编号
 * @returns {Promise<Array<{instanceId, taskId, approverId, approvalCode}>>}
 */
async function findPendingTasksByApplicationNo(applicationNo) {
  const approvalCode = config.approval.approvalCode;
  if (!approvalCode) return [];

  const now = Date.now();
  const res = await requestAPI('POST', '/approval/v4/instances/query?user_id_type=open_id', {
    approval_code: approvalCode,
    instance_start_time_from: now - 14 * 86400 * 1000,
    instance_start_time_to: now,
    page_size: 100,
  });
  if (res.code !== 0) {
    throw new Error(`查询审批实例列表失败: ${res.msg} (code: ${res.code})`);
  }

  const approverAllow = getAutoApproverIds();
  for (const item of res.data?.instance_list || []) {
    const summary = item.instance || {};
    if (String(summary.serial_id || '') !== applicationNo) continue;
    const inst = await getInstanceDetail(summary.code);
    const tasks = [];
    for (const t of inst.task_list || []) {
      const status = String(t.status || '').toUpperCase();
      if (['DONE', 'APPROVED', 'REJECTED', 'CANCELED'].includes(status)) continue;
      const approverId = await resolveToOpenId(t.user_id || t.approver_id || '');
      if (!approverId || !approverAllow.has(approverId)) continue; // 名单外 fail-closed
      tasks.push({
        instanceId: inst.instance_code || summary.code,
        taskId: t.id || t.task_id,
        approverId,
        approvalCode: inst.approval_code || approvalCode,
      });
    }
    return tasks;
  }
  return [];
}

/**
 * 接单成功后自动通过对应审批任务（批量：并行分支的全部待审任务逐一通过）
 * @param {object} sourceRecord 源表工单记录 {record_id, fields}
 * @param {string} acceptorName 接单人姓名（写进审批意见留痕）
 * @param {string} role 接单人角色（组员/负责人/多人单，写进审批意见）
 * @param {string} comment 完整审批意见（留空用默认模板）
 * @returns {Promise<{done: boolean, approved?: number, reason?: string}>}
 */
async function autoApproveForTicket(sourceRecord, acceptorName, role = '组员', comment = '') {
  // 「申请编号」是超链接字段（{text, link}）：必须取纯文本 text，
  // formatFieldValue 会渲染成 [text](link) markdown，与审批表单里的纯文本编号永远对不上
  const applicationNo = String(formatFieldText(sourceRecord.fields['申请编号']) || '').trim();
  if (!applicationNo) return { done: false, reason: '无申请编号' };

  // 同意层守卫：仅当工单仍处于触发节点（等待接单/等待负责人确认）才自动通过，
  // 防止实例已推进到「回执单：是否结单」等节点后误通过缓存里/新到达的其它节点任务。
  // 节点值可能为并行分支多段拼接（「；」分隔），用 matchNodeValue 拆段匹配
  const nodeField = config.approvalNode.field;
  const node = nodeField ? String(sourceRecord.fields[nodeField] ?? '') : '';
  if (nodeField && !config.matchNodeValue(node, config.approvalNode.acceptValues)) {
    return { done: false, reason: `审批节点「${node || '(空)'}」不在联动范围，跳过自动通过` };
  }

  let tasks = [...(pendingTasks.get(applicationNo)?.values() || [])];

  // 缓存缺失兜底：事件还没到或重启丢缓存时，按申请编号反查实例列表定位待审任务
  if (tasks.length === 0) {
    try {
      tasks = await findPendingTasksByApplicationNo(applicationNo);
      for (const t of tasks) upsertPendingTask(applicationNo, t);
      if (tasks.length > 0) {
        console.log(`[审批联动] 缓存缺失，已按申请编号反查定位 ${tasks.length} 个待审任务: ${applicationNo}`);
      }
    } catch (err) {
      console.warn(`[审批联动] 反查审批实例失败 ${applicationNo}: ${err.message}`);
    }
  }
  if (tasks.length === 0) {
    return { done: false, reason: '审批任务尚未到达缓存（等待审批事件推送后重试）' };
  }

  let approved = 0;
  let lastReason = null;
  for (const pending of tasks) {
    try {
      const res = await requestAPI('POST', '/approval/v4/tasks/approve?user_id_type=open_id', {
        approval_code: pending.approvalCode,
        instance_code: pending.instanceId,
        task_id: pending.taskId,
        user_id: pending.approverId,
        comment: comment || `${role} ${acceptorName || '（未知）'} 已在群内确认接单，自动通过`,
      });
      if (res.code === 0) {
        approved++;
        removePendingTask(applicationNo, pending.taskId);
      } else {
        lastReason = res.msg;
        console.error(`[审批联动] 自动通过失败 ${applicationNo} task ${pending.taskId}: ${res.msg} (code: ${res.code})`);
      }
    } catch (err) {
      lastReason = err.message;
      console.error(`[审批联动] 调用同意接口失败 ${applicationNo} task ${pending.taskId}:`, err.message);
    }
  }

  if (approved > 0) {
    console.log(`[审批联动] 已自动通过审批: ${applicationNo}（${approved}/${tasks.length} 个任务）`);
    return { done: true, approved };
  }
  return { done: false, reason: lastReason || '审批任务同意失败' };
}

module.exports = {
  handleApprovalTaskEvent,
  autoApproveForTicket,
};
