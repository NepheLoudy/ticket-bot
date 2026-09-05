const config = require('../config');
const dayjs = require('dayjs');
const { listAllRecords } = require('../feishu/bitable');
const { resolvePersonGroups } = require('../utils/personFields');
const { getCreatedTime } = require('../utils/fields');

// 无人接单分桶阈值：与超时检查一致（发起超过 6h 仍无人接单才进 DDL 曝光，刚发布的工单不播）
const UNCLAIMED_MIN_AGE_MS = 6 * 60 * 60 * 1000;

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
 * 工单按组分桶（供 DDL 播报分组分栏使用），一次全量拉取后按审批节点本地拆分两类：
 *
 * 1. 结单分桶（urgent/week）：节点 =「回执单：是否结单」（拆段匹配）且理想结单时间
 *    在 7 日内。播报对象 = 指定负责人 → 补充负责人（两者都空不播，不回退发起人/当前
 *    处理人）；分组按负责人所属组别（USER_GROUPS → 通讯录部门 → 面向组别兜底）。
 * 2. 无人接单分桶（unclaimed）：节点 ∈ 触发节点（拆段匹配）+ 补充负责人为空
 *    （有人接单即写入该字段：公示即绑定/多人单续接都天然不在此列）+ 距发起时间
 *    ≥ 6h（与超时检查阈值对齐）。无负责人可解析，分组直接用工单「面向组别」。
 *
 * 分组经播报路由映射为群 chatId；一张工单跨多组会出现在多个群。
 *
 * 口径说明（勿当成 bug）：
 * - 管理层/未匹配到播报群组别的工单不会出现在任何 DDL 分栏——管理层群只同步
 *   工单发布与问询播报（GROUP_ROUTES），不作为 DDL 播报对象（hub 仅读四个播报群键）；
 * - pm-robot 降级直读链路（ticket-bot 不可用时）两个分桶的口径应与本章一致；
 * - 全量拉取本地拆段匹配而非服务端等值过滤：并行分支会把节点名以「；」拼接写入
 *   同一字段（与超时检查/确认追问同款做法），等值过滤对拼接值静默失效。
 *
 * @returns {Promise<Object<{urgent: Array, week: Array, unclaimed: Array}>>} 以群 chatId 为键
 */
async function getUnclosedByGroup() {
  const { sourceAppToken, sourceTableId } = config.bitable;
  const approvalField = config.approvalNode.field;
  const closeValue = config.approvalNode.closeValue;
  const deadlineField = config.closeReminder.deadlineField;
  const routeField = config.broadcast.routeField;
  const assigneeField = config.assign.assigneeField || '指定负责人';
  const supplementField = config.assign.supplementField || '补充负责人';

  const records = await listAllRecords(sourceAppToken, sourceTableId);

  const now = dayjs();
  const nowMs = Date.now();
  const result = {};
  let skippedNoResponsible = 0;
  let unclaimedTotal = 0;

  const ensureChat = (chatId) => {
    if (!result[chatId]) result[chatId] = { urgent: [], week: [], unclaimed: [] };
    return result[chatId];
  };

  for (const record of records) {
    const fields = record.fields;
    const nodeValue = approvalField ? fields[approvalField] : '';

    // —— 无人接单分桶：触发节点 + 补充负责人为空 + 发起超过 6h ——
    if (config.matchNodeValue(nodeValue, config.approvalNode.acceptValues)) {
      const sup = fields[supplementField];
      if (sup && sup.length > 0) continue; // 已有人接单（含公示即绑定/多人单续接中）
      const createdMs = Number(getCreatedTime(fields)) || 0; // 缺失/非数值跳过（宁漏勿误）
      if (!createdMs || nowMs - createdMs < UNCLAIMED_MIN_AGE_MS) continue;

      const groups = fields[routeField] || [];
      const groupList = Array.isArray(groups) ? groups.map(String) : groups ? [String(groups)] : [];
      const chatIds = new Set();
      for (const group of groupList) {
        const route = config.broadcast.routes.find((r) => r.value === group);
        if (route && route.chatId) chatIds.add(route.chatId);
      }
      if (chatIds.size === 0) continue;

      const ticket = {
        recordId: record.record_id,
        title: getTicketTitle(fields, record.record_id),
        elapsedHours: Math.floor((nowMs - createdMs) / (60 * 60 * 1000)),
      };
      for (const chatId of chatIds) ensureChat(chatId).unclaimed.push(ticket);
      unclaimedTotal++;
      continue; // 触发节点工单不进结单分桶
    }

    // —— 结单分桶：节点 =「回执单：是否结单」——
    if (!config.matchNodeValue(nodeValue, [closeValue])) continue;

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
      handlerName: people.map((p) => p.name || '未知').join('、'),
      daysLeft,
      deadlineFormatted: deadlineTs.format('YYYY-MM-DD'),
    };
    const bucket = daysLeft <= 2 ? 'urgent' : 'week';
    for (const chatId of chatIds) {
      ensureChat(chatId)[bucket].push(ticket);
    }
  }

  // 排序：结单桶按剩余天数升序（越紧越前）；无人接单桶按已发布时长降序（等最久的排前）
  for (const buckets of Object.values(result)) {
    buckets.urgent.sort((a, b) => a.daysLeft - b.daysLeft);
    buckets.week.sort((a, b) => a.daysLeft - b.daysLeft);
    buckets.unclaimed.sort((a, b) => b.elapsedHours - a.elapsedHours);
  }

  if (skippedNoResponsible > 0) {
    console.log(`[未结单分组] ${skippedNoResponsible} 条工单无指定/补充负责人，跳过分栏播报`);
  }
  if (unclaimedTotal > 0) {
    console.log(`[未结单分组] 无人接单分栏 ${unclaimedTotal} 条（触发节点滞留超 6h）`);
  }

  return result;
}

module.exports = {
  getUnclosedByGroup,
};
