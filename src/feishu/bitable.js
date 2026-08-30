const { requestAPI } = require('./client');

/**
 * 拉取多维表格指定表的全部记录（自动翻页）
 * @param {string} appToken 多维表格 app_token
 * @param {string} tableId 表 ID
 * @param {string} [filter] 过滤公式，如 CurrentValue.[状态] = "待处理"
 * @returns {Promise<Array<{record_id: string, fields: object}>>}
 */
async function listAllRecords(appToken, tableId, filter) {
  if (!appToken || !tableId) {
    throw new Error('未配置多维表格 appToken 或 tableId');
  }

  const records = [];
  let pageToken = '';
  const pageSize = 100;

  do {
    const query = new URLSearchParams({ page_size: String(pageSize) });
    if (filter) query.set('filter', filter);
    if (pageToken) query.set('page_token', pageToken);

    const res = await requestAPI(
      'GET',
      `/bitable/v1/apps/${appToken}/tables/${tableId}/records?${query.toString()}`
    );

    if (res.code !== 0) {
      throw new Error(`拉取多维表格记录失败: ${res.msg} (code: ${res.code})`);
    }

    const items = res.data?.items || [];
    for (const item of items) {
      records.push({ record_id: item.record_id, fields: item.fields });
    }

    pageToken = res.data?.has_more ? (res.data.page_token || '') : '';
  } while (pageToken);

  return records;
}

/**
 * 获取单条记录
 * @param {string} appToken 多维表格 app_token
 * @param {string} tableId 表 ID
 * @param {string} recordId 记录 ID
 */
async function getRecord(appToken, tableId, recordId) {
  if (!appToken || !tableId || !recordId) {
    throw new Error('未配置多维表格 appToken/tableId 或 recordId');
  }

  const res = await requestAPI(
    'GET',
    `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`
  );

  if (res.code !== 0) {
    throw new Error(`获取记录失败: ${res.msg} (code: ${res.code})`);
  }

  return { record_id: res.data.record.record_id, fields: res.data.record.fields };
}

/**
 * 新增记录
 * @param {string} appToken 多维表格 app_token
 * @param {string} tableId 表 ID
 * @param {object} fields 字段键值对
 * @returns {Promise<{record_id: string, fields: object}>}
 */
async function createRecord(appToken, tableId, fields) {
  if (!appToken || !tableId) {
    throw new Error('未配置多维表格 appToken 或 tableId');
  }

  const res = await requestAPI(
    'POST',
    `/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    { fields }
  );

  if (res.code !== 0) {
    throw new Error(`新增记录失败: ${res.msg} (code: ${res.code})`);
  }

  return { record_id: res.data.record.record_id, fields: res.data.record.fields };
}

/**
 * 更新记录
 * @param {string} appToken 多维表格 app_token
 * @param {string} tableId 表 ID
 * @param {string} recordId 记录 ID
 * @param {object} fields 字段键值对
 */
async function updateRecord(appToken, tableId, recordId, fields) {
  if (!appToken || !tableId || !recordId) {
    throw new Error('未配置多维表格 appToken/tableId 或 recordId');
  }

  const res = await requestAPI(
    'PUT',
    `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    { fields }
  );

  if (res.code !== 0) {
    throw new Error(`更新记录失败: ${res.msg} (code: ${res.code})`);
  }

  return { record_id: res.data.record.record_id, fields: res.data.record.fields };
}

/**
 * 创建表格字段（多行文本）
 * @param {string} appToken 多维表格 app_token
 * @param {string} tableId 表 ID
 * @param {string} fieldName 字段名
 * @param {number} [type] 字段类型，默认 1（文本）
 */
async function createField(appToken, tableId, fieldName, type = 1) {
  if (!appToken || !tableId || !fieldName) {
    throw new Error('未配置多维表格 appToken/tableId 或字段名');
  }

  const res = await requestAPI(
    'POST',
    `/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
    { field_name: fieldName, type }
  );

  if (res.code !== 0) {
    throw new Error(`创建字段失败: ${res.msg} (code: ${res.code})`);
  }

  return res.data?.field;
}

module.exports = {
  listAllRecords,
  getRecord,
  createRecord,
  updateRecord,
  createField,
};
