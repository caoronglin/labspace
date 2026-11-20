# D509 工作台（LabSpace 实验室一体化门户）

React 19 + TypeScript + Vite + Ant Design 6 的内网统一门户，聚合实验室的 AI、文件、科研绘图、文献与科研数据库，
以 Casdoor 作为唯一身份源。**全部入口使用 `192.0.2.10 + 端口`，不依赖任何域名或 DNS。**

| 文档 | 内容 |
| --- | --- |
| [USER_GUIDE.md](docs/USER_GUIDE.md) | **面向实验室成员的使用说明**：每天怎么用、文件/组会/种子/PDF/邮件/联动 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 拓扑、网络、端口、身份流、数据流、防火墙 |
| [DEPLOY.md](DEPLOY.md) | 从零部署步骤与命令 |
| [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | 设计令牌、组件规范、主题 |
| [SERVICE_INTEGRATION.md](SERVICE_INTEGRATION.md) | 各第三方服务的集成方式与限制 |
| [SECURITY.md](SECURITY.md) | 威胁面、鉴权边界、已知风险 |
| [TEST.md](TEST.md) | 实际执行的验证与结果 |
| [ROLLBACK.md](ROLLBACK.md) | 回滚路径 |
| [CHANGELOG.md](CHANGELOG.md) | 变更记录 |
| [IMAGES_LOCK.md](IMAGES_LOCK.md) | 镜像与 digest |

## 入口（IP + 端口）

| 服务 | 地址 |
| --- | --- |
| 门户 D509 工作台 | http://192.0.2.10/ |
| 统一认证 Casdoor | http://192.0.2.10:8090/ |
| 文件存储（门户原生网盘） | http://192.0.2.10/files |
| 文件工坊 SnapOtter | http://192.0.2.10:8092/ |
| draw.io | http://192.0.2.10:8082/ |
| Linux 命令速查 | http://192.0.2.10:8086/ |
| JBrowse 2 基因组浏览器 | http://192.0.2.10:8091/ |
| 图纸平台 | http://192.0.2.10:8093/ |
| 生信实训平台 | http://192.0.2.10:8102/ |
| Baserow 数据表 | http://192.0.2.10:8094/ |
| 引物设计 Primer3 | http://192.0.2.10:8097/ |
| PDF 工具箱（门户自绘） | http://192.0.2.10/pdf |
| 邮件（只收不发） | http://192.0.2.10/mail/ |

> **Open WebUI（:3000）与 Quantum（:8080）已下线**：容器、镜像与 `lab-quantum_default` 网络均已清理，
> 门户服务目录（Go 核心唯一权威源）也不再收录这两个条目；文件相关能力由门户原生网盘 `/files`
> 与文件工坊 SnapOtter（:8092）承担。

> **端口对照**（与 `docker ps` 实际映射一致）：
> 门户 `:80`（宿主机 nginx）；draw.io `:8082`（`lab-drawio` 容器直出）、SnapOtter `:8092`（`lab-snapotter` 容器直出）；
> Casdoor `:8090`（宿主机 nginx → `lab-casdoor` 127.0.0.1:8000）；
> Linux 命令 `:8086`、JBrowse `:8091`、图纸平台 `:8093`、生信实训 `:8102`（宿主机 nginx）；
> Baserow `:8094`（宿主机 nginx → `lab-baserow` 127.0.0.1:8096，容器端口仅回环）；
> SearXNG 容器仅监听回环 127.0.0.1:8081，对外统一走门户 `/search`。

Tailscale 入口为 `http://198.51.100.71/`（同端口）。访问控制由独立 nftables 表 `labfilter` 承担：**normal 档**（默认）LAN 只放行对外入口端口，文件核心/后端/备份等内部服务只走 Tailscale；**strict 档** LAN 只留 DNS，全部访问强制走 Tailscale。切换：`ops/lab-firewall-mode.sh normal|strict|confirm|status`。

> **入口自适应**：从哪个入口进入，门户内所有服务地址就用同一个主机。
> 内网客户端访问 `192.0.2.10` 时其它服务也是 `192.0.2.10`；
> 通过 Tailscale 访问 `198.51.100.71` 时其它服务自动换成 `198.51.100.71`。
> 门户地址、Casdoor issuer、服务目录、前端外链均已适配；
> 门户内页面（文件存储 / 文件工坊 / 公共基因组 / 生信实训）与静态站链接同样跟随当前入口。

## 快速开始

```bash
# 入口
open http://192.0.2.10/

# 常用命令
labctl status          # 既有栈状态
labctl health          # 全部组件探活
cd /opt/labspace/deploy && docker compose ps   # 门户自身栈
cd /opt/labspace/go-core && go test ./...      # Go 核心单测
systemctl status labgo                        # Go 核心状态
cd /opt/labspace/e2e && node e2e.mjs           # 浏览器端到端验收（需 LAB_PASS）
```

## 账号

| 账号 | 角色 | 说明 |
| --- | --- | --- |
| `admin01` | `lab-superadmin` + `lab-admin` + `lab-student` | 系统管理员（平台运维），**不是教师**；需要教师视图要另加 `lab-teacher` |
| `teacher01` | `lab-admin` + `lab-teacher` + `lab-superadmin` | 平台管理员 + 教师 |
| 其他成员 | `lab-student` / `lab-phd` / `lab-master` … | 由管理员在 `/admin/users` 创建与维护 |

> 新账号初始口令由管理员在账号管理里生成并**一次性展示**；首次登录强制修改。
> 登录标识 = 邮箱（Casdoor 按 email 查用户）；Casdoor 是唯一身份源，门户与生信实训共用同一套账号。
> 口令清单 `/etc/labspace/casdoor-users.txt` 权限 0600，仅 root 可读，**不入库**。
> ⚠ 账号 email 变更后必须同步两处：Casdoor `user` 表、`/etc/labspace/casdoor-users.txt`。

## 目录

```
labspace/
├── frontend/            React 19 + TS + Vite + Ant Design 6
│   └── src/{app,components,pages,routes,services,theme}
├── backend/             FastAPI（OIDC 会话 / 收藏 / 受控绘图保存 / 统一语料 / 数据库 API
│   │                    / 个人工作台 / Agent 中继 / 翻译 / 文档解析 / 天气）
│   └── app/{config,security,casdoor,catalog,corpus,databases,db_apis,snapotter,
│            workbench,agent,mt,docparse,weather,http,db,golink,main}.py
├── go-core/             Go 核心（LabGo，纯标准库、零外部依赖）
│   ├── cmd/labgo        服务入口（:8122）
│   └── internal/{session,labfiles,health,embed,catalog,endpoints,platform,
│                  guard,policy,registry,preview,search,knowledge,vault,blast,downloads,imagegen}
│                        会话/CSRF 校验、实验室文件目录索引与授权、服务探活、
│                        内嵌探测、服务注册表（唯一权威源）、容器地址映射
├── agent/               助手技能（pi 网关已于 2026-11-10 下线，助手改由 AgentScope 提供）
│   └── skills/          技能内容：deep-research / literature-search / plant-database-search / research-workflow
├── deploy/
│   ├── compose.yaml     backend + latex-compile + casdoor + drawio + pdf2zh + baserow
│   ├── .env             真实凭据（0600，不入库）
│   └── nginx/labspace.conf
├── e2e/                 Playwright 验收脚本与截图
├── docs/                本目录
└── README.md
```

## 现状一览

- 门户：面向实验室成员的原生工作台，OIDC 登录、收藏/最近访问、深浅色主题、移动端适配；服务目录以 Go 核心为准。
- 统一语料：command 621 / SnapOtter 工具 243 / 数据库 107 / 页面 15 / 服务 13 / 浏览器工具 12，
  命令面板与全局搜索共用（按类型限额，避免单一类型刷屏）。
- 生物数据库目录：**107 条真实资源、13 个分类**，其中 **32 个**已接入真实 API（服务端代理 + 归一化结果，
  页面内可直接检索）；未接入的条目逐条写明原因。
- 身份：Casdoor（内网 :8090）为唯一身份源，门户与生信实训使用 OIDC 客户端（labspace / bioinfo-training）+ 本地口令兜底。
- 平台内嵌：draw.io / Linux Command / JBrowse 支持 iframe 内嵌（图纸平台为外链），服务端按 `X-Frame-Options` 与 CSP `frame-ancestors` 判定，不允许时回退「新窗口打开」。
- 个人工作台 `/workbench`：一句话捕获 → 自动分类（任务/项目/计划/想法/知识/记忆/笔记）→ 人工确认 → 落库。
- Agent 助手 `/agent`：底层 **AgentScope 2.0.11**（独立容器，与门户共享 Postgres），12 个 `lab_*` MCP 工具；
  支持知识库 RAG 检索（回答带来源）、工作台捕获、绘图与脚本沙箱；首次进入有 antd Tour 互动引导。
- 文本论文翻译 `/translation`（Hy-MT2，模型未部署时自动回退本机引擎并标注来源）、文档解析 `/docparse`
  （OXR-1.0，内网 Docling 兜底）、天气 `/weather`（Open-Meteo）。
- 单点登录：门户与生信实训平台共用 Casdoor 账号免密进入；JBrowse / draw.io / Linux 命令为静态站，SnapOtter 走门户原生界面，均无需单独登录。
- 既有服务保留：SearXNG、Tika、Docling、科研 API/MCP、Open Terminal、oikb；Open WebUI 与 Quantum 已下线（见入口表）。
- 未新增第二套认证系统、文件系统或容器编排平台。

## 一键回归

```bash
cd /opt/labspace/e2e && ./run-regression.sh          # 全部 13 个脚本
cd /opt/labspace/e2e && ./run-regression.sh e2e.mjs   # 只跑指定脚本
```
