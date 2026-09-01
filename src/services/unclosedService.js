const config = require('../config');
const dayjs = require('dayjs');
const { listAllRecords } = require('../feishu/bitable');
const { resolvePersonGroups } = require('../utils/personFields');

// 与 pm-robot ticketCloseService 对齐的字段解析：标题取 申请编号 → 需求1/需求 → 工单-后6位
function extractText(value) {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) return extractText(value[0]);
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (value.text !== null && value.text !== undefined && value.text !== '') return String(value.text);
    if (value.name) return String(value.name);
  }
  return String(value);
}

function getTicketTitle(fields, recordId) {
  return (
    extractText(fields['申请编号']) ||
    extractText(fields['需求1']) ||
    extractText(fields['需求']) ||
    `工单-${recordId.slice(-6)}`
  );
}

/**
 * 未结单工单按「负责人所属组别」分桶（供 DDL 播报分组分栏使用）
 *
 * 未结单判定与 pm-robot ticketCloseService 对齐：
 * 审批节点处于「回执单：是否结单」且理想结单时间在 7 日内。
 *
 * 播报对象：指定负责人 → 补充负责人（两者都为空的工单不播，不回退到发起人）。
 * 分组依据：负责人的所属组别（USER_GROUPS → 通讯录部门 → 工单「面向组别」兜底），
 * 组别经播报路由映射为群 chatId；一张工单负责人横跨多组时会出现在多个群。
 *
 * @returns {Promise<Object<{urgent: Array, week: Array}>>} 以群 chatId 为键
 */
async function getUnclosedByGroup() {
  const { sourceAppToken, sourceTableId } = config.bitable;
  const approvalField = config.approvalNode.field;
  const closeValue = config.approvalNode.closeValue;
  const deadlineField = config.closeReminder.deadlineField;
  const routeField = config.broadcast.routeField;
  const assigneeField = config.assign.assigneeField || '指定负责人';
  const supplementField = config.assign.supplementField || '补充负责人';

  const filter = `CurrentValue.[${approvalField}] = "${closeValue}"`;
  const records = await listAllRecords(sourceAppToken, sourceTableId, filter);

  const now = dayjs();
  const result = {};
  let skippedNoResponsible = 0;

  for (const record of records) {
    const fields = record.fields;

    // 播报对象：指定负责人 → 补充负责人（不去找发起人/当前处理人）
    const people = [];
    const seen = new Set();
    for (const field of [assigneeField, supplementField]) {
      for (const p of fields[field] || []) {
        if (p && p.id && !seen.has(p.id)) {
          seen.add(p.id);
          people.push(p);
        }
      }
    }
    if (people.length === 0) {
      skippedNoResponsible++;
      continue;
    }

    const deadline = fields[deadlineField];
    if (!deadline) continue;
    const deadlineTs = dayjs(deadline);
    if (!deadlineTs.isValid()) continue;
    const daysLeft = deadlineTs.diff(now, 'day');
    if (daysLeft > 7) continue; // 超出 7 日的不播报

    // 负责人所属组别 → 播报群 chatId（多负责人/多组别时取并集）
    const chatIds = new Set();
    for (const person of people) {
      const groups = await resolvePersonGroups(routeField ? fields[routeField] : null, person);
      for (const group of groups) {
        const route = config.broadcast.routes.find((r) => r.value === group);
        if (route && route.chatId) chatIds.add(route.chatId);
      }
    }
    if (chatIds.size === 0) continue;

    const ticket = {
      recordId: record.record_id,
      title: getTicketTitle(fields, record.record_id),
      handlerName: people[0].name || '未知',
      daysLeft,
      deadlineFormatted: deadlineTs.format('YYYY-MM-DD'),
    };
    const bucket = daysLeft <= 2 ? 'urgent' : 'week';
    for (const chatId of chatIds) {
      if (!result[chatId]) result[chatId] = { urgent: [], week: [] };
      result[chatId][bucket].push(ticket);
    }
  }

  for (const buckets of Object.values(result)) {
    buckets.urgent.sort((a, b) => a.daysLeft - b.daysLeft);
    buckets.week.sort((a, b) => a.daysLeft - b.daysLeft);
  }

  if (skippedNoResponsible > 0) {
    console.log(`[未结单分组] ${skippedNoResponsible} 条工单无指定/补充负责人，跳过分栏播报`);
  }

  return result;
}

module.exports = {
  getUnclosedByGroup,
};
