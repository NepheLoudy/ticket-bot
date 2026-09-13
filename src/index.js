const express = require('express');
const { requireApiToken } = require('./auth');
const cors = require('cors');
const config = require('./config');
const { startEventSubscription, processBitableEvent } = require('./feishu/eventSubscription');
const { handleApprovalTaskEvent } = require('./services/approvalLinkService');
const { processChatMessage } = require('./services/chatService');
const ticketService = require('./services/ticketService');
const syncService = require('./services/syncService');
const unclosedService = require('./services/unclosedService');
const { startCronJobs, runSummary, getCronStatus, getSummaryHistory, runAssigneeNudgeCheck } = require('./cron');

const app = express();

app.use(cors());
// 网关会转发完整事件体（表格事件含 before/after 全量字段，可能超 100kb），放宽 body 限制
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    botName: config.bot.name,
    sourceTableId: config.bitable.sourceTableId,
    targetTableId: config.bitable.targetTableId,
  });
});

// ---------- 定制窗口（规则见顶层 AGENTS「机器人后端定制窗口」）：定制项全景只读 ----------

app.get('/api/tickets/policy', (req, res) => {
  const maskTarget = (t) => (t ? { value: t.value, chatId: t.chatId || '', viaWebhook: Boolean(t.webhookUrl) } : null);
  res.json({
    bot: { name: config.bot.name, port: config.port },
    feishuEvent: { useLongConnection: config.feishuEvent.useLongConnection },
    broadcast: {
      routeField: config.broadcast.routeField,
      routes: (config.broadcast.routes || []).map(maskTarget),
      defaultTarget: maskTarget(config.broadcast.defaultTarget),
      on: config.broadcast.on,
      markField: config.broadcast.markField,
      displayFields: config.broadcast.displayFields,
      watchedFields: config.broadcast.watchedFields,
    },
    assign: {
      field: config.assign.field,
      assigneeField: config.assign.assigneeField,
      supplementField: config.assign.supplementField,
      userGroups: [...config.assign.userGroups.keys()],
    },
    multiAccept: { field: config.multiAccept.field, windowHours: config.multiAccept.windowHours, windowField: config.multiAccept.windowField },
    approvalNode: {
      field: config.approvalNode.field,
      acceptValues: config.approvalNode.acceptValues,
      assignAcceptValue: config.approvalNode.assignAcceptValue,
      closeValue: config.approvalNode.closeValue,
    },
    approval: {
      linked: Boolean(config.approval.approvalCode) && (config.approval.autoApproverIds.length > 0 || Boolean(config.approval.autoApproverId)),
      autoApproverCount: config.approval.autoApproverIds.length + (config.approval.autoApproverId ? 1 : 0),
    },
    closeReminder: { deadlineField: config.closeReminder.deadlineField, leadDays: config.closeReminder.leadDays },
    assignNudge: { hours: config.assignNudge.hours },
    groupLeaders: [...config.groupLeaders.keys()],
    ignoreChatIds: config.ignoreChatIds,
    p2pCommandAllow: { openIdCount: config.p2pCommandAllow.openIds.length, chatIdCount: config.p2pCommandAllow.chatIds.length },
    cron: { schedule: config.cron.schedule },
  });
});

// ---------- 工单查询 ----------

// 未结单工单按「负责人所属组别」分桶（键为群 chatId），供 pm-robot DDL 播报分组分栏
app.get('/api/tickets/unclosed-by-group', async (req, res) => {
  try {
    const result = await unclosedService.getUnclosedByGroup();
    res.json({ result });
  } catch (err) {
    console.error('[API] 未结单工单分组查询失败:', err);
    res.status(500).json({ error: err.message });
  }
});

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
app.post('/api/sync', requireApiToken, async (req, res) => {
  try {
    const result = await syncService.syncAll();
    res.json({ success: true, result });
  } catch (err) {
    console.error('全量同步失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- 播报 ----------

app.post('/api/bot/test-summary', requireApiToken, async (req, res) => {
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
app.post('/api/bot/rebroadcast', requireApiToken, async (req, res) => {
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

// 手动触发指定负责人确认追问检查（超 24h 未确认私聊追问）
app.post('/api/bot/test-nudge', requireApiToken, async (req, res) => {
  try {
    const result = await runAssigneeNudgeCheck();
    res.json({ success: true, result });
  } catch (err) {
    console.error('确认追问检查失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 手动触发播报对账（扫描触发节点工单，漏播补播/漏搬补搬）
app.post('/api/bot/reconcile', requireApiToken, async (req, res) => {
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

  if (header?.event_type === 'drive.file.bitable_record_changed_v1') {
    setImmediate(async () => {
      try {
        // V2 事件结构（长连接/网关转发同款）：event.action_list[] 内含 { action, record_id, after_value }
        const actionList = event?.action_list || [];
        for (const item of actionList) {
          const actionType =
            item.action === 'record_added' ? 'create' : item.action === 'record_edited' ? 'update' : null;
          if (!actionType) continue;
          await processBitableEvent({
            table_id: event?.table_id,
            record_id: item.record_id,
            action_type: actionType,
            fields: item.after_value || item.before_value || undefined,
          });
        }
      } catch (err) {
        console.error('处理飞书事件失败:', err);
      }
    });
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

  // 工单审批任务事件（网关转发，秒级）：缓存待审任务，接单后自动通过
  if (header?.event_type === 'approval_task') {
    setImmediate(async () => {
      try {
        await handleApprovalTaskEvent(event || {});
      } catch (err) {
        console.error('处理审批任务事件失败:', err);
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
