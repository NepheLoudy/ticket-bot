const crypto = require('crypto');

// ============================================================
// 管理端点鉴权（2026-09-13，gateway auth.js 同款模板）：
// 写/配置类 POST 端点需带 X-API-Token 头（API_TOKEN，.env 存储随 push 下发，
// 全工作区共享同一值；运维台代理自动带头）。fail-closed：未配置 = 端点锁定。
// /api/feishu/event 与 /api/chat/command 等用户可达链路不挂本中间件。
// ============================================================

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function requireApiToken(req, res, next) {
  const expected = process.env.API_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: '本服务未配置 API_TOKEN，管理端点已锁定（在 .env 配置后重启生效）' });
  }
  const provided = req.get('X-API-Token') || req.query.token || '';
  if (!safeEqual(provided, expected)) {
    return res.status(403).json({ error: '鉴权失败：X-API-Token 缺失或不匹配' });
  }
  next();
}

module.exports = { requireApiToken };
