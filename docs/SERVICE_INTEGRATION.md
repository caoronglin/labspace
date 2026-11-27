# SERVICE_INTEGRATION.md — 各服务集成方式与限制

集成原则：**能自绘的用门户原生 Ant Design 页面**（Baserow 多维表格、PDF 工具箱、邮件列表、SSH/SFTP 工作台）；不能自绘的走链接或受控 iframe，并统一由 nginx 做门户会话鉴权。旧第三方 WebSSH 已下架，现由自研 SSH 网关承担。

| 服务 | 集成方式 | 入口 | 验证 |
| --- | --- | --- | --- |
| 文件管理（门户原生网盘） | 门户内原生页面（Go 核心 `labfiles` 索引 + 按用户 ACL 授权） | 门户 `/files` | ✅ Go 核心实现，含单元测试 |
| Agent 助手 | 门户内 IM 页 → AgentScope 2.0.12（独立容器） | 门户 `/agent` | ✅ SSE 流式回复、12 个 `lab_*` MCP 工具、知识库 RAG、会话落库 |
| SSH/SFTP 工作台 | 门户原生页面 → 同源 `/ssh-api/` → 自研 FastAPI + AsyncSSH 网关 | 门户 `/ssh` | ✅ 连接加密保存、首次主机指纹确认、真实终端回显、SFTP 目录操作、跨账号隔离与公网目标拒绝 |
| 生信实训平台 | 门户 `/bioinfo` → 同源 iframe → 生信 OIDC 自动 SSO | 门户 `/bioinfo` | ✅ 门户会话自动登录，课程、实验、提交与批阅闭环 |
| draw.io | 独立页面 + 门户受控保存/导出 | `http://192.0.2.10/draw/` | ✅ 绘图页可打开、可另存 XML 到个人目录 |
| Linux Command | 官方仓库静态构建，Nginx 直接托管 | `http://192.0.2.10:8086/` | ✅ 页面加载，标题“Linux命令搜索引擎” |
| IT-Tools | 官方镜像，独立页面 | `http://192.0.2.10:8084/` | ✅ 页面加载，标题“IT Tools - Handy online tools” |
| 科研文献搜索 | 门户内页面 → 后端代理科研 API | 门户 `/literature` | ✅ PubMed / Europe PMC / Crossref / UniProt / NCBI Gene |
| 统一搜索 | 门户内页面 → 后端代理 SearXNG | 门户 `/search` | ✅ 中文/学术/视频分类切换 |
| 文档解析 | 门户内页面 → OXR-1.0（Docling 回退） | 门户 `/docparse` | ✅ OXR 官方免费实例可用，PDF 真实解析出 Markdown |
| 个人工作台 | 门户内原生页面（AntD） | 门户 `/workbench` | ✅ 捕获→分类→确认写入、计划与方向、简报 |
| 论文翻译（文本） | 门户内页面 → Hy-MT2（本地引擎回退） | 门户 `/translation` | ✅ Hy-MT2 未部署时自动回退到本地引擎并标注来源 |
| 天气预测 | 门户内页面 → Open-Meteo | 门户 `/weather` | ✅ 实时天气 + 5~7 日预报 |
| 数据库速查 + API | 门户内页面 → 32 个真实适配器 | 门户 `/databases` | ✅ 107 个资源、32 个适配器实测返回真实结果 |
| PDF 论文翻译（整篇 PDF） | 门户内页面 → PDFMathTranslate 工作进程 | 门户 `/translate` | ✅ 队列 + 双语/纯译产物 |
| 引物设计 Primer3 | Apptainer 承载 FastAPI，nginx 反向代理 + 门户会话鉴权 | 门户 `/genomes` 服务目录 → `:8097` | ✅ 13 条路由全通过、FASTA 索引与批量设计实测 |
| PDF 工具箱 | 门户 **antd 自绘** → 同源 `/pdf-api/` → Stirling PDF 3.3 | 门户 `/pdf` | ✅ 合并/拆分/压缩/密码等 14 项实测，文件不出内网 |
| 邮件（只收不发） | Mailbox 0.7.5（容器内加密凭据），门户自绘前端 + 同源 `/mail/` 代理 | 门户 `/mail/` | ✅ 服务 healthy、`/mail/health` 200；具体邮箱账号待配置 |
| 组员共享与课题资料 | 门户原生页面 + Go 核心 ACL | 门户 `/shared`、`/research`、`/meetings` | ✅ 仅教师可见课题资料；逐周授权、沿用上周、48h 删除窗回归通过 |

## SSH/SFTP 工作台（自研网关）

- 入口：门户 `/ssh`；后端路径：同源 `/ssh-api/`；容器：`lab-ssh-gateway`，仅绑定 `127.0.0.1:8118`。
- 身份：Nginx 先调用门户 `/api/auth/check`，再覆盖注入 `X-User-ID`；SSH 网关不提供第二套登录。
- 隔离：连接、主机密钥、活动会话与审计都按门户 `user_id` 过滤；远端文件权限仍由目标 SSH 账号决定。
- 凭据：SSH 口令/私钥用 Fernet 加密后写入 `ssh_gateway.connections`，API 永不返回明文或密文。
- 目标：默认只允许私网、回环和 Tailscale CGNAT；域名先解析并校验全部地址，再固定到已校验 IP 连接，防 DNS 重绑定。
- 主机密钥：首次连接必须人工确认 SHA256 指纹；后续严格校验，指纹变化直接拒绝。
- 配额：默认单人 2 个会话、全局 8 个会话、每人每分钟 6 次连接/指纹探测，空闲 30 分钟回收。
- 文件：SFTP 列目录、文本预览、上传、下载、新建目录、重命名、删除；上传先写临时文件，成功后原子改名。
- 审计：连接保存/删除、指纹确认、会话启停、终端挂接和文件操作均记录到 `ssh_gateway.audit`。
- 旧第三方 WebSSH 的 socket.io 协议与独立账号体系不再使用；当前终端协议为原生 WebSocket JSON。

## draw.io 的集成（与官方建议的差异及原因）

- 官方建议 Embed Mode（iframe + postMessage）。实测本机部署的 `jgraph/drawio:latest`
  （Tomcat 版）**不包含 embed 应用**（镜像内 `/usr/local/tomcat/webapps/draw/` 无 embed 目录，
  `/embed/index.html` 返回 404），主应用也不会触发 postMessage 握手（无 `init` 事件）。
- 按任务要求「嵌入失败时优先采用独立内部页面，而不是修改第三方源码移除安全限制」，
  门户改为：独立页面编辑 → 回到门户「导入 XML」保存到“我的图形”或导出到个人目录。
- 已验证链路：模板生成 XML → 保存 → `labspace.drawings` 落库 → 导出 →
  `/srv/lab/users/student01/drawio/rnaseq.drawio`（门户网盘可见，0640 + ACL）。
- 内容校验：仅接受含 `<mxfile` / `<mxGraphModel` 的内容，拒绝 `<!DOCTYPE`、`<!ENTITY`、`<script>`、
  `javascript:`；单文件上限 2MB；文件名白名单化；写入路径限定在 `<users_root>/<username>/drawio/`。
- 若后续更换带 embed 应用的镜像，门户端的 iframe + postMessage 实现已保留在 git 历史中，可直接切回。

## Open WebUI / Quantum（已下线，2026-11-04 清理）

- 二者曾分别承担 AI 聊天（Open WebUI，:3000）与文件管理（FileBrowser Quantum，:8080），
  2026-11-04 已连同容器、镜像与 `lab-quantum_default` 网络一并清理，服务目录（Go 核心 `catalog.go`）不再收录。
- 沿革：当时两者均已接入内网 Casdoor（OIDC 客户端 `openwebui` / `quantum`），但 issuer 与回调是**静态配置**，
  需在用户点「一键登录」时按入口主机改配置并重建容器；该机制随服务下线已失效。
- 替代能力：文件 → 门户原生网盘 `/files` 与文件工坊 SnapOtter（:8092）；聊天 → 门户 Agent 助手 `/agent`。

## OIDC 入口自适应（跟随访问入口主机）

门户支持内网与 Tailscale 入口。LabGo OIDC Provider、服务目录地址与生信回调都跟随当前同源主机。

| 事实 | 说明 |
| --- | --- |
| 门户认证 | `/login` 本地账号口令 + bcrypt；会话为门户自签 JWT |
| OIDC issuer | LabGo 按白名单请求 Host 发布 `http(s)://<host>/oidc` |
| 未登录回跳 | 使用公开 `/oidc/authorize?...`，保留完整 PKCE 参数 |
| 生信回调 | `/apps/bioinfo/api/v1/auth/callback`，与当前入口同主机 |
| 原生页面 | `/files`、`/agent`、`/snapotter` 等按当前 Host 生成地址 |
| Casdoor | 容器与 8090 监听已下线；原账号库仅保留兼容数据 |

## Linux 命令库（门户内完整版）

- 数据源：linux-command 官方仓库 `src/dist/data.json`（621 条索引）与 `src/command/*.md`（完整 Markdown 文档）。
- 后端接口（均需登录）：
  - `GET /api/commands?q=&limit=` → 索引检索（名称 + 用途模糊匹配）
  - `GET /api/commands/{name}` → 单条命令完整 Markdown（最多 200KB）
- 前端 `/commands`：搜索框 + 按首字母分组的命令列表 + 右侧全文。
- 渲染方式：**不使用 `dangerouslySetInnerHTML`**，Markdown 由 `MarkdownView.tsx` 解析成 React 元素
  （标题/代码块/粗体/行内代码/列表/段落），天然免疫 XSS。
- 挂载方式：后端容器只读挂载 `data.json` 与 `command/` 两个独立目录（避免只读目录下再挂载）。
- 独立站点 `http://192.0.2.10/commands/` 保留，供交互式浏览；两者内容同源。
- **只读**：任何命令都不会被执行，页面仅展示官方文档。

## 浏览器主页（/start）

浏览器起始页，全屏独立布局（不套门户 Header/Sider）：

| 能力 | 实现 |
| --- | --- |
| 登录 | 复用门户会话：右上角显示头像/姓名与下拉（个人资料、退出登录），未登录显示「登录」按钮 |
| 换背景 | 5 套本地 CSS 渐变/纹理（实验蓝、松石绿、晨曦、网格、深空）+ 深浅色主题切换，选择持久化在 localStorage（`labspace.bg`），**不拉外链图片，离线可用** |
| 多元搜索 | 大搜索框 + 来源切换（全部=general,science,videos / 网页 / 学术 / 视频），走门户后端 `/api/search` → SearXNG 多引擎聚合；回车跳到结果页并带上 categories |
| 快捷入口 | 文件共享、文件工坊、知识库问答、绘图、Linux 命令、文献检索 |

入口：门户头部新增「浏览器主页」按钮，首页新增「浏览器主页」卡片；建议把
`http://192.0.2.10/start` 设为浏览器起始页。

## OIDC 登录的两条硬规则（踩过的坑）

### 规则 1：口令由门户账号库统一管理

门户 `/login` 直接校验账号库中的 bcrypt 哈希。新账号使用服务端随机一次性口令，首次登录强制修改；
管理员重置口令同样要求本人修改。登录成功/失败/锁定均写入审计，并按账号与可信来源 IP 联合限流。

### 规则 2：OIDC 回调必须与登录入口同主机

浏览器会话 Cookie 按主机隔离。LabGo OIDC Provider 按白名单 Host 发布 issuer，生信客户端按当前
入口生成 `/apps/bioinfo/api/v1/auth/callback`，避免 LAN/Tailscale 之间丢失会话。

登录回跳必须保留完整 `/oidc/authorize` 查询参数（尤其是 PKCE `code_challenge`），且不能把 Nginx
内部路径 `/v1/oidc/*` 返回给浏览器。

## JBrowse 2 基因组浏览器（/jbrowse/）

| 项 | 说明 |
| --- | --- |
| 版本 | v4.3.0 官方 web 包（`jbrowse-web-v4.3.0.zip`，GMOD/jbrowse-components release） |
| 部署方式 | 静态应用 + Nginx `alias` 托管，数据目录 `/srv/labdata/jbrowse/web/data`（教师可放自己的基因组） |
| 入口 | `http://192.0.2.10/jbrowse/index.html?config=data/demo/config.zh.json`（注意参数是 `config`，不是 `data`；`?data=` 是旧版写法，v4 会回落到 `/jbrowse/config.json` 报 JSON 解析错） |
| 内置示例 | 人类 hg19 断点/变异（BAM + VCF + chrom.sizes，5.5MB，**完全离线**），轨道名与组装名已中文化 |
| 教师投放数据 | 放到 `data/<数据集>/`，内含 `config.json`，用 `?config=data/<数据集>/config.json` 打开 |
| 语言 | 配置里 `"locale": "zh"`；JBrowse 2 的 web 包未内置中文语言包，**菜单仍为英文**（轨道/组装/说明已中文化） |
| 出网 | 该 web 包默认会上报 Google Analytics（离线环境请求失败即忽略）；如需彻底拦截可对 lab 网段拒绝 `www.google-analytics.com` |

## 植物与生物医学数据库速查（107 个资源、32 个真实 API）

把实验室常用的植物与生物医学数据库/资源/工具做成门户的一等能力，并尽量接入**真实公开 API**：

| 项 | 说明 |
| --- | --- |
| 数据 | `backend/app/databases.py`（107 条，含中文名、简介、分类、标签、官方链接） |
| 分类 | 13 类：通用 / 序列与蛋白 / 基因组与注释 / 转录组与ncRNA / 代谢与通路 / 表型与遗传 / 比较基因组 / 多组学与单细胞 / 工具与平台 / 医学与临床 / 微生物与病毒 / 组学与多组学 / 蛋白质与药物 |
| 接口 | `GET /api/databases?q=&category=`（需登录）；`GET /api/databases/apis`（适配器清单 + 探活状态）；`POST /api/databases/{id}/query`（真实检索）；`GET /api/databases/{id}/probe`（单库探活） |
| 门户页 | `/databases`：搜索框 + 分类 Segmented + 卡片网格 + 「站内查询」抽屉（真实调用 API 并归一化展示） |
| 首页常驻 | 「数据库速查」面板（默认展示常用资源） |
| **全局搜索并入** | 门户搜索框与「网页/学术搜索」会同时命中本地目录，命中项以「数据库」标签区分（engine=d509） |

### 已接入真实 API 的 32 个适配器（`backend/app/db_apis.py`）

| 方向 | 适配器 |
| --- | --- |
| 植物/通用 | ncbi、ncbi-sra、ncbi-blast、ena、uniprotkb、interpro、pfam、alphafold、kegg、expression-atlas、pdb、panther、plant-ontology、rnacentral |
| 生物医学新增 | chembl、pubchem、clinvar、opentargets、string-db、hpa、cellosaurus、encode、cbioportal、openfda、europepmc、chebi、taxonomy、hgnc、pride、enrichr、brain-atlas |

- 其余 75 个库逐条写明「没有可用公开 API」的原因（需订阅下载 / 需注册 key / 站点无检索接口 / 本机房不可达等），
  页面上以「仅网页访问」徽标 + Tooltip 说明，不伪造检索结果。
- 返回结构统一为 `{title, subtitle, url, source, fields:[{label,value}]}`，前端无需为每个库单独适配。
- 端点全部实测（`e2e/db-api-integration.mjs` 24/24、`e2e/biomed-api-test.mjs` 17/17）；
  慢接口单独放宽超时（ChEMBL 实测 25~30 秒 → 70 秒）。

覆盖范围：NCBI、NCBI SRA、NCBI BLAST、ENA、KEGG、KAAS、TAIR、UniProtKB、AlphaFold DB、SignalP、EggNOG-mapper、
PDB、InterPro、Pfam、PANTHER、Phytozome、Gramene、CoGe、GRIN、iTAK、PhytoPath、Ensembl Plants、
PLAZA、PlantGDB、MSU 水稻、SolGenomics、PASA、SoyBase、番茄基因组平台、PlantCyc、MetaCyc、BRENDA、
PRGdb（含 4.0 版）、PlantTFDB、植物小 RNA 库、miRBase、PMRD、Plant-ImputeDB、C-values、EBI、Plant Ontology、
植物 RNA-seq 文库平台、Expression Atlas、TreeGenes、Tropicos、Genesys、GDR、CottonGen、植物 MLST、SoySNP、
PlantcircBase、PlantRegMap、URGI、OryzaSNP、ChromLoops、植物代谢网络、PlantReactome、PlantDeepSEA、PmiREN、
PsctH、PCMDB、Cell BLAST、Plant Cell Atlas、MetaboLights、ChromStates、PlantGSEA、PNRD、PlantExp、BUSCO、GeneMANIA、
ChEMBL、PubChem、ClinVar、Open Targets、STRING、HPA、Cellosaurus、ENCODE、cBioPortal、openFDA、Europe PMC、
ChEBI、NCBI Taxonomy、HGNC、PRIDE、Enrichr、Brain Atlas。

## SnapOtter 文件工坊（原生 REST 重写，端口 8092）

| 项 | 说明 |
| --- | --- |
| 镜像 | `snapotter/snapotter:latest`（GHCR `ghcr.io/snapotter-hq/snapotter` 拉取更快，镜像 12.3GB） |
| 部署 | `/opt/lab-snapotter/compose.yaml`（compose name `lab-snapotter`）：app + postgres:17-alpine + redis:8-alpine |
| 入口 | `http://192.0.2.10:8092/`（官方界面），门户页 `/snapotter` |
| 数据 | `/srv/labdata/snapotter/{data,workspace,pgdata,redisdata}` |
| 容器网络 | `lab-tools`（external），门户后端按容器名 `lab-snapotter:1349` 直连，不经过宿主机端口 |
| 资源限制 | app 3g/3cpu/384 pid/shm 1g；pg 512m；redis 512m + `--maxmemory 384mb` |
| 鉴权 | `POST /api/auth/login` → 会话；`POST /api/v1/api-keys` → `si_` 前缀 API Key（`Authorization: Bearer si_...`） |
| 密钥存放 | `/etc/lab-snapotter/credentials`（0600）；门户后端用 `SNAPOTTER_API_KEY` 环境变量 |
| 工具目录 | **没有 `/api/v1/tools` 列表接口**；权威来源是 `/api/v1/openapi.yaml`（610KB），后端用 PyYAML 解析出 243 个 `POST /api/v1/tools/{section}/{toolId}` 工具，缓存 10 分钟 |
| 分区 | image(107) / video(57) / pdf(29) / audio(27) / files(23) |
| 门户代理 | `GET /api/snapotter/status`、`GET /api/snapotter/tools`、`POST /api/snapotter/run`、`GET /api/snapotter/jobs/{id}`、`GET /api/snapotter/pipelines`、`GET /api/snapotter/download?url=` |
| SSRF 防护 | 下载代理只允许 `/api/v1` 前缀与本机/容器名 host |
| 合并 PDF 注意事项 | 官方 `merge-pdf` 需要**至少两个文件**，门户当前单文件上传流程只适合单文件类工具 |

> **数据库角色坑**：镜像内**没有** `DATABASE_MIGRATION_URL` 的建角色逻辑（`grep -rl DATABASE_MIGRATION_URL /app` 无结果），
> 必须自建 `/srv/labdata/snapotter/initdb/10-app-role.sh` 在 Postgres 首启时 `CREATE ROLE snapotter_app` +
> `GRANT ALL PRIVILEGES ON DATABASE snapotter` + `ALTER SCHEMA public OWNER TO snapotter_app`。
> 手工执行 SQL 时 `docker exec` 必须加 `-i`，否则 heredoc 内容不会送进 psql。

## 统一语料（Unified Corpus）

门户内所有「可检索的东西」汇总成一份索引，首页 ⌘K 命令面板、全局搜索「本地资源」分组、搜索建议三处同源：

| 类型 | 条数 | 来源 |
| --- | --- | --- |
| command | 621 | Linux Command 官方索引 |
| database | 107 | `backend/app/databases.py` |
| page | 15 | 门户页面路由 |
| service | 13 | `backend/app/catalog.py` |
| tool | 12 | 浏览器本地工具（/devtools） |
| snapotter | 243 | SnapOtter OpenAPI 工具目录（中文别名见 `corpus._TOOL_ALIASES`） |

- 实现：`backend/app/corpus.py`；接口 `GET /api/corpus?q=&limit=`、`GET /api/search/suggest`。
- 搜索结果**按类型限额**（`corpus.TYPE_CAPS`：snapotter 4 / command 5 / database 10 / service 5 / tool 4 / page 4），
  避免 243 个文件工具或 621 条命令把结果洗掉。
- SnapOtter 工具通过 `?section=&tool=` 深链接直达（`/snapotter?section=pdf&tool=merge-pdf`）。
- 中文别名只覆盖常用能力（`corpus._TOOL_ALIASES`），例如「PDF 合并」→ `Merge PDFs`、「抠图」→ `Remove background`。

## 个人工作台（/workbench）

以「一句话输入 → AI 分类 → 人工确认 → 落库」为核心的个人工作台，设计参考开源项目
`Qiang-Z/personal-workbench`（其首页为单输入框 + 提案确认卡 + 计划与方向 + 健康状态条）。

| 项 | 说明 |
| --- | --- |
| 实现 | 后端 `backend/app/workbench.py`（router `/api/workbench`），前端 `frontend/src/pages/Workbench.tsx` |
| 接口 | `GET /summary`、`GET/POST /items`、`PATCH/DELETE /items/{id}`、`GET/POST /projects`、`GET/POST /plans`、`GET /briefs`、`POST /capture` |
| 捕获分类 | `POST /api/workbench/capture` 本地规则分类：task / project / plan / idea / knowledge / memory / note；同时抽取 due_date / tags / priority |
| 确认流 | 捕获结果先进待确认卡片（显示分类、理由、置信度、抽取字段），「确认写入」才正式入库，「重新编辑」回填输入框 |
| 落库 | `workbench_items` / `workbench_projects` / `workbench_plans` / `workbench_briefs` 四张表（schema `labspace`） |
| 权限 | 所有读写按 session 里的用户 id 隔离；后端不信任前端传入的任何 user id |

## Agent 助手（/agent，AgentScope 2.0.12）

门户里的 IM 形态助手，底层是 **AgentScope 2.0.12 Agent Service**（容器 `lab-agentscope`）。
门户负责账号、模型白名单、配额与审计，AgentScope 负责会话、工具装配、知识库、长期记忆与工作区。

| 项 | 说明 |
| --- | --- |
| 服务 | `deploy/agentscope/app.py`，容器 `lab-agentscope`，仅回环 `127.0.0.1:8103` 暴露给 Nginx |
| 存储 | PostgreSQL 库 `agentscope` + Qdrant 向量库；长期记忆落在每用户 AgentScope 工作区 |
| 工具 | `lab_mcp_server.py` 以进程内 MCP server 接入门户业务工具；身份由 Nginx 核验后的 `X-User-ID` 断言签名，模型不能伪造 |
| 后端 | `backend/app/agent.py` 会话 CRUD、消息落库、SSE 中继、配额与管理员配置；`agentscope_adapter.py` 将 AgentScope 事件翻译为 `ready/delta/tool/done/error` |
| 接口 | `/api/agent/status`、`/models`、`/sessions`、`/sessions/{id}/messages`、`/abort`、`/stream`、`/hitl`、`/quota`、`/admin/config`、`/admin/usage` |
| HITL | 工具确认与 AskUser 经服务端重建事件后回传；前端只展示服务端问题，不自行批准任意工具 |
| 前端 | `pages/Agent.tsx` 只做模式编排；`pages/agent/` 下拆分流式 Hook、Ant Design X 消息/会话/输入区、HITL 与知识记忆面板 |
| 全站入口 | 顶栏与移动端菜单「让 Agent 分析当前页」通过结构化一次性交接带入来源、路径与选中文本 |
| 权限 | 普通用户只能访问自己的资源；教师/管理员可跨用户只读助手与知识库，凭据永不共享；上游失败按无权限处理 |

> AgentScope 原始流与门户翻译流路径不同：`/api/agent/as/sessions/{id}/stream`、
> `/api/agent/agentscope/sessions/{id}/stream`、`/api/agent/sessions/{id}/stream`。
> 门户 UI 只依赖统一后的五类 SSE 事件，不直接依赖上游私有事件形状。

## 文本论文翻译（/translation，Hy-MT2）

| 项 | 说明 |
| --- | --- |
| 目标模型 | Tencent-Hunyuan/Hy-MT2-1.8B（GGUF），官方提示模板「将以下文本翻译为 {目标语言}，注意只需要输出翻译后的结果，不要额外解释：」 |
| 部署位置 | 计划部署在 Windows 宿主机 `100.64.0.10:8000`（OpenAI 兼容 `/v1`），由 `LABSPACE_MT_BASE_URL` 指定 |
| 现状 | **该宿主机当前完全不可达**（7997/8000/22/3389/5000 全 closed），`GET /api/translate/status` 返回 `available=false reason=模型服务不可达：ConnectTimeout` |
| 回退 | 自动回退到**本机 pi 网关模型**（minimax-cn/MiniMax-M3.1-Flash），响应带 `provider=本地引擎（pi 网关）`、`fallback_used=true`、`fallback_reason` |
| 接口 | `GET /api/translate/status`（含 `fallback` 与 `effective_available`）、`POST /api/translate/text?text=&target_lang=&style=&terminology=` |
| 实测 | 英文→英文原句回译验证通过（28.3 秒，provider 标注为本地引擎） |

> 与 `/translate`（整篇 PDF 的 PDFMathTranslate 队列）是**两个不同的能力**：前者是文本翻译，后者是 PDF 翻译。

## 文档解析（/docparse，OXR-1.0）

| 项 | 说明 |
| --- | --- |
| 首选 | SoMark/OXR-1.0，`POST {base}/parse/sync`（multipart: file、api_key、output_formats=markdown） |
| 默认实例 | 官方免费实例 `https://free-oxr.somark.ai/api/v1`；自建实例改 `LABSPACE_OXR_BASE_URL`（协议完全一致） |
| 回退 | 内网 `lab-docling:5001`（`LABSPACE_DOCLING_URL`），OXR 不可用时自动回退并在响应里标注 `fallbackUsed` |
| 接口 | `GET /api/docparse/status`（provider / available / fallback 状态）、`POST /api/docparse/parse`（multipart file） |
| 实测 | 官方免费实例从本机房解析 PDF 成功（返回 Markdown、页数、fileType、taskId） |

## 天气预测（/weather）

| 项 | 说明 |
| --- | --- |
| 数据源 | Open-Meteo（`api.open-meteo.com` + `geocoding-api.open-meteo.com`），无需 API Key |
| 接口 | `GET /api/weather?city=&days=` → 当前天气（温度/体感/湿度/风速/天气码）+ 逐日预报（最高/最低/降水） |
| 中文化 | WMO 天气代码 40 条中文描述表 |
| 实测 | 「北京 晴 7.8℃」+ 5 日预报 |

## 出站网络的 IPv4 强制（重要坑）

容器内同时存在 IPv4 与 IPv6 路由，但 IPv6 出口对部分公网站点是黑洞：DNS 返回 AAAA 记录时，
asyncio 会先尝试 IPv6 并挂到超时，**可用的 IPv4 地址根本没被用上**（表现为 OXR / ENCODE 等外部接口
「时好时坏、ConnectTimeout」，而宿主机 curl 正常）。

修复：新增 `backend/app/http.py`，统一用 `httpx.AsyncHTTPTransport(local_address="0.0.0.0")`
创建客户端（`http_client()`），强制只走 IPv4。所有访问外部服务的模块（`db_apis` / `docparse` /
`weather` / `mt`）都改用它。修后 OXR、ENCODE、ChEMBL 等接口稳定返回 200。

## 门户原生重写的功能（Ant Design 6）

原本跳转/内嵌的第三方页面，凡可在门户内实现的都已用 **Ant Design 6 原生组件**重写：

| 页面 | 路由 | 替代/包含的第三方功能 | 说明 |
| --- | --- | --- | --- |
| 学术检索 | 主页面板 + `/search` | SearXNG | 门户 API 代理，AntD Segmented/Input.Search，多引擎聚合 |
| 科研文献检索 | `/literature` | 科研 OpenAPI | PubMed / Europe PMC / Crossref / UniProt / NCBI Gene |
| 开发工具箱 | `/devtools` | IT-Tools | **10 个工具**：JSON 美化/压缩、YAML↔JSON、Base64、URL 编解码、SHA-1/256/512、UUID、时间戳、正则测试、文本对比、进制转换；全部浏览器本地处理 |
| Linux 命令速查 | `/commands` | Linux Command | 内置官方 621 条命令完整说明（Markdown 安全渲染） |
| 我的图形 | `/drawings` | draw.io 图形管理 | 列表 / 重命名 / 下载 / 删除 / 继续编辑 |
| PDF 论文翻译 | `/translate` | PDFMathTranslate GUI | AntD 上传 + 队列进度 + 结果下载 |
| 文件工坊 | `/snapotter` | SnapOtter | **原生 REST 调用**（非 iframe）：243 个图像/PDF/音视频/文件工具，上传→处理→下载全链路在门户内完成 |
| 公告管理 | 管理端 | — | 真实公告（数据库），首页不再显示占位 |

保留第三方原生页面的原因（不做重写）：draw.io 图形编辑器、JBrowse 基因组浏览器——
这些是完整专业应用，重写没有意义且易失真。
原版 IT-Tools 仍保留在 `http://192.0.2.10:8084/`（导航「IT-Tools 原版」）。

## PDF 论文翻译（已实测跑通）

| 环节 | 实现 |
| --- | --- |
| 服务 | 官方镜像 `awwaawwa/pdfmathtranslate-next`（v4.3.0 系），**串行工作进程**（共享卷队列），非 Gradio 直连 |
| 任务流 | 后端写 `/jobs/pending/<id>.pdf`（0644）→ 工作进程取件执行 `pdf2zh` → 产物目录打包为 `<id>.zip` → 后端轮询 `/jobs/done/<id>.json` |
| 页面 | 门户 AntD 页：上传（Dragger）→ 进度（Progress）→ 下载（Result） |
| 资源限制 | 内存 2GB / CPU 1 核 / 进程 256；单文件 ≤30MB；队列串行，翻译期间不挤占学生练习资源 |
| 引擎 | 默认 `bing`（免密钥），可在 `deploy/.env` 用 `PDF2ZH_SERVICES` 切换（deepL / openai 兼容接口等） |
| 实测 | 上传 PDF → 队列 → 生成 `*.zh.dual.pdf`（双语）与 `*.zh.mono.pdf`（纯译），译文中英文对照正确 |
| 失败处理 | 校验产物非空才算成功；失败保留源文件与日志，页面显示失败原因 |

## 权限边界

- 门户按 Casdoor 角色过滤菜单与卡片；后端所有 API 独立校验角色（未登录 401、越权 403）。
- 学生看不到 Open Terminal（终端卡片与后端接口均受限）。
- 学生看不到他人文件（门户原生网盘与生信实训工作区均按用户 ACL 隔离）。
