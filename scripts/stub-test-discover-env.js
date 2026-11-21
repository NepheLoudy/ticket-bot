// discover.js 环境变量化 stub 测试（2026-11-22 TICKET-DISCOVER-ENV，安全审计 P2 整改）：
// base app_token 硬编码字面量已移除——纯 process.env.BITABLE_APP_TOKEN 读取，缺失 fail-closed。
// ① env 有值 → 解析通过且值拼进 bitable 请求 URL（fetch 全桩，零网络）
// ② env 缺失/空白 → 抛错文案指明 BITABLE_APP_TOKEN 键；子进程实测非零退出
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const discover = require('./discover.js'); // require 不触发 main（require.main 守卫）

// —— ① 纯解析：有值原样返回，前后空白 trim ——
assert.strictEqual(discover.resolveAppToken({ BITABLE_APP_TOKEN: 'bfnSTUBbase0001' }), 'bfnSTUBbase0001', '① env 有值应原样解析');
assert.strictEqual(discover.resolveAppToken({ BITABLE_APP_TOKEN: '  bfnSTUBbase0001  ' }), 'bfnSTUBbase0001', '①b 前后空白应 trim');

// —— ② 纯解析：缺失/空白 fail-closed ——
assert.throws(() => discover.resolveAppToken({}), /BITABLE_APP_TOKEN/, '②a env 缺失应抛错且文案含 BITABLE_APP_TOKEN');
assert.throws(() => discover.resolveAppToken({ BITABLE_APP_TOKEN: '   ' }), /BITABLE_APP_TOKEN/, '②b 纯空白串视同缺失');

(async () => {
  // —— ① 集成：main() 把 env 配置的 app_token 拼进表列表/字段请求 URL（fetch 走桩，离线） ——
  const prevToken = process.env.BITABLE_APP_TOKEN;
  process.env.BITABLE_APP_TOKEN = 'bfnSTUBbase0002';
  const realFetch = globalThis.fetch;
  const seenUrls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seenUrls.push(u);
    if (u.includes('/auth/v3/tenant_access_token/internal')) {
      return { json: async () => ({ code: 0, tenant_access_token: 't-stub' }) };
    }
    if (u.endsWith('/tables?page_size=100')) {
      // 数据表列表：回一张桩表，连带走通字段探测分支
      return { json: async () => ({ code: 0, data: { items: [{ table_id: 'tblSTUB01', name: '桩表' }] } }) };
    }
    return { json: async () => ({ code: 0, data: { items: [] } }) };
  };
  try {
    await discover.main();
  } finally {
    globalThis.fetch = realFetch;
    if (prevToken === undefined) delete process.env.BITABLE_APP_TOKEN;
    else process.env.BITABLE_APP_TOKEN = prevToken;
  }
  assert.ok(
    seenUrls.some(u => u.endsWith('/apps/bfnSTUBbase0002/tables?page_size=100')),
    '①c env 配置的 app_token 应进入数据表列表请求 URL'
  );
  assert.ok(
    seenUrls.some(u => u.includes('/apps/bfnSTUBbase0002/tables/tblSTUB01/fields')),
    '①d env 配置的 app_token 应进入字段探测请求 URL'
  );

  // —— ② 集成：子进程跑真脚本，BITABLE_APP_TOKEN 显式置空（dotenv 不覆盖已存在的键，等效缺失）→ 非零退出 ——
  const r = spawnSync(process.execPath, [path.join(__dirname, 'discover.js')], {
    env: { ...process.env, BITABLE_APP_TOKEN: '' },
    encoding: 'utf8',
  });
  assert.notStrictEqual(r.status, 0, '②c env 缺失时脚本必须非零退出');
  const errText = (r.stderr || '') + (r.stdout || '');
  assert.ok(errText.includes('BITABLE_APP_TOKEN'), '②d 错误文案须指明 BITABLE_APP_TOKEN 键');

  console.log('✅ discover 环境变量 stub：8 断言全过（①解析+URL 走查 4 / ②fail-closed 4）');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
