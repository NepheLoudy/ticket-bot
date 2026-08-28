# ticket-bot 工单系统机器人

基于飞书多维表格的工单系统机器人，监测「【27赛季】千里工单系统」数据表，按工单字段走并行分支播报到组别对应的群聊，并在 category 有值时搬运记录至项目看板成为子项目。

## 一、核心功能

### 1. 工单播报（创建时触发）

**分支逻辑**：
- **未指定负责人**（`是否指定人员负责=否`）：
  - 按`面向组别`（多选）并行分发到对应组群
  - 播报卡片包含接单确认提醒："@机器人确认接单"
  - 接单者在群内 @机器人 后，自动更新项目状态为"进行中"

- **已指定负责人**（`是否指定人员负责=是`）：
  - 查询指定负责人所属组别（优先级：USER_GROUPS 手动映射 → 飞书通讯录部门 → 工单`面向组别`兜底）
  - 在对应组群 @本人提醒有工单发布

### 2. 项目搬运（category 门控）

**触发条件**：工单的 `category` 字段有值时触发搬运

**字段映射**：
| 工单字段 | 项目看板字段 | 说明 |
|---------|------------|------|
| `category` | `category` | 相同字段同步 |
| `理想结单时间` | `ddl` | 日期时间 |
| `需求` / `需求1` | `fileToken` | 文本 |
| - | `priority` | 默认 `low` |
| `申请状态` | `status` | 审批中→in_progress，已通过→completed |
| `name` | `parentId` | name 字段值作为父项目名称，在项目看板中查找匹配记录 |
| 指定负责人 | 人员字段 | 机械→owner，电控/硬件→dkyjcontributers，视觉→sjcontributers，宣运→xycontributers |

**父子关系建立**：
- 工单的 `name` 字段值作为父项目名称
- 在项目看板中查找匹配的记录作为 `parentId`
- 工单搬运后成为该父项目的子项目

### 3. 接单确认机制

**流程**：
1. 无指定负责人的工单播报时，卡片提醒"接单者@机器人确认接单"
2. 机器人监听群聊消息，检测到 @机器人 后：
   - 查找该群最新的待接单工单
   - 更新项目状态：waiting → in_progress
   - 发送确认消息："XXX 已确认接单"

### 4. 状态同步

**申请状态变化时**：
- 审批中 → 项目 status = in_progress
- 已通过 → 项目 status = completed
- 其他状态 → 项目 status = died 或 pending

## 二、数据表约定

- **源表**：`tblFA6Pj4Mv83Mb0`「【27赛季】千里工单系统」
  关键字段：`面向组别`(多选)、`是否指定人员负责`(是/否)、`指定负责人`(人员)、
  `category`(单选)、`name`(父项目名称)、`申请编号`、`需求`、`发起人`、`申请状态`

- **目标表**：`tblIcyn9814CsgaH`「tbl_project」项目看板
  需包含字段：name, category, ddl, fileToken, priority, status, parentId, owner, dkyjcontributers, sjcontributers, xycontributers, 源记录ID

飞书应用沿用 qianli 项目群共用应用（与 knowledge-tracker / bambu-print-server /
approval-bot 同一个 App），各项目按 table_id 过滤事件互不干扰。

## 三、配置说明

### 1. 群聊路由配置

**格式**：`组别名=chat_id|webhook_url`（逗号分隔）

- `chat_id`：群聊标识（用于 @人 等场景）
- `webhook_url`：群自定义机器人 webhook URL（实际发消息用这个）

**示例**：
```
GROUP_ROUTES=机械组=oc_xxx|https://open.feishu.cn/open-apis/bot/v2/hook/xxx,电控组=oc_yyy|https://open.feishu.cn/open-apis/bot/v2/hook/yyy
```

### 2. 人员组别映射（可选）

**格式**：`姓名或open_id:组别名`（逗号分隔）

**示例**：
```
USER_GROUPS=张三:机械组,李四:电控组,ou_xxx:视觉组
```

**优先级**：
1. USER_GROUPS 手动映射
2. 飞书通讯录部门（需开通 `contact:contact.base:readonly` 权限）
3. 工单的`面向组别`字段兜底

### 3. 项目看板字段

目标表需包含以下字段：
- `源记录ID`（文本，upsert 查重依据）
- `parentId`（单向关联，关联到项目看板自身）
- 其他字段见上方映射表

## 四、本地开发

```bash
cd ticket-bot
npm install
npm run dev        # 开发模式（.env 已配置）
```

健康检查：`curl http://localhost:3003/api/health`

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

## 六、机器人指令

| 指令 | 说明 |
|------|------|
| `/ticket-help` | 显示帮助 |
| `/ticket-list` | 查看全部工单 |
| `/ticket-pending` | 查看待处理工单 |
| `/ticket-status` | 查看工单状态统计 |
| `/ticket-sync` | 手动全量搬运到项目看板 |

## 七、脚本工具

```bash
node scripts/discover.js           # 列出多维表格全部数据表、字段、机器人所在群聊
node scripts/probe-data.js         # 抽样源表记录，测试通讯录权限
node scripts/probe-project-table.js # 探测项目看板字段结构
node scripts/query-parent-projects.js # 查询各 category 的顶层项目
```

## 八、部署到 NAS

```bash
npm run deploy        # git push + SSH 部署 + pm2 启动（/opt/ticket-bot，端口 3003）
npm run deploy:check  # 检查部署状态
npm run deploy:config # 仅上传 .env 并重启
```

## 九、项目结构

```
ticket-bot/
├── src/
│   ├── cron/index.js              # 每日汇总播报（可选）
│   ├── feishu/
│   │   ├── bitable.js             # 多维表格API（读/写/upsert）
│   │   ├── bot.js                 # 卡片构建 + 群路由发送 + 接单确认提醒
│   │   ├── client.js              # 飞书API客户端
│   │   └── eventSubscription.js   # 事件订阅（长连接）+ 群聊消息监听
│   ├── services/
│   │   ├── ticketService.js       # 工单分支播报 + category 门控搬运 + 接单确认处理
│   │   ├── syncService.js         # 字段映射清洗同步 + 父项目查找 + 状态映射
│   │   └── chatService.js         # 聊天指令处理 + @机器人检测
│   ├── utils/fields.js            # 字段值格式化/归一化
│   ├── config.js                  # 配置中心（支持 chat_id|webhook_url 格式）
│   └── index.js                   # 主入口（Express API）
├── scripts/
│   ├── discover.js                # 结构探测（表/字段/群聊）
│   ├── probe-data.js              # 数据抽样 + 权限测试
│   ├── probe-project-table.js     # 项目看板字段探测
│   └── query-parent-projects.js   # 父项目查询
├── deploy.js                      # 一键部署脚本
└── .env                           # 实际配置（不入库）
```

## 十、待完成配置

1. **提供六个组群的 chat_id 和 webhook**：
   ```
   机械组：chat_id = ?   webhook = ?
   电控组：chat_id = ?   webhook = ?
   硬件组：chat_id = ?   webhook = ?
   宣运组：chat_id = ?   webhook = ?
   管理层：chat_id = ?   webhook = ?
   视觉组：chat_id = ?   webhook = ?
   ```

2. **可选**：给应用开通 `contact:contact.base:readonly` 权限，"查询人员所属组别"走通讯录会更准

3. **目标表准备**：确认项目看板已包含所有必需字段（见上方映射表）
