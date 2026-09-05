/**
 * 排查最新工单为何未播报：列出最近记录的关键字段（审批节点/是否指定/面向组别/标记）
 * 用法：node scripts/probe-latest-nodes.js [条数，默认8]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = process.env.BITABLE_APP_TOKEN;
const TABLE_ID = process.env.SOURCE_TABLE_ID || 'tblFA6Pj4Mv83Mb0';
const NODE_FIELD = process.env.APPROVAL_NODE_FIELD || '审批节点';
const MARK_FIELD = process.env.BROADCAST_MARK_FIELD || '已播报';

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

function text(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join('、');
  if (typeof v === 'object') return v.text || v.name || JSON.stringify(v);
  return String(v);
}

(async () => {
  const token = await getToken();
  const limit = Number(process.argv[2] || 8);
  const list = await api(token, 'GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records?page_size=500`);
  if (list.code !== 0) throw new Error(`读表失败: ${list.msg}`);

  const records = (list.data?.items || []).map((r) => ({ id: r.record_id, f: r.fields }));
  // 按创建时间倒序取最近 N 条（字段值是毫秒时间戳）
  records.sort((a, b) => (b.f['创建时间'] || b.f['发起时间'] || 0) - (a.f['创建时间'] || a.f['发起时间'] || 0));

  console.log(`源表共 ${records.length} 条，最近 ${Math.min(limit, records.length)} 条：\n`);
  for (const r of records.slice(0, limit)) {
    const f = r.f;
    console.log(`— record ${r.id}`);
    console.log(`  审批节点      : [${text(f[NODE_FIELD])}]`);
    console.log(`  是否指定负责人: [${text(f['是否指定人员负责'])}]`);
    console.log(`  面向组别      : [${text(f['面向组别'])}]`);
    console.log(`  补充负责人    : [${text(f['补充负责人'])}]`);
    console.log(`  已播报标记    : [${text(f[MARK_FIELD])}]`);
    console.log(`  是否多人接单  : [${text(f['是否允许多人接单'])}]`);
    console.log(`  发起时间      : [${text(f['发起时间'] || f['创建时间'])}]`);
  }

  // 顺带统计全表审批节点的取值分布（看新流程的节点名长什么样）
  const nodeCount = {};
  for (const r of records) {
    const key = text(r.f[NODE_FIELD]) || '(空)';
    nodeCount[key] = (nodeCount[key] || 0) + 1;
  }
  console.log('\n全表审批节点取值分布:');
  for (const [k, v] of Object.entries(nodeCount).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v} 条  [${k}]`);
  }
})();
