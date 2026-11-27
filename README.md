# D509 工作台（LabSpace 实验室一体化门户）

> **关于本文档中的地址与账号**：为了能公开分享，仓库里的内网地址统一写成
> 文档保留段（RFC 5737：`192.0.2.0/24`、`198.51.100.0/24`），账号写成
> `teacher01` / `admin01` / `student01…` 这类示例名，域名用 `example.local`。
> 它们**不是**任何真实部署的值：真实地址、账号与口令只在部署机的 `deploy/.env`
> （0600，不入库）与环境变量里。照着本文档部署时，把这些示例值替换成你自己的。


React 19 + TypeScript + Vite + Ant Design 6 的内网统一门户，聚合实验室的 AI、文件、科研绘图、文献与科研数据库，
使用门户自有统一认证（账号口令 + OIDC Provider）。**Casdoor 已下线**，应用优先通过 Nginx 同源路径访问，不依赖任何域名或 DNS。

> **文档只有一个真源：`docs/`。** 根目录只保留本 README，其他文档一律在
> `docs/` 下（历史上根目录还有一份同名副本，两份会各自漂移，已经删掉）。

| 文档 | 内容 |
| --- | --- |
| [USER_GUIDE.md](docs/USER_GUIDE.md) | **面向实验室成员的使用说明**：每天怎么用、文件/组会/种子/PDF/邮件/联动 |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 拓扑、网络、端口、身份流、数据流、防火墙 |
| [DEPLOY.md](docs/DEPLOY.md) | 从零部署步骤与命令 |
| [DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) | 设计令牌、组件规范、主题 |
| [SERVICE_INTEGRATION.md](docs/SERVICE_INTEGRATION.md) | 各第三方服务的集成方式与限制 |
| [SECURITY.md](docs/SECURITY.md) | 威胁面、鉴权边界、已知风险 |
| [TEST.md](docs/TEST.md) | 实际执行的验证与结果 |
| [ROLLBACK.md](docs/ROLLBACK.md) | 回滚路径 |
| [CHANGELOG.md](docs/CHANGELOG.md) | 变更记录 |
| [IMAGES_LOCK.md](docs/IMAGES_LOCK.md) | 镜像与 digest |
| [PHASE1_SECURITY_HARDENING.md](docs/PHASE1_SECURITY_HARDENING.md) | Phase 1 安全止血的验收证据 |
| [PHASE2_ACCEPTANCE.md](docs/PHASE2_ACCEPTANCE.md) | Phase 2 验收记录（门禁结果与目标对照） |
| [PHASE2_STATUS.md](docs/PHASE2_STATUS.md) | Phase 2 中间踩坑记录（历史） |

文档内的相对链接可用 `ops/check-docs-links.py` 校验（CI 与本地都能跑）。

## 入口（门户同源路径优先）

| 服务 | 地址 |
| --- | --- |
| 门户 D509 工作台 | http://192.0.2.10/ |
| 登录 / 登出 | http://192.0.2.10/login |
| 文件空间（门户原生网盘） | http://192.0.2.10/files |
| SSH/SFTP 工作台 | http://192.0.2.10/ssh |
| 文件工坊 SnapOtter | http://192.0.2.10/snapotter |
| draw.io | http://192.0.2.10/apps/drawio/ |
| Linux 命令速查 | http://192.0.2.10/apps/commands/ |
| JBrowse 2 基因组浏览器 | http://192.0.2.10/jbrowse/index.html?config=data/demo/config.zh.json |
| 生信实训平台 | http://192.0.2.10/apps/bioinfo/ |
| 引物设计 Primer3 | http://192.0.2.10/apps/primer/ |
| PDF 工具箱（门户自绘） | http://192.0.2.10/pdf |
| 邮件（只收不发） | http://192.0.2.10/mail/ |

> **Open WebUI（:3000）与 Quantum（:8080）已下线**：容器、镜像与 `lab-quantum_default` 网络均已清理，
> 门户服务目录（Go 核心唯一权威源）也不再收录这两个条目；文件相关能力由门户原生网盘 `/files`
> 与文件工坊 SnapOtter（:8092）承担。

> **端口对照**（与 `docker ps` 实际映射一致）：
> 门户 `:80`（宿主机 nginx）；draw.io `:8082`（`lab-drawio` 容器直出）、SnapOtter `:8092`（`lab-snapotter` 容器直出）；
> Linux 命令、JBrowse、生信实训与 Primer3 的正式入口均走门户同源路径；旧直连端口只保留回环或已关闭；
> Baserow `:8094`（宿主机 nginx → `lab-baserow` 127.0.0.1:8096，容器端口仅回环）；
> SearXNG 容器仅监听回环 127.0.0.1:8081，对外统一走门户 `/search`。

Tailscale 入口为 `http://198.51.100.71/`（同端口）。访问控制由独立 nftables 表 `labfilter` 承担：**normal 档**（默认）LAN 只放行对外入口端口，文件核心/后端/备份等内部服务只走 Tailscale；**strict 档** LAN 只留 DNS，全部访问强制走 Tailscale。切换：`ops/lab-firewall-mode.sh normal|strict|confirm|status`。

> **入口自适应**：从哪个入口进入，门户内所有服务地址就用同一个主机。
> 内网客户端访问 `192.0.2.10` 时其它服务也是 `192.0.2.10`；
> 通过 Tailscale 访问 `198.51.100.71` 时其它服务自动换成 `198.51.100.71`。
> 门户地址、OIDC issuer、服务目录、前端外链均已适配；
> 门户内页面（文件空间 / 文件工坊 / 生信工具 / 公共基因组 / 生信实训）与静态站链接同样跟随当前入口。

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
> 登录标识 = 账号名；门户自有认证是唯一身份源，门户、生信实训与 Primer3 共用同一套账号。
> 口令清单 `/etc/labspace/casdoor-users.txt` 权限 0600，仅 root 可读，**不入库**。
> 账号数据沿用原 Casdoor PostgreSQL 库（容器已下线、数据保留）；口令为 bcrypt 哈希，不以明文入库。

## 目录

```
labspace/
├── frontend/            React 19 + TS + Vite + Ant Design 6
│   └── src/{app,components,pages,routes,services,theme}
├── backend/             FastAPI（OIDC 会话 / 收藏 / 受控绘图保存 / 统一语料 / 数据库 API
│   │                    / 个人工作台 / Agent 中继 / 翻译 / 天气）
│   └── app/{config,security,accounts,catalog,corpus,databases,db_apis,snapotter,
│            workbench,agent,mt,text_extract,biotools,weather,http,db,golink,main}.py
├── go-core/             Go 核心（LabGo，纯标准库、零外部依赖）
│   ├── cmd/labgo        服务入口（:8122）
│   └── internal/{session,labfiles,health,embed,catalog,endpoints,platform,
│                  guard,policy,registry,preview,search,knowledge,vault,blast,downloads,imagegen}
│                        会话/CSRF 校验、实验室文件目录索引与授权、服务探活、
│                        内嵌探测、服务注册表（唯一权威源）、容器地址映射
├── agent/               助手技能（pi 网关已于 2026-11-10 下线，助手改由 AgentScope 提供）
│   └── skills/          技能内容：deep-research / literature-search / plant-database-search / research-workflow
├── deploy/
│   ├── compose.yaml     backend + ssh-gateway + latex-compile + drawio + pdf2zh + baserow
│   ├── .env             真实凭据（0600，不入库）
│   ├── ssh-gateway/     自研 FastAPI + AsyncSSH 网关（连接/指纹/会话/SFTP/审计）
│   └── nginx/labspace.conf
├── e2e/                 Playwright 验收脚本与截图
├── docs/                本目录
└── README.md
```

## 现状一览

- 门户：面向实验室成员的原生工作台，OIDC 登录、收藏/最近访问、深浅色主题、移动端适配；服务目录以 Go 核心为准。
- 统一语料：command 621 / SnapOtter 工具 243 / 数据库 107 / 页面 15 / 服务 14 / 浏览器工具 12，
  命令面板与全局搜索共用（按类型限额，避免单一类型刷屏）。
- 生物数据库目录：**107 条真实资源、13 个分类**，其中 **32 个**已接入真实 API（服务端代理 + 归一化结果，
  页面内可直接检索）；未接入的条目逐条写明原因。
- 身份：门户自有认证（账号口令 + OIDC Provider）；Casdoor 容器与 :8090 已下线，生信与 Primer3 通过门户 OIDC 单点登录。
- 平台内嵌：draw.io / Linux Command / JBrowse 支持 iframe 内嵌（图纸平台为外链），服务端按 `X-Frame-Options` 与 CSP `frame-ancestors` 判定，不允许时回退「新窗口打开」。
- 个人工作台 `/workbench`：一句话捕获 → 自动分类（任务/项目/计划/想法/知识/记忆/笔记）→ 人工确认 → 落库。
- Agent 助手 `/agent`：底层 **AgentScope 2.0.12**（独立容器，与门户共享 Postgres），12 个 `lab_*` MCP 工具；
  支持知识库 RAG 检索（回答带来源）、工作台捕获、绘图与脚本沙箱；首次进入有 antd Tour 互动引导。
- 文本论文翻译 `/translation`（Hy-MT2，模型未部署时自动回退本机引擎并标注来源）
  - `/docparse`（文档解析页）已下架：它只是一层「上传 PDF 看 Markdown」的壳，
    同样的能力现在由**知识库入库**在用（PDF/图片 → Markdown 走 Docling/MinerU，见 `backend/app/text_extract.py`）。
  - **生信工具 `/bio-tools`**（Biopython 1.88 + scikit-bio 0.7.4 + dna-features-viewer）：
    序列分析 / CDS 提取 / 酶切 / ORF / 蛋白参数 / 引物 Tm 与稀释 / 格式互转 / 双序列与多序列比对 /
    NJ 树 / GC 滑窗与 k-mer / 单三字母与专利排版 / 去载体 / `.ab1` / 批量筛选 / 质粒图谱 / PCoA，
    以及 Entrez / BLAST（无外网时 3 秒内明确报错）。原来的 CropGenome（rust-bio）已下架，
    原因与回滚见 [`docs/RETIRE-CROPGENOME.md`](docs/RETIRE-CROPGENOME.md)。
  （OXR-1.0，内网 Docling 兜底）、天气 `/weather`（Open-Meteo）。
- SSH/SFTP 工作台 `/ssh`：自研 FastAPI + AsyncSSH 网关，连接内网真实 SSH 服务器；
  支持 xterm 终端、SFTP 文件目录、加密凭据、首次主机指纹确认、按门户账号隔离与操作审计。
- 单点登录：门户与生信实训平台共用统一认证账号免密进入；JBrowse / draw.io / Linux 命令为静态站，SnapOtter 走门户原生界面，均无需单独登录。
- 既有服务保留：SearXNG、Tika、Docling、科研 API/MCP、Open Terminal、oikb；Open WebUI 与 Quantum 已下线（见入口表）。
- 未新增第二套账号库或文件系统；原账号数据库保留，认证运行时已收口到门户自身。

## 一键回归

```bash
cd /opt/labspace/e2e && ./run-regression.sh          # 全套浏览器与接口回归
cd /opt/labspace/e2e && ./run-regression.sh e2e.mjs   # 只跑指定脚本
```
