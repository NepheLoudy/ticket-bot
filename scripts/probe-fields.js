/**
 * 核对工单表列名与最新记录的「多人接单」相关取值
 * 用法：node scripts/probe-fields.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = process.env.BITABLE_APP_TOKEN;
const TABLE_ID = process.env.SOURCE_TABLE_ID || 'tblFA6Pj4Mv83Mb0';

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

(async () => {
  const token = await getToken();

  const fields = await api(token, 'GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields?page_size=100`);
  if (fields.code !== 0) throw new Error(`读字段失败: ${fields.msg}`);
  console.log('工单表全部列名:');
  for (const f of fields.data?.items || []) {
    console.log(`  - ${f.field_name} (${f.type})`);
  }

  const list = await api(token, 'GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records?page_size=500`);
  if (list.code !== 0) throw new Error(`读表失败: ${list.msg}`);
  const records = (list.data?.items || []).map((r) => r.fields);
  records.sort((a, b) => (b['创建时间'] || b['发起时间'] || 0) - (a['创建时间'] || a['发起时间'] || 0));

  const latest = records[0];
  console.log('\n最新一条记录的全部非空字段:');
  for (const [k, v] of Object.entries(latest || {})) {
    const text = Array.isArray(v) ? JSON.stringify(v) : String(typeof v === 'object' ? JSON.stringify(v) : v);
    console.log(`  ${k} = ${text.slice(0, 120)}`);
  }

  // 所有名字带「多人」的列在最近 5 条上的取值
  const multiCols = (fields.data?.items || []).map((f) => f.field_name).filter((n) => n.includes('多人'));
  console.log(`\n名字带「多人」的列: ${multiCols.length ? multiCols.join(' / ') : '(无)'}`);
  for (const col of multiCols) {
    records.slice(0, 5).forEach((r, i) => {
      const v = r[col];
      console.log(`  第${i + 1}条 [${col}] = ${v === undefined ? '(列不存在于该记录)' : JSON.stringify(v)}`);
    });
  }
})();
