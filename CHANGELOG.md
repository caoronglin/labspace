# CHANGELOG.md

## 2026-11-20 — 下架文档解析页 + 垃圾清理

**下架 `/docparse`（文档解析页）**

它只是「上传 PDF → 看 Markdown」的一层壳，同样的能力已经由**知识库入库**在用
（PDF/图片 → Markdown 走 MinerU / OXR / Docling）。保留两个入口只会让人问
「我该在哪儿解析」。

- 删除 `frontend/src/pages/Docparse.tsx`、路由、导航项、`api.docparseStatus/docparseParse`
  与两个类型；命令面板（`corpus.py`）里的那条入口一并去掉。
- 后端删除 `app/docparse.py`（含 `/api/docparse/status|parse`）；知识库仍在用的取文本能力
  迁到 **`app/text_extract.py`**（纯内部库，不再挂路由），`knowledge.py` 改从那里导入。
- 顺手修掉转移过程中的两个隐患：
  - 数值型环境变量改走 `_env_number()`：以前 `LABSPACE_DOCPARSE_MAX_BYTES=20MB` 这种手误
    会让整个模块导入失败（后端起不来），现在只记一条 warning 用默认值。
  - 耗时统一 `time.monotonic()`（`time.time()` 被 NTP 回拨时会算出负数）。
- e2e：`/docparse` 从路由清单移除，专门测该页的断言改成「已下架（404）」；
  新增 `e2e/_docparse_gone.mjs` 验证 404 + 首页无残留入口。

**数据表令牌刷新的真实故障（顺手修复）**

`/lab`（多维表格）停留约 20 分钟后所有请求开始 401（`ERROR_INVALID_ACCESS_TOKEN`），
刷新页面也没用：`_token(force=True)` 按**门户邮箱**（`x@local`）清缓存，而
`_user_token` 按**数据表身份**（`x@labspace.local`）写缓存 —— 键不一致，“刷新”拿回的
还是那个过期令牌。修复缓存键并让 TTL（18 分钟）短于 Baserow 的 JWT 有效期；
新增 `backend/tests/test_baserow_token_refresh.py`（去掉修复即 FAIL，已实证）。

**垃圾清理**

- 删除两个从未被引用的组件：`components/charts/DatabaseCategoryBar.tsx`（126 行）、
  `TaskStatusDonut.tsx`（152 行）。
- 修正导航里两处 `group: 'learn'` —— `NAV_GROUPS` 里没有这个分组，属于死配置。
- 清理 `backend/**/__pycache__`、`.pytest_cache`、`.ruff_cache`。
- `e2e/shots` 56MB 历史截图 + `e2e` 根目录 4MB 散落 PNG（都是脚本产物，未入库）。
- `/tmp` 2.8G → 104M（含 1.3G 残留的 `lab-trash-annot-*`、711M 旧 AgentScope 包目录）。
- Docker：删除已下架的 `ghcr.io/bifrost0x/webssh`（353MB）与旧版
  `lab/agentscope-service:2.0.11`（1GB），清空构建缓存。
- Qdrant：删除孤儿集合 `kb_6c360db8f7684636b22fe44f0ee5d463`（1 个空 payload 向量，
  对应知识库记录已不存在；DB 里只剩 `auth` 这一个知识库）。

**验证**：`pytest` 224 passed；`go test ./...` 全过；`tsc -b` 干净；`vite build` ✓；
全局巡检 **34 条路由，老师 / 学生均 0 问题**；`/docparse` → 404 且首页无残留入口；
`/api/docparse/*` → 404，`/api/knowledge` 仍 200。

## 2026-11-20 — 多维表格 / 种子台账对非管理员可用

**问题**（全局巡检 35 条路由对老师、学生各跑一遍发现）：

- `/seeds`：`GET /api/baserow/templates/seed` 挂着 `require_admin`，学生与导师一进页面就 **403**，
  而页面只有这一条入口，整个种子模块对他们白屏。
- `/lab`（多维表格）：`GET /api/baserow/overview` 对 `@local` 账号稳定 **409**
  「该邮箱已在数据表服务中注册」——完全指错方向。

**根因**：

1. 门户账号邮箱是 `<账号>@local`，Baserow 注册接口（Django EmailValidator）判其非法回 **400**；
   后端把这个 400 当成「已注册」，于是永远 409。
2. 种子台账建在**管理员**账号的 Baserow 工作区里，普通账号拿自己的令牌看不到，
   于是解析表 404；读接口又被 `require_admin` 挡在门口。

**改动**：

- `backend/app/baserow.py`
  - 新增 `_account_email()`：不合法的门户邮箱映射为 `<账号>@labspace.local`（一人一账号）。
  - `_provision()` 区分 400 / 409：400 报「服务拒绝了账号 + 原因」，409 才说「账号已存在」。
  - 新增 `call_as_admin()`：只允许 GET/HEAD，供全实验室共享的只读台账使用。
- `backend/app/seed_tables.py`
  - `GET /templates/seed` 改为 `require_user`；管理员走自己的令牌并顺带清理空行，
    非管理员用管理员令牌**只读**解析（`_shared_seed_ids()` 带 5 分钟缓存）。
  - 新增 `GET /seed/rows`：全实验室同一份台账的只读行接口，不接受前端传 table id。
- `frontend/src/services/api.ts`：`BaserowSeedTemplateField` 补 `primary`/`select_options`；
  新增 `seedRows()`。
- `frontend/src/pages/SeedStore.tsx`：去掉对 `/tables/{id}/fields` 的第二次请求
  （非管理员必 404，还会丢选项），字段完全取自模板；行数据走 `/seed/rows`。

**实测**：巡检 35 条路由，老师 / 学生均 **0 问题**；学生 `/seeds` 能看到台账行、
`/lab` 自动开通个人工作区（`baserow_accounts` 写入 `student02@labspace.local`）。

## 2026-11-20 — 文件分类可见性按角色重写（老师看全部 / 其他人只看自己那份）

**问题**：`/files` 里「课题资料」「组会汇报」老师打不开（后端 `listable:false`），
而学生只要名册里有授权就能看到这两个分类；`共享文件-组员` 整棵树物理上挂在
**学生**（`admin01`）家目录下，于是该学生即使不是教师也能看到全部 13 位组员的目录，
真正的导师（`teacher01`）反而看不到。

**根因**：
1. `LoadACL` 只在 ACL 文件**缺少** `groups` 键时才用 `DefaultGroups()`。线上
   `/etc/lab-go/acl/labgo-acl.json` 里 `lab-teacher` 只有 public/plasmids/genomes，
   老师的整源权限完全依赖这份**陈旧**配置，而不是代码。
2. `decide()` 的管理员绕过对 `research` / `meeting` 同样生效，与「管理员不穿透」的
   既定口径矛盾。
3. 共享树建在导师家目录下这一前提没有落实（实际建在了一位学生家目录里）。

**改动**：
- `go-core/internal/labfiles/labfiles.go`
  - 新增 `policyRules()`：`lab-teacher` 的**整源**权限由代码保证 —— 课题资料 /
    组会汇报可读写，另加每位导师家目录下的「共享文件-组员」成员目录全权
    （名册加人、加目录自动生效，不必补 ACL）。教师自己的家目录也补一条，
    避免老账号没有 `users` 授权时连「同步组员目录」都被 403。
  - 新增 `protectedSource()`：`research` / `meeting` **不接受**管理员绕过。
  - `personalAccessLocked()` / `SharedWith()` 接受 `Origin: "policy"`，教师因此能在
    「共享给我」里看到别人的共享树，也能上传（`WritePaths` / `MkdirPaths` 同步生效）。
- `go-core/internal/labfiles/shared_test.go`：新增 5 条回归（老师看全部成员树、
  学生只看自己那棵、老师整源课题资料/组会、管理员不穿透、显式拒绝优先、老师自建树）。
- `frontend/src/pages/Files.tsx`
  - 无权限的分类**不渲染**（原来渲染成点不动的灰页签）；当前分类被收回权限时回退到
    第一个可打开的分类。
  - 写权限统一看服务端 `writePaths`：学生进「共享给我」上传按钮不再消失
    （之前 `writable` 在共享视图被强制 false）。
  - 顶部标签按实际权限显示「部分可编辑 / 可上传 / 只读」，不再把「只能上传」错标成只读。
- `backend/app/lab_shared.py`：`_advisor_of` 的 `SELECT DISTINCT advisor` 加 `ORDER BY`
  （两个导师并存时同一学生可能看到两棵不同的树）。

**数据迁移（一次性，已执行并验证）**：
- `/srv/lab/users/admin01/共享文件-组员` → `/srv/lab/users/teacher01/共享文件-组员`
  （先备份到 `/srv/labbackup/archives/pre-move/`）。
- `labspace.lab_roster` 的 20 行合并为 13 行，`advisor` 统一为 `teacher01`。
- 12 个组员账号的 `users` 授权改指新路径（旧的按前缀剔除，保留各自家目录）。

**实测**：
- 老师（`teacher01`）：六个分类全开，课题资料 3 个目录、「共享文件-组员」13 位组员。
- 学生（`student02`）：「共享给我」只有 `2605_钱同学`；上传 200、建子目录 403。
- 管理员+学生（`admin01`）：课题资料 / 组会汇报**不出现**，个人文件只有自己家目录。
- 无课题资料授权的学生（`student01`）：分类不渲染。
- `go test ./...` 全过；`pytest` 222 passed；`tsc` 0 错；`vite build` ✓。

## 2026-11-20 — 使用说明与互动引导同步

- 新增 [docs/USER_GUIDE.md](docs/USER_GUIDE.md)：面向实验室成员的完整使用说明，
  覆盖登录入口、导航、文件/课题资料/组会/共享目录、PDF 工具箱、AI 与文献、
  种子与多维表格、邮件、防火墙两档与常见问题。
- README 增加用户指南链接；入口表补齐 primer、PDF 工具箱、邮件；账号表改为真实的
  两级管理员示例（并明确 `admin01` 是系统管理员+学生、不是教师）。
- 帮助中心「快速上手」四步与按角色推荐入口同步到当前功能：
  文献 AI 解读、种子 AI 分析、组会沿用上周、PDF 工具箱。
- 互动式 Tour 更新文案与步骤：新增「结果可以接着用，不用下载再上传」一步；
  侧栏说明补上实验工具子菜单与权限分组。
- 起始页 AccessGuide 增加种子管理、PDF 工具箱、邮件、primer 入口。
- SERVICE_INTEGRATION 移除已下线的 WebSSH，补充 PDF 工具箱与 Mailbox 的定位。

## 2026-10-25 — LabSpace 首次部署

### 新增

- **LabSpace 门户**：React 19 + TypeScript + Vite 8 + Ant Design 6.6（ConfigProvider 统一 Token，
  light/dark/auto 主题），8 个页面：首页、全部服务、服务详情、我的收藏、统一搜索、科研文献、绘图、文档解析、
  管理端（服务状态 / 用户和权限 / 配置与日志，仅 lab-admin 可见）。
- **LabSpace 后端**（FastAPI）：OIDC 会话（Casdoor）、服务目录与健康检查（TTL 30s）、
  收藏与最近访问（独立库 `labspace`）、科研检索与 SearXNG 代理、受控绘图保存/导出、管理端只读信息。
- **Casdoor**（`casbin/casdoor`）：本地部署，独立库 `casdoor`；组织 built-in、角色组
  lab-admin / lab-teacher / lab-student / project-rnaseq / project-mcn；
  OIDC 客户端 labspace / openwebui / quantum；初始账号 labadmin、student01、student02。
- **Nginx 内网入口**（apt 安装）：80 端口按主机名分发 7 个站点，未匹配主机名/IP 直连 → 门户；
  WebSocket/SSE 透传、大文件 10G、Web 搜索与科研 API 限速。
- **dnsmasq**：`*.lab.internal` 内网解析（192.0.2.10:53）。
- **第三方组件**：draw.io（官方镜像）、IT-Tools（官方镜像）、Linux Command（官方仓库静态构建，43MB）。
- **e2e 验收**：Playwright 脚本（登录、页面巡检、角色边界、深色、移动端）+ 13 张截图。

### 修改（既有服务）

- `lab-core` compose 追加 `extra_hosts`（auth/portal.lab.internal）与 `ENABLE_OAUTH_PERSISTENT_CONFIG=true`
  （下次重建生效，当前容器未重建）。
- Open WebUI 的 OIDC 配置通过管理员 API 写入（provider=本地 Casdoor，merge-by-email 保留原账号）；
  因容器内嵌 DNS 与客户端缓存问题，登录入口当前返回 500（详见 SERVICE_INTEGRATION.md）。
- Docker daemon 增加 `dns: [192.0.2.10, 192.0.2.1]`，使**新建**容器可解析内网主机名。
- 宿主机 `/etc/resolv.conf` 增加 `nameserver 192.0.2.10`（备份在 `/root/resolv.conf.bak.*`）。

### 2026-10-26 追加

- **统一 OIDC 打通**：重建 Open WebUI（备份后）与 Quantum，接入内网 Casdoor；
  `adminlegacy@qq.com` 按邮箱绑定既有账号（知识库与用户 ID 不变）。
- **访问方式改为 IP 优先**：门户 `http://192.0.2.10/`；draw.io `/draw/`、IT-Tools `:8084`、Linux Command `/commands/`；
  `*.lab.internal` 降级为可选别名（dnsmasq 提供）。
- **Quantum 中文化与调优**：profile locale=zh-CN、中文登录页、OIDC 与口令并行、OIDC 用户 scope 与口令用户对齐。
- **VM 优化**：内核参数补充、systemd-oomd、容器内存/CPU 上限、fstrim、镜像与 apt 清理（~9GB）、
  nftables 防火墙（内网 + Tailscale）、每日巡检 `lab-health.timer`、备份扩展到 4 个库。
- **两个自查修复**：nftables 误用 `flush ruleset` 冲掉 Docker 规则（已改为只重建本表并重启 dockerd）；
  防火墙 FORWARD 链误拦容器互通（已放行 Docker 网段）。

- **门户内 Linux 命令库**：把 linux-command 官方 621 条命令的完整说明（Markdown 原文）内置到门户
  `/commands`（搜索 + 首字母分组 + 全文），后端只读挂载官方数据，渲染不使用 dangerouslySetInnerHTML。

- **浏览器主页 /start**：全屏起始页，支持 Casdoor 登录态、5 套本地背景切换、深浅色主题、
  多元搜索（网页/学术/视频/全部，SearXNG 多引擎聚合）与常用工具直达。
- **Ant Design 官方 CLI 接入**：`npm i -g @ant-design/cli`，`antd doctor` 14 项全过、
  `antd lint ./src` 由 37 项 AntD 6 弃用告警清零（Tag bordered→variant、Alert message→title、
  Statistic valueStyle→styles.content、Space direction→orientation、Drawer width→size、List→Listy）。
- **修 422 报错**：OIDC 回调在缺少 code/state 或 IdP 返回 error 时，改为跳转门户并提示原因，
  不再抛 FastAPI 422（`loc: ["query","code"]`）。
- **修 Open WebUI 跳到 lab.example.org**：其持久化配置 `webui.url` 仍是占位域名，
  已改为 `http://192.0.2.10:3000` 并写入 compose（`WEBUI_URL`），OIDC 失败不再跳到不存在的域名。
- **修门户搜索失效**：后端容器内代理 SearXNG 用了 `127.0.0.1:8081`（指向容器自身），
  改为 `http://lab-searxng:8080/search`，超时放宽到 45s（多分类聚合约 15s）。

- **口令统一**：`lab-sync-passwords` 把同名账号在 Casdoor / Quantum / Open WebUI 的口令统一
  （学生原本的 Quantum 口令现在可直接用于 Casdoor 登录），每日 06:50 自动同步，清单存
  `/etc/labspace/casdoor-users.txt`（0600）。
- **修复 OIDC 回调域不匹配**：Open WebUI 的 `OPENID_REDIRECT_URI` 改为 IP 形式
  （`http://192.0.2.10:3000/oauth/oidc/callback`）并写入 compose/.env；
  此前回调落到 `ai.lab.internal`，浏览器不带会话 Cookie → `mismatching_state` →
  页面报 “Sign-in with your identity provider failed”。
- **修复 `webui.url`**：Open WebUI 持久化配置里仍是占位域名 `https://lab.example.org`，
  改为 `http://192.0.2.10:3000`（并写入 compose 的 `WEBUI_URL`）。

- **JBrowse 2 基因组浏览器**：v4.3.0 官方 web 包静态部署（`/jbrowse/`），内置离线中文教学示例
  （人类 hg19 断点/变异，轨道与组装名中文化），教师可自备数据集（`data/<数据集>/config.json`）。
- **PDF 论文翻译（PDFMathTranslate-next）**：官方镜像 + 自建串行工作进程（共享卷队列），
  门户用 Ant Design 重写上传/进度/下载页面；资源限制 2GB 内存 / 1 核 CPU / 256 进程、单文件 ≤30MB。
- **图纸平台**：新增服务卡片（http://192.0.2.29:5244），后端健康检查直连该内网地址。
- **主页多源学术检索**：首页新增「学术检索」面板（AntD 原生组件，走门户 API → SearXNG 多引擎聚合），
  支持学术文献 / 网页 / 教学视频分类切换。
- **公告改为真实数据**：新增 `labspace.announcements` 表与管理端「公告管理」页，首页不再显示占位提示。
- **AntD CLI 持续检查**：`antd lint ./src` 24 个文件 0 问题；`antd doctor` 14 项全过。

- **开发工具箱（原生重写）**：`/devtools` 用 Ant Design 6 实现 10 个 IT-Tools 同类工具（JSON/YAML/Base64/URL/Hash/UUID/时间戳/正则/文本对比/进制），
  全部浏览器本地处理；原版 IT-Tools 保留为「IT-Tools 原版」入口。
- **我的图形（原生重写）**：`/drawings` 提供图形列表 / 重命名 / 下载 / 删除 / 继续编辑，后端新增 rename + download 接口。
- **PDF 翻译实测跑通**：修正上传文件权限(0644)与 worker 打包逻辑（`--output` 实为目录，需二次打包），
  产物含 `*.zh.dual.pdf`（双语对照）与 `*.zh.mono.pdf`，译文为中文。
- **路由冲突修正**：门户原生工具页改用 `/devtools`（`/tools/` 已被 Nginx 映射给原版 IT-Tools）。

- **API 集成体检脚本** `e2e/api-integration.mjs`：34 项真实接口调用（含会话恢复、CSRF、角色边界），全部通过。
- **修复科研 API 全线 500**：重构时丢失 `fetch()` 与上游常量/正则，补回后 PubMed/EuropePMC/Crossref/UniProt/NCBI Gene 全部正常，MCP 9 个工具可用。
- **修复门户文献检索 502**、**收藏接口 500**、**容器内 127.0.0.1 误用**三处缺陷。
- **核心优化**：路由懒加载（入口 chunk 310KB）、全局错误边界、401 自动回登录并带 `back`、最近访问真实化。

- **植物数据库速查**：新增 50 个植物领域数据库/资源/工具目录（`/databases`），门户搜索与全局搜索
  均可命中本地目录（命中项标记为「植物库」），首页常驻速查面板。

- **语言默认统一中文**：Casdoor `forceLanguage=zh`（登录页已实测中文）；Open WebUI `DEFAULT_LOCALE=zh-Hans` + DB `ui.default_locale` 持久化。
- **重启持久化验证**：labspace + lab-core 全容器重启后数据/配置/静态资源全部保留，各入口探活 200。
- **备份恢复演练**：新增 `lab-restore-drill`（恢复到临时库比对行数，不触碰生产库），openwebui/casdoor 均通过。

- **Casdoor 入口全面 IP 化（修复登录页跳域名）**：Casdoor 改由 `http://192.0.2.10:8090` 提供（nginx 独立 server
  块，`Host` 保留端口，Casdoor `origin/originFrontend` 同步为该地址），门户 / Open WebUI / Quantum 的 issuer、
  授权地址、token 端点全部为 IP，**不再依赖 `auth.lab.internal` 的 DNS 解析**；`auth.lab.internal` 保留为兼容别名。
- **修复 `/login` 路由错误**：`/login` 之前渲染的是「浏览器主页」，现已改为真正的统一认证入口（已登录则直接回工作台）。
- **nginx 配置漂移修复**：`/etc/nginx/sites-available/labspace.conf` 原为独立副本，现已改为指向
  `/opt/labspace/deploy/nginx/labspace.conf` 的软链，避免"改了源码没生效"。
- **Casdoor issuer 三态化**：Casdoor `origin` 留空改为按请求 Host 回显；门户后端按访问主机动态推导
  issuer（LAN IP / Tailscale IP / 域名别名回落 IP），state 中固化 redirect_uri 与 issuer。**Tailscale 远端
  访问此前无法登录（授权地址指向 LAN IP），现已打通**。
- **新增 OIDC 全流程回归**：真实浏览器走通 门户 → Casdoor(IP:8090) → 登录 → 回调 → 已登录，并断言授权地址不含域名。

- **域名别名（*.lab.internal）统一处理**：确认根因为路由器 DHCP 下发的 DNS 不认 lab.internal（客户端侧问题）；
  7 个别名 vhost 全部验证通过，新增门户「访问与别名诊断」页（`/network`）：IP 直达入口、别名解析自检、
  一键复制 hosts、下载 hosts 配置脚本（Windows .bat / Linux·macOS .sh）；统一认证地址恒为 IP:8090。
- **修复巡检脚本静默失效**：`lab-health` 在中文 locale 下因 `free` 表头本地化而中断，已改为解析
  `/proc/meminfo` 并固定 `LC_ALL=C`。

- **访问方式全面改为「192.0.2.10 + 端口」，`*.lab.internal` 全部退役**：
  - draw.io → `http://192.0.2.10:8082/`（容器直接发布，`DRAWIO_BASE_URL=/`）
  - IT-Tools 原版 → `http://192.0.2.10:8084/`（`BASE_URL=/`）
  - Linux 命令速查 → `http://192.0.2.10:8086/`（nginx 静态）
  - JBrowse 2 → `http://192.0.2.10:8091/`（nginx 静态，并修正示例数据的相对路径，轨道加载 0 失败）
  - 门户旧路径 `/draw/ /tools/ /commands/ /jbrowse/` 改为 302 跳转到对应端口
  - nginx 域名 vhost 全删、dnsmasq 别名删除、`/etc/hosts` 别名删除、Casdoor 回调只登记 IP、容器 extra_hosts 域名映射删除
  - 门户新增「服务入口」页（`/network`）：8 个入口实时自检；浏览器主页与首页同步展示端口入口

### 未改动

Open WebUI 容器与数据卷（ID `f4e811d3…`，仅一次原地重启，数据库与知识库未变）、Quantum、SearXNG、
Tika、Docling、科研 API/MCP、Open Terminal、oikb 定时器与备份策略。

## 2026-11-01 — D509 工作台改版 + SnapOtter 文件工坊

### 品牌与设计

- **LabSpace 更名「D509 工作台」**：首页、导航、页签标题、404 页统一文案；保留 `LabSpace` API 路径不变。
- **设计系统重建**：新增 `frontend/src/theme/tokens.ts`（colorPrimary `#2B5CE6`、colorAccent `#12A594`、
  圆角 10/14、header 60、sider 232 等）与 `frontend/src/styles.css`（hero 径向渐变 + 网格纹理、入场动画、
  卡片悬浮、命令面板、骨架微光、`prefers-reduced-motion` 降级）。
- **修复图标加载失败**：`frontend/index.html` 引用 `/favicon.svg` 但文件缺失，nginx SPA fallback 返回了
  index.html（HTTP 200 但内容是 HTML）。已补 `public/favicon.svg`、`logo.svg`、`brand-mark.svg`。

### SnapOtter 文件工坊（新增，端口 8092）

- **部署**：`/opt/lab-snapotter/compose.yaml`（app + postgres:17-alpine + redis:8-alpine），数据在
  `/srv/labdata/snapotter/`，app 3g/3cpu/384pid，容器网络 `lab-tools`。
- **门户原生重写**（非 iframe）：`/snapotter` 页面 + 后端代理
  `/api/snapotter/{status,tools,run,jobs/{id},pipelines,download}`；**243 个工具**
  （image 107 / video 57 / pdf 29 / audio 27 / files 23），工具目录从 `/api/v1/openapi.yaml` 解析。
- **权限与安全**：API Key `si_` 前缀，存于 `/etc/lab-snapotter/credentials`（0600）与后端环境变量；
  下载代理做 SSRF 白名单（仅 `/api/v1` 与本机/容器名 host）。

### 统一语料（更新）

- **植物库 50 → 71 条**：新增 NCBI SRA/ENA/NCBI BLAST/AlphaFold DB/SignalP/EggNOG-mapper/KAAS/PASA/
  miRBase/PMRD/Expression Atlas/MetaCyc/BRENDA/Tropicos/Genesys/CoGe/Plant Cell Atlas/MetaboLights/
  BUSCO/GeneMANIA/PlantRegMap 等 21 个真实资源。
- **SnapOtter 243 个工具进入语料**（`type=snapotter`），约 140 条常用工具配中文别名（「PDF 合并」→ Merge PDFs）。
- **按类型限额**（`TYPE_CAPS`）避免单一类型洗掉结果；`/api/corpus` 空查询改为均衡展示。
- **深链接**：`/snapotter?section=pdf&tool=merge-pdf` 可直接定位到具体工具。

### 防火墙与运维

- **修复「服务基本都不能用」**：nftables `input` 链策略为 drop，原先只放行 22/80/53，新增端口全被 DROP
  （本机 loopback 自测走 `lo` 规则，因此自测全绿而外部全不通）。现用集合 `svc_ports`
  （80/8090/3000/8080/8082/8084/8086/8091/8092）按内网 `192.0.2.0/24` 与 Tailscale `100.64.0.0/10` 放行。
- **容器端口绑定改为 0.0.0.0**：原先同时绑 `127.0.0.1` 与 `192.0.2.10` 会报 `address already in use`，
  且 Tailscale 地址访问不通；现由 nftables 承担访问控制。
- **验证方法改进**：用 network namespace 模拟真实非 loopback 客户端（LAN 与 Tailscale 两种源地址），
  注意**回程路由必须同时添加**，否则表现为超时而非拒绝。
- **备份扩容**：`lab-backup` 新增 SnapOtter 配置与 `snapotter` 库；`lab-health` 新增 8092 探活。

### 回归结果（全部实测）

| 项目 | 结果 |
| --- | --- |
| API 集成体检 | 51/51 |
| 门户 e2e | 失败 0（首页 12 张服务卡片） |
| SnapOtter 集成 | 15/15（含真实图片缩放） |
| OIDC 双入口 | LAN OK / Tailscale OK |
| Quantum | 27/27 |
| SearXNG | 16/16 |
| lab-health | 失败 0、警告 1（Windows 模型 API 不可达） |
| antd lint / doctor | 35 文件 0 问题 / 14/14 |
| 外部可达性 | netns 模拟 LAN 与 Tailscale 客户端，9 个端口全 200 |

## 2026-11-01（续）— 账号体系对齐 + Docker DNS 别名冲突修复

### 账号体系（Casdoor 为唯一身份源）
- 登录标识统一为**邮箱**（Casdoor 按 `email` 查用户），此前 `labadmin@local` 报「built-in/labadmin@local不存在」。
- 邮箱与 Open WebUI 账号**刻意保持一致**（`labadmin@local` / `student01@local` / `student02@local` / `adminlegacy@qq.com`），
  OIDC 单点登录按邮箱绑定既有账号，不再新建 pending 账号（清除了残留的 `student01@lab.internal` pending 账号）。
- 修复两个坏账号：`labadmin` 的 bcrypt 哈希与任何已知口令都不匹配；`student02` 存的是明文但 `password_type=bcrypt`。
  两者已重置为 bcrypt 哈希（`<labadmin 口令>` / `<student01 口令>`）。
- `/usr/local/bin/lab-sync-passwords` 重写：账号映射改为 `@local`，写 **bcrypt 哈希**（旧版写明文 + `password_type=plain`，
  与 bcrypt 混用会直接导致登录失败），并修复输出清单重复行。
- `/etc/labspace/casdoor-users.txt`、`/etc/labspace/casdoor-admin.txt` 更新为真实可用值（后者 URL 仍指向已下线的 auth.lab.internal，已改为 IP）。
- 浏览器实测 4 个账号均可登录 Casdoor；门户 OIDC、Open WebUI OIDC、Quantum OIDC 三条链路均验证通过。

### Docker 网络 DNS 别名冲突（间歇性 500 根因）
- 现象：`api-integration` 随机 3~4 项失败；SnapOtter 探活偶发 `HTTP 500`；Open WebUI 偶发探测掉线。
- 根因：`lab-tools` 网络上 `lab-postgres` 与 `lab-snapotter-postgres` **同时占用 `postgres` 这个 DNS 别名**，
  Docker 内嵌 DNS 轮询返回两条记录，约一半新连接打到错误的库 →
  `password authentication failed for user "snapotter_app" / "labowui"`。
- 修复：
  - SnapOtter 的 compose 服务名改为 `snapotter-db` / `snapotter-cache`，连接串指向唯一名；
  - Open WebUI 的 `DATABASE_URL` / `PGVECTOR_DB_URL` 从 `@postgres` 改为 `@lab-postgres`；
  - 全网别名扫描确认已无冲突（`lab-postgres` 独占 `postgres`）。
- `lab-health` 新增 **3.1 Docker 网络 DNS 别名冲突** 检测，防止复发。
- 验证：Bearer 连打 100 次全部 200，容器日志 0 个 500。

### 备份恢复演练扩容
- `lab-restore-drill` 新增 `snapotter` 目标（独立 Postgres 容器，按业务表总行数比对，22=22）。
- 修复 `labspace` 目标必然失败的 bug：labspace 库用的是 `labspace` schema 而非 `public`，无 `user` 表；
  改为无 `user` 表时按非系统 schema 下所有表总行数比对（4=4）。
- 四个目标全部通过：openwebui 5=5、casdoor 5=5、labspace 4=4、snapotter 22=22。
