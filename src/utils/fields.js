/**
 * 飞书多维表格字段值的格式化与归一化工具
 */

/**
 * 将字段原始值格式化为可读文本（用于播报卡片/指令回复展示）
 */
function formatFieldValue(value) {
  if (value === null || value === undefined || value === '') return '';

  if (Array.isArray(value)) {
    return value.map(v => formatSingleValue(v)).filter(Boolean).join('、');
  }
  return formatSingleValue(value);
}

function formatSingleValue(value) {
  if (value === null || value === undefined || value === '') return '';

  if (typeof value === 'string') return value;
  if (typeof value === 'number') return formatMaybeTimestamp(value);
  if (typeof value === 'boolean') return value ? '是' : '否';

  if (typeof value === 'object') {
    // 人员: { id, name }
    if (value.name) return value.name;
    // 超链接: { link, text } → 渲染为 markdown 链接，避免展示冗长 URL
    if (value.link) return value.text ? `[${value.text}](${value.link})` : value.link;
    // 附件: { file_token, name }
    if (value.file_token && value.name) return value.name;
    if (value.text) return value.text;
    return JSON.stringify(value);
  }

  return String(value);
}

/**
 * 大数值视为毫秒时间戳（多维表格日期字段的返回格式），仅保留日期（去掉时分秒）
 */
function formatMaybeTimestamp(num) {
  if (Number.isFinite(num) && num > 10 ** 12) {
    try {
      const d = new Date(num);
      return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    } catch (e) {
      return String(num);
    }
  }
  return String(num);
}

/**
 * 提取字段的纯文本（用于标题等场景，超链接只取 text、人员只取 name）
 */
function formatFieldText(value) {
  if (Array.isArray(value)) value = value[0];
  if (value && typeof value === 'object') {
    if (value.text !== null && value.text !== undefined && value.text !== '') return String(value.text);
    if (value.name) return String(value.name);
    if (value.link) return String(value.link);
  }
  return formatFieldValue(value);
}

/**
 * 将时间戳归一到当天 00:00:00（用于目标表日期字段，去掉时分秒）
 */
function toDateOnlyTimestamp(num) {
  if (!Number.isFinite(num)) return num;
  const d = new Date(num);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 将字段原始值归一化为目标表可写值
 * 人员等引用型数组仅保留 id（跨表写入时 name 可能不匹配）
 */
function normalizeForWrite(value) {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    if (
      value.length > 0 &&
      typeof value[0] === 'object' &&
      value[0] !== null &&
      'id' in value[0] &&
      !('file_token' in value[0]) &&
      !('link' in value[0])
    ) {
      // 人员/部门等引用型字段
      return value.map(v => (typeof v === 'object' && v !== null ? { id: v.id } : v));
    }
    return value;
  }

  return value;
}

/**
 * 工单发起时间（毫秒）：优先「发起时间」，缺失回退「创建时间」，都没有返回 0。
 * 播报排序/超时判断统一走这里，避免两处字段名不一致导致排序口径漂移
 */
function getCreatedTime(fields) {
  return fields?.['发起时间'] || fields?.['创建时间'] || 0;
}

module.exports = {
  formatFieldValue,
  formatFieldText,
  toDateOnlyTimestamp,
  normalizeForWrite,
  getCreatedTime,
};
