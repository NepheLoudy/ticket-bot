# ticket-bot 工单系统机器人

基于飞书多维表格 + 长连接事件订阅的工单机器人。监测「【27赛季】千里工单系统」数据表，按工单字段走并行分支播报到组别对应的群聊，并在 `category` 有值时把工单搬运到项目看板成为子项目。

飞书应用沿用 qianli 项目群共用应用（与 knowledge-tracker / bambu-print-server / approval-bot 同一个 App），各项目按 `table_id` 过滤事件互不干扰。

---

## 一、核心业务逻辑

### 1. 播报触发（监听「审批节点」）

机器人订阅云文档事件 `drive.file.bitable_record_changed_v1`，并前置订阅多维表格。

> **注意**：本应用与 approval-bot / knowledge-tracker / 爆米花机共用同一个飞书应用。事件统一由 **feishu-gateway** 持有唯一长连接并转发到本服务 `/api/feishu/event`（本服务 `FEISHU_USE_LONG_CONNECTION=false`），事件不再被随机分发。**每分钟轮询对账兜底保留**：扫描源表所有处于触发节点的工单（补播/补绑定/审批联动补偿）与「回执单：是否结单」节点的工单（补搬运），覆盖网关重启窗口。已播报工单会写入源表「已播报」字段（`BROADCAST_MARK_FIELD`），保证跨重启/跨轮询不重复播报。

**触发条件**：工单「审批节点」字段进入以下任一节点时触发播报（等价于之前的「申请状态=审批中」）。创建与更新事件均支持，通过 `record_id` 去重保证只播一次。

- `群内有组员接单后通过`：未指定负责人工单的审批节点；
- `负责人确认消息后通过`：指定负责人工单的审批节点。

触发节点值可在 `APPROVAL_NODE_ACCEPT_VALUE` 中逗号分隔配置多个。

### 2. 播报分支（按「是否指定人员负责」）

播报统一由**应用机器人（对话型）**通过 IM API 发卡片（`chat_id` 优先，应用机器人发送失败时回退群自定义机器人 webhook）。

- **未指定负责人**（`是否指定人员负责 = 否`）：
  - 按「面向组别」（多选）并行分发到对应组群；
  - 播报卡片公开询问是否有人接单，并提示「在群内 @爆米花机-对话型 并发送『接单』」；
  - 记录待接单工单到内存，等待接单确认。

- **已指定负责人**（`是否指定人员负责 = 是`）：
  - 查询负责人所属组别（优先级：`USER_GROUPS` 手动映射 → 飞书通讯录部门 → 工单「面向组别」兜底）；
  - 在对应组群 @本人公示工单；
  - **公示即绑定**：播报成功后直接写「补充负责人」= 指定负责人，并按其组别合并写看板人员字段；
  - 同样记录待接单工单到内存（绑定负责人 open_id，确认时校验本人）。

### 3. 接单确认（@对话型机器人，事件驱动）

接单不做任何消息轮询/回扫：群内 **@爆米花机-对话型** 并发送「接单」，feishu-gateway 把该消息事件**秒级**转发到本服务（网关路由：含「接单」且 @机器人 → ticket-bot）。@触发对话（hub）与接单回执（ticket-bot）由网关**独占路由**天然分立：含「接单」的 @ 只进 ticket-bot，其余 @ 进 hub 对话，不会重复响应。

1. 未指定负责人的工单，任一组员确认即生效；
   已指定负责人的工单**仅限本人**确认（以源表「指定负责人」为准，他人确认会收到提示）；
2. 机器人匹配该群最新待接单工单（指定负责人工单只匹配本人），执行：
   - 项目状态 `waiting → in_progress`；
   - 群内回执卡片「✅ 某某 已确认接单」。

> 指定负责人工单「公示即绑定」只写补充负责人与看板人员字段；**状态推进与审批自动通过必须等本人确认**。绑定失败的工单由每分钟对账补偿绑定（只补绑定，不碰状态与审批）。

### 3.4 指定负责人 24h 未确认追问（私聊链路）

指定负责人工单公示即绑定后，若超过 `ASSIGN_NUDGE_HOURS`（默认 24）小时仍未确认（节点未推进），机器人每小时检查并**私聊负责人**追问；同一工单追问间隔不小于该时长。负责人两种方式完成确认：

- 在公示群内 @机器人 发送「接单」；
- 直接**私聊机器人回复「接单」**（网关按 p2p+接单 路由到本服务，匹配其「已绑定未确认」工单后走同一确认链路）。

### 3.5 审批联动（确认 → 机器代理审批通过）

工单接单确认后，机器人以审批任务审批人的身份自动「同意」对应触发节点的待审任务（`APPROVAL_CODE` + `APPROVAL_AUTO_APPROVER_ID`/`APPROVAL_AUTO_APPROVER_IDS` 配置联动，名单全空 = 关闭）：

- 未指定负责人工单 → 自动通过「群内有组员接单后通过」节点；
- 已指定负责人工单（本人确认后）→ 自动通过「负责人确认消息后通过」节点。

两层防误同：审批任务事件按审批人白名单缓存（事件不带节点名）；同意前再校验工单「审批节点」必须仍处于触发节点，实例推进到「回执单：是否结单」等节点后不会误自动通过。

### 4. 超时处理（6 小时未接单）

每小时检查一次：`审批节点` 处于任一触发节点 + `当前处理人有值` + 距发起时间超 6 小时。

- **当前处理人 == 发起人**：私信该人询问是否结单，指引去审批界面；
- **当前处理人 != 发起人**：
  - 有指定负责人 → 私信当前处理人；
  - 无指定负责人 → 重走公开问询流程（强调还没人接单），并 **@对应组组长**。

### 5. 结单提醒（理想结单时间过后）

每小时检查一次：`审批节点 = 回执单：是否结单` 且已过「理想结单时间后 1 天」时：

1. 先由机器人本人（应用机器人，非 webhook）**私聊当前处理人**；
2. 下次检查仍未结单，则转对应群组发卡片引导其去审批界面确认结单。

### 6. 项目搬运（category 门控）

**触发条件**：工单 `category` 字段有值时触发搬运到项目看板。

**字段映射**：

| 工单字段 | 项目看板字段 | 说明 |
|---------|------------|------|
| `category` | `category` | 相同字段同步 |
| `理想结单时间` | `ddl` | 去掉时分秒，仅保留日期 |
| `需求` / `需求1` | `fileToken` | 文本 |
| - | `priority` | 默认 `low` |
| `申请状态` + `审批节点` | `status` | 已通过→completed；已拒绝/已撤回等→died；审批中按节点推进：触发节点（等待接单/等待负责人确认）→waiting，回执单节点（负责人已确认接单）→in_progress |
| `name` | `parentId` | `name` 字段值作为父项目名称，在项目看板中查找匹配记录作为 parentId |
| `category` | `name` | 支持项目统一命名 `（{category}支持项目）` |
| `指定负责人` | 人员字段 | 按负责人所属组别映射（见下表） |
| - | `源记录ID` | 查重依据（upsert）；status 只向前推进，不会把接单后的 in_progress 重置回 waiting |

**组别 → 人员字段映射**：

| 组别 | 项目看板人员字段 |
|------|----------------|
| 机械组 | `owner` |
| 电控组 | `dkyjcontributers` |
| 硬件组 | `dkyjcontributers` |
| 视觉组 | `sjcontributers` |
| 宣运组 | `xycontributers` |
| 管理层 | `owner` |

---

## 二、数据表约定

- **源表**：`tblFA6Pj4Mv83Mb0`「【27赛季】千里工单系统」
  关键字段：`申请编号`（超链接）、`申请状态`、`审批节点`、`面向组别`（多选）、`是否指定人员负责`、`指定负责人`（人员）、`补充负责人`（人员）、`category`、`name`（父项目名称）、`需求`/`需求1`、`发起人`、`发起人部门`、`当前处理人`、`理想结单时间`、`相关说明`（超链接）。

- **目标表**：`tblIcyn9814CsgaH`「tbl_project」项目看板
  需包含字段：`name`、`category`、`ddl`、`fileToken`、`priority`、`status`、`parentId`（单向关联）、`owner`、`dkyjcontributers`、`sjcontributers`、`xycontributers`。`源记录ID`（查重字段）缺失时会自动创建。

---

## 三、配置说明

所有配置在 `.env`（不入库），模板见 [`.env.example`](./.env.example)。关键配置：

### 1. 群聊路由 `GROUP_ROUTES`

格式：`组别名=chat_id|webhook_url`，逗号分隔。播报优先走应用机器人（`chat_id`，接单确认依赖其消息事件），发送失败时回退群自定义机器人 webhook。**请确保应用机器人（爆米花机-对话型）已加入各组别群**。

```
GROUP_ROUTES=机械组=oc_xxx|https://open.feishu.cn/open-apis/bot/v2/hook/xxx,电控组=oc_yyy|https://...
```

### 2. 组长映射 `GROUP_LEADERS`

格式：`组别名:组长open_id或姓名`，逗号分隔。用于超时工单重问询时 @组长。

```
GROUP_LEADERS=机械组:ou_xxx,电控组:ou_yyy,...
```

### 3. 审批节点监听

| 变量 | 说明 | 默认 |
|------|------|------|
| `APPROVAL_NODE_FIELD` | 审批节点字段名 | `审批节点` |
| `APPROVAL_NODE_ACCEPT_VALUE` | 触发播报/超时判断的节点值（逗号分隔多个） | `群内有组员接单后通过,有组员接单后通过,负责人确认消息后通过` |
| `APPROVAL_NODE_ASSIGN_ACCEPT_VALUE` | 指定负责人工单的触发节点（「公示即绑定」与对账补绑定只作用于该节点） | `负责人确认消息后通过` |
| `APPROVAL_NODE_CLOSE_VALUE` | 触发结单提醒的节点值 | `回执单：是否结单` |
| `MULTI_ACCEPT_FIELD` / `MULTI_ACCEPT_YES_VALUE` | 多人接单开关字段及「是」取值 | `是否允许多人接单` / `是` |
| `MULTI_ACCEPT_WINDOW_HOURS` | 多人单续接窗口（小时），窗口内可续接、到期自动通过审批 | `6` |
| `MULTI_ACCEPT_WINDOW_FIELD` | 窗口截止时间写回的源表字段 | `多人接单截止` |
| `ASSIGN_NUDGE_HOURS` | 指定负责人公示绑定后超 N 小时未确认 → 私聊追问 | `24` |

### 4. 结单提醒

| 变量 | 说明 | 默认 |
|------|------|------|
| `DEADLINE_FIELD` | 理想结单时间字段 | `理想结单时间` |
| `CLOSE_REMINDER_LEAD_DAYS` | 理想结单时间过后 N 天提醒 | `1` |

### 5. 接单确认与审批联动

| 变量 | 说明 | 默认 |
|------|------|------|
| `SUPPLEMENT_ASSIGNEE_FIELD` | 接单人写入的源表字段（人员类型） | `补充负责人` |
| `APPROVAL_CODE` | 工单审批定义 code，审批联动开关（留空 = 关闭） | 空 |
| `APPROVAL_AUTO_APPROVER_ID` | 联动节点审批人 open_id（单值），机器人以该身份自动同意；全空 = 关闭 | 空 |
| `APPROVAL_AUTO_APPROVER_IDS` | 联动节点审批人 open_id 多值（逗号分隔，与单值取并集） | 空 |

---

## 四、本地开发

```bash
cd ticket-bot
npm install
npm run dev        # 开发模式（nodemon）
# 或
npm start          # 生产模式
```

健康检查：`curl http://localhost:3003/api/health`

---

## 五、API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/tickets` | 源表全部工单 |
| GET | `/api/tickets/pending` | 待处理工单 |
| GET | `/api/tickets/:id` | 工单详情 |
| GET | `/api/sync/config` | 查看同步与播报配置 |
| POST | `/api/sync` | 手动全量搬运（category 门控） |
| POST | `/api/bot/test-summary` | 触发一次每日汇总 |
| GET | `/api/bot/routes` | 查看群路由 |
| GET | `/api/bot/history` | 播报历史 |
| GET | `/api/bot/cron-status` | 定时任务状态 |
| POST | `/api/bot/rebroadcast` | 手动补播指定工单（body: `{recordId}`，幂等） |
| POST | `/api/bot/reconcile` | 手动触发播报对账（漏播补播/漏搬补搬） |
| POST | `/api/bot/test-nudge` | 手动触发一次指定负责人确认追问检查（测试） |
| POST | `/api/feishu/event` | 飞书事件 HTTP 回调（长连接未启用时） |

---

## 六、机器人指令

| 指令 | 说明 |
|------|------|
| `/ticket-help` | 显示帮助 |
| `/ticket-list` | 查看全部工单 |
| `/ticket-pending` | 查看待处理工单 |
| `/ticket-status` | 查看工单状态统计 |
| `/ticket-sync` | 手动全量搬运到项目看板 |

---

## 七、脚本工具

```bash
node scripts/discover.js               # 列出多维表格全部数据表、字段、机器人所在群聊
node scripts/probe-data.js             # 抽样源表记录，测试通讯录权限
node scripts/probe-fields.js           # 探测源表字段结构
node scripts/probe-latest-nodes.js     # 查看最近工单的审批节点取值分布
node scripts/probe-project-table.js    # 探测项目看板字段结构
node scripts/probe-ticket-category.js  # 探测 category 字段取值
node scripts/probe-ticket.js           # 抽样工单记录
node scripts/query-parent-projects.js  # 查询各 category 的顶层项目
node scripts/verify-nas.js             # 核对 NAS 上某条工单的播报/搬运结果（一次性排查工具）
```

---

## 八、部署到 NAS

```bash
npm run push "提交说明"      # 一键部署：git 提交推送 → NAS 部署 → 上传 .env → pm2 重启
```

`push.js` 流程：
1. `git add` + `commit` + `push` 到 GitHub；
2. 连接 NAS（SSH），上传代码并 `npm install`；
3. 上传 `.env`；
4. `pm2 restart ticket-bot`。

> 若本地无法访问 GitHub（443 被重置），`push.js` 会自动降级为 SFTP 直传代码到 NAS，不影响部署。

部署目标：NAS `qianli@10.253.33.233:8500`，服务路径 `/opt/ticket-bot`，端口 `3003`，pm2 进程名 `ticket-bot`。

---

## 九、项目结构

```
ticket-bot/
├── src/
│   ├── cron/index.js              # 每日汇总 + 超时检查 + 结单提醒 + 播报对账 + 24h 确认追问
│   ├── feishu/
│   │   ├── bitable.js             # 多维表格 API（读/写/upsert）
│   │   ├── bot.js                 # 卡片构建 + 群路由发送 + 接单/结单提醒卡片
│   │   ├── client.js              # 飞书 API 客户端（tenant_access_token）
│   │   └── eventSubscription.js   # 事件订阅（长连接）+ 群聊消息监听
│   ├── services/
│   │   ├── ticketService.js       # 工单分支播报 + category 门控搬运 + 接单确认处理
│   │   ├── syncService.js         # 字段映射清洗同步 + 父项目查找 + 状态映射
│   │   ├── approvalLinkService.js # 接单 → 审批任务自动通过（白名单 + 反查兜底）
│   │   ├── unclosedService.js     # 未结单按负责人组别分桶（供 pm-robot DDL 分栏取数）
│   │   └── chatService.js         # 聊天指令处理 + @机器人检测
│   ├── utils/fields.js            # 字段值格式化/归一化（超链接、日期、人员）
│   ├── utils/personFields.js      # 人员组别解析与看板人员字段合并
│   ├── config.js                  # 配置中心
│   └── index.js                   # 主入口（Express API）
├── scripts/                       # 结构探测 / 数据抽样脚本
├── trigger.js                     # 手动触发单条工单事件的调试入口
├── push.js                        # 一键部署脚本
├── .env.example                   # 配置模板
└── .env                           # 实际配置（不入库）
```

---

## 十、注意事项

- `.env` 含飞书应用凭证与群 webhook，严禁提交；已在 `.gitignore` 中排除。
- 群播报走应用机器人（对话型）IM API（webhook 仅兜底）；接单确认、接单回执、超时私信、结单私信走应用机器人。接单确认依赖应用机器人的消息事件（网关秒级转发），**没有消息轮询/回扫**。
- `补充负责人` 写入为「尽力而为」，失败不阻断接单确认与回执，错误会打在日志里。
- 待接单工单映射保存在内存中，服务重启后会清空；此时 @机器人 会提示「该群无待接单工单」。
