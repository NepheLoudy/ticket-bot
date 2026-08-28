/**
 * 结构探测脚本：列出多维表格的全部数据表、每张表的字段定义、机器人所在群聊
 * 用于填写 .env（SOURCE_TABLE_ID / TARGET_TABLE_ID / GROUP_ROUTES 等）
 *
 * 用法：node scripts/discover.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = process.env.BITABLE_APP_TOKEN || 'ZlVZbXDkRayUzSsFRiycznmZn5b';

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
  const token = await getToken();

  // 1. 数据表列表
  const tables = await api(token, 'GET', `/bitable/v1/apps/${APP_TOKEN}/tables?page_size=100`);
  console.log('========== 数据表列表 ==========');
  for (const t of tables.data?.items || []) {
    console.log(`table_id: ${t.table_id}  名称: ${t.name}  URL参数table=${t.table_id}`);
  }

  // 2. 每张表的字段
  for (const t of tables.data?.items || []) {
    const fields = await api(token, 'GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${t.table_id}/fields?page_size=100`);
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

main().catch(err => {
  console.error('探测失败:', err.message);
  process.exit(1);
});
