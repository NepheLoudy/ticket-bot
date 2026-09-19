const config = require('../config');
const bitableApi = require('../feishu/bitable');

// ============================================================
// 动态广场事件流（机器人项目看板「动态广场」表）：
// 关键业务事件落一行，供多维表格仪表盘/时间线展示。
// 只观察不阻塞：写失败仅 warn，绝不影响主流程；未配置表时整体静默。
// 2026-09-20 拍板：动态广场改由用户自维护，机器人停写——PLAZA_ENABLED=1 才恢复
//（停写后用户恢复/重建广场表也不会被机器人灌数据，TableIdNotFound warn 不再刷）。
// ============================================================

const SOURCE = 'ticket-bot';

function enabled() {
  if (process.env.PLAZA_ENABLED !== '1') return false;
  return Boolean(config.plaza && config.plaza.appToken && config.plaza.tableId);
}

async function append({ event, title, count, link } = {}) {
  if (!enabled() || !event || !title) return;
  try {
    await bitableApi.createRecord(config.plaza.appToken, config.plaza.tableId, {
      '标题': String(title).slice(0, 500),
      '来源机器人': SOURCE,
      '事件类型': event,
      ...(count != null ? { '数量': count } : {}),
      ...(link ? { '链接': { link } } : {}),
    });
  } catch (err) {
    console.warn('[动态广场] 写入失败（忽略）:', err.message);
  }
}

module.exports = { append };
