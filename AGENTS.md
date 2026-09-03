# ticket-bot 开发边界（防需求发错会话）

## 本项目职能
工单系统机器人：监听源表【27赛季】千里工单系统，按审批节点把工单播报到组别群；@机器人「接单」确认；搬运到项目看板；结单提醒与超时处理；未结单工单按负责人组别分桶 API（`GET /api/tickets/unclosed-by-group`，供 pm-robot 的 DDL 分栏）。


## 顶层规则与交互性（每次开工先读）

本会话是独立工作区，**不会自动加载顶层规则**——开工前先读一遍 `../AGENTS.md`（顶层职能总表 + 架构铁律）；涉及消息路由、@识别、指令转发的改动，再读顶层 `.agents/skills/qianli-chat-architecture/SKILL.md`。

与其它机器人/服务的交互契约（改接口前先对顶层文档）：
- 五个机器人**共用同一个飞书应用**；长连接只属于 feishu-gateway，本项目事件一律 `FEISHU_USE_LONG_CONNECTION=false`，由网关转发到本项目的 `POST /api/feishu/event`；
- 指令交互契约：`POST /api/chat/command`，入参 `{command, args}`，回 `{reply}`（回复由调用方——网关或 hub——代发）；
- 群播报走群自定义机器人 webhook，对话回复走飞书 IM API；
- 部署一律项目内 `npm run push "说明"`（规则见 qianli-deploy skill 与顶层 AGENTS.md），NAS 凭证在 .env 的 NAS_*；
- 通用坑：@识别要兼容 mentioned_type='bot'；多维表格字段值先过 fieldText 类工具再拼字符串；express.json 建议放宽到 2mb。

顶层职能速览（需求跨项目即停，走上方"发错时的规定动作"）：
ticket-bot=工单域｜approval-bot=财务审批｜project-management-robot=对话枢纽+DDL｜bambu-print-reservation=打印预约｜feishu-gateway=事件接入｜qianli 顶层=部署/架构/整理。

## 只管这些（归属信号）
工单、接单、结单、面向组别、指定负责人、补充负责人、工单播报文案、工单表字段、搬运看板、结单提醒、工单路由（GROUP_ROUTES/USER_GROUPS）。

## 不管这些（发错信号 → 立即停手）
- **项目 DDL 播报、逾期确认、各群对话/关键词/会议提醒** → project-management-robot 会话
- **审批、发票、报销、转账、财务催办** → approval-bot 会话
- **3D 打印、预约、打印机** → bambu-print-reservation 会话
- **事件被抢、指令路由、@无响应（跨项目）** → feishu-gateway 会话
- **部署链路、push.js、架构、工作区整理** → qianli 顶层会话

## 易混裁定
- DDL 卡片里"未结单工单分栏"的**数据口径、负责人取值、分桶规则** → 本项目（`src/services/unclosedService.js`）；
- 该分栏在 DDL 卡片里的**展示样式、卡片其它栏目** → project-management-robot。

## 发错时的规定动作
用户需求落在"不管这些"时，必须：
1. **停止开发，不写任何代码、不改任何文件**；
2. 回复：「⚠️ 这个需求属于 <X 项目>（负责 <…>），当前会话是 ticket-bot——你可能发错会话了。请到对应会话发送；如确认要在 ticket-bot 做，请回复"就在本项目做"。」
3. 用户明确确认后才继续；模糊回答（如"就这里做吧"）时再确认一次。
4. 边界模糊、可能横跨多个项目时：先列出各项目分工与建议归属，等用户指定后再动手。
