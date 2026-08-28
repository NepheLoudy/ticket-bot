/**
 * 数据形态探测：抽样源表记录 + 测试通过通讯录查询人员部门
 * 用法：node scripts/probe-data.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = process.env.BITABLE_APP_TOKEN;
const TABLE_ID = 'tblFA6Pj4Mv83Mb0';

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

  // 1. 抽样 5 条源表记录
  const recs = await api(token, 'GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records?page_size=5`);
  console.log('========== 源表抽样记录 ==========');
  let sampleUser = null;
  for (const r of recs.data?.items || []) {
    console.log(JSON.stringify({ record_id: r.record_id, fields: r.fields }, null, 2));
    if (!sampleUser && r.fields['指定负责人']) sampleUser = r.fields['指定负责人'][0];
  }

  // 2. 部门列表（看是否存在与组别对应的部门）
  const depts = await api(token, 'GET', '/contact/v3/departments?department_id_type=department_id&fetch_child=true&page_size=50&user_id_type=open_id');
  console.log('\n========== 部门列表 ==========');
  if (depts.code !== 0) {
    console.log(`查询部门失败: ${depts.msg} (code: ${depts.code})`);
  } else {
    for (const d of depts.data?.items || []) {
      console.log(`dept_id: ${d.department_id}  名称: ${d.name}`);
    }
  }

  // 3. 抽样人员的部门
  if (sampleUser?.id) {
    const u = await api(token, 'GET', `/contact/v3/users/${sampleUser.id}?user_id_type=open_id&department_id_type=department_id`);
    console.log(`\n========== 人员「${sampleUser.name}」的部门 ==========`);
    if (u.code !== 0) {
      console.log(`查询人员失败: ${u.msg} (code: ${u.code})`);
    } else {
      console.log(JSON.stringify({ name: u.data?.user?.name, department_ids: u.data?.user?.department_ids }, null, 2));
    }
  }
}

main().catch(err => {
  console.error('探测失败:', err.message);
  process.exit(1);
});
