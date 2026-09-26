/**
 * 幂等迁移脚本：确保源工单表存在接单痕迹字段「接单确认时间」（数字列，毫秒数）。
 *
 * 背景（2026-09-27 信任模型修复）：对账代通过（maybeAutoApproveOnReconcile）现在
 * 以该字段非空为前置证据——字段不存在时接单确认链路的运行时补建会兜底尝试，
 * 但新部署/新表环境建议先跑一次本脚本预建，避免首批接单的痕迹写入失败
 * （写入失败不阻断接单，但该单对账将不代通过）。
 *
 * 幂等：字段已存在（报错 FieldNameDuplicate/1254040 等）按成功处理，可重复执行。
 * 用法：node scripts/ensure-ticket-fields.js（需 .env 配好 BITABLE_APP_TOKEN/SOURCE_TABLE_ID）
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const bitableApi = require('../src/feishu/bitable');
const config = require('../src/config');

const FIELD_ACCEPT_TRACE = config.acceptTraceField || '接单确认时间';
const FIELD_TYPE_NUMBER = 2; // 飞书 bitable 字段类型：2 = 数字

async function ensureField(field, type, typeDesc) {
  try {
    await bitableApi.createField(
      config.bitable.sourceAppToken,
      config.bitable.sourceTableId,
      field,
      type
    );
    console.log(`✓ 已创建字段「${field}」（${typeDesc}）`);
    return 'created';
  } catch (err) {
    const msg = String(err.message || '');
    // 字段已存在类报错视作成功（幂等）；其余报错如实抛出
    if (/已存在|duplicate|1254040|FieldNameDuplicate|Exist/i.test(msg)) {
      console.log(`✓ 字段「${field}」已存在，跳过`);
      return 'exists';
    }
    throw err;
  }
}

(async () => {
  if (!config.bitable.sourceAppToken || !config.bitable.sourceTableId) {
    console.error('✗ 未配置 BITABLE_APP_TOKEN / SOURCE_TABLE_ID（请检查 .env）');
    process.exit(1);
  }
  console.log(`目标表: app=${config.bitable.sourceAppToken} table=${config.bitable.sourceTableId}`);
  console.log(`接单痕迹字段「${FIELD_ACCEPT_TRACE}」为对账代通过的前置证据（接单确认链路自写毫秒数），写入失败不阻断接单但该单对账不代通过`);
  const result = await ensureField(FIELD_ACCEPT_TRACE, FIELD_TYPE_NUMBER, '数字，存毫秒时间戳');
  console.log(`\n完成（${result === 'created' ? '新建' : '已存在'}）。首次部署请在机器人启动前执行一次；重复执行无副作用。`);
  process.exit(0);
})().catch((err) => {
  console.error('✗ 迁移失败:', err.message);
  process.exit(1);
});
