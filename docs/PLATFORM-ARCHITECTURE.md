# D509 实验平台 — 总体架构说明（含代码分布与 API 清单）

> 适用主机：`192.0.2.10`（Tailscale：`198.51.100.71`），Debian 内网服务器
> 生成时间：2026-11-03
> 用途：2026-11-03 的**历史架构基线**。文中 Casdoor、8090、Open WebUI、Quantum 等描述已过时；当前认证与同源入口以 README.md / DEPLOY.md 为准。
> 配套文档：生信平台侧另有 `docs/architecture.md`、`filebrowser-integration.md`、`authentication.md` 等。

---

## 镜像拆分（2026-11）

一个 `backend/Dockerfile` 出四个运行 target，避免"一个镜像背所有东西"：

| target | 镜像 | 带什么 | 干什么 |
|---|---|---|---|
| `backend` | `lab/labspace-backend:1.0.0` | 基础依赖 + LibreOffice + tesseract | 门户 API（含 Office 转换、种子 OCR） |
| `latex` | `lab/labspace-latex:1.0.0` | 基础依赖 + TeX Live | 只跑 `app.latex_worker`（8131） |
| `biotools` | `lab/labspace-biotools:1.0.0` | 基础依赖 + 科学计算栈 + HDF5 | 只跑 `app.biotools_service`（8133，仅内网） |

为什么要拆：Biopython / scikit-bio / dna-features-viewer 会带进 numpy / scipy / pandas /
matplotlib / h5py，而 Python 3.15 上这些**没有 manylinux 轮子**，必须源码编译（gcc + HDF5 头文件）。
放在门户镜像里会让它从 1.3 GB 涨到 3.2 GB，而门户本身不需要它们；LaTeX sidecar 更不需要
LibreOffice。拆分后三个镜像分别是 1.32 / 1.54 / 1.51 GB，且各自的可写面更小。

生信服务的鉴权在门户侧：浏览器只访问 `http://<门户>/api/biotools/*`，
`app/biotools_proxy.py` 校验会话（写操作还校验 CSRF）后原样转发给 `biotools:8133`。
那个容器不发布宿主端口、不做鉴权、`cap_drop: ALL`。

## 目录

1. [一句话概览](#1-一句话概览)
2. [部署拓扑（物理视图）](#2-部署拓扑物理视图)
3. [代码分布总览](#3-代码分布总览)
4. [代码目录树](#4-代码目录树)
5. [API 清单](#5-api-清单)
6. [组件清单与互联关系](#6-组件清单与互联关系)
7. [身份与认证架构](#7-身份与认证架构)
8. [数据存储架构](#8-数据存储架构)
9. [关键数据流](#9-关键数据流)
10. [可观测性与运维](#10-可观测性与运维)
11. [架构优化建议](#11-架构优化建议)
12. [已知风险与遗留](#12-已知风险与遗留)
13. [附录：路径速查](#13-附录路径速查)

---

## 1. 一句话概览

平台由**一台宿主机**承载三类东西：

1. **D509 工作台（LabSpace）门户** —— 统一入口 + 服务目录 + 管理台（Docker + Nginx + FastAPI，~2 万行）
2. **生信实训平台（bioinfo-training）** —— 课程/实验/终端/工作区（原生 systemd + FastAPI + React，~1.5 万行）
3. **一体化服务栈** —— Casdoor、SearXNG、Docling/Tika、draw.io、JBrowse、SnapOtter、PDFMathTranslate、科研 API/MCP
   （FileBrowser Quantum 与 Open WebUI 已于 2026-11-04 清理下线）

身份统一由 **Casdoor** 承载；文件统一由**门户原生网盘 `/files`** 承载（SnapOtter 只做文件工具处理）；
门户只做**目录/编排/代理**，不建第二份存储。

---

## 2. 部署拓扑（物理视图）

```
                         ┌─────────────────────────────────────────────┐
   局域网 192.0.2.0/24 │            宿主机 192.0.2.10              │
   Tailscale 100.64/10   │   Debian · nftables · systemd · Docker      │
                         └─────────────────────────────────────────────┘

   客户端浏览器
        │  HTTP（全部 IP + 端口，无域名依赖）
        ▼
 ┌────────────────────────────────────────────────────────────────────┐
 │ Nginx  /etc/nginx/sites-enabled/{labspace,bioinfo}.conf              │
 │  :80   D509 门户静态站 + /api/ 反代        :8090 Casdoor 反代        │
 │  :8086 Linux 命令速查（静态）               :8091 JBrowse 2（静态）  │
 │  :8102 生信实训平台前端 + /api 反代                                   │
 └──┬────────┬────────────┬─────────────┬─────────────────────────────┘
    │        │            │             │
    ▼        ▼            ▼             ▼
 ┌────────┐ ┌─────────┐ ┌─────────┐ ┌──────────────┐
 │LabSpace│ │bioinfo- │ │ Casdoor │ │  JBrowse 2   │
 │backend │ │ api     │ │ :8000   │ │  :8091 静态  │
 │ :8088  │ │ :8100   │ │(容器内) │ │              │
 │(容器)  │ │bioinfo- │ └─────────┘ └──────────────┘
 └────────┘ │ terminal│
            │  :8101  │
            └─────────┘

  Docker 网络（3 个）：labspace-net / lab-core_lab-backend / lab-tools
  宿主 systemd（非容器）：nginx · dnsmasq · bioinfo-api · bioinfo-terminal
    bioinfo-cgroup-helper · lab-agent-gateway(Node 172.28.0.1:8110)
    lab-oidc-sync(Python 172.28.0.1:8111) · lab-health.timer
```

### 2.1 对外端口总表（nftables `svc_ports` 白名单）

| 端口 | 服务 | 形态 | 访问地址 |
|---|---|---|---|
| 80 | D509 门户 | Nginx 静态 + 反代 | `http://192.0.2.10/` |
| 8082 | draw.io | Docker 直出 | `http://192.0.2.10:8082/` |
| 8084 | IT-Tools | Docker 直出 | `http://192.0.2.10:8084/` |
| 8086 | Linux 命令速查 | Nginx 静态 | `http://192.0.2.10:8086/` |
| 8090 | Casdoor 认证 | Nginx 反代 | `http://192.0.2.10:8090/` |
| 8091 | JBrowse 2 | Nginx 静态 | `http://192.0.2.10:8091/index.html` |
| 8092 | SnapOtter | Docker 直出 | `http://192.0.2.10:8092/` |
| 8093 | 图纸平台 | Nginx 反代 | `http://192.0.2.10:8093/` |
| 8094 | Baserow 数据表 | Nginx 反代 | `http://192.0.2.10:8094/` |
| 8102 | 生信实训平台 | Nginx 反代 | `http://192.0.2.10:8102/` |

> 约定：**所有入口一律 IP + 端口**。`*.lab.internal` 已下线（dnsmasq 保留可选别名，不影响使用）。

---

## 3. 代码分布总览

| 代码库 | 路径 | 技术栈 | 代码量 | 形态 |
|---|---|---|---|---|
| D509 门户前端 | `/opt/labspace/frontend` | React 19 · TS · Vite · AntD 6 · TanStack Query | **12,231 行** (58 文件) | 构建产物 `dist` → Nginx |
| D509 门户后端 | `/opt/labspace/backend` | Python · FastAPI · SQLAlchemy · psycopg | **7,954 行** (18 文件) | Docker `lab-labspace-backend` |
| D509 Agent 网关 | `/opt/labspace/agent` | Node 26 · pi RPC | `gateway.mjs` + 插件 | systemd `lab-agent-gateway` |
| D509 运维脚本 | `/opt/labspace/ops` | Python | `oidc-sync.py` | systemd `lab-oidc-sync` |
| 生信平台前端 | `/opt/bioinfo-training/frontend` | React 19 · antd 6 · TanStack Query 5 · react-router 7 | **9,785 行** (33 文件) | 构建产物 `dist` → Nginx :8102 |
| 生信平台后端 | `/opt/bioinfo-training/backend/app` | Python · FastAPI · SQLAlchemy 2 · Alembic | **5,105 行** (25 文件) | systemd `bioinfo-api` |
| 科研 API / MCP | `/opt/lab-research-api/app` | Python · FastAPI | `main.py` `tools.py` `mcp_server.py` | Docker ×2 |
| e2e 测试 | `/opt/labspace/e2e` | Playwright (Node) | **50+ 脚本** | 本地执行 |
| 运维脚本 | `/usr/local/bin/lab-*` | Bash / Python | **19 个** | 宿主机 |

### 3.1 数据层代码量对比
- 门户后端 7,954 行中，`db_apis.py`（32 个科研数据库适配器）与 `databases.py`（50 个植物库静态目录）占比最大，是"数据密集"型模块。
- 生信平台后端 5,105 行分布在 12 个 router + 10 个核心模块（`security/rbac/oidc/terminal/cgroup_helper`）。

---

## 4. 代码目录树

### 4.1 D509 门户前端 `/opt/labspace/frontend/src`

```
src/
├── main.tsx                      入口（ConfigProvider + theme + QueryClient）
├── routes/index.tsx              25 条路由，全部 React.lazy + Suspense
├── styles.css / styles/
│   ├── motion.css                动效系统（240ms 进 / 160ms 出 / 120ms 悬停）
│   └── prose.css                 Markdown 排版
├── theme/
│   ├── ThemeContext.tsx          深/浅色主题切换
│   └── tokens.ts                 设计 Token（与 docs/DESIGN_SPEC.md 对齐）
├── utils/host.ts                 currentHost()/hostUrl() —— IP 自适应（清 27 处硬编码 IP）
├── services/api.ts               统一 fetch 封装（JWT Cookie + CSRF 头 + 401 回登录）
├── app/
│   ├── AppLayout.tsx             门户主框架（侧栏/顶栏/内容区）
│   └── AuthContext.tsx           会话状态、角色、菜单可见性
├── components/
│   ├── AcademicSearch.tsx        学术检索面板（NCBI/EBI/EuropePMC…）
│   ├── AccessGuide.tsx           IP 直达入口 + DNS/hosts 修复指引
│   ├── CommandPalette.tsx        命令面板
│   ├── EmbedFrame.tsx            IFRAME 内嵌容器（sandbox 策略）
│   ├── ErrorBoundary.tsx         全局错误边界（防白屏）
│   ├── HomeStats.tsx             首页统计
│   ├── MarkdownView.tsx          Markdown 渲染
│   ├── PageHeader.tsx            页头
│   ├── PlantDatabasePanel.tsx    首页植物库常驻面板（默认 8 个）
│   ├── QuickActions.tsx          快捷入口
│   ├── ServiceCard.tsx           服务卡片（写最近访问）
│   ├── SsoButton.tsx             一键登录按钮
│   └── charts/                   AntV 图表（懒加载，首屏 gzip 增量 ≈0）
│       ├── ChartCard.tsx  chartTheme.ts
│       ├── DatabaseCategoryBar.tsx  DiskUsagePanel.tsx
│       ├── ModelUsageBar.tsx   ServiceHealthDonut.tsx  TaskStatusDonut.tsx
└── pages/
    ├── Home.tsx  Services.tsx  ServiceDetail.tsx  Start.tsx  Login.tsx
    ├── SearchPage.tsx  Literature.tsx  Databases.tsx  Network.tsx
    ├── Favorites.tsx  Workbench.tsx  Agent.tsx  Weather.tsx
    ├── Drawio.tsx  Drawings.tsx  Docling.tsx  Docparse.tsx
    ├── Translate.tsx  Translation.tsx  Commands.tsx  DevTools.tsx
    ├── SnapOtter.tsx  EmbedPage.tsx  SsoLogin.tsx  Admin.tsx  NotFound.tsx
    └── admin/AgentAdmin.tsx
```

### 4.2 D509 门户后端 `/opt/labspace/backend/app`

```
backend/app/
├── main.py            FastAPI 入口：路由聚合 + _client_host() + _auto_sso_follow 中间件
├── config.py          Settings（CASDOOR_ISSUER / LABSPACE_PUBLIC_URL / DB_URL / 模型地址）
├── db.py              SQLAlchemy 引擎、会话、Base
├── models.py          门户业务表（favorites / drawings / recent / announcements / agent_*）
├── security.py        会话 JWT + HttpOnly Cookie + 双提交 CSRF + require_user_or_service
├── casdoor.py         Casdoor OIDC 授权/回调/登出；state 固化 redirect_uri + issuer
├── catalog.py         服务目录（静态元数据）+ adapt_host() 按入口 Host 自适应
├── sso.py             第三方服务 SSO 编排（显式 prepare 切换 issuer，等容器健康）
├── workbench.py       个人工作台 16 个接口
├── agent.py           Agent 会话 + SSE 流式 + 工具调用记录
├── mt.py              Hy-MT2 翻译（走科研 API）
├── docparse.py        OXR-1.0 优先 / Docling 回退
├── weather.py         Open-Meteo 天气
├── databases.py       50 个植物生信库目录（静态数据，9 分类）
├── db_apis.py         32 个科研数据库实时适配器
├── corpus.py          全局搜索统一语料（975+ 条，含中文别名与深链接）
├── snapotter.py       SnapOtter 工具目录（取自其 openapi.yaml）
└── http.py            统一 HTTP 客户端封装
```

### 4.3 生信平台前端 `/opt/bioinfo-training/frontend/src`

```
src/
├── main.tsx  routes/index.tsx  services/api.ts  theme/tokens.tsx  styles.css
├── app/
│   ├── AppLayout.tsx     平台框架
│   ├── AuthContext.tsx   会话/角色
│   └── labels.ts         中文文案映射
├── components/workspace/
│   ├── TerminalPanel.tsx        xterm.js 终端面板（WebSocket）
│   └── WorkspaceFileBrowser.tsx 工作区文件浏览
└── pages/
    ├── Login.tsx  Dashboard.tsx  Courses.tsx  CourseDetail.tsx
    ├── Labs.tsx  LabDetail.tsx  Datasets.tsx  Workspace.tsx
    ├── Submissions.tsx  Records.tsx  Profile.tsx
    ├── admin/  AdminOverview/AdminUsers/AdminCourses/AdminDatasets/
    │           AdminLabs/AdminEnvironments/AdminResources/AdminTerminals/
    │           AdminAudit/AdminSettings
    └── teaching/ TeachingOverview/TeachingCourses/TeachingAssignments/
                 TeachingDatasets/TeachingReviews/TeachingStudents
```

### 4.4 生信平台后端 `/opt/bioinfo-training/backend/app`

```
backend/
├── alembic/versions/2d7f4d463fb7_init.py     初始迁移（31 表）
├── app/
│   ├── main.py          FastAPI 入口 + 12 个 router 挂载
│   ├── terminal_app.py  终端网关入口（WebSocket）
│   ├── config.py        pydantic-settings（env 前缀 BIOINFO_）
│   ├── db.py            engine / SessionLocal / Base / TimestampMixin
│   ├── models.py        ~30 张表
│   ├── security.py      会话 Cookie / CSRF / current_user / require_csrf / sync_roles
│   ├── rbac.py          GROUP_ROLE_MAP / ROLE_LEVEL / require_admin / require_teacher
│   ├── oidc.py          Casdoor OIDC（PyJWKClient + PKCE + userinfo）
│   ├── workspaces.py    学生工作区（student_001 形式内部 ID）
│   ├── terminal.py      终端会话编排
│   ├── pty_agent.py     PTY 子进程代理
│   ├── cgroup_helper.py 经 unix socket 调 cgroup 助手
│   ├── audit.py         审计事件
│   └── routers/
│       ├── auth.py      login / callback / csrf / logout / me / profile
│       ├── courses.py   课程 / 选课 / 进度
│       ├── labs.py      实验 / 作业
│       ├── datasets.py  数据集 / 下载
│       ├── workspaces.py 工作区 / 文件
│       ├── submissions.py 提交 / 批阅
│       ├── dashboard.py 概览 / 通知
│       ├── terminal.py  终端会话
│       ├── teaching.py  教学端（教师/助教）
│       ├── users.py     用户与角色
│       └── admin.py     管理端
└── tests/               pytest
```

### 4.5 Agent 与运维

```
/opt/labspace/agent/
├── gateway.mjs              Node 26，pi RPC 网关：每会话 fork `pi --mode rpc`
│                            禁用内置 read/bash/edit/write，只允许 lab_* 插件
├── package.json
└── extensions/lab-portal.js 5 个工具：
                            lab_services / lab_database_query / lab_web_search
                            lab_workbench_capture / lab_workbench_list

/opt/labspace/ops/oidc-sync.py  已下线服务的历史 issuer 同步器（监听 172.28.0.1:8111）
                                随 Open WebUI / Quantum 于 2026-11-04 清理而停用

/usr/local/bin/  （运维脚本）
lab-backup            备份（Casdoor/LabSpace、SnapOtter）
lab-restore-drill     恢复演练（恢复到临时库比对行数）
lab-health            每日巡检（systemd timer）
lab-reset-init        重置初始化（TRUNCATE + 入口/API 校验）
lab-casdoor-init      Casdoor 应用/用户初始化
lab-sync-passwords    密码同步（casdoor）
lab-searxng-test  lab-oikb-sync  lab-pyproject-sync

（`lab-owui-*`、`lab-quantum-*`、`lab-pull-full-openwebui.sh` 是已下线服务的历史脚本，
不再有对应服务，已从现行清单移除。）
```

### 4.6 测试

```
/opt/labspace/e2e/         50+ Playwright 脚本
  e2e.mjs（门户主流程）  api-integration.mjs（51 断言）  oidc-ip-flow.mjs
  oidc-multi.mjs（LAN/Tailscale/别名三入口）  ip-adaptive-test.mjs（17）
  sso-flow.mjs  embed-test.mjs  sso-e2e-test.mjs  agent-integration.mjs（20）
  agent-chat-test.mjs  biomed-api-test.mjs  db-api-integration.mjs
  databases-api-ui.mjs  design-selfcheck.mjs  components-polish-test.mjs（51）
  charts-test.mjs  jbrowse-i18n.mjs  i18n-full.mjs  perf3.mjs  ports-test.mjs
  bioinfo-api-smoke.mjs（7）  bioinfo-terminal-test.mjs  post-reset-test.mjs
  fixtures/  package.json

/opt/bioinfo-training/e2e/  生信平台专用 e2e
/opt/bioinfo-training/backend/tests/  pytest（auth/oidc_state/workspace 等）
/opt/lab-research-api/     科研 API 自测
```

---

## 5. API 清单

### 5.1 门户后端（FastAPI，`lab-labspace-backend` @127.0.0.1:8088，经 Nginx :80 `/api/` 暴露）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查（巡检用） |
| GET | `/api/me` | 当前用户（id/角色/组） |
| GET | `/api/services` | 服务目录（按角色过滤） |
| GET | `/api/services/health` | 全部服务健康快照 |
| GET | `/api/services/{id}/health` | 单服务健康 |
| GET | `/api/services/{id}/embed` | IFRAME 可嵌入性判定 |
| GET | `/api/services/{id}/sso` | 该服务的 SSO 入口信息 |
| GET | `/api/auth/login` | 发起 Casdoor 授权 |
| GET | `/api/auth/callback` | 授权回调（校验 state，签发会话） |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/auth/logout-redirect` | 登出跳转 |
| GET | `/api/sso/status` | 第三方 SSO 状态（clientIp/desiredHost/auto） |
| GET | `/api/sso/{service_id}/prepare` | 准备第三方免密登录（触发 issuer 切换） |
| GET | `/api/search` | 全局搜索（本地语料 + SearXNG + 科研 API） |
| GET | `/api/search/categories` | 搜索分类 |
| GET | `/api/search/suggest` | 搜索建议 |
| GET | `/api/corpus` | 搜索语料导出 |
| GET | `/api/databases` | 50 个植物生信库目录（`?q=&category=`） |
| GET | `/api/databases/apis` | 可实时查询的库清单 |
| POST | `/api/databases/{db_id}/query` | 实时查询某库 |
| GET | `/api/databases/{db_id}/probe` | 探活 |
| GET | `/api/literature` | 科研文献检索（聚合） |
| GET | `/api/commands` `/api/commands/{name}` | Linux 命令速查（621 条） |
| GET/POST/DELETE | `/api/favorites[/{service_id}]` | 收藏服务 |
| GET/POST | `/api/recent[/{service_id}]` | 最近访问 |
| GET/POST | `/api/drawings[/{id}]` `/rename` `/export` `/download` | 图形管理 |
| GET/POST/DELETE | `/api/announcements[/{aid}]` | 公告（管理端发布） |
| GET | `/api/teacher/announcements` | 教师端公告 |
| GET | `/api/pdf-translate/status` `/jobs/{id}` `/jobs/{id}/result` | PDF 翻译任务 |
| POST | `/api/pdf-translate/jobs` | 投递 PDF 翻译 |
| GET | `/api/snapotter/status` `/tools` `/pipelines` `/jobs/{id}` `/download` | SnapOtter 集成 |
| POST | `/api/snapotter/run` | 触发 SnapOtter 流程 |
| — | `/api/workbench/*` | 个人工作台 16 接口：items/plans/projects/sessions/briefs/notifications/quota/models |
| — | `/api/agent/*` | Agent：sessions、messages、SSE stream、abort、summary、models、capture、text |
| — | `/api/docparse/*` `/api/mt/*` `/api/weather` | 文档解析 / 翻译 / 天气 |
| GET | `/api/network/entries` `/api/admin/*` | 网络入口诊断 / 管理端（health、info、config、usage） |

### 5.2 生信平台后端（FastAPI，systemd @127.0.0.1:8100，经 Nginx :8102 `/api/` 暴露）

| Router | 端点 |
|---|---|
| auth | `GET /login` `GET /callback` `GET /csrf` `POST /logout` `GET /me` `PUT /me/profile` |
| dashboard | `GET /overview` `GET /notifications` `POST /notifications/read` |
| courses | `GET /courses` `GET /{course_id}` `POST /{course_id}/enroll` `POST /{course_id}/progress` `GET /progress/mine` |
| labs | `GET /labs` `GET /labs/{lab_id}` `POST /labs` `GET /assignments` `POST /assignments` |
| datasets | `GET /categories` `GET /{dataset_id}` `GET /{dataset_id}/download` |
| workspaces | `GET /me/tree` `POST /me/upload` `GET /me/download` `GET /me/progress` `GET /me/submissions` `DELETE /me/files` |
| submissions | `GET /{submission_id}` `GET /{submission_id}/files/{file_id}` `POST /{submission_id}/review` |
| terminal | `POST /sessions` `GET /sessions` `GET /sessions/current` `GET /sessions/{id}` `POST /sessions/{id}/resize` `POST /sessions/{id}/stop` `GET /terminal-sessions` `POST /terminal-sessions/{id}/stop` |
| teaching | `GET /students` `GET /enrollments` `GET /capacity` `GET /environments` `GET /resource-profiles` `GET /overview` `GET /audit` |
| users | `GET /users` `POST /users/{id}/roles` `POST /users/{id}/status` |
| admin | `GET/POST/PATCH` items / plans / projects / sessions / users；`GET/PUT /admin/config` `GET /admin/usage` |

### 5.3 FileBrowser Quantum（已下线，2026-11-04 清理）

Quantum 的容器、镜像与 `lab-quantum_default` 网络均已清理，平台不再调用其 `/files/api/*` 端点，
Casdoor 客户端 `quantum` 亦已停用。文件访问改由门户原生网盘 `/files` 承担
（Go 核心 `labfiles`：只读索引 + 按用户 ACL 授权，对外路径 `/api/files`）；
文件处理类需求（图像/PDF/音视频）由 SnapOtter（:8092）承担。

### 5.4 外部公共 API（门户科研检索，`db_apis.py` + `corpus.py`）

| 类别 | 端点 |
|---|---|
| NCBI | `eutils.ncbi.nlm.nih.gov/entrez/eutils/{esearch,esummary}.fcgi`、`blast.ncbi.nlm.nih.gov/Blast.cgi` |
| UniProt | `rest.uniprot.org/uniprotkb/search` |
| Europe PMC | `europepmc.org`、`europepmc.org/article/MED/` |
| PubChem | `pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/{name}/property/.../JSON` |
| AlphaFold DB | `alphafold.ebi.ac.uk/api/prediction/` |
| RCSB PDB | `search.rcsb.org/rcsbsearch/v2/query` |
| KEGG | `rest.kegg.jp/{find,info}/kegg` |
| Reactome/Enrichr | `maayanlab.cloud/Enrichr/` |
| STRING | `string-db.org/api/json/network` |
| Open Targets | `platform.opentargets.org/api/v4/graphql` |
| cBioPortal | `cbioportal.org/api/studies`、`/study/summary` |
| OpenFDA | `api.fda.gov/drug/label.json` |
| HGNC | `rest.genenames.org/fetch/symbol/{sym}` |
| PANTHER | `pantherdb.org/services/oai/pantherdb/geneinfo` |
| Cellosaurus | `api.cellosaurus.org/search/cell-line` |
| Brain Map | `api.brain-map.org/api/v2/data/query.json` |
| RNAcentral | `rnacentral.org` |
| Plant Ontology | `plantontology.org` |

其它外部依赖：`Open-Meteo`（天气）、`Bing`（PDFMathTranslate 翻译后端）、`ChEBI`（生物医学库测试，受上游超时影响）。

### 5.5 MCP / 科研工具

- 科研 API 与 MCP **共用同一实现** `/opt/lab-research-api/app/tools.py`（避免行为漂移）。
- MCP Streamable HTTP 实测：initialize 200、session 正常、`tools/list` 返回 **9 个工具**。
- Agent 插件工具（`lab-portal.js`）：`lab_services` / `lab_database_query` / `lab_web_search` / `lab_workbench_capture` / `lab_workbench_list`。

---

## 6. 组件清单与互联关系

### 6.1 D509 工作台（LabSpace）

前端 `frontend/`（React 19 + TS + Vite + AntD 6），产物 `dist` 由 Nginx 托管；后端 `backend/app`（FastAPI）跑在容器 `lab-labspace-backend`（宿主 127.0.0.1:8088）；DB = `lab-postgres` 容器内的 `labspace` 库。

| 模块 | 职责 | 关键接口 |
|---|---|---|
| `main.py` | 入口、中间件、路由聚合 | `/api/health`、`/api/*` |
| `catalog.py` | 服务目录 + `adapt_host()` 按入口 Host 自适应 | `/api/services` |
| `casdoor.py` | OIDC 授权/回调/登出，state 固化 redirect_uri+issuer | `/api/auth/*` |
| `security.py` | 会话 JWT + HttpOnly Cookie + 双提交 CSRF + `require_user_or_service` | 依赖注入 |
| `sso.py` | 第三方 SSO 编排（显式 prepare 切换 issuer） | `/api/sso/*` |
| `workbench.py` | 个人工作台 | `/api/workbench/*` |
| `agent.py` | Agent 会话 + SSE | `/api/agent/*` |
| `mt.py` / `docparse.py` / `weather.py` | 翻译 / 文档解析 / 天气 | `/api/mt/*` `/api/docparse/*` |
| `databases.py` / `db_apis.py` / `corpus.py` | 植物库目录 / 32 实时适配器 / 搜索语料 | `/api/databases*` `/api/search*` |
| `snapotter.py` | SnapOtter 集成 | `/api/snapotter/*` |

路由（`routes/index.tsx`，25 条，全部懒加载）：`/` `/start` `/services[/:id]` `/embed/:id` `/sso/:serviceId` `/favorites` `/search` `/literature` `/databases` `/network` `/drawio` `/drawings` `/docling` `/docparse` `/translate` `/translation` `/weather` `/workbench` `/agent` `/devtools` `/snapotter` `/admin` `/login` `/404`

### 6.2 生信实训平台（bioinfo-training）

**原生 systemd，不用 Docker**（需要精细 cgroup/权限控制）。DB = 独立 PostgreSQL 17 @5433，库 `bioinfo`，Alembic 31 表。Nginx `listen 192.0.2.10:8102`。

| systemd 单元 | 说明 |
|---|---|
| `bioinfo-api.service` | uvicorn `--workers 2` @127.0.0.1:8100，用户 `bioinfo`，`ProtectSystem=strict`、`NoNewPrivileges=yes` |
| `bioinfo-terminal.service` | uvicorn `--workers 1` @127.0.0.1:8101（keep-alive 75s） |
| `bioinfo-cgroup-helper.service` | **root**，只做 cgroup 委派，unix socket `/run/bioinfo/cgroup.sock` |
| `bioinfo-term-<uuid>.service` | 每终端会话一个 cgroup 单元（标准档 1 核 / 1.5 GiB / 256 PID / 10 GiB） |

### 6.3 一体化服务栈

| 服务 | 目录 | 容器/形态 | 对外 | 认证 |
|---|---|---|---|---|
| Casdoor | `labspace/deploy` | `lab-casdoor` 127.0.0.1:8000 | Nginx :8090 | 自身账号 + OIDC Provider |
| PostgreSQL | 同上 | `lab-postgres` pgvector/pg17 | 内网 | 库：`casdoor` `labspace` |
| 门户原生网盘 | Go 核心（无容器） | `labgo` systemd，172.28.0.1:8122 | 门户 `/files` | 门户会话 + 按用户 ACL |
| SearXNG | `lab-search` | `lab-searxng` 127.0.0.1:8081 + valkey | 门户代理 | 门户统一入口 |
| Docling + Tika | `lab-docparse` | `lab-docling` / `lab-tika` | 内网 | 门户代理 |
| draw.io | `labspace/deploy` | `lab-drawio` | :8082 | 内网无认证 |
| IT-Tools | 同上 | `lab-it-tools` | :8084 | 内网无认证 |
| JBrowse 2 | 静态 | `/srv/labdata/jbrowse/web` | Nginx :8091 | 内网无认证 |
| SnapOtter | `lab-snapotter` | `lab-snapotter` + 独立 pg/redis | :8092 | 自身账号 |
| PDFMathTranslate-next | `labspace/deploy` | `lab-pdf2zh` (7860) | 门户代理 | 门户会话 |
| 科研 API / MCP | `lab-research-api` | `lab-research-api` / `lab-research-mcp` | 内网 | Bearer / X-Agent-Token |
| Open Terminal | `lab-terminal` | `lab-open-terminal` | 内网 | 门户会话（管理员） |
| pi RPC 网关 | `labspace/agent` | systemd Node，172.28.0.1:8110 | 内网 | `X-Agent-Token` |
| OIDC 同步器 | `labspace/ops` | systemd Python，172.28.0.1:8111 | 内网 | 本机 |

---

## 7. 身份与认证架构

```
                     ┌──────────────────┐
   浏览器 ──────────▶ │   Casdoor :8090  │  唯一身份源
                     │  用户 / 组织 / 应用│
                     └────────┬─────────┘
                              │ OIDC (code + PKCE)
                  ┌───────────┴───────────┐
                  ▼                       ▼
           D509 门户              生信实训平台
           (labspace)            (bioinfo-training)
                  │                       │
      state 固化 redirect_uri+issuer      │ client_id=bioinfo-training
                  ▼                       ▼
           门户会话 JWT             平台会话 Cookie
           (HttpOnly Cookie)        bioinfo_session
```

### 7.1 Casdoor 作为唯一 IdP
- 现有应用：`labspace`、`bioinfo-training`、`app-built-in`（client_id 见 `application` 表）；`openwebui` / `quantum` 客户端随 2026-11-04 清理停用。
- 组/角色：`lab-admin` / `lab-teacher` / `lab-student` / `project-*`；生信平台另有 `bioinfo-admin/instructor/teacher/ta/assistant/student`。
- 关键修复：`application.enable_signin_session=true` + `enable_auto_signin=true`（现有应用）→ 授权码流建立浏览器会话 → **跨应用免密**。
- `origin`/`originFrontend` 留空 → issuer 随请求 Host 回显 → IP 入口无需域名。

### 7.2 门户会话
授权码 → 后端换 token → 自签会话 JWT（`sub`=用户 id）→ HttpOnly Cookie；附加**双提交 CSRF**（Cookie `labspace_csrf` + 头 `X-CSRF-Token`）。服务间调用走 `require_user_or_service` + `X-Lab-Service-Token`。

### 7.3 第三方 issuer 按入口切换（已下线）

Open WebUI / Quantum 的 issuer 曾是**静态配置**，无法像 Casdoor 那样按请求 Host 回显，必须改配置并重建容器才能切换。
这两个服务已于 2026-11-04 清理下线，切换机制（`ops/oidc-sync.py` + `/api/sso/{id}/prepare`）随之停用；
门户与生信实训平台的 issuer 均按请求 Host 动态推导，不再触发任何容器重建。

### 7.4 FileBrowser Quantum 的用户级认证（已下线）

平台曾为每个登录用户签发**短时效 HS256 断言**（`X-JWT-Assertion` 头）交给 FQ 做用户级访问。
随 Quantum 于 2026-11-04 下线，该断言链路与宿主密钥 `/etc/lab-quantum/quantum.env`(0600) 一并退役；
现行文件访问由门户原生网盘的 Go 核心 ACL 承担。

---

## 8. 数据存储架构

```
  ┌───────────────────────────────────────────┐   ┌───────────────────────────┐
  │ lab-postgres (pgvector/pg17)              │   │ bioinfo PostgreSQL 17     │
  │   casdoor / labspace                      │   │  宿主 :5433, 库 bioinfo   │
  │                                           │   │  Alembic 31 表            │
  └───────────────────────────────────────────┘   └───────────────────────────┘
  ┌───────────────────────────┐   ┌────────────────────────────────┐
  │ snapotter postgres + redis│   │ 门户原生网盘（Go 核心 labfiles）│
  └───────────────────────────┘   │  /srv/lab/public    公共资料     │
                                   │  /srv/lab/plasmids  公共质粒     │
                                   │  /srv/lab/genomes   公共基因组   │
                                   │  /srv/lab/users/<user> 个人文件  │
                                   └────────────────────────────────┘
  其它：/srv/labdata（jbrowse、bioinfo-training 用户区、备份）
        （已下线服务的宿主目录 /opt/lab-core-stack、/opt/lab-quantum 已停用，保留待清理）
```

### 8.1 门户原生网盘权限模型（当前生效）
- 源（source）：`public`（公共资料）、`plasmids`（公共质粒）、`genomes`（公共基因组）为共享源；`users` 为个人空间。
- 组规则（`labfiles.DefaultGroups()`）：`lab-student` 三个共享源只读；`lab-teacher` 可写 `genomes`；`lab-admin` 可写全部共享源。
- 个人空间：`users/<local>` 目录自动创建，仅本人可见（可显式共享给指定人），跨用户访问一律拒绝。
- 应用层 ACL 校验 + POSIX ACL 双重保护；写操作由 `labgo` 运行账号落盘，操作进文件审计。

---

## 9. 关键数据流

### 9.1 跨应用免密登录
```
浏览器 → 门户 /api/auth/login → Casdoor 授权（已有会话静默通过）
      → 回调 /api/auth/callback → 门户会话 JWT（HttpOnly Cookie）
      → 生信实训平台用同一 Casdoor 会话免密进入（enable_auto_signin）
```

### 9.2 PI Agent 流式对话
```
浏览器 → 门户 /api/agent/... (SSE) → 后端 agent.py
      → HTTPX → pi RPC 网关 172.28.0.1:8110 → 该会话 fork `pi --mode rpc`
      → 子进程只允许 lab_* 插件工具（read/bash/edit/write 已禁用）
      → 工具经 X-Lab-Service-Token 回调门户 API
      → 网关 autoFollowed 在纯工具轮次后自动追问「请给出最终答复」
      → SSE 分片推送到浏览器
```
> 坑：SSE 跨 chunk 丢半行 → `aiter_text()` 需保留半行（已修于 agent.py / mt.py）。

### 9.3 文件访问（门户原生网盘）
```
浏览器 → 门户 /files → Go 核心 labfiles（只读索引 + 按用户 ACL 授权）
  列目录  GET  /api/files?source=users
  预览    GET  /api/files/{id}/preview
  下载    GET  /api/files/{id}/download      批量打包 GET /api/files/archive?ids=
  上传/新建/重命名/共享/回收站  POST /api/files/{action}
  删除    DELETE /api/files
```

---

## 10. 可观测性与运维

| 组件 | 位置 | 说明 |
|---|---|---|
| 每日巡检 | `/usr/local/bin/lab-health` + `lab-health.timer` | 宿主资源 / 容器 / 内网入口（11 项 URL 探活）/ Docker 别名冲突 / 模型 API / 备份 / 定时任务 / 磁盘（当前：失败 0、警告 1） |
| 备份 | `/usr/local/bin/lab-backup` | Casdoor+LabSpace、SnapOtter；保留 14 天 |
| 恢复演练 | `/usr/local/bin/lab-restore-drill` | 恢复 → 临时库比对行数 → 删除 |
| 账号工具 | `lab-sync-passwords` `lab-casdoor-init` `lab-oikb-sync` | 凭据在 `/etc/lab-*/credentials`(0600) |
| e2e | `/opt/labspace/e2e/*.mjs`（50+）、`/opt/bioinfo-training/e2e/` | Playwright + 集成体检 |
| 日志 | `journalctl -u <unit>`、`docker logs` | Nginx 记录各入口访问 |

### 10.1 防火墙
`/etc/nftables.conf`：`inet filter`，`policy drop`；白名单 = `lan_net`（192.0.2.0/24、172.16/12、10.88/16）+ `ts_net`（100.64/10）× `svc_ports`（80、8082、8084、8086、8090、8091、8092、8102）；SSH 22 单独放行；DNS 53 仅内网。
（3000 / 8080 是已下线服务遗留的白名单条目，当前无进程监听。）
> 严禁 `flush ruleset`（会清掉 Docker 的 iptables 链）；新增端口必须同步 `svc_ports`。

---

## 11. 架构优化建议

按收益/风险排序：

1. **统一编排到一套 Compose/网络命名空间**
   现状 6 个 compose 项目 + 3 个 Docker 网络 + 3 套 Nginx 配置 + 3 套 systemd。容器服务名必须全局唯一（曾因 `postgres` 别名冲突导致约一半数据库连接打错库、间歇性 500）。
   → 收敛为单一 compose 栈（或统一网络命名 + 服务名前缀），CI 加「服务名唯一性」静态检查。

2. **端口与入口收敛**
   10 个对外端口、10 个入口 URL → 统一走单一反代前缀（`/files/`、`/tools/`…），nftables 白名单可缩到 2–3 个。

3. **数据层归并**
   3 个 PostgreSQL 实例 → bioinfo 库并入 `lab-postgres`（保留 pgvector）；SnapOtter 是否合并按负载再定。

4. **认证层收口为「Casdoor + 一个 SSO 网关」**
   现状 Casdoor 既是 IdP 又有自建账号库，bioinfo 另有一套 OIDC 账号体系。
   → 以 Casdoor 为唯一 IdP，统一由「SSO 入口服务」完成 issuer 解析 / redirect_uri 登记，删掉手工同步。

5. **入口与 issuer 的方向性缺陷**
   → 改用 Tailscale 子网路由（advertised routes）让两个网段互通，一次配置永久生效；或「每个入口绑定固定 issuer，客户端自选入口」。

6. **生信平台「非容器」路线成本复核**
   现状需 root 的 cgroup 操作通过窄权限 unix socket 助手完成，复杂度高。
   → 若不依赖精细 cgroup 委派，可评估迁入 Docker（`--cgroupns` + 容器内 `systemd-run`），省掉 helper 进程与 socket 协议。

7. **统一静态前端托管与缓存策略**
   现状门户 `dist`（no-cache/index + immutable/assets）、JBrowse/Linux 命令独立静态根、生信平台另一站点 → 统一 location 模板、缓存头、版本号注入。

8. **可观测性补齐**
   → 门户/生信 API 加 `/metrics`；nginx access log 结构化；关键链路（SSO 准备、FQ 断言签发、Office 转换）打 trace id 贯穿日志。

9. **构建与依赖统一**
   现状后端一处 uv/venv、一处 pip/requirements；容器与宿主 Python 版本不一致。
   → 统一 `pyproject.toml` + uv lock（容器内也用 uv）；前端统一 workspace + lockfile；CI 加 lockfile 一致性检查。

10. **备份覆盖面补齐**
    `lab-backup` 未覆盖**生信平台库与用户工作区**，也未备份 `/srv/lab`（实验室共享文件源）→ 纳入并做定期恢复演练。

11. **代码组织收敛**
    门户后端 18 个模块堆在单包 `app/`，`main.py` 承担过多职责；生信平台已用 `routers/` 拆分。
    → 门户后端照搬生信平台的 `routers/` 分层（auth/catalog/sso/workbench/agent/search/…），并把 `db_apis.py`（32 适配器）按数据源家族拆分，避免单文件超千行继续膨胀。

12. **测试资产治理**
    门户 e2e 有 50+ 脚本但存在调试残留（`_*_probe*`、`_dbg*`）；且 `sso-flow` / `embed-test` / `ip-adaptive` 之间存在**状态污染**（改 issuer 后未复原）。
    → 引入测试夹具统一复原全局状态（issuer、网络命名空间、DB 行数），CI 串行隔离执行；清理探针脚本。

---

## 12. 已知风险与遗留

| 项 | 影响 | 现状 |
|---|---|---|
| Windows Server 模型 API `100.64.0.10:7997` 不可达 | Embedding/Reranker/知识库向量化无法验证 | 巡检唯一警告 |
| 外部图纸平台 `192.0.2.29:5244` 端口关闭 | 目录中该服务不可用 | 标 `external-down`，非本机故障 |
| 客户端默认 DNS `192.0.2.1` 不解析 `*.lab.internal` | 域名访问不可用 | 已下线域名，IP 访问不受影响 |
| LAN/Tailscale 同时在线时 issuer 互翻 | 跨入口登录可能跳错主机 | 见优化建议 5 |
| 生信平台未纳入备份 | 数据丢失风险 | 见优化建议 10 |
| 门户原生网盘共享源为组级粗粒度 ACL | 学生对共享源只读，粒度到源而非到文件 | 需要更细粒度时由 `labfiles` ACL 扩展 |
| 门户后端单包结构 | 继续膨胀将难维护 | 见优化建议 11 |

---

## 13. 附录：路径速查

```
门户前后端      /opt/labspace/{frontend,backend,deploy}
门户 Nginx 源   /opt/labspace/deploy/nginx/labspace.conf → /etc/nginx/sites-available/labspace.conf（软链）
Agent 网关      /opt/labspace/agent/{gateway.mjs,extensions/lab-portal.js}
OIDC 同步器     已下线服务的历史 issuer 同步器 /opt/labspace/ops/oidc-sync.py（已停用）
生信平台        /opt/bioinfo-training/{frontend,backend,deploy,docs,e2e}
生信 Nginx      /etc/nginx/sites-available/bioinfo.conf
FQ              已下线：/opt/lab-quantum（容器、镜像与 lab-quantum_default 网络已于 2026-11-04 清理）
Open WebUI      已下线：/opt/lab-core-stack（同上，:3000 入口与容器均已清理）
生信平台 env    /etc/bioinfo-training/platform.env(0600)             资源档 /etc/bioinfo-training/resource-profiles.json
Casdoor 用户表  /etc/labspace/casdoor-users.txt(0600)
数据库          lab-postgres 容器（casdoor/labspace）；bioinfo 宿主 5433
数据盘          /srv/labdata（jbrowse / bioinfo-training / 备份）
实验室文件源    /srv/lab/{public,plasmids,genomes,users}（Go 核心 labfiles 索引根）
e2e             /opt/labspace/e2e（50+ Playwright 脚本）
```
