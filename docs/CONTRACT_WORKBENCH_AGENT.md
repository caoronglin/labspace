# D509 工作台 · 个人工作台与 Agent 助手 API 契约（实现依据）

> 本文件是前后端共同契约。任何实现都必须与本文件一致（字段名、形状、状态码）。
> 认证：门户使用 `labspace_session` Cookie（HttpOnly）。写操作必须带 `X-CSRF-Token` 头（值等于 `labspace_csrf` Cookie）。
> 内部调用（pi 插件、网关）：允许使用 `X-Lab-Service-Token: <LABSPACE_SERVICE_TOKEN>` 头代替 Cookie，仅对白名单路径开放。

---

## 1. 个人工作台 `/api/workbench`

数据形状（日期一律 ISO 8601 字符串，标签一律字符串数组）：

```jsonc
// item
{"id":"…","user_id":"…","kind":"task|project|idea|knowledge|note|memory|plan",
 "title":"…","content":"…","status":"active|done|paused|archived",
 "priority":"low|normal|high","tags":["…"],"project_id":"…|null","plan_id":"…|null",
 "due_date":"2026-11-05|null","source":"manual|capture|agent","ai_class":"…|null",
 "ai_reason":"…|null","confidence":0.0,"created_at":"…","updated_at":"…"}
// project
{"id":"…","name":"…","description":"…","status":"active|done|paused","health":"on_track|at_risk|blocked|done",
 "progress":0,"next_step":"…","due_date":"…|null","created_at":"…","updated_at":"…"}
// plan
{"id":"…","kind":"direction|stage","title":"…","outcome":"…","metrics":"…","horizon":"…",
 "progress":0,"status":"active|paused|done|archived","next_step":"…","due_date":"…|null","created_at":"…","updated_at":"…"}
// brief
{"date":"2026-11-01","content":"…","payload":{}}
```

| 方法 | 路径 | 请求体 / 查询 | 响应 |
|---|---|---|---|
| GET | `/api/workbench/summary` | — | `{"today":{"tasks":[],"overdue":[],"dueToday":[],"doneToday":[]},"projects":[],"plans":{"directions":[],"stages":[]},"brief":null,"stats":{"activeTasks":0,"activeProjects":0,"activeDirections":0,"inbox":0,"completedThisWeek":0}}` |
| GET | `/api/workbench/items` | `kind,status,q,project_id,limit(默认50)` | `{"items":[item],"total":n}` |
| POST | `/api/workbench/items` | `{kind,title,content,tags,priority,due_date,project_id,plan_id,status}` | `{"item":item}` |
| PATCH | `/api/workbench/items/{id}` | 上述字段任意子集 | `{"item":item}` |
| DELETE | `/api/workbench/items/{id}` | — | `{"ok":true}` |
| GET | `/api/workbench/projects` | — | `{"projects":[project]}` |
| POST | `/api/workbench/projects` | `{name,description,next_step,due_date,health,status}` | `{"project":project}` |
| PATCH | `/api/workbench/projects/{id}` | 任意子集 | `{"project":project}` |
| DELETE | `/api/workbench/projects/{id}` | — | `{"ok":true}` |
| GET | `/api/workbench/plans` | — | `{"plans":[plan]}` |
| POST | `/api/workbench/plans` | `{kind,title,outcome,metrics,horizon,next_step,due_date,progress,status}` | `{"plan":plan}` |
| PATCH | `/api/workbench/plans/{id}` | 任意子集 | `{"plan":plan}` |
| DELETE | `/api/workbench/plans/{id}` | — | `{"ok":true}` |
| GET | `/api/workbench/briefs` | `limit(默认7)` | `{"briefs":[brief]}` |
| POST | `/api/workbench/briefs` | `{content,payload}` | `{"brief":brief}`（同一用户同一天覆盖） |
| POST | `/api/workbench/capture` | `{text}` | `{"item":item,"ai_class":"task","ai_reason":"识别到截止日期","confidence":0.72,"extracted":{"due_date":null,"tags":[],"priority":"normal"}}` |

**智能捕获规则（`/capture`，纯本地规则，不调用 LLM，必须可预测）**：
- `kind` 判定优先级：`plan`（含「计划/目标/方向/里程碑」）> `task`（含「待办/需要/要做/记得/完成/deadline/截止/前完成」）> `project`（含「项目/课题/研究」且无任务词）> `idea`（含「想法/灵感/点子/或许/可以试试」）> `knowledge`（含「文献/论文/笔记/知识/参考」）> `memory`（含「记住/以后/经验/教训」）> `note`（默认）。
- 抽取 `due_date`：`YYYY-MM-DD`、`今天/今日`→今天、`明天`→明天、`后天`、`本周X/下周X`（周一=1）、`N天后`。
- 抽取 `tags`：`#标签` 形式，最多 5 个。
- 抽取 `priority`：`紧急/急/尽快/asap/立刻`→high；`不急/有空/低优先`→low；否则 normal。
- `title`：第一行去掉标签与日期关键词后的前 60 字；`content` 保存全文。
- `confidence`：0.4~0.95 之间由命中规则数决定。

---

## 2. Agent 助手 `/api/agent`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/agent/status` | `{"available":bool,"reason":"","gateway":"http://172.28.0.1:8110","model":"…","models":[{"id","provider","label","context"}]}` |
| GET | `/api/agent/models` | `{"models":[{"id":"MiniMax-M3.1-Flash","provider":"minimax-cn","label":"MiniMax M3.1 Flash","context":1000000,"enabled":true}]}`（只返回管理员允许的模型；`enabled=false` 表示已禁用） |
| GET | `/api/agent/sessions` | `{"sessions":[{"id","title","model","status","message_count","tokens_in","tokens_out","created_at","updated_at"}]}` |
| POST | `/api/agent/sessions` | body `{title?,model?}` → `{"session":{…}}` |
| DELETE | `/api/agent/sessions/{id}` | `{"ok":true}` |
| GET | `/api/agent/sessions/{id}/messages` | `{"messages":[{"id","role":"user|assistant|system|tool","content","meta":{},"created_at"}]}` |
| POST | `/api/agent/sessions/{id}/messages` | body `{content}` → `{"accepted":true,"message":{…}}`；超配额 → **429** `{"detail":"已超出每小时消息配额"}` |
| POST | `/api/agent/sessions/{id}/abort` | `{"ok":true}` |
| GET | `/api/agent/sessions/{id}/stream` | **SSE**（`Content-Type: text/event-stream`），事件名与负载：<br>`event: delta` → `{"text":"增量文本"}`<br>`event: tool` → `{"name":"工具名","phase":"start|end","summary":"一行摘要"}`<br>`event: done` → `{"message_id":"…","usage":{"input":n,"output":n}}`<br>`event: error` → `{"message":"…"}` |
| GET | `/api/agent/quota` | `{"limits":{"messages_per_hour":30,"messages_per_day":200,"tokens_per_day":500000,"max_sessions":3},"usage":{"messagesHour":0,"messagesDay":0,"tokensToday":0,"sessionsActive":0},"remaining":{"messagesHour":30,"tokensToday":500000}}` |
| GET | `/api/agent/admin/config` | **需 lab-admin** → `{"models":[{"id","label","enabled"}],"default_model":"…","quotas":{"messages_per_hour":30,"messages_per_day":200,"tokens_per_day":500000,"max_sessions":3},"plugins":[{"id","name","enabled"}],"system_prompt":""}` |
| PUT | `/api/agent/admin/config` | **需 lab-admin** + CSRF，body 同上 → 同上 |
| GET | `/api/agent/admin/usage` | **需 lab-admin** → `{"users":[{"user_id","messages","tokens_in","tokens_out","sessions"}],"totals":{"messages":0,"tokens_in":0,"tokens_out":0,"sessions":0}}` |

**消息持久化**：`user` 消息落库后立即返回；`assistant` 消息在流式结束时由后端落库（含 usage）。

---

## 3. 内部服务令牌白名单（`X-Lab-Service-Token`）

允许免 Cookie 调用的路径前缀（仅限内部 pi 插件使用）：
- `/api/workbench/*`
- `/api/databases`、`/api/databases/apis`、`/api/databases/{id}/query`、`/api/databases/{id}/probe`
- `/api/search`、`/api/search/categories`
- `/api/services`、`/api/services/health`

其余路径一律要求门户会话。

---

## 4. pi 插件契约（`/opt/labspace/agent/extensions/lab-portal.js`）

pi 扩展（`export default function(pi){ … }` 形式，见 pi 文档 extensions.md），注册以下工具：

| 工具名 | 参数 | 行为 |
|---|---|---|
| `lab_services` | `{q?: string}` | 调用 `GET /api/services` 返回内网服务清单（名称/URL/说明） |
| `lab_database_query` | `{database: string, query: string, limit?: number}` | 调用 `POST /api/databases/{id}/query`，返回归一化结果；`database` 支持中文名或 id 模糊匹配 |
| `lab_web_search` | `{query: string}` | 调用 `GET /api/search?scope=web&q=…` 返回搜索结果 |
| `lab_workbench_capture` | `{text: string}` | 调用 `POST /api/workbench/capture` 把一句话记入工作台 |
| `lab_workbench_list` | `{kind?: string, limit?: number}` | 调用 `GET /api/workbench/items` 返回当前用户条目 |

插件必须：从环境变量 `LAB_PORTAL_URL`（默认 `http://192.0.2.10`）与 `LAB_PORTAL_TOKEN` 读取地址与令牌；所有请求带 `X-Lab-Service-Token` 头；网络失败要给出中文错误提示而不是抛栈。
