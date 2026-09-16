const config = require('../config');
const dayjs = require('dayjs');
const { listAllRecords } = require('../feishu/bitable');
const { resolvePersonGroups } = require('../utils/personFields');
const { getCreatedTime } = require('../utils/fields');

// 无人接单分桶阈值：与超时检查一致（发起超过 6h 仍无人接单才进 DDL 曝光，刚发布的工单不播）
const UNCLAIMED_MIN_AGE_MS = 6 * 60 * 60 * 1000;

// 与 pm-robot ticketCloseService 对齐的字段解析（2026-09-17 口径）：标题=需求文本优先
// （需求1/需求），申请编号只作 code 标注字段——此前标题取 申请编号 优先，导致 DDL 分栏
// 每行只显示编号看不到需求内容；两者都空回退 工单-后6位。需求截断 40 字防卡片爆行。
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

function getTicketDisplay(fields, recordId) {
  const code = extractText(fields['申请编号']);
  const request = extractText(fields['需求1']) || extractText(fields['需求']);
  const raw = request || code || `工单-${recordId.slice(-6)}`;
  return { title: raw.length > 40 ? `${raw.slice(0, 40)}…` : raw, code };
}

/**
 * 工单按组分桶（供 DDL 播报分组分栏使用），一次全量拉取后按审批节点本地拆分两类：
 *
 * 1. 结单分桶（urgent/week）+ 等回执桶（waiting）：节点 =「回执单：是否结单」（拆段匹配）。
 *    有负责人且理想结单时间在 7 日内 → urgent（≤2 天）/ week（2-7 天）；其余（无负责人 /
 *    未填结单时间 / 超 7 日）一律进 waiting 桶（2026-09-17 用户口径：等回执=没做完，
 *    节点上不允许静默漏播）。播报对象 = 指定负责人 → 补充负责人（不回退发起人/当前
 *    处理人）；有负责人按人解组别（USER_GROUPS → 通讯录部门 → 面向组别兜底），
 *    无负责人按「面向组别」直分（与无人接单桶同款兜底）。
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
  let unclaimedTotal = 0;

  const ensureChat = (chatId) => {
    if (!result[chatId]) result[chatId] = { urgent: [], week: [], unclaimed: [], waiting: [] };
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

      const display = getTicketDisplay(fields, record.record_id);
      const ticket = {
        recordId: record.record_id,
        title: display.title,
        code: display.code,
        elapsedHours: Math.floor((nowMs - createdMs) / (60 * 60 * 1000)),
        groups: groupList,
      };
      for (const chatId of chatIds) ensureChat(chatId).unclaimed.push(ticket);
      unclaimedTotal++;
      continue; // 触发节点工单不进结单分桶
    }

    // —— 结单分桶：节点 =「回执单：是否结单」——
    // 2026-09-17 用户口径：等回执的工单说明没做完，节点上不允许静默漏播——
    // 有负责人且有 7 日内结单时间 → urgent/week；其余（无负责人/未填结单时间/超 7 日）→ waiting 桶
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

    const deadline = fields[deadlineField];
    const deadlineTs = deadline ? dayjs(deadline) : null;
    const hasDeadline = Boolean(deadlineTs && deadlineTs.isValid());
    const daysLeft = hasDeadline ? deadlineTs.diff(now, 'day') : null;

    // 分组：有负责人按人解组别；无负责人按「面向组别」直分（与无人接单桶同款兜底）
    const chatIds = new Set();
    if (people.length > 0) {
      for (const person of people) {
        const groups = await resolvePersonGroups(routeField ? fields[routeField] : null, person);
        for (const group of groups) {
          const route = config.broadcast.routes.find((r) => r.value === group);
          if (route && route.chatId) chatIds.add(route.chatId);
        }
      }
    } else {
      const groups = fields[routeField] || [];
      const groupList = Array.isArray(groups) ? groups.map(String) : groups ? [String(groups)] : [];
      for (const group of groupList) {
        const route = config.broadcast.routes.find((r) => r.value === group);
        if (route && route.chatId) chatIds.add(route.chatId);
      }
    }
    if (chatIds.size === 0) continue; // 组别/路由都解不出来（管理层等），仍无法定向播报

    const display = getTicketDisplay(fields, record.record_id);
    const qualifiesNormal = people.length > 0 && daysLeft !== null && daysLeft <= 7;
    if (qualifiesNormal) {
      const ticket = {
        recordId: record.record_id,
        title: display.title,
        code: display.code,
        handlerName: people.map((p) => p.name || '未知').join('、'),
        daysLeft,
        deadlineFormatted: deadlineTs.format('YYYY-MM-DD'),
      };
      const bucket = daysLeft <= 2 ? 'urgent' : 'week';
      for (const chatId of chatIds) {
        ensureChat(chatId)[bucket].push(ticket);
      }
    } else {
      // 等回执待结单：无负责人 / 未填理想结单时间 / 超出 7 日窗口——也要曝光
      const ticket = {
        recordId: record.record_id,
        title: display.title,
        code: display.code,
        handlerName: people.length ? people.map((p) => p.name || '未知').join('、') : '',
        daysLeft,
        deadlineFormatted: hasDeadline ? deadlineTs.format('YYYY-MM-DD') : '',
      };
      for (const chatId of chatIds) {
        ensureChat(chatId).waiting.push(ticket);
      }
    }
  }

  // 排序：结单桶按剩余天数升序（越紧越前）；无人接单桶按已发布时长降序（等最久的排前）；
  // waiting 桶有结单时间的在前（升序），未填时间的殿后
  for (const buckets of Object.values(result)) {
    buckets.urgent.sort((a, b) => a.daysLeft - b.daysLeft);
    buckets.week.sort((a, b) => a.daysLeft - b.daysLeft);
    buckets.unclaimed.sort((a, b) => b.elapsedHours - a.elapsedHours);
    buckets.waiting.sort((a, b) => {
      if (a.daysLeft === null && b.daysLeft === null) return 0;
      if (a.daysLeft === null) return 1;
      if (b.daysLeft === null) return -1;
      return a.daysLeft - b.daysLeft;
    });
  }

  if (unclaimedTotal > 0) {
    console.log(`[未结单分组] 无人接单分栏 ${unclaimedTotal} 条（触发节点滞留超 6h）`);
  }

  return result;
}

module.exports = {
  getUnclosedByGroup,
};
