// 工单附图上卡桩测试（2026-11-16）：serial 提取 / form 字符串解析 image 控件 /
// instances/query 分片+serial 匹配+page_token / fetchImageKeys 全链（下载→上传→缓存）/
// 失败降级 []（warn 一次）/ 并发去重。全部出网（token/query/detail/CDN/im 上传）走 fetch 桩。
// 运行：npm run test:approval-images
const config = require('../src/config');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

const realFetch = global.fetch;
const CDN_URL = 'https://lf6-approval-sign.feishucdn.com/img/x.jpeg?x-expires=999#/obj/obj.jpeg';
const formControls = [
  { id: '0', type: 'radioV2', value: '某选项' },
  { id: '1', type: 'textarea', value: '需求描述' },
  { id: '2', type: 'image', value: [CDN_URL] },
];
const RECORD = {
  record_id: 'rec1',
  fields: {
    '申请编号': { link: 'https://applink...', text: '202611140001' },
    '发起时间': Date.now() - 3 * 86400000,
  },
};

function stubFetch(opts = {}) {
  const calls = [];
  global.fetch = async (url, opts2 = {}) => {
    const u = String(url);
    calls.push(u);
    const json = (obj) => ({ ok: true, status: 200, json: async () => obj, headers: new Map() });
    if (u.includes('/auth/v3/tenant_access_token')) return json({ code: 0, tenant_access_token: 'T' });
    if (u.includes('/instances/query')) {
      opts.queryCalls++;
      if (opts.queryErr) return json({ code: 1390001, msg: 'query time range exceeds 30 days' });
      const list = opts.serialHit ? [{ instance: { code: 'INST-UUID', serial_id: opts.wantSerial || '202611140001' } }] : [];
      return json({ code: 0, data: { instance_list: list, has_more: !!opts.hasMore, page_token: 'p2' } });
    }
    if (u.includes('/instances/INST-UUID')) {
      if (opts.detailErr) return json({ code: 1390003, msg: 'instance code not found' });
      return json({ code: 0, data: { form: JSON.stringify(formControls) } });
    }
    if (u.includes('/im/v1/images')) {
      opts.uploadCalls++;
      return json({ code: 0, data: { image_key: 'img_v3_stub_' + opts.uploadCalls } });
    }
    if (u.includes('feishucdn.com')) {
      if (opts.cdnErr) return { ok: false, status: 403, json: async () => ({}) };
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  return calls;
}

(async () => {
  const svc = require('../src/services/approvalImageService');

  console.log('== 1. serialOf / extractImageUrls 纯函数 ==');
  check('serial 取超链接 text', svc.serialOf(RECORD) === '202611140001');
  check('serial 字符串字段兜底', svc.serialOf({ fields: { '申请编号': '202611090004' } }) === '202611090004');
  check('serial 缺失返回空', svc.serialOf({ fields: {} }) === '' && svc.serialOf(null) === '');
  const urls = svc.extractImageUrls(JSON.stringify(formControls));
  check('form 字符串解析出 image CDN URL', urls.length === 1 && urls[0].split('#')[0] === CDN_URL.split('#')[0], JSON.stringify(urls));
  check('无 image 控件 → 空数组', svc.extractImageUrls(JSON.stringify([{ type: 'textarea', value: 'x' }])).length === 0);
  check('非字符串输入兼容', svc.extractImageUrls(formControls).length === 1 && svc.extractImageUrls(null).length === 0);

  console.log('== 2. fetchImageKeys 全链（未配置 approvalCode → 降级 []） ==');
  config.broadcast.approvalCode = '';
  const calls0 = stubFetch({ queryCalls: 0, uploadCalls: 0 });
  const r0 = await svc.fetchImageKeys(RECORD);
  check('未配置 → [] 且不发任何请求', r0.length === 0 && calls0.length === 0, 'calls=' + calls0.length);

  console.log('== 3. 全链成功：query→详情→CDN→上传→缓存 ==');
  config.broadcast.approvalCode = 'DEF-CODE';
  const opts = { queryCalls: 0, uploadCalls: 0, serialHit: true };
  stubFetch(opts);
  const r1 = await svc.fetchImageKeys(RECORD);
  check('返回 image_key', r1.length === 1 && r1[0] === 'img_v3_stub_1', JSON.stringify(r1));
  check('query 带定义 code+时间窗', opts.queryCalls === 1 && calls0.length === 0, 'queryCalls=' + opts.queryCalls);
  const r2 = await svc.fetchImageKeys(RECORD);
  check('缓存命中不再转存（upload 仍 1 次）', r2.length === 1 && opts.uploadCalls === 1);
  const others = await svc.fetchImageKeys({ fields: { '申请编号': { text: '无单号' }, '发起时间': Date.now() } });
  check('serial 未命中实例 → [] 降级', others.length === 0, JSON.stringify(others));

  console.log('== 4. 失败矩阵：详情失败 / CDN 失败 → [] 且同 serial 只 warn 一次 ==');
  const opts4 = { queryCalls: 0, uploadCalls: 0, serialHit: true, detailErr: true };
  stubFetch(opts4);
  const r4 = await svc.fetchImageKeys({ fields: { '申请编号': { text: 'detail-fail' }, '发起时间': Date.now() } });
  check('详情失败 → []', r4.length === 0);
  const opts5 = { queryCalls: 0, uploadCalls: 0, serialHit: true, cdnErr: true };
  stubFetch(opts5);
  const r5 = await svc.fetchImageKeys({ fields: { '申请编号': { text: 'cdn-fail' }, '发起时间': Date.now() } });
  check('CDN 下载失败 → []', r5.length === 0);

  console.log('== 5. 并发去重：同 serial 并发共享一个 Promise ==');
  const serial6 = 'concurrent-' + Date.now();
  const opts6 = { queryCalls: 0, uploadCalls: 0, serialHit: true, wantSerial: serial6 };
  const calls6 = stubFetch(opts6);
  const rec6 = { fields: { '申请编号': { text: serial6 }, '发起时间': Date.now() } };
  const [a, b] = await Promise.all([svc.fetchImageKeys(rec6), svc.fetchImageKeys(rec6)]);
  check('并发两请求同结果', a.length === 1 && b.length === 1 && a[0] === b[0]);
  check('CDN 只下载一次（inflight 去重）', opts6.uploadCalls === 1, 'uploads=' + opts6.uploadCalls);

  global.fetch = realFetch;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail > 0) process.exit(1);
})().catch((e) => { global.fetch = realFetch; console.error('测试执行失败:', e); process.exit(1); });
