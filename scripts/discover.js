/**
 * 结构探测脚本：列出多维表格的全部数据表、每张表的字段定义、机器人所在群聊
 * 用于填写 .env（SOURCE_TABLE_ID / TARGET_TABLE_ID / GROUP_ROUTES 等）
 *
 * 用法：node scripts/discover.js
 * 需 .env 配 BITABLE_APP_TOKEN（要探测的多维表格 app_token）；缺失时直接报错退出，不字面量兜底
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'https://open.feishu.cn/open-apis';

// 探测目标 base 的 app_token（资源标识符非密钥）：纯 env 读取 + fail-closed。
// 2026-11-22 TICKET-DISCOVER-ENV（安全审计 P2）：移除字面量兜底——硬编码换 base 时会漏改。
function resolveAppToken(env) {
  const v = (env.BITABLE_APP_TOKEN || '').trim();
  if (!v) {
    throw new Error(
      '缺少 BITABLE_APP_TOKEN：未配置要探测的多维表格 app_token。' +
        '请在 .env 配 BITABLE_APP_TOKEN 键（机器人项目看板 base 的 app_token，资源标识符非密钥，' +
        '现网值见项目 AGENTS.md），或行内临时指定：BITABLE_APP_TOKEN=<app_token> node scripts/discover.js'
    );
  }
  return v;
}

async function getToken() {
  const res = await fetch(`${BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: process.env.APP_ID,
      app_secret: process.env.APP_SECRET,
    }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`获取token失败: ${data.msg}`);
  return data.tenant_access_token;
}

async function api(token, method, p) {
  const res = await fetch(`${BASE_URL}${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return res.json();
}

async function main() {
  const appToken = resolveAppToken(process.env); // fail-closed：任何网络请求之前先校验
  const token = await getToken();

  // 1. 数据表列表
  const tables = await api(token, 'GET', `/bitable/v1/apps/${appToken}/tables?page_size=100`);
  console.log('========== 数据表列表 ==========');
  for (const t of tables.data?.items || []) {
    console.log(`table_id: ${t.table_id}  名称: ${t.name}  URL参数table=${t.table_id}`);
  }

  // 2. 每张表的字段
  for (const t of tables.data?.items || []) {
    const fields = await api(token, 'GET', `/bitable/v1/apps/${appToken}/tables/${t.table_id}/fields?page_size=100`);
    console.log(`\n========== 表「${t.name}」(${t.table_id}) 字段 ==========`);
    for (const f of fields.data?.items || []) {
      let extra = '';
      if (f.property?.options) {
        extra = ' 选项: ' + f.property.options.map(o => o.name).join(' / ');
      }
      console.log(`- ${f.field_name}  [类型:${f.type}${f.ui_type ? '/' + f.ui_type : ''}]${extra}`);
    }
  }

  // 3. 机器人所在群聊
  const chats = await api(token, 'GET', '/im/v1/chats?page_size=100');
  console.log('\n========== 机器人所在群聊 ==========');
  for (const c of chats.data?.items || []) {
    console.log(`chat_id: ${c.chat_id}  名称: ${c.name}`);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('探测失败:', err.message);
    process.exit(1);
  });
}

// 供离线桩测试 require（stub-test-discover-env.js），不触发 main
module.exports = { resolveAppToken, main };
