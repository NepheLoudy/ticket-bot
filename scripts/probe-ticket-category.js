/**
 * 探测工单表的 category 字段选项
 * 用法：node scripts/probe-ticket-category.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = process.env.BITABLE_APP_TOKEN;
const TABLE_ID = process.env.SOURCE_TABLE_ID;

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

  // 1. 工单表字段
  const fields = await api(token, 'GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields?page_size=100`);
  console.log('========== 工单表字段 ==========');
  for (const f of fields.data?.items || []) {
    let extra = '';
    if (f.property?.options) {
      extra = ' 选项: ' + f.property.options.map(o => o.name).join(' / ');
    }
    console.log(`- ${f.field_name}  [类型:${f.type}${f.ui_type ? '/' + f.ui_type : ''}]${extra}`);
  }

  // 2. category 字段详情
  const categoryField = (fields.data?.items || []).find(f => f.field_name === 'category');
  if (categoryField) {
    console.log('\n========== category 字段详情 ==========');
    console.log(JSON.stringify(categoryField, null, 2));
  }

  // 3. 抽样有 category 值的工单
  const recs = await api(token, 'GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records?page_size=50`);
  console.log('\n========== 有 category 的工单 ==========');
  const withCategory = (recs.data?.items || []).filter(r => r.fields['category']);
  console.log(`共 ${withCategory.length} 条有 category 值`);
  for (const r of withCategory.slice(0, 5)) {
    console.log(`- ${r.fields['申请编号'] || r.record_id}: category=${r.fields['category']}, 面向组别=${JSON.stringify(r.fields['面向组别'])}, 指定负责人=${r.fields['指定负责人']?.[0]?.name || '无'}`);
  }
}

main().catch(err => {
  console.error('探测失败:', err.message);
  process.exit(1);
});
