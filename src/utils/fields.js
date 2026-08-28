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
    // 超链接: { link, text }
    if (value.link) return value.text ? `${value.text}(${value.link})` : value.link;
    // 附件: { file_token, name }
    if (value.file_token && value.name) return value.name;
    if (value.text) return value.text;
    return JSON.stringify(value);
  }

  return String(value);
}

/**
 * 大数值视为毫秒时间戳（多维表格日期字段的返回格式）
 */
function formatMaybeTimestamp(num) {
  if (Number.isFinite(num) && num > 10 ** 12) {
    try {
      return new Date(num).toLocaleString('zh-CN', { hour12: false });
    } catch (e) {
      return String(num);
    }
  }
  return String(num);
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

module.exports = {
  formatFieldValue,
  normalizeForWrite,
};
