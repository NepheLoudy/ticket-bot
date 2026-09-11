const config = require('../config');

const BASE_URL = 'https://open.feishu.cn/open-apis';

// tenant_access_token 缓存，避免每次调用都重新获取
let tokenCache = { token: null, expiresAt: 0 };

/**
 * 获取飞书 tenant_access_token（带缓存，提前 60 秒过期）
 */
async function getTenantAccessToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 60 * 1000) {
    return tokenCache.token;
  }

  if (!config.feishu.appId || !config.feishu.appSecret) {
    throw new Error('未配置飞书应用凭证 (APP_ID/APP_SECRET)');
  }

  const res = await fetch(`${BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: config.feishu.appId,
      app_secret: config.feishu.appSecret,
    }),
  });

  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`获取 tenant_access_token 失败: ${data.msg} (code: ${data.code})`);
  }

  tokenCache = {
    token: data.tenant_access_token,
    expiresAt: now + data.expire * 1000,
  };
  return tokenCache.token;
}

/**
 * 调用飞书开放平台 API
 * @param {string} method HTTP 方法
 * @param {string} path 路径（以 / 开头，不含 host）
 * @param {object} body 请求体（GET 时传 null）
 * @returns {Promise<object>} 飞书返回的完整 JSON（含 code/msg/data）
 */
async function requestAPI(method, path, body) {
  const token = await getTenantAccessToken();

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    // 无超时的 fetch 挂起会拖死每分钟对账与全部 cron，15s 强制超时
    signal: AbortSignal.timeout(15000),
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  try {
    return await res.json();
  } catch (err) {
    throw new Error(`飞书 API 返回非 JSON 响应 (HTTP ${res.status}): ${path}`);
  }
}

module.exports = {
  getTenantAccessToken,
  requestAPI,
};
