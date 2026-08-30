const express = require('express');
const cors = require('cors');
const config = require('./config');
const { startEventSubscription, processBitableEvent } = require('./feishu/eventSubscription');
const { processChatMessage } = require('./services/chatService');
const ticketService = require('./services/ticketService');
const syncService = require('./services/syncService');
const { startCronJobs, runSummary, getCronStatus, getSummaryHistory } = require('./cron');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    botName: config.bot.name,
    sourceTableId: config.bitable.sourceTableId,
    targetTableId: config.bitable.targetTableId,
  });
});

// ---------- 工单查询 ----------

app.get('/api/tickets', async (req, res) => {
  try {
    const tickets = await ticketService.getAllTickets();
    res.json(tickets);
  } catch (err) {
    console.error('获取工单列表失败:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tickets/pending', async (req, res) => {
  try {
    const tickets = await ticketService.getPendingTickets();
    res.json(tickets);
  } catch (err) {
    console.error('获取待处理工单失败:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tickets/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { getRecord } = require('./feishu/bitable');
    const record = await getRecord(config.bitable.sourceAppToken, config.bitable.sourceTableId, id);
    res.json(record);
  } catch (err) {
    console.error('获取工单详情失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- 同步 ----------

// 查看同步配置（字段映射 + 群路由）
app.get('/api/sync/config', (req, res) => {
  res.json({
    fieldMapping: config.sync.fieldMapping,
    syncKeyField: config.sync.syncKeyField,
    categoryField: config.sync.categoryField,
    routeField: config.broadcast.routeField,
    routes: config.broadcast.routes,
    defaultTarget: config.broadcast.defaultTarget,
    displayFields: config.broadcast.displayFields,
    assign: {
      field: config.assign.field,
      assigneeField: config.assign.assigneeField,
      yesValue: config.assign.yesValue,
      noValue: config.assign.noValue,
    },
    broadcastOn: config.broadcast.on,
  });
});

// 手动全量同步 源表 → 目标表
app.post('/api/sync', async (req, res) => {
  try {
    const result = await syncService.syncAll();
    res.json({ success: true, result });
  } catch (err) {
    console.error('全量同步失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- 播报 ----------

app.post('/api/bot/test-summary', async (req, res) => {
  try {
    const result = await runSummary();
    res.json({ success: true, result });
  } catch (err) {
    console.error('测试汇总播报失败:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bot/routes', (req, res) => {
  res.json({
    routeField: config.broadcast.routeField,
    routes: config.broadcast.routes,
    defaultTarget: config.broadcast.defaultTarget,
  });
});

app.get('/api/bot/history', (req, res) => {
  res.json({
    broadcast: ticketService.getBroadcastHistory(),
    summary: getSummaryHistory(),
  });
});

app.get('/api/bot/cron-status', (req, res) => {
  res.json(getCronStatus());
});

// 手动补播指定工单（漏播修复，走去重集合保证幂等）
app.post('/api/bot/rebroadcast', async (req, res) => {
  try {
    const recordId = req.body?.recordId;
    if (!recordId) {
      return res.status(400).json({ error: '缺少 recordId' });
    }
    const result = await ticketService.rebroadcastRecord(recordId);
    res.json({ success: true, result });
  } catch (err) {
    console.error('补播失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 手动触发播报对账（扫描触发节点工单，漏播补播/漏搬补搬）
app.post('/api/bot/reconcile', async (req, res) => {
  try {
    const result = await ticketService.reconcileBroadcasts();
    res.json({ success: true, result });
  } catch (err) {
    console.error('对账失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- 飞书事件 HTTP 回调（长连接未启用时使用） ----------

app.post('/api/feishu/event', async (req, res) => {
  const { type, challenge, token, header, event } = req.body;

  if (config.feishuEvent.verificationToken && token !== config.feishuEvent.verificationToken) {
    return res.status(403).json({ error: 'Invalid verification token' });
  }

  if (type === 'url_verification') {
    return res.json({ challenge });
  }

  if (config.feishuEvent.useLongConnection) {
    console.log('[HTTP回调] 已启用长连接模式，跳过HTTP回调事件处理');
    res.json({ code: 0, msg: 'success' });
    return;
  }

  if (header?.event_type === 'bitable.record.create' || header?.event_type === 'bitable.record.update') {
    setImmediate(async () => {
      try {
        const tableId = event?.table_id;
        const recordId = event?.record?.record_id;
        const actionType = header?.event_type === 'bitable.record.create' ? 'create' : 'update';
        const fields = event?.record?.fields;

        if (tableId && recordId) {
          await processBitableEvent({
            table_id: tableId,
            record_id: recordId,
            action_type: actionType,
            fields,
          });
        }
      } catch (err) {
        console.error('处理飞书事件失败:', err);
      }
    });
  }

  if (header?.event_type === 'im.message.receive_v1') {
    setImmediate(async () => {
      try {
        await processChatMessage(event);
      } catch (err) {
        console.error('处理消息事件失败:', err);
      }
    });
  }

  res.json({ code: 0, msg: 'success' });
});

function startServer() {
  const server = app.listen(config.port, () => {
    console.log(`🚀 ${config.bot.name}运行在 http://localhost:${config.port}`);
    console.log(`📚 API 健康检查: http://localhost:${config.port}/api/health`);
    console.log(`🗂  源表: ${config.bitable.sourceTableId || '(未配置)'} → 目标表: ${config.bitable.targetTableId || '(未配置)'}`);
    console.log(`📡 播报路由: ${config.broadcast.routes.length} 个群${config.broadcast.defaultTarget ? ' + 兜底群' : ''}`);
  });

  startCronJobs();
  startEventSubscription();

  process.on('SIGINT', () => {
    console.log('\n正在关闭服务器...');
    server.close(() => {
      console.log('服务器已关闭');
      process.exit(0);
    });
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = app;
