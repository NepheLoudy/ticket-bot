const lark = require('@larksuiteoapi/node-sdk');
const config = require('../config');
const { handleRecordCreate, handleRecordUpdate } = require('../services/ticketService');
const { processChatMessage } = require('../services/chatService');

let wsClient = null;

function startEventSubscription() {
  if (!config.feishuEvent.useLongConnection) {
    console.log('[事件订阅] 已配置为不使用长连接模式，跳过启动（需通过HTTP回调接收事件）');
    return null;
  }

  if (!config.feishu.appId || !config.feishu.appSecret) {
    console.warn('[事件订阅] 未配置飞书应用凭证（APP_ID/APP_SECRET），跳过事件订阅');
    return null;
  }

  if (!config.bitable.sourceTableId) {
    console.warn('[事件订阅] 未配置源表 SOURCE_TABLE_ID，跳过多维表格事件过滤');
  }

  const baseConfig = {
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.FeiShu,
    loggerLevel: lark.LoggerLevel.info,
  };

  wsClient = new lark.WSClient(baseConfig);

  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      try {
        console.log('[事件订阅] 收到消息事件:', data.message?.message_id);
        await processChatMessage(data);
      } catch (err) {
        console.error('[事件订阅] 处理消息事件失败:', err.message);
      }
    },
    'bitable.record.changed': async (data) => {
      try {
        const tableId = data?.table_id;
        const recordId = data?.record_id;
        const changeType = data?.change_type || data?.changeType;

        console.log(`[事件订阅] 收到多维表格事件: table=${tableId}, change=${changeType}, record=${recordId}`);

        // 只处理源表的记录变更
        if (config.bitable.sourceTableId && tableId !== config.bitable.sourceTableId) {
          return;
        }

        if (changeType === 'add' || changeType === 'create') {
          await handleRecordCreate(recordId);
        } else if (changeType === 'update' || changeType === 'modify') {
          await handleRecordUpdate(recordId);
        }
      } catch (err) {
        console.error('[事件订阅] 处理多维表格事件失败:', err.message);
      }
    },
  });

  wsClient.start({
    eventDispatcher,
  });

  console.log('📡 飞书事件订阅（长连接模式）已启动');
  console.log('   监听事件: im.message.receive_v1, bitable.record.changed');
  console.log(`   监听源表: ${config.bitable.sourceTableId || '(未配置)'}`);

  return wsClient;
}

function stopEventSubscription() {
  if (wsClient) {
    wsClient.stop();
    wsClient = null;
    console.log('📡 飞书事件订阅已停止');
  }
}

/**
 * 处理HTTP回调的多维表格事件（仅在未启用长连接时使用）
 */
async function processBitableEvent(event) {
  const { table_id, record_id, action_type, fields } = event;

  console.log(`[HTTP回调] 收到多维表格事件: table=${table_id}, action=${action_type}, record=${record_id}`);

  if (config.bitable.sourceTableId && table_id !== config.bitable.sourceTableId) {
    return;
  }

  if (action_type === 'create') {
    await handleRecordCreate(record_id, fields);
  } else if (action_type === 'update') {
    await handleRecordUpdate(record_id, fields);
  }
}

module.exports = {
  startEventSubscription,
  stopEventSubscription,
  processBitableEvent,
};
