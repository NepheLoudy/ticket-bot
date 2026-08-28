/**
 * 查询项目看板中各 category 的顶层项目（parentId 为空的记录）
 * 用法：node scripts/query-parent-projects.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = process.env.BITABLE_APP_TOKEN;
const TABLE_ID = 'tblIcyn9814CsgaH';

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

  // 查询所有项目
  const recs = await api(token, 'GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records?page_size=500`);
  const all = recs.data?.items || [];

  console.log(`========== 项目看板共 ${all.length} 条记录 ==========\n`);

  // 按 category 分组
  const byCategory = {};
  for (const r of all) {
    const cat = r.fields['category'] || '(无category)';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(r);
  }

  // 找出顶层项目（parentId 为空或 null）
  console.log('========== 各 category 的顶层项目（parentId 为空） ==========\n');
  for (const [cat, items] of Object.entries(byCategory).sort()) {
    const topLevel = items.filter(r => {
      const p = r.fields['parentId'];
      if (!p || !Array.isArray(p) || p.length === 0) return true;
      const first = p[0];
      return !first.record_ids && !first.text;
    });

    if (topLevel.length > 0) {
      console.log(`【${cat}】顶层项目 ${topLevel.length} 个：`);
      for (const r of topLevel.slice(0, 3)) {
        console.log(`  - ${r.fields['name']} (record_id: ${r.record_id})`);
      }
      if (topLevel.length > 3) {
        console.log(`  ... 还有 ${topLevel.length - 3} 个`);
      }
      console.log('');
    }
  }

  // 统计有 parentId 的子项目
  const withParent = all.filter(r => {
    const p = r.fields['parentId'];
    if (!p || !Array.isArray(p) || p.length === 0) return false;
    const first = p[0];
    return first.record_ids || first.text;
  });
  console.log(`========== 有 parentId 的子项目：${withParent.length} 条 ==========\n`);
  for (const r of withParent.slice(0, 5)) {
    const p = r.fields['parentId'][0];
    console.log(`- ${r.fields['name']} (category: ${r.fields['category']}) -> parentId: ${p.record_ids || p.text}`);
  }
}

main().catch(err => {
  console.error('查询失败:', err.message);
  process.exit(1);
});
