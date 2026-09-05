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
// 链路：审批任务事件（approval_task，秒级）→ 按审批人白名单缓存待审任务
//       {申请编号 → {instanceId, taskId, approverId}}
//       群内 @机器人 接单成功 → 以该任务审批人身份调同意 API，
//       审批流自动流转（节点审批人可全部配置为同一个人）。
// 事件/接单之间有时差：缓存优先，缓存缺失时按申请编号反查实例兜底。
// 两层防误同：缓存层按审批人白名单过滤（事件不带节点名）；
//             同意层校验工单「审批节点」必须处于触发节点，
//             防止实例推进到回执单等节点后误通过新节点的任务。
// ============================================================

// 申请编号 → 待审任务（一个实例同分支只有一个待审任务）
const pendingTasks = new Map();

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
    pendingTasks.delete(link.applicationNo);
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
 * @param {string} role 接单人角色（组员/负责人，写进审批意见）
 */
async function autoApproveForTicket(sourceRecord, acceptorName, role = '组员') {
  const applicationNo = formatFieldValue(sourceRecord.fields['申请编号']) || '';
  if (!applicationNo) return { done: false, reason: '无申请编号' };

  // 同意层守卫：仅当工单仍处于触发节点（等待接单/等待负责人确认）才自动通过，
  // 防止实例已推进到「回执单：是否结单」等节点后误通过缓存里/新到达的其它节点任务
  const nodeField = config.approvalNode.field;
  const node = nodeField ? String(sourceRecord.fields[nodeField] ?? '') : '';
  if (nodeField && !config.approvalNode.acceptValues.includes(node)) {
    return { done: false, reason: `审批节点「${node || '(空)'}」不在联动范围，跳过自动通过` };
  }

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
      comment: `${role} ${acceptorName || '（未知）'} 已在群内确认接单，自动通过`,
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
