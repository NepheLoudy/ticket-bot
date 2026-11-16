// ============================================================
// 工单附图上卡（2026-11-16 v?：曼波令「工单系统附图没法在机器人回复中显示」）
// 根因：工单从审批流发起，附图在审批实例 form 的 image 控件里（CDN 签名直链），
// 工单表「相关说明」只存 previewAttachment 链接 +「N 张图片」文本（admin 链接队员无权限）。
// 链路（approval-bot 发票回溯同款，serial_id 匹配 + form 单条 JSON 字符串为实测坑位）：
//   申请编号 serial → POST /approval/v4/instances/query（定义 code+30 天窗分片，返回
//   instance_list[].instance.code）→ GET /instances/:code 详情 → JSON.parse(form 字符串)
//   → image 控件 value=CDN URL 数组 → 下载 → uploadImImage → image_key（缓存永久）。
// 降级：未配置 TICKET_APPROVAL_CODE / 任何一步失败 → 返回 []，播报保持现状文本。
// 缓存：serial → image_keys 永久（上传后 image_key 不随 CDN 签名过期）；同 serial 并发共享。
// ============================================================
const { requestAPI, uploadImImage } = require('../feishu/client');
const config = require('../config');

const QUERY_WINDOW_MS = 29 * 24 * 3600 * 1000; // instances/query 单次跨度硬限 30 天
const serialCache = new Map(); // serial -> string[] image_keys
const inflight = new Map(); // serial -> Promise（并发去重）
const warnedSerials = new Set(); // 失败只 warn 首次，防播报刷屏

// 工单记录 → 申请编号 serial（{link,text} 超链接字段的 text，如 202611140001）
function serialOf(record) {
  const v = record && record.fields && record.fields['申请编号'];
  if (v && typeof v === 'object' && v.text) return String(v.text).trim();
  return typeof v === 'string' ? v.trim() : '';
}

// 实例详情 form 字符串 → image 控件的 CDN URL 数组（实测：form=单条 JSON 字符串，8 控件）
function extractImageUrls(formRaw) {
  const controls = typeof formRaw === 'string' ? JSON.parse(formRaw) : (Array.isArray(formRaw) ? formRaw : []);
  const out = [];
  for (const c of controls) {
    if (!c || c.type !== 'image') continue;
    const urls = Array.isArray(c.value) ? c.value : [];
    for (const u of urls) if (typeof u === 'string' && /^https?:\/\//.test(u)) out.push(u);
  }
  return out;
}

// 时间窗分片拉实例列表（审批发起时间起点=工单「发起时间」字段毫秒，覆盖到今天）
async function findInstanceCode(serial, startMs) {
  const from = Number.isFinite(startMs) && startMs > 0 ? startMs : Date.now() - QUERY_WINDOW_MS;
  let start = from;
  const now = Date.now();
  let pageToken = '';
  let pendingToken = null; // 跨片翻页：page_token 在片边界延续
  // <= 而非 <：发起时刻与查询同毫秒（测试全同步 mock 会踩）时窗口也要查一次
  while (start <= now) {
    const end = Math.min(start + QUERY_WINDOW_MS, now);
    let token = pageToken;
    do {
      // page_token 必须走 query string（approval-bot 实测：放 body 被忽略）
      const res = await requestAPI('POST', `/approval/v4/instances/query${token ? `?page_token=${encodeURIComponent(token)}` : ''}`, {
        approval_code: config.broadcast.approvalCode,
        instance_start_time_from: start,
        instance_start_time_to: end,
        page_size: 100,
      });
      if (res.code !== 0) throw new Error(`instances/query 失败 (${res.code}): ${res.msg}`);
      const list = (res.data && res.data.instance_list) || [];
      const hit = list.find((x) => x.instance && String(x.instance.serial_id || '') === serial);
      if (hit) return hit.instance.code;
      token = '';
      pendingToken = res.data && res.data.has_more ? res.data.page_token : null;
    } while (false);
    if (pendingToken) {
      // 片内还有下一页：下一轮循环同片续查
      pageToken = pendingToken;
      pendingToken = null;
      continue;
    }
    pageToken = '';
    if (end <= start) break; // 零增量兜底（查询已覆盖到 now，start 前推无意义时防死循环）
    start = end;
  }
  return null;
}

async function fetchImageKeys(record) {
  if (!config.broadcast.approvalCode) return []; // 未配置=功能关，零请求零告警
  const serial = serialOf(record);
  if (!serial) return [];
  if (serialCache.has(serial)) return serialCache.get(serial);
  if (inflight.has(serial)) return inflight.get(serial);
  // deferred 模式：job（pending promise）先注册进 inflight 再启动异步流——
  // IIFE 立即执行会在首个 await 让出后才轮到 inflight.set，理论上同步段安全，
  // 实测在桩测试全同步 mock 下有微任务时序摇摆（B 可能看到 job 已完成、inflight 已清理）
  let resolveJob, rejectJob;
  const job = new Promise((res, rej) => { resolveJob = res; rejectJob = rej; });
  inflight.set(serial, job);
  (async () => {
    try {
      const startMs = record.fields && record.fields['发起时间'];
      const code = await findInstanceCode(serial, Number(startMs) || 0);
      if (!code) throw new Error('instances/query 未匹配到 serial=' + serial);
      const det = await requestAPI('GET', `/approval/v4/instances/${encodeURIComponent(code)}?user_id_type=open_id`);
      if (det.code !== 0) throw new Error(`实例详情失败 (${det.code}): ${det.msg}`);
      const urls = extractImageUrls(det.data && det.data.form);
      if (!urls.length) throw new Error('实例无 image 控件（本单无附图）');
      const keys = [];
      for (const u of urls.slice(0, 9)) {
        // 上限 9 张（对齐 pm-robot 关键词帖单条上限）；CDN 锚点 #/obj/... fetch 自动剥离
        const res = await fetch(u.split('#')[0], { signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`CDN 图下载失败 HTTP ${res.status}（签名过期则旧单降级）`);
        const buf = Buffer.from(await res.arrayBuffer());
        keys.push(await uploadImImage(buf));
      }
      serialCache.set(serial, keys);
      resolveJob(keys);
    } catch (err) {
      if (!warnedSerials.has(serial)) {
        warnedSerials.add(serial);
        console.warn(`[工单附图] ${serial} 转存失败，播报降级为文本（${err.message}）`);
      }
      resolveJob([]); // 降级：调用方拿空数组渲染现状文本，不 reject
    } finally {
      inflight.delete(serial);
    }
  })();
  return job;
}

module.exports = { serialOf, extractImageUrls, fetchImageKeys };
