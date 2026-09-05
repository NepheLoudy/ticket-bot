const config = require('../config');
const { requestAPI } = require('../feishu/client');
const { formatFieldValue } = require('../utils/fields');

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

/** 拉取审批实例详情 */
async function getInstanceDetail(instanceId) {
  const res = await requestAPI(
    'GET',
    `/approval/v4/instances/${instanceId}?user_id_type=open_id&locale=zh_cn`
  );
  if (res.code !== 0) {
    throw new Error(`获取审批实例失败: ${res.msg} (code: ${res.code})`);
  }
  return res.data?.instance || null;
}

/** 实例表单 → 工单联动信息（申请编号 + 面向组别），标题关键词自适应 */
function extractLinkInfo(form) {
  const info = { applicationNo: '', groups: [] };
  for (const item of form || []) {
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
        ` 审批人 open_id=${t ? (t.user_id || t.approver_id || '?') : '?'} 状态=${t ? t.status : '?'}`
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

  const approverId = task.user_id || task.approver_id || '';
  // 只联动白名单审批人名下的任务（触发节点的审批人）；名单外的任务到达时留痕，
  // 便于核对 APPROVAL_AUTO_APPROVER_ID 是否配错（如张郭浩 open_id 变动）
  if (!approverAllow.has(approverId)) {
    console.log(
      `[审批联动] 跳过非联动审批人的任务: ${link.applicationNo} task ${taskId} 审批人 open_id=${approverId || '?'}`
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
 * 缓存缺失兜底：按申请编号在审批定义近期的实例列表中定位待审任务
 * （服务重启丢缓存 / 审批任务事件先于部署到达时使用）。
 * 并行分支下同一实例可能有多个待审任务，全部返回。
 * @param {string} applicationNo 申请编号
 * @returns {Promise<Array<{instanceId, taskId, approverId, approvalCode}>>}
 */
async function findPendingTasksByApplicationNo(applicationNo) {
  const approvalCode = config.approval.approvalCode;
  if (!approvalCode) return [];

  const now = Date.now();
  const res = await requestAPI('POST', '/approval/v4/instances?user_id_type=open_id', {
    approval_code: approvalCode,
    start_time: now - 14 * 86400 * 1000,
    end_time: now,
    page_size: 100,
  });
  if (res.code !== 0) {
    throw new Error(`查询审批实例列表失败: ${res.msg} (code: ${res.code})`);
  }

  for (const instanceCode of res.data?.instance_list || []) {
    const inst = await getInstanceDetail(instanceCode);
    const link = extractLinkInfo(inst.form);
    if (link.applicationNo !== applicationNo) continue;
    // 命中实例即返回其全部待审任务（并行分支可同时挂多个触发节点任务）
    return (inst.task_list || [])
      .filter((t) => {
        const status = String(t.status || '').toUpperCase();
        if (['DONE', 'APPROVED', 'REJECTED', 'CANCELED'].includes(status)) return false;
        return getAutoApproverIds().has(t.user_id || t.approver_id || '');
      })
      .map((t) => ({
        instanceId: instanceCode,
        taskId: t.id || t.task_id,
        approverId: t.user_id || t.approver_id || '',
        approvalCode: inst.approval_id || approvalCode,
      }));
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
  const applicationNo = formatFieldValue(sourceRecord.fields['申请编号']) || '';
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
