/**
 * 探测项目看板字段结构
 * 用法：node scripts/probe-project-table.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = process.env.BITABLE_APP_TOKEN;
const TABLE_ID = 'tblIcyn9814CsgaH'; // 项目看板

async function getToken() {
  const res = await fetch(`${BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: process.env.APP_ID, app_secret: process.env.APP_SECRET }),
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

  // 1. 项目看板字段
  const fields = await api(token, 'GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields?page_size=100`);
  console.log('========== 项目看板字段 ==========');
  for (const f of fields.data?.items || []) {
    let extra = '';
    if (f.property?.options) {
      extra = ' 选项: ' + f.property.options.map(o => o.name).join(' / ');
    }
    console.log(`- ${f.field_name}  [类型:${f.type}${f.ui_type ? '/' + f.ui_type : ''}]${extra}`);
  }

  // 2. 抽样 3 条项目记录
  const recs = await api(token, 'GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records?page_size=3`);
  console.log('\n========== 项目看板抽样记录 ==========');
  for (const r of recs.data?.items || []) {
    console.log(JSON.stringify({ record_id: r.record_id, fields: r.fields }, null, 2));
  }

  // 3. category 字段的选项（用于理解父子关系）
  const categoryField = (fields.data?.items || []).find(f => f.field_name === 'category');
  if (categoryField?.property?.options) {
    console.log('\n========== category 选项 ==========');
    for (const opt of categoryField.property.options) {
      console.log(`- ${opt.name} (id: ${opt.id})`);
    }
  }
}

main().catch(err => {
  console.error('探测失败:', err.message);
  process.exit(1);
});
