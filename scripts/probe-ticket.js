/**
 * 按申请编号定位工单并打印全部字段（排查播报问题）
 * 用法：node scripts/probe-ticket.js 202609050003
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

function text(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join('、');
  if (typeof v === 'object') return v.text || v.name || JSON.stringify(v);
  return String(v);
}

(async () => {
  const no = process.argv[2] || '';
  if (!no) throw new Error('用法: node scripts/probe-ticket.js <申请编号>');

  const token = await getToken();
  const list = await api(token, 'GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records?page_size=500`);
  if (list.code !== 0) throw new Error(`读表失败: ${list.msg}`);

  const items = list.data?.items || [];
  const hit = items.find((r) => text(r.fields['申请编号']).includes(no));
  if (!hit) {
    console.log(`未找到申请编号含「${no}」的记录（表内共 ${items.length} 条）。`);
    console.log('现有编号:');
    for (const r of items) console.log(`  - ${text(r.fields['申请编号'])}`);
    return;
  }

  console.log(`命中记录 ${hit.record_id}，全部字段：\n`);
  for (const [k, v] of Object.entries(hit.fields)) {
    const s = Array.isArray(v) || typeof v === 'object' ? JSON.stringify(v) : String(v);
    console.log(`  ${k} = ${s.slice(0, 200)}`);
  }

  // 播报判定模拟（与 src 修复后逻辑一致）
  const nodeField = process.env.APPROVAL_NODE_FIELD || '审批节点';
  const acceptValues = (process.env.APPROVAL_NODE_ACCEPT_VALUE || '群内有组员接单后通过,有组员接单后通过,负责人确认消息后通过')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const raw = hit.fields[nodeField];
  const segs = String(raw ?? '').split(/[;；,，、|]/).map((s) => s.trim()).filter(Boolean);
  const nodeHit = segs.some((seg) => acceptValues.includes(seg));
  console.log('\n—— 播报判定模拟（修复后逻辑）——');
  console.log(`  审批节点拆段: ${JSON.stringify(segs)}`);
  console.log(`  命中触发节点: ${nodeHit}`);
  console.log(`  是否指定负责人: ${text(hit.fields['是否指定人员负责']) || '(空)'}`);
  console.log(`  已播报标记: ${text(hit.fields[process.env.BROADCAST_MARK_FIELD || '已播报']) || '(空)'}`);
  console.log(`  补充负责人: ${text(hit.fields['补充负责人']) || '(空)'}`);
  console.log(`  多人接单列: ${text(hit.fields['是否允许多人接单']) || '(空)'}`);
})();
