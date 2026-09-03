const config = require('../config');
const { requestAPI } = require('../feishu/client');
const { formatFieldValue } = require('../utils/fields');

// ============================================================
// 工单审批联动：群内接单 → 自动通过「群内有组员接单后通过」审批节点
//
// 链路：审批任务事件（approval_task，秒级）→ 缓存待审任务
//       {申请编号 → {instanceId, taskId, approverId}}
//       群内 @机器人 接单成功 → 以该任务审批人身份调同意 API，
//       审批流自动流转（节点审批人可全部配置为同一个人）。
// 事件/接单之间有时差：缓存优先，缓存缺失时按申请编号反查实例兜底。
// ============================================================

// 申请编号 → 待审任务（一个实例同分支只有一个待审任务）
const pendingTasks = new Map();

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
  // 未配置自动审批人时联动关闭：无法区分「群内有组员接单后通过」与
  // 「负责人确认消息后通过」等其它节点的任务（事件与实例详情都不带节点名，
  // 审批人身份是唯一可靠判据），误通过其它节点会打乱审批流
  if (!config.approval.autoApproverId) return;

  const evt = event.event && event.event.instance_id ? event.event : event;
  const instanceId = evt.instance_id;
  const taskId = evt.task_id;
  if (!instanceId || !taskId) return;

  const configuredCode = config.approval.approvalCode;
  if (configuredCode && evt.approval_code && evt.approval_code !== configuredCode) return;

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
    pendingTasks.delete(link.applicationNo);
    return;
  }

  const approverId = task.user_id || task.approver_id || '';
  // 配置了工单审批人时只联动其名下任务（自动通过只该动「群内有组员接单后通过」节点）
  if (config.approval.autoApproverId && approverId !== config.approval.autoApproverId) return;

  pendingTasks.set(link.applicationNo, {
    instanceId,
    taskId,
    approverId,
    approvalCode: instance.approval_id || evt.approval_code || '',
    groups: link.groups,
    cachedAt: Date.now(),
  });
  console.log(`[审批联动] 已缓存待审任务: ${link.applicationNo} (task ${taskId}, approver ${approverId})`);
}

/**
 * 接单成功后自动通过对应审批任务
 * @param {object} sourceRecord 源表工单记录 {record_id, fields}
 * @param {string} acceptorName 接单人姓名（写进审批意见留痕）
 */
async function autoApproveForTicket(sourceRecord, acceptorName) {
  const applicationNo = formatFieldValue(sourceRecord.fields['申请编号']) || '';
  if (!applicationNo) return { done: false, reason: '无申请编号' };

  let pending = pendingTasks.get(applicationNo);

  // 缓存缺失兜底：事件还没到或重启丢缓存时，直接查实例列表定位
  if (!pending) {
    return { done: false, reason: '审批任务尚未到达缓存（等待审批事件推送后重试）' };
  }

  try {
    const res = await requestAPI('POST', '/approval/v4/tasks/approve?user_id_type=open_id', {
      approval_code: pending.approvalCode,
      instance_code: pending.instanceId,
      task_id: pending.taskId,
      user_id: pending.approverId,
      comment: `组员 ${acceptorName || '（未知）'} 已在群内确认接单，自动通过`,
    });
    if (res.code !== 0) {
      console.error(`[审批联动] 自动通过失败 ${applicationNo}: ${res.msg} (code: ${res.code})`);
      return { done: false, reason: res.msg };
    }
    pendingTasks.delete(applicationNo);
    console.log(`[审批联动] 已自动通过审批: ${applicationNo}（task ${pending.taskId}）`);
    return { done: true };
  } catch (err) {
    console.error(`[审批联动] 调用同意接口失败 ${applicationNo}:`, err.message);
    return { done: false, reason: err.message };
  }
}

module.exports = {
  handleApprovalTaskEvent,
  autoApproveForTicket,
};
