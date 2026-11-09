# TEST.md — 验证记录

环境：Debian 13 / 12 vCPU / 11.5G RAM；验证方式：curl 探活 + Playwright 真实浏览器（Chromium 156）。
截图目录：`/opt/labspace/e2e/shots/`（home、services、service-detail、favorites、search、literature、
drawio、docling、admin、dark、mobile-home、app-*）。

## 1. 平台入口

| 检查 | 结果 |
| --- | --- |
| `http://192.0.2.10/`（IP 直连，default_server） | ✅ 200，门户 HTML |
| `http://portal.lab.internal/` | ✅ 200 |
| auth / ai / files / draw / commands / tools 六个主机名 | ✅ 全部 200 |
| Nginx `nginx -t` | ✅ syntax is ok / test is successful |
| `docker compose config`（labspace / lab-core） | ✅ 均通过 |

## 2. 认证与权限（Playwright 实测）

| 检查 | 结果 |
| --- | --- |
| 匿名 `GET /api/me` | ✅ `{"authenticated":false}` |
| 匿名 `GET /api/admin/info` | ✅ 401（未登录） |
| Casdoor 登录（student01） | ✅ 跳转 authorize → 登录 → 回调 → 会话建立 |
| 登录后 `GET /api/me` | ✅ `authenticated:true`，`roles:["lab-student"]` |
| 管理员（labadmin）打开 `/admin/status` | ✅ 显示系统信息与健康检查；`/api/admin/info` 200 |
| 学生打开 `/admin/status` | ✅ 403「无访问权限」；`/api/admin/info` → 403「需要 lab-admin 权限」 |
| 学生可见服务卡片 | ✅ 不含 Open Terminal（角色过滤） |
| 退出登录 | ✅ 清除会话与 CSRF Cookie |

## 3. 页面与 UI（浏览器实检）

| 页面 | 结果 |
| --- | --- |
| 首页 | ✅ 欢迎语 + 角色、全局搜索、常用服务、服务网格、最近访问/我的收藏/公告（空态用 Empty） |
| 全部服务 | ✅ 搜索 + 分类 Tabs + 卡片网格 |
| 服务详情 | ✅ 描述、使用指南、安全提示、健康状态、打开服务、收藏 |
| 我的收藏 / 统一搜索 / 科研文献 / 绘图 / 文档解析 | ✅ 均 200 且渲染正常 |
| 深色主题 | ✅ 切换生效并截图 |
| 移动端 390×844 | ✅ 无横向溢出（scrollWidth-clientWidth = 0px） |

## 4. 第三方应用（经内网主机名实际访问）

| 应用 | 结果 |
| --- | --- |
| Linux Command | ✅ 200「Linux命令搜索引擎」 |
| IT-Tools | ✅ 200「IT Tools - Handy online tools for developers」 |
| draw.io | ✅ 200「Flowchart Maker & Online Diagram Software」 |
| Quantum | ✅ 200 登录页 |
| Open WebUI | ✅ 200，登录页出现「Continue with Casdoor」入口 |

## 5. 健康检查（后端容器内探测，9/9 正常）

Open WebUI / Quantum / draw.io / Linux Command / IT-Tools / 科研检索 API / Docling / SearXNG 全部 `up`。

## 6. draw.io 保存链路（端到端）

| 步骤 | 结果 |
| --- | --- |
| 门户打开独立 draw.io | ✅ 新窗口加载成功 |
| 载入模板 → 保存到我的图形 | ✅ `labspace.drawings` 出现记录 |
| 导出到个人目录 | ✅ `/srv/lab/users/student01/drawio/rnaseq.drawio`（0640，Quantum 可见） |
| 越权路径 | ✅ `/etc/passwd` 被 403 拒绝（科研 API 侧同规则） |

## 7. 既有服务回归（不得破坏）

| 检查 | 结果 |
| --- | --- |
| Open WebUI 容器 ID | ✅ 重启前后一致（`f4e811d3…`），未重建、数据卷未动 |
| Open WebUI 既有用户 | ✅ `adminlegacy@qq.com`（admin）仍在，OIDC 合并策略已配置为按邮箱关联 |
| Open WebUI 知识库 | ✅ 4 个知识库（课程/项目/个人×2）仍在，oikb 增量同步仍为 `unchanged` |
| Quantum 越权测试 | ✅ `lab-quantum-check` 27/27 通过 |
| SearXNG 检索 | ✅ `lab-searxng-test` 16/16 通过 |
| 科研 API | ✅ PubMed/EuropePMC/Crossref/UniProt/NCBI Gene 真实返回；MCP initialize 200 |

## 7.5 2026-10-26 增补验证

| 检查 | 结果 |
| --- | --- |
| Open WebUI Casdoor OIDC 登录 | ✅ 302 → Casdoor → 回调 307；`adminlegacy@qq.com` 绑定 oidc sub（按邮箱关联既有账号，未新建重复用户） |
| Quantum Casdoor OIDC 登录 | ✅ student01@local 登录成功并进入文件界面；口令与 OIDC 并行（口令为管理员兜底） |
| Quantum 中文界面 | ✅ 登录页显示「FileBrowser Quantum 或 OpenID Connect」；用户 profile locale=zh-CN |
| Quantum 越权/只读回归 | ✅ `lab-quantum-check` 27/27 通过 |
| IP 直连全量 | ✅ 门户 /、/draw/、/tools/、/commands/、:3000、:8080/files/、:8084 均 200 |
| Tailscale 访问 | ✅ http://198.51.100.71/ 与 MagicDNS 名均 200 |
| 容器互通 | ✅ 修复防火墙 FORWARD 链后，9 个服务健康检查全部 up |
| 防火墙 | ✅ nftables 默认 DROP，仅放行内网/Tailscale 的 22/80/53 与 Docker 网桥 |
| VM 优化 | ✅ 内核参数（swappiness 10 / watermark 10 / min_free 256MB / BBR / THP）、systemd-oomd、容器内存上限、fstrim、镜像清理（回收 ~9GB）、apt 清理、每日巡检 timer |
| 备份 | ✅ lab-backup 现覆盖 openwebui / openwebui_vectors / casdoor / labspace 四个库 + Open WebUI 文件 + Quantum 配置 |

## 7.6 2026-10-27 增补验证（JBrowse / 主页学术检索 / 公告 / 图纸平台）

| 检查 | 结果 |
| --- | --- |
| JBrowse 2 v4.3.0 部署 | ✅ 官方 web 包静态部署于 `/jbrowse/`，配置参数须用 `?config=`（`?data=` 是旧版写法，v4 会回落 `/jbrowse/config.json` 报 JSON 错） |
| JBrowse 渲染 | ✅ 浏览器实测：chr3/chr6 参考坐标、PacBio 变异集/比对轨道（轨道名已中文化） |
| JBrowse 离线示例 | ✅ 自带教学数据集（BAM+VCF+chrom.sizes 5.5MB）已复制到 `data/demo/` 并生成中文 `config.zh.json` |
| 主页多源学术检索面板 | ✅ AntD 原生组件（Segmented + Input.Search），走门户 API → SearXNG 多引擎聚合 |
| 公告（真实数据） | ✅ 新增 `labspace.announcements` 表 + 管理端「公告管理」页（发布/删除），首页不再显示占位提示 |
| 图纸平台 | ✅ 服务卡片 + 后端健康检查直连 `http://192.0.2.29:5244`（后端容器内可达，200） |
| AntD CLI | ✅ `antd lint ./src` 24 文件 0 问题；`antd doctor` 14 项全过 |
| 启动依赖与健康检查 | ✅ drawio / it-tools / pdf2zh 补 healthcheck；compose 校验通过 |
| PDF 论文翻译 | ⚠️ 官方镜像（0.9GB）因镜像源限速仍在拉取（9/13 层），页面与队列 API 已就绪，镜像到位后即可启用 |

## 7.7 2026-10-27 增补：原生重写与 PDF 翻译实测

| 检查 | 结果 |
| --- | --- |
| 开发工具箱 `/devtools` | ✅ 10 个页签渲染正常；JSON 美化出结果；UUID 批量生成 5 个；AntD lint 0 问题 |
| 我的图形 `/drawings` | ✅ 列表/重命名/下载/删除接口齐备（后端 rename + download 新增） |
| PDF 翻译端到端 | ✅ 上传 → 队列 → 产出 `*.zh.dual.pdf` + `*.zh.mono.pdf`；抽取译文首页确认中文内容正确 |
| 翻译失败保护 | ✅ 校验产物非空才算成功，失败保留源文件与日志 |
| 服务目录（学生视角） | ✅ 11 项可见（Open Terminal 仅导师/管理员）；PDF 翻译与 JBrowse 均已 up |

## 7.8 2026-10-27 API 集成体检 + 会话恢复（`e2e/api-integration.mjs`）

**34/34 全部通过**（每项都是真实调用，非 mock）：

| 分类 | 覆盖接口 | 结果 |
| --- | --- | --- |
| 身份/会话 | `/api/me`、会话 Cookie（HttpOnly/SameSite=Lax）、CSRF Cookie（非 HttpOnly） | ✅ |
| **会话恢复** | 刷新页面后仍有效、**新标签页**会话可恢复且直接显示登录用户 | ✅ |
| 服务目录 | `/api/services`（11 项）、`/api/services/health`（11/11 up）、`/api/services/{id}/health` | ✅ |
| 收藏/最近 | favorites 增删查、recent 查询与写入 | ✅ |
| 检索 | `/api/search`（学术 20 条 / 网页）、`/api/literature`（PubMed / UniProt） | ✅ |
| 命令库 | `/api/commands`（命中 7）、`/api/commands/{name}`（19,334 字符全文） | ✅ |
| 翻译 | `/api/pdf-translate/status` | ✅ |
| 图形 | `/api/drawings` 增删改查 + download | ✅ |
| 公告 | 查询通过；**学生发布被 403** | ✅ |
| 管理端 | **学生访问 `/api/admin/info`、`/api/admin/health` 均 403** | ✅ |
| CSRF | 缺 CSRF 头的写操作 → 403 | ✅ |
| 登出 | `POST /api/auth/logout` → 会话失效 | ✅ |

**本次体检发现并修复的 4 个真实缺陷**：

1. **科研 API 全线 500**（重构时丢失 `fetch()` 与 `EUTILS/DOI_RE/ACCESSION_RE/_eutils_params` 等常量）
   → PubMed/EuropePMC/Crossref/UniProt/NCBI Gene 全部 500，门户「科研文献检索」页因此一直空白。已补回并逐个接口验证。
2. **门户 `/api/literature` 502**：后端容器内用 `127.0.0.1:8000` 指向容器自身 → 改 `lab-research-api:8000`（同类问题在 SearXNG 代理上已修过一次，这次统一排查）。
3. **`POST /api/favorites/{id}` 500**：参数名写成 `_` 却在函数体里用 `user` → NameError。已修正。
4. **容器内健康探测用 `127.0.0.1`**（指向容器自身）→ 统一改为服务名/宿主地址。

MCP（Streamable HTTP）单独验证：initialize 200、session id 正常、`tools/list` 返回 **9 个工具**
（pubmed_search / pubmed_abstracts / europepmc_search / crossref_doi / crossref_search / uniprot_search /
uniprot_entry / ncbi_gene_search / docling_convert）。

## 7.9 核心优化

| 优化 | 说明 |
| --- | --- |
| 路由懒加载 | 27 个页面全部 `React.lazy` + Suspense，入口 chunk 310KB，按需加载（总 dist 1.5MB） |
| 全局错误边界 | `ErrorBoundary` 兜底页面白屏，展示错误摘要 + 刷新/返回首页 |
| 会话过期统一处理 | 任意 API 返回 401 → 自动带 `back` 参数跳登录，登录后回原页面 |
| 最近访问真实化 | 点击服务卡片/打开服务即 `POST /api/recent/{id}`，首页“最近访问”显示真实数据（已验证 open-webui） |
| AntD CLI 复核 | `antd lint ./src` 27 文件 **0 问题**；`antd doctor` 14 项全过 |

## 7.10 植物数据库目录（新增）

| 检查 | 结果 |
| --- | --- |
| `GET /api/databases` 全量 | ✅ **107 个资源 / 13 个分类**（含医学与临床、微生物与病毒、组学与多组学、蛋白质与药物） |
| `GET /api/databases?q=单细胞` | ✅ 命中 6（Cell BLAST / ChromLoops / ChromStates / PCMDB / PlantDeepSEA / PsctH） |
| `GET /api/databases?category=多组学与单细胞` | ✅ 全部条目分类一致 |
| 全局搜索并入本地库 | ✅ 搜「miRNA」时 local 命中非空，页面上以「植物库」标签区分 |
| 门户目录页 | ✅ 搜索 + 分类切换 + 卡片渲染（截图 databases.png） |
| 首页速查面板 | ✅ 常驻显示常用资源，可直接跳转 |
| 真实 API 适配器 | ✅ **32 个**（植物 15 + 生物医学 17），`GET /api/databases/apis` 返回 withApi=32 |
| 单库真实检索 | ✅ `POST /api/databases/{id}/query` 归一化返回 `{title,subtitle,url,source,fields}` |
| 无 API 库 | ✅ 逐条写明原因（需订阅 / 需 key / 无检索接口 / 不可达），页面标「仅网页访问」 |
| 目录页 API 徽标 | ✅ 107 张卡片、33 个 API 徽标；抽屉内真实查询返回 6 条 NCBI 结果 |

测试脚本：`node /opt/labspace/e2e/db-api-integration.mjs` → **24/24 通过**；
`node /opt/labspace/e2e/biomed-api-test.mjs` → **17/17**；
`node /opt/labspace/e2e/biomed-search-test.mjs` → 通过（统一搜索命中 ClinVar / ChEMBL / STRING 等）。

API 集成体检随之扩充到 **51 项，全部通过**。

## 7.12 SnapOtter 文件工坊（新增）

| 检查 | 结果 |
| --- | --- |
| 容器状态 | ✅ app + postgres + redis 三容器均 healthy |
| 官方界面 | ✅ `http://192.0.2.10:8092/` 200 |
| 工具目录 | ✅ 243 个（image 107 / video 57 / pdf 29 / audio 27 / files 23），来源为 `/api/v1/openapi.yaml` |
| 门户代理 | ✅ `/api/snapotter/status`、`/api/snapotter/tools` 200 |
| 真实工具调用 | ✅ 浏览器生成 64×64 PNG → `POST /api/snapotter/run?section=image&tool_id=resize` → jobId + downloadUrl → `/api/snapotter/download` 返回 200（112 字节缩略图） |
| 门户页面 | ✅ `/snapotter` 渲染正常、显示「在线 · 243 个工具」、目录可选、控制台无错误（截图 snapotter.png） |
| 深链接 | ✅ `/snapotter?section=pdf&tool=merge-pdf` 自动定位到 Merge PDFs |

测试脚本：`node /opt/labspace/e2e/snapotter-integration.mjs` → **15/15 通过**。

## 7.13 统一语料（新增）

| 检查 | 结果 |
| --- | --- |
| 语料总量 | ✅ **1011 条**：command 621 / snapotter 243 / database 107 / page 15 / service 13 / tool 12 |
| 中文别名命中 | ✅ 「PDF 合并」→ Merge PDFs；「抠图」→ Remove background；「图片压缩」→ Compress Image + SnapOtter 服务 |
| 类型限额 | ✅ 单类型最多 snapotter 4 / command 5 / database 10，避免结果被单一类型洗掉 |
| 六类齐全 | ✅ `/api/corpus` 空查询按配额均衡返回 page/service/tool/snapotter/database/command |
| 单细胞检索 | ✅ 命中 8 个单细胞/多组学植物库 |
| 命令面板 | ✅ ⌘K 输入「PDF 合并」命中 Merge PDFs（截图 cmdpalette.png） |

## 7.14 外部可达性（防火墙回归）

| 检查 | 结果 |
| --- | --- |
| nftables 放行集 | ✅ `svc_ports = { 80, 8090, 3000, 8080, 8082, 8084, 8086, 8091, 8092 }`，仅内网与 Tailscale 源可达 |
| LAN 客户端 | ✅ netns 模拟 192.0.2.199，9 个端口全 200（8080 为 301 → /files/） |
| Tailscale 客户端 | ✅ netns 模拟 100.66.99.99，9 个端口全 200 |
| 容器绑定 | ✅ Open WebUI/Quantum/draw.io/IT-Tools/SnapOtter 均为 0.0.0.0，访问控制交给 nftables |

> 排查要点：本机 curl 自测走 `lo` 规则，**不能**证明外部可达；netns 模拟时必须同时添加回程路由，
> 否则表现为超时而非拒绝。

## 7.15 语言默认 / 重启持久化 / 备份恢复演练

| 检查 | 结果 |
| --- | --- |
| Casdoor 登录页语言 | ✅ 中文（"Web身份验证 / 用户名 / 密码 / 登录 / 没有账号？立即注册"），`forceLanguage=zh` |
| Open WebUI 界面语言 | ✅ 中文浏览器下全中文；服务端默认 `DEFAULT_LOCALE=zh-Hans`（新用户默认 + DB `ui.default_locale` 持久化）。**注意**：匿名登录页跟随浏览器语言（上游行为），实验室终端为中文浏览器故实际显示中文 |
| 容器重启持久化 | ✅ 重启 labspace + lab-core 全部容器后：favorites=1 / drawings=2 / openwebui 用户=5 / casdoor 用户=5 / JBrowse 示例数据保留 / 门户·开发工具箱·植物库·Open WebUI·Quantum·JBrowse 探活全 200 |
| 备份恢复演练 | ✅ `lab-restore-drill`：openwebui 与 casdoor 备份恢复到临时库 `restore_drill`，「user」行数与生产一致（5=5）；labspace（`labspace` schema，无 user 表）与 snapotter 按业务表总行数比对；演练后自动删除临时库，不触碰生产库 |

## 7.16 个人工作台 / Agent 助手 / 翻译 / 天气 / 文档解析（新增）

测试脚本：`node /opt/labspace/e2e/agent-integration.mjs` → **20/20 通过**。

| 检查 | 结果 |
| --- | --- |
| 工作台 summary | ✅ `GET /api/workbench/summary` 200（today / projects / plans / brief / stats） |
| 智能捕获 | ✅ `POST /api/workbench/capture` → kind=task、标题「下午提交论文修改稿」（含 due_date / tags / priority 抽取） |
| 条目与计划 | ✅ items / projects / plans / briefs 全部 200 |
| 天气 | ✅ `GET /api/weather?city=北京&days=5` → 「北京 晴 7.8℃」+ 5 日预报 |
| 文本翻译 | ✅ Hy-MT2 未部署时 `GET /api/translate/status` 明确返回 `available=false reason=模型服务不可达：ConnectTimeout`；真实翻译走**本地引擎回退**，28.3 秒返回英文译文，`provider=本地引擎（pi 网关）`、`fallback_used=true` |
| 文档解析 | ✅ `GET /api/docparse/status` → OXR-1.0 在线；`POST /api/docparse/parse` 解析 PDF 成功（Markdown + 页数）；OXR 不可用时自动回退 Docling（provider=Docling） |
| Agent 状态与模型 | ✅ 网关可达，4 个模型（minimax-cn 系列） |
| Agent 会话 | ✅ 建会话 200、发消息 200、删除 200 |
| **Agent SSE 流式回复** | ✅ 字数 ≈ 90~100，事件序列 `delta… → done{usage}`；助手回复已落库（roles = user, assistant） |
| 配额 | ✅ `GET /api/agent/quota` 返回用量与剩余；管理员改配额后立即生效（`agent-quota-test.mjs`） |

> **排查记录**：曾出现「消息已落库但前端一个字收不到」。根因是 pi 启动阶段也会发一次 `agent_settled`，
> SSE 中继提前断流。修复：中继只在收到 `assistant_message` 之后才允许按 settled 结束。

## 7.17 首页排版 / 内嵌 / 中文化（新增）

| 检查 | 结果 |
| --- | --- |
| 首页三档排版 | ✅ 桌面 1440×900 / 平板 1024×768 / 移动 390×844 均无横向溢出、无元素重叠、12 张服务卡（`home-layout.mjs`） |
| 内嵌页 | ✅ 7 个可嵌入服务全部渲染成功、无 X-Frame/CSP 阻断；SnapOtter 正确判为不可嵌入并给出中文原因与新窗口回退（`embed-test.mjs` 37/37） |
| 单点登录 | ✅ Open WebUI / Quantum / JBrowse / draw.io / IT-Tools / Linux 命令 六处均免密进入（`sso-flow.mjs`） |
| 中文化 | ✅ 门户 12 个页面无英文文案；draw.io / IT-Tools / Linux 命令 / JBrowse / Open WebUI 全中文；Quantum 上游无语言包，已给中文操作指引（`i18n-full.mjs` 10/10、`jbrowse-i18n.mjs` 5/5） |

## 7.18 全量回归一键执行

```bash
cd /opt/labspace/e2e && ./run-regression.sh          # 全部脚本
cd /opt/labspace/e2e && ./run-regression.sh e2e.mjs   # 指定脚本
```

覆盖：api-integration(51) / e2e / snapotter-integration(15) / agent-integration(20) /
new-features(16) / db-api-integration(24) / biomed-api(17) / biomed-search / i18n-full(10) /
embed-test(37) / jbrowse-i18n(5) / home-layout / oidc-multi / ip-adaptive(15) / sso-e2e(4) /
charts(18) / design-selfcheck(88) / components-polish(51) / post-reset(8) / bioinfo-api-smoke(7) /
bioinfo-terminal。

> 脚本默认口令写在 `run-regression.sh` 里（`LAB_PASS` / `LAB_ADMIN_PASS`），便于内网自检；
> 对外分享时请用环境变量覆盖。

> 2026-11-04 实测：Go 核心接管服务目录 / 健康 / 内嵌 / 语料 / 搜索后，**25 个脚本全部通过**
> （含此前偶发抖动的 `new-features-test.mjs` 与受外网影响的 `db-api-integration.mjs`）。
> 日志：`/tmp/regression-go-search.log`。

### 7.18.1 Go 核心专项验证

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| Go 构建 / 静态检查 | `go build ./... && go vet ./...` | ✅ 通过 |
| Go 单测 | `go test ./...` | ✅ 全包 ok |
| 服务目录一致性 | `node e2e/catalog-parity.mjs` | ✅ 0 差异（Go vs Python 逐字段） |
| 语料 / 搜索一致性 | `docker exec lab-labspace-backend python /tmp/corpus-parity.py` | ✅ 0 差异 |
| Go 文件访问 | `node e2e/go-next-api.mjs` | ✅ 14/14 |

## 7.19 入口自适应（IP 自适应，新增）

| 检查 | 结果 |
| --- | --- |
| 服务地址跟随入口 | ✅ `/api/services`、`/api/network/entries`、`/api/search`、`/api/sso/status` 在 `Host: 192.0.2.10` 与 `Host: 198.51.100.71` 下均返回对应主机的地址（外部主机 `192.0.2.29` 例外） |
| 页面外链跟随 | ✅ 两个入口的 `/start` 页 IP 外链全部指向当前入口，且页面不出现另一入口的 IP |
| OIDC issuer 切换 | ✅ 点「一键登录」时 Open WebUI / Quantum 的授权端点切换到当前入口的 Casdoor，并能切回内网 |
| 端到端免密 | ✅ 门户内网入口 → Open WebUI 无密码框；门户 Tailscale 入口 → Quantum 无密码框（`sso-e2e-test.mjs` 4/4、`ip-adaptive-test.mjs` 15/15） |

> 验证脚本：`e2e/ip-adaptive-test.mjs`、`e2e/sso-e2e-test.mjs`。
> 切换动作会重建 Open WebUI / Quantum 容器（约 10~30 秒），测试期间服务短暂不可用属预期。

## 7.12 Casdoor IP 化与真实 OIDC 回归

| 检查 | 结果 |
| --- | --- |
| 门户 → Casdoor 授权地址 | ✅ `http://192.0.2.10:8090/login/oauth/authorize`（**不含 `auth.lab.internal`**） |
| OIDC 浏览器全流程 | ✅ 门户 → Casdoor 登录页 → 提交 → 回调 `http://192.0.2.10/api/auth/callback` → 已登录进入工作台 |
| Open WebUI SSO | ✅ 点击「使用 Casdoor 继续」跳转 `http://192.0.2.10:8090/login/oauth/authorize` |
| Quantum OIDC | ✅ `lab-quantum-check` 27/27 通过（issuer 已同步为 IP:8090） |
| 兼容别名 | ✅ `http://auth.lab.internal/` 仍可访问（仅作别名，授权地址仍为 IP） |
| 回归 | ✅ API 集成体检 **40 项全通过**（新增 2 项 OIDC 断言）；门户 e2e **失败 0**（登录流程已改为真实 OIDC） |
| Tailscale 入口 OIDC | ✅ 访问 `http://198.51.100.71/` → 授权端点 `http://198.51.100.71:8090/login/oauth/authorize` → 登录成功 |
| 域名别名 OIDC | ✅ 访问 `http://portal.lab.internal/` → 授权端点回落为 `http://192.0.2.10:8090/...`（Casdoor 对非 IP 主机默认按 https 生成 issuer，内网为纯 HTTP 故统一回落 IP） |

### Casdoor issuer 的三态设计（IP 优先）

| 访问入口 | 授权端点 | 说明 |
| --- | --- | --- |
| `http://192.0.2.10/`（内网主入口） | `http://192.0.2.10:8090/login/oauth/authorize` | IP 直连，无需 DNS |
| `http://198.51.100.71/`（Tailscale） | `http://198.51.100.71:8090/login/oauth/authorize` | 按访问主机动态推导 issuer，state 中固化 redirect_uri 与 issuer |
| `http://portal.lab.internal/`（别名） | `http://192.0.2.10:8090/...` | 非 IP 主机回落到规范 IP issuer（Casdoor 对域名默认生成 https） |

## 7.13 访问方式统一为「192.0.2.10 + 端口」（域名全部退役）

**决策**：不使用任何 `*.lab.internal` 域名，全部服务以 `192.0.2.10 + 端口` 对外，
客户端无需 DNS 解析 / hosts / 改路由器设置。

| 服务 | 地址 | 验证 |
| --- | --- | --- |
| 门户 LabSpace | `http://192.0.2.10/` | ✅ 200 |
| 统一认证 Casdoor | `http://192.0.2.10:8090/` | ✅ 200；授权地址 `http://192.0.2.10:8090/login/oauth/authorize` |
| Open WebUI | `http://192.0.2.10:3000/` | ✅ 200 |
| Quantum 文件 | `http://192.0.2.10:8080/files/` | ✅ 200 |
| draw.io | `http://192.0.2.10:8082/` | ✅ 200，编辑器正常加载（`DRAWIO_BASE_URL=/`） |
| IT-Tools 原版 | `http://192.0.2.10:8084/` | ✅ 200（`BASE_URL=/`） |
| Linux 命令速查 | `http://192.0.2.10:8086/` | ✅ 200，标题「Linux命令搜索引擎」 |
| JBrowse 2 | `http://192.0.2.10:8091/` | ✅ 200，参考序列与轨道加载成功，0 失败资源 |

退役动作：nginx 域名 vhost 全删 → 改为端口 server 块；dnsmasq 别名记录删除；`/etc/hosts` 别名删除；
Casdoor 三个应用的回调只保留 IP；容器 `extra_hosts` 域名映射删除；`/network` 页面改为「入口清单 + 实时自检」。

## 7.14 巡检脚本语言无关化（真实缺陷）

系统 locale 设为 `zh_CN.UTF-8` 后，`free` 的输出表头变成"内存：/交换："，
`lab-health` 里按英文 `/^Mem:/`、`/^Swap:/` 的正则全部失配 → 内存/Swap 检查静默失效
（今日 07:24 的定时巡检即因此中断在第 23 行）。

- 修复：脚本头部 `export LC_ALL=C LANG=C`，并改为直接解析 `/proc/meminfo`（MemTotal/MemAvailable/SwapTotal/SwapFree）
- 验证：中文 locale 与 C locale 下均正常输出（内存 4661M/10867M 42%、Swap 57M），systemd timer 手动触发通过

## 8. 未通过 / 未完成（如实记录）

| 项 | 原因 |
| --- | --- |
| ~~Open WebUI 的 Casdoor 登录~~ | **已解决**（2026-10-26 重建容器后打通）：compose 补 `extra_hosts` + `ENABLE_OAUTH_PERSISTENT_CONFIG=true`，并把 `lab-postgres` 的三个网络写入 compose，避免手工 `docker network connect` 在重建时丢失 |
| ~~Quantum 的 OIDC 登录~~ | **已解决**：客户端 `quantum` 已注册并启用，OIDC + 口令并行 |
| draw.io Embed Mode | 所用镜像不含 embed 应用（`/embed/index.html` 404），按要求改为独立页面 + 门户受控保存 |
| HTTPS | 按实验室决策不部署（内网可信链路）；风险已记录于 SECURITY.md |
| 客户端 DNS 接入 | 可选。**IP 直连不依赖 DNS**（`http://192.0.2.10/` 即门户）；需要域名时在客户端用 hosts 或把 DNS 指向 192.0.2.10 |
