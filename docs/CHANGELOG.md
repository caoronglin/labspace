# CHANGELOG.md

## 2026-11-24 — v2026.11.24 三端代码预览与统一认证切换

- **门户**：源码文件改为原生 `CodePreview` 优先，不再先交给第三方 OFV；
  增加 1000 行分段渲染、「显示后续」、自动换行与复制反馈。
- **生信平台**：工作区预览增加 NUL 字节嗅探，伪装成源码的二进制不会进入 JSON/DOM；
  预览弹窗同样支持分段渲染与换行；后端边界测试覆盖截断、超大文件和非法 UTF-8。
- **primer3**：序列预览增加分段渲染与换行开关；Apptainer 直接绑定 Vite 构建产物，
  避免提交哈希化 assets。
- **认证**：门户登录切换为账号口令直连；Casdoor 容器、8090 监听与旧 OIDC 同步服务正式下线，
  原 PostgreSQL 账号库保留；生信与 primer3 通过门户 OIDC 单点登录，并从 Nginx 同源路径访问。
  门户 OIDC 按白名单访问主机发布 issuer，生信回调同步使用当前 LAN/Tailscale 同源主机。
- **Agent 入口**：个人助手收敛为「对话 / 知识与记忆 / 能力中心」三项；知识库问答与长期记忆
  改为页内二级入口，实验记录统一回到个人工作台，旧深链自动重定向；能力中心移除重复知识库页签。
- **退出与侧栏**：登出只清理门户会话并回本地登录页，不再信任外部 logout URL；修复移动端
  子菜单无法展开，以及桌面折叠悬浮后子弹菜单随鼠标移入而收起的问题。
- **Ant Design CLI**：`antd doctor` 17/17 通过，`antd lint ./src` 从 49 项清零到 0；覆盖弃用 API、
  受控上传、静态 message、表格深导入与 v6 语义样式迁移。
- **回归**：新增门户长文件、生信工作区、primer3 序列三组端到端用例，并纳入全量套件；
  新增 Agent 入口收敛与本地登出回归，侧栏回归补移动端与悬浮弹层点击。

## 2026-11-22 — v2026.11.22.4 侧栏子菜单联动修复

- **根因**：子菜单 key 只用 `sub:<标签>`，而「实用工具 / 文件与数据 / 分析与写作」等
  sub 标签跨多个分组同名复用——AntD 把同 key 视为同一逻辑子菜单，点开一个，
  其他分组的同名子菜单同时展开（视觉审查实测：点一下联动开三个）。
  现在 key 按分组唯一（`<group>:sub:<标签>`），`subKeyOfPath` 同构改造。
- **附带**：折叠态一律忽略 `onOpenChange`（AntD 在 inline ↔ vertical 模式切换时会
  回灌空数组甚至部分 key 快照，此前的空数组守卫挡不住部分快照导致状态丢失）；
  侧栏 zIndex 25 → 15（低于页头 20），悬浮展开的阴影不再染脏页头底带。
- 回归用例升级：`sider-collapse-test`（6 项）——点一个只展开一个、第二个独立展开、
  离开回来保持、子菜单页面自动展开所属项。

## 2026-11-22 — v2026.11.22.3 后端路由拆分残留修复

重建后端镜像后暴露了 Phase 2 拆 `main.py` 时残留的路由注册损伤（旧镜像侥幸未命中）：
- `routers/auth.py` 的公告装饰器成了裸行；`routers/misc.py` 的公告函数无装饰器 → 迁移并注册。
- `routers/drawings.py` 的 8 条绘图路由和 3 个辅助函数完全丢失 → 从拆分前版本恢复并补齐 imports。
- `routers/network.py` 的 6 条孤儿装饰器链把 `/api/services`、`/api/favorites` 等
  错误绑定到 `api_databases`（返回结构错位），`/api/databases` 两条又被绑定成查询接口（422）
  → 清理孤儿链，把函数体与装饰器在 `catalog.py` 正确配对。
- 新增 `ops/check-route-wiring.py`：扫描所有 router 的「装饰器链必须以 def 结束」，
  防止后续拆分再次留下孤儿装饰器。

## 2026-11-22 — v2026.11.22.2 侧栏修复与 PubScholar 接入

- **侧栏折叠**：修复展开子菜单后鼠标离开即全部收起的问题。根因是 Sider 折叠时
  AntD 把 Menu 从 inline 切成 vertical 并回调空数组清空 openKeys；现在 openKeys
  始终受控且折叠态忽略那次清空。新增 `sider-collapse-test.mjs`（5 项）。
- **中科院 PubScholar 接入**（合规方式）：数据库目录新增条目（网页访问），
  文献检索页新增「PubScholar 检索」按钮，带当前关键词跳到
  `https://pubscholar.cn/explore?query=<词>`（已实测预填搜索框）。
  不爬取、不逆向其私有 API —— 平台条款明确禁止自动化访问。新增 `pubscholar-test.mjs`（6 项）。
- **修复重建后端镜像暴露的两处拆分回归**：
  - `routers/auth.py` 的 `from . import accounts` 改为绝对导入（重建后登录链路曾 403）；
  - `routers/network.py` 两条裸 `@router.get` 曾把 `api_databases_query` 错误注册成
    GET `/api/databases`（422），补回目录接口函数体后恢复。
  两处均为 Phase 2 拆 main.py 时残留、旧镜像侥幸未暴露的问题，重建镜像后修复。

## 2026-11-22 — v2026.11.22.1 帮助中心重构

- 帮助内容（`QUICK_START` / `ROLE_STARTS` / `FAQ`）抽到 `frontend/src/content/helpContent.tsx`，
  `Help.tsx` 480→338 行，只管渲染与交互；与 `releases.ts`（版本日志）形成「内容 / 页面」分离。
- FAQ 新增「代码预览」「多维表格」两节；删除已下线 CropGenome 的旧说明，
  序列分析改为指向现存的公共基因组 / 比对工具；双入口说明不再写死示例地址。
- 角色入口补齐「数据表格 / ACL 巡检」；顶栏搜索 placeholder 更新为当前检索能力。
- 版本号统一升到 `2026.11.22.1`（releases / package.json / FastAPI version），
  更新弹窗与帮助中心「当前版本」自动指向新条目。

## 2026-11-22 — v2026.11.22 代码预览与体验加固

面向用户的功能更新已同步到帮助中心 / 更新弹窗的数据源 `frontend/src/content/releases.ts`，
版本号 `CURRENT_VERSION` 自动指向首条记录，老用户下次进入工作台会看到一次性更新介绍。

**新增功能**
- **代码预览**：文件空间为 30+ 源码扩展名（`.py/.ts/.go/.rs/...`）与 Dockerfile / Makefile 等
  返回 `kind=code` + 语言 + 行数；前端等宽展示、行号、换行开关与一键复制，超 60k 字符服务端截断。
  线上 `/api/files/{id}/preview` 走 Go（labgo）优先，Python 侧作 fallback——两侧口径已对齐。
- **ACL 巡检与审计导出**：`/api/admin/acl/audit` 报孤儿身份 / 悬空目录授权 / 越权组可写三类异常；
  `/api/admin/audit` 支持按时间、操作人导出 JSON / CSV，写操作全落 `labspace.account_audit`。

**稳定性与体验**
- 统一身份认证：改密后强制校验（pwd_reset claim）、登录回跳与 SSO 链路修复。
- 路由与导航：10 条旧别名集中重定向并带埋点；侧栏按「工作区 / 文件与课题 / 分析与写作 / 科研工具 / 系统」分组。
- 多端布局：修复起始页 `BorderBeam outset` 导致的三档视口 2px 横向溢出。
- 双入口自适应：Host 受白名单约束，LAN / Tailscale 入口自动跟随。

**工程侧（详见 docs/PHASE2_ACCEPTANCE.md）**
- 巨石拆分：`BaserowPage` 3882→646、`Files` 2789→82、`api.ts` 2790→832、`main.py` 2072→497。
- 回归套件：一次性探针 167→2，`run-regression.sh` 全绿；新增 `code-preview-test.mjs`（8 项）。
- 门禁：tsc 0 error / vite ✓ / pytest 307 / go test -race 25 包 / 裸 hex 0 / e2e r19 全绿。

## 2026-11-20 晚 — 镜像拆分瘦身 / 台账写权限 / HITL 策略 / 前端清理

### 3. 科学计算栈拆出独立镜像（后端 3.24 GB → 1.32 GB）

| 镜像 | 之前 | 现在 | 说明 |
|---|---|---|---|
| `lab/labspace-backend` | 3.24 GB | **1.32 GB** | 只留门户需要的依赖 + LibreOffice/tesseract |
| `lab/labspace-latex` | （复用后端镜像） | **1.54 GB** | 只有 TeX Live + 基础依赖 |
| `lab/labspace-biotools` | （无） | **1.51 GB** | Biopython/scikit-bio/matplotlib 等 |

- 依赖拆成两组：`requirements-lock.txt`（37 包，基础）与 `requirements-biotools-lock.txt`
  （28 包，生信）；`pyproject.toml` 里生信三件套移到 `[project.optional-dependencies].biotools`。
- `backend/Dockerfile` 改成 5 个 target：`wheels` / `python-deps` / `backend` / `latex` / `biotools`。
- 生信成为独立服务 `lab-biotools`（8133，只连 compose 内网、**不发布宿主端口、不做鉴权**），
  门户新增 `app/biotools_proxy.py`：`/api/biotools/*` 做「鉴权 → 原样转发 → 原样回传」，
  支持 JSON / multipart / `image/png`，POST 走 CSRF 双提交。
- 构建期冒烟两次救场：缺 `libhdf5_serial_hl.so.310`（h5py 高阶库）与 `libgomp.so.1`（OpenMP）
  都会让 `import skbio` 在运行期才 500；现在构建阶段就 `import` 一次，装漏立刻停。
- 顺手修 `require_csrf`：抽成纯函数 `verify_csrf()`，代理层在函数体里调用它时不会再把
  FastAPI 的 `Header(...)`/`Cookie(...)` 哨兵当真实值（否则 `TypeError` → 500）。

### 7. `api.ts` 清掉 50 个没有调用点的封装

逐个复核（点取用 / 裸词取用 / `api[...]` 动态取用 / e2e 与 docs 引用）后删除 50 个方法与
21 个因此变成孤儿的导出类型，并在原处留注释说明「能力没有 UI 入口、服务端接口仍在」。

### 8. antd 6 弃用项全量替换

`Spin tip` → `description`、`Space direction` → `orientation`、`Drawer width` → `size`，
共 16 个文件 21 处；PlotStudio / BioTools 由拆分那条线一并处理。

### 9. 组件拆分降复杂度

`PlotStudio.tsx` 1067 → **622 行**（近似复杂度 78 → 53），抽出 `components/plot/`（参数面板、
AntV 预览、CSV 解析、参数默认值）；`BioTools` 抽出 `components/bio/ToolFieldInput.tsx`。

### 10. 小屏实测（390×844）

新增 `e2e/_small_screen.mjs`：`/drawio` `/plot` `/bio-tools` `/files` `/seeds` `/genomes` `/latex`
7 个页面**零横向溢出**、零 JS 异常、零 4xx（截图在 `/tmp/small-*.png`）。

### 11. 种子台账改为「登录即可写」

- 新增 `POST /api/baserow/seed/rows`、`PATCH /api/baserow/seed/rows/{row_id}`
  （`require_user` + CSRF）；写操作经 `baserow.admin_row_create/update` 用管理员令牌落到
  **服务端解析出来的**台账表（前端拿不到「写任意表」的入口），并记审计日志（含操作人）。
- 删除单条/批量、Excel 导入导出、表与字段结构仍然只有管理员。
- 前端种子页的「新建/编辑」改走新接口；`tests/test_seed_write.py` 4 条覆盖边界。

### 13. HITL：确认/问答界面此前是「死代码」

`LabToolMiddleware` 里 2026-11-10 写的 deny-shim（"门户没有确认入口，停在等确认会卡死"）会把
所有 ASK 一律拒掉，所以 2.0.12 新加的确认面板与 AskUser 表单**根本触发不到**。
现在：`AskUser`（纯问答、无副作用）放行 ASK；写文件 / Bash / 团队操作仍然拒绝（不给
"一键批准任意命令"留口子）。新增 `tests/test_hitl.py` 5 条：服务端重建事件形状、
不接受前端伪造 `rules`、`ask` 只认 `AskUser`。

> 真实往返（让模型自己发一次提问）**未完成**：MiniMax key 回
> `Rate limit or quota exceeded`，模型侧配额用尽，不是代码问题。

### 12. 其他

- 删除遗留目录 `/opt/lab-quantum`（先归档到 `/srv/labbackup/archives/retired-code/lab-quantum-20261120/`）。
- `latex_worker` 绑定地址改可配置（`LATEX_WORKER_BIND`），并补文件末尾换行。

**验证**：`pytest` **290 passed**；`tsc -b` 干净；`vite build` ✓；巡检 38 路由 0 问题；
`/api/biotools/*` 经代理实测（JSON / PNG / multipart / CSRF 403 / 未登录 401）；
学位论文模板经新 latex 镜像编译成功（46 KB PDF）。

## 2026-11-20 — 统一生信入口 + 导航重构 + 学位论文模板可编译

### A. 生信工具 `/bio-tools`（Biopython + scikit-bio，取代 CropGenome）

- 新增 `backend/app/biotools.py`：25 个端点，一个入口做完序列层面的事
  - 序列：分析（GC/互补/转录/三框翻译/理化参数）、CDS 提取、格式互转（GenBank/FASTA/EMBL）、
    ORF 六框、GC 滑窗 + k-mer、单/三字母互转 + 专利排版
  - 克隆：限制酶切（内置 30 种酶）、去载体/接头、质粒图谱（dna-features-viewer，PNG/SVG）
  - 蛋白与引物：ProtParam（MW/pI/GRAVY/芳香性/不稳定指数/消光系数）、Tm（NN/GC/Wallace）、稀释换算
  - 比对与进化：双序列（全局/局部/半全局）、多序列（星型渐进，docstring 写明不是 MSA 最优解）、
    NJ 树、Newick ↔ JSON/文本树、PCoA
  - 测序与批处理：`.ab1` 峰图解析（质量 + Mott 裁剪）、SeqIO 批量筛选（长度/GC/名称正则）
  - 外部：Entrez / BLAST —— 本机无外网，**3 秒快速失败**并给中文提示，不挂在请求上等超时
  - 上限与错误全部本地化（2 MB 源码、1 MB ab1、20 MB 序列文件；非法输入 400 说明原因）
- 前端新增 `src/pages/BioTools.tsx`（antd 自绘，抽屉式分组 + 结果表格/比对视图/图谱预览），
  导航「分析与写作 → 生信工具」。请求 URL 走**端点白名单**（`endpointOf()`），不接受运行时拼接。
- `src/pages/Genomes.tsx` 收缩为「只负责浏览」：JBrowse 2 轨道 + 公共基因组文件表，
  顶部加「生信工具」入口；删除 `components/genome/{GenomeTools,ResultActions}.tsx`。
- 依赖与镜像：新增 `biopython==1.88`、`scikit-bio==0.7.4`、`dna-features-viewer==3.1.5`。
  这三个在 Python 3.15 上**没有 manylinux 轮子**（scikit-bio/biom-format/h5py 需源码编译），
  因此 `backend/Dockerfile` 改成两阶段：`wheels` 阶段装 gcc/HDF5 做 wheel，运行时镜像只装
  wheel 并补 `libhdf5-310`（h5py 动态链接系统 HDF5，缺了 `import skbio` 直接失败）。
  `requirements-lock.txt` 重生成（37 → 65 个包，保留原有 pin，只新增传递依赖）。
- 测试：`backend/tests/test_biotools.py` 51 条（含非法序列、空输入、过大上传、未知格式）。

### B. 前端导航与工具入口重构

- `/tools` 三合一入口**拆成三个独立页面**：`/drawio`（流程图设计）、`/plot`（绘图工作台）、
  `/genomes`（公共基因组），各自带标题条；`/tools?tool=…` 与 `/tools` 走兼容重定向，不 404。
- `/drawings`（我的图形）并进 `/drawio` 的抽屉：列表/重命名/删除/导出到个人目录全保留，
  `/drawings` 重定向到 `/drawio?panel=drawings`。
- `/plot` 交互简化：5 个一键预设（柱状·分组/折线·趋势/散点·回归/火山图/热图）点一下即出预览；
  高级参数默认折叠；列名改为下拉并按语义收窄（y 只给数值列）。
  最短路径从「10+ 次交互」降到 **2 次点击出成品图**。
- 子菜单去重：「实验工具」+「学习与小工具」合并为「实用工具」（`NAV_SUBS` 5 → 4）。
- 「文件存储」改名「文件空间」，与首页快捷入口一致；导航/引导/帮助文案同步。
- 分组键收紧为 `work | research | admin`，修掉 `/start` 的 `group: 'tools'` 与
  `/weather`、`/network` 的 `'learn'` 死枚举（原来会被静默隐藏）。

### C. LaTeX 学位论文模板「开箱不可编译」

- 现象：选「西农学位论文骨架」直接编译，xelatex 停在 `File 'nwafuthesis.cls' not found`，
  随后卡在交互提示符 `Enter file name: → Emergency stop`。
- 根因两条：模板 `\documentclass{nwafuthesis}` 依赖的类文件不在仓库里；模板还 `\include`
  了 9 个根本不存在的子文件。
- 修复：模板改为**自包含 `ctexbook`** 学位论文骨架（封面/中英文摘要/目录/章节/参考文献/致谢），
  实测编译通过（86 KB PDF）；官方类文件路径保留在注释里（上传 `.cls` 后改一行即可）。
- 编译 sidecar 增加**编译前检查**：缺 `.cls` 或 `\include` 的子文件时直接返回
  「缺少文档类 nwafuthesis.cls / 把缺的文件用右侧「素材」上传」，不再让用户面对 TeX 交互提示符。
- `docx2latex` 的 `nwafu` 模板同步改成 ctexbook 骨架（原来也是直接写 `\documentclass{nwafuthesis}`）。
- 顺手：`latex_worker` 的数值环境变量改走 `_env_int()`（手误不再让 sidecar 反复重启）；
  删除从未被调用、且会抛未捕获异常的 `convert_docx_path()`。

**验证**：`pytest` **275 passed**（新增 51 条 biotools + 修 2 条模板断言）；
`go build ./...` + `go test ./...` 全绿；`tsc -b` 干净；`vite build` ✓；
全局巡检 **38 条路由，老师 / 学生均 0 问题**；`/api/biotools/*` 实测
（分析/酶切/ORF/比对/质粒图谱 PNG）；学位论文模板经真实编译接口产出 86 KB PDF。

## 2026-11-20 — 下架文档解析页 + 垃圾清理

### 下架 CropGenome（rust-bio 序列服务）

rust-bio 生态停更、`/usr/local/bin/cropgenome` 没有源码无法升级，而序列层面的需求
已经由门户内置生信工具承接，两个入口只会让人问「我该在哪儿做」。

- 停用 `cropgenome-api.service` / `cropgenome-worker.service`，删除二进制、`/opt/cropgenome`
  与前端静态产物目录。
- nginx 删掉 `/cropgenome/api/`、`/cropgenome/`、`/cropgenome/assets/` 三段 location，
  原地留注释指向 `/bio-tools`。
- 服务目录 `jbrowse` 条目文案：`Engine` 改为 `JBrowse 2 + Biopython / scikit-bio`。
- 前端 `api.ts` 改调 `/api/biotools/*`；`ops/` 删掉四个只为该服务存在的 CI/部署脚本。
- 数据库 `cropgenome` **未删**（备份照旧）。原因、清单与回滚步骤见
  **`docs/RETIRE-CROPGENOME.md`**。

### 下架 `/docparse`（文档解析页）

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

### 数据表令牌刷新的真实故障（顺手修复）

`/lab`（多维表格）停留约 20 分钟后所有请求开始 401（`ERROR_INVALID_ACCESS_TOKEN`），
刷新页面也没用：`_token(force=True)` 按**门户邮箱**（`x@local`）清缓存，而
`_user_token` 按**数据表身份**（`x@labspace.local`）写缓存 —— 键不一致，“刷新”拿回的
还是那个过期令牌。修复缓存键并让 TTL（18 分钟）短于 Baserow 的 JWT 有效期；
新增 `backend/tests/test_baserow_token_refresh.py`（去掉修复即 FAIL，已实证）。

### 垃圾清理

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

- 新增 [docs/USER_GUIDE.md](USER_GUIDE.md)：面向实验室成员的完整使用说明，
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

## 2026-11-09 — 实验记录并入工作台 + 文件列表类型图标 + 任务清单归档

### 实验记录（ELN）整合到个人工作台
- `frontend/src/pages/Workbench.tsx`：新增「实验记录」页签，懒加载 `lab/ElnPanel`，页签状态写入 URL（`/workbench?tab=records` 可直达/分享）；任务、每日文献、计划、项目、指派、成长、简报等原有页签行为不变。
- `frontend/src/pages/lab/ElnPanel.tsx`：改为内嵌式「工具栏 + 表格」，去掉与外层重复的 Card；搜索、模板筛选、新建/编辑抽屉、状态、标签、转任务、存知识库、删除全部保留。
- `frontend/src/pages/Lab.tsx`：移除实验记录页签，默认落到库存台账；`/lab?tab=eln` 重定向到 `/workbench?tab=records`，`/lab?tab=bookings` 仍跳转 `/agent?mode=lab`。
- `frontend/src/app/navigation.tsx`：个人工作台导航补充 `eln / 实验记录 / 实验` 关键词。
- Agent 个人助手的「实验记录」模式复用同一面板，未受影响。
- 验证：`npm run build` 通过；新增 `e2e/_workbench_eln.mjs` 13 项全 PASS（旧入口重定向、页签选中、新建/回显/转任务/删除、默认页签、URL 写回、Agent 模式、无前端异常）；`e2e/_latex_ui.mjs` 回归 ALL PASS。

### 文件管理：列表视图按类型着色图标
- `frontend/src/pages/Files.tsx`：列表视图「名称」列不再统一用灰色 `FileOutlined`，改为复用 `fileVisual(name, dir)`，按扩展名显示图片/PDF/Excel/PPT/Word/压缩包/文本/代码/生信/视频/音频/文件夹图标及对应颜色，与网格、详情、时间线三个视图保持一致。
- `e2e/_files_write_verify.mjs`：登录等待由固定 5s 改为等待门户正文出现（最长 30s），并自动关闭首次登录欢迎弹窗，避免 Casdoor 跳转耗时波动导致的偶发失败。
- 验证：`npm run build` 通过；文件管理写/排序/用量/时间列回归脚本已修正登录等待（本轮未重跑）。

### 任务清单归档
- 新增 `docs/TASKS.md` 作为长期任务清单快照：记录全部已完成项的分组汇总、当前无进行中任务，以及需外部条件才能启用的两项能力（SiliconFlow 决策模型、RAG 生成模型）。

## 2026-11-06 — 账号创建原子化 + 文件权限管理

- **账号供给闭环**：新建账号时，LabGo 同步创建 `/srv/lab/users/<name>`，并原子写入个人可写、公共/课程只读的文件作用域；LabGo 不可达时后端回滚 Casdoor 记录并返回 502，避免“能登录但没有个人文件空间”的半成品账号。
- **文件权限管理**：账号编辑弹窗新增“项目共享目录”授权（来自 `/srv/lab/projects` 的真实目录），保存后立即生效；管理页表格展示每个账号的共享目录。个人目录仍只对本人可见，管理员不可浏览。
- **LabGo 内部管理接口**：新增 `POST /v1/admin/provision`、`GET/PUT /v1/admin/file-access`，仅接受服务令牌、不经 Nginx 暴露；ACL 写入保留 `admins`/`source`/`exported_at` 等未知顶层字段，失败即回滚内存状态。
- **ACL 存储可写**：`/etc/lab-go/acl/labgo-acl.json`（目录 2770、文件 660，systemd 仅放行该子目录）；旧路径保留符号链接；备份清单新增 `/etc/lab-go`。
- **账号 UI**：用户名自动带出 `@local` 邮箱、内网邮箱校验修复（原 AntD `email` 规则拒绝 `@local`）、角色快速预设、强口令生成、创建/重置后一次性口令交付摘要（可复制），移动端表格可横向滚动。
- **测试**：新增 `labfiles` 供给/项目授权单测、`httpapi` 管理接口鉴权单测；`_accounts_native.mjs` 真实浏览器全流程通过（创建→授权→登录→上传→越权隔离），并实测 LabGo 停机时创建账号回滚。

## 2026-11-05（晚）— 依赖全量锁定到最新版 + 旧代码安全加固（第一方代码审计 21 项修复）

### 依赖

- **前端三个工程全部改为精确版本**（新增 `.npmrc` 的 `save-exact=true`）：
  `labspace/frontend`、`bioinfo-training/frontend`、`cropgenome-toolkit/frontend` —— antd `6.6.8→6.7.0`、
  @tanstack/react-query `5.105.x→5.106.1`、vite `8.3.5→8.3.6`、@vitejs/plugin-react `6.1.2/6.2.1→6.2.1`、
  typescript 锁 5.9.3、playwright 锁 1.64.1（浏览器二进制与 revision 精确匹配，**不升**）。
- **Python 依赖升到当前最新**：fastapi `0.115.6/0.136.3→0.162.0`、starlette `0.41.3→1.10.0`、pydantic `2.10.4→2.14.2`、
  pydantic-settings `2.7.0→2.16.2`、sqlalchemy `2.0.36→2.1.8`、alembic `1.14.0→1.20.1`、uvicorn `0.34.0→0.54.0`、
  PyJWT `2.10.1/2.14.0→2.15.1`、python-multipart `0.0.20/0.0.32→0.0.33`、psutil `6.1.1→7.2.2`、
  pytest `8.3.4→9.2.0`、pytest-asyncio `0.25.0→1.4.1.post1`。
- **门户后端镜像瘦身**：基础镜像由 `openwebui/open-webui:0.12.2-slim`（179 个包，含 langsmith / httpx2 / openai / boto3 / azure-* / black / alembic 等与门户无关的依赖）改为官方 `python:3.11-slim`；
  新增 `backend/requirements-lock.txt`（29 个包的**全量**锁定，含传递依赖）→ 镜像 **873MB → 286MB**，依赖面同时收敛。
- **仓库锁文件修复**：`labspace/pnpm-lock.yaml` 原为 158 行的残缺文件（只含 pnpm 自举 importer，缺 frontend/e2e）→ 换回完整锁文件（2306 行，222 resolution），`pnpm install --frozen-lockfile` 通过。

### 安全加固（第一方代码审计发现，逐条修复）

- **认证绕过（最严重）**：`backend/app/casdoor.py` 在 Casdoor discovery 缺 `jwks_uri` 或 userinfo 拉取失败时，会退化到**不验签**地解析 id_token，而 `main.py` 的 `merged = {**info, **claims}` 又让 `roles` 可能取自未验签数据 → 角色可被伪造。
  现改为：缺 `jwks_uri` 直接 401（失败关闭）；userinfo 异常时不再返回未验签 claims；`jwt.decode` 的 algorithms 由 `["RS256","ES256","HS256"]` 收窄为 `["RS256","ES256"]`（消除 HS256 算法混淆）。
- **URL 注入**：`db_apis.py` 的 KEGG `space` 参数未校验就拼进上游 URL → 增加 `KEGG_SPACES` 白名单。
- **gzip 炸弹**：`http.py` 的 `strip_residual_gzip` 无上限解压 → 改为分块解压 + 32MiB 上限。
- **CSRF 缺口**：`POST /api/databases/{id}/query` 缺 CSRF 校验 → 补 `require_csrf`（Bearer / 服务令牌调用豁免）。
- **内存打满**：`snapotter.py` 与 `docparse.py` 先整包读入内存再判大小 → 新增 `backend/app/uploads.py::read_upload_capped`（1MiB 分块 + 上限）。
- **公网上传泄露**：`docparse.py` 默认把用户 PDF 发到公网 `free-oxr.somark.ai` → 改为默认只用内网 Docling，公网 OXR 需显式 `LABSPACE_OXR_ALLOW_EXTERNAL=1`。
- **无限并发 SSE**：`agent.py::stream_session` 无并发上限 → 新增 `MAX_CONCURRENT_STREAMS=3` 与信号量。
- **Bearer 与 Cookie 不一致**：`security.py` 的 `require_admin` / `require_teacher` 只认 Cookie → 同时支持 `Authorization: Bearer`。
- **会话撤权不生效**：`bioinfo-training/backend/app/security.py::sync_roles` 只加角色从不删 → 改为双向同步（Casdoor 组被移除时同步回收 `granted_by="casdoor"` 的角色）。
- **OIDC 校验缺失**：`bioinfo-training/backend/app/oidc.py` 未校验 issuer → 补 `issuer=`；`config.py` 新增 `validate_startup()`，密钥仍是示例默认值时**拒绝启动**（原来 state 用公开常量签名，任何人都能伪造登录 CSRF）。
- **终端容量准入失效**：`terminal.py` / `routers/terminal.py` 用带横线 UUID 查 cgroup → 查不到时回落整机根 cgroup，内存指标失真 → 改用 `unit_sid`（32 位 hex）。
- **上传无上限**：`bioinfo-training/backend/app/routers/submissions.py` 的 `copyfileobj` 无大小限制 → 改为分块写入 + 512MiB 上限。
- **口令进 argv**：`/usr/local/bin/lab-sync-passwords` 把明文口令作为 python 参数传入（`/proc/*/cmdline` 可见）→ 改为 stdin 传入。
- **nginx 安全头丢失**：location 级 `add_header` 会**整体替换** server 级安全头 → 新增 `deploy/nginx/lab-security-headers.conf` 片段，所有自带 `add_header` 的 location 与 8086/8090/8091 三个 server 块统一 include。
- **限流形同虚设**：nginx 定义了 `limit_req_zone` 却从未挂 `limit_req` → 现已在 `/api/`（`rate=50r/s burst=100` + `limit_conn 200`）与 Casdoor 登录路径（`rate=60r/m burst=10`，覆盖 `POST /api/get-account`）真正启用（实测：400 并发 → 128×200 / 272×503；普通访问 300 次全通过）。
- **Go 侧**：`session.go` 无 `exp` 的令牌视为永不过期 → 改为直接拒绝；`newVault()` 密钥长度判断 `<16` 与 `vault.New` 要求的 32 字节不一致 → 改为 `!= 32` 并告警。

### 修复的既有缺陷

- **`db.scalors()` 拼写错误**（`bioinfo-training/backend/app/security.py`）：SQLAlchemy 2.1 移除了这个「碰巧能用」的属性，OIDC 回调直接 500 → 改为 `db.scalars()`。**这是升级依赖暴露出的真实 bug**，升级前一直潜伏。
- **`e2e/cropgenome-test.mjs` 竞态**：门户首页对未登录用户会跳转 `/login`，`page.evaluate(fetch)` 被导航打断（"Execution context was destroyed"）→ 改用 Playwright 的 `APIRequestContext`（`page.request`），不再依赖页面上下文。

### 验证

- 全量回归 28 个脚本：除上游 NCBI/EBI 波动导致的 `api-integration`（PubMed）、`db-api-integration`、`databases-api-ui`、`biomed-api-test` 外全部通过（NCBI eutils 侧 `esearch` 当前返回 `Search Backend failed … Cannot connect to SOLR`，属上游故障）。
- 门户容器依赖 179 → 35 个包；镜像 873MB → 286MB；`bioinfo-api-smoke.mjs` 7/7、`bioinfo-terminal-test.mjs` 7/7、`agent-integration.mjs` 20/20、`cropgenome-test.mjs` 6/6、OIDC 全流程通过。
- nginx 安全头逐 location 实测存在；限流实测生效。


## 2026-11-05 — 修复 Tailscale 入口 502 Bad Gateway（取消 OIDC issuer 自动跟随，改显式切换）

### 修复

- **502 Bad Gateway 根因**：`_auto_sso_follow` 中间件（`backend/app/main.py`）在**每个** `/api/*` 请求后按来访客户端网段自动把 Open WebUI / Quantum 的 OIDC issuer 切到对应入口主机；切换必须 `docker compose up -d` 重建容器（约 30s），期间直连 `:3000` / `:8080` 会命中 Docker **docker-proxy 的 502**。内网与 Tailscale 用户交替访问时容器被反复重建，502 反复出现。
  已实测复现：Playwright 访问 Tailscale 入口触发翻转 → `lab-open-webui`/`lab-quantum` 的 `StartedAt` 同步变化 → 用户随后访问即 502。
  现改为：浏览行为**只观测**客户端网段（记入 `sso_status.auto.lastSeenIp/lastSeenHost`），**不再**触发任何容器重建；issuer 只在用户明确点击「一键登录」时（`/api/sso/{id}/prepare`）切换，且宿主机 `ops/oidc-sync.py` 会**等容器 healthy** 才返回登录地址。
- **前端入口统一走中转页**：服务详情页「打开服务」（`pages/ServiceDetail.tsx`）与 Start 页入口清单（`components/AccessGuide.tsx`）中的 Open WebUI / Quantum 改为跳门户 `/sso/:id`，避免直接打端口时 issuer 未切换而被指向不可达的内网地址。
- **`e2e/ip-adaptive-test.mjs` 断言修正**：原断言“页面正文不得出现另一入口 IP”与 Start 页刻意展示两个入口地址的 UI 冲突 → 改为只校验“链接不得指向另一入口”（正文展示两个入口是有意设计）。

### 新增

- **`e2e/sso-no-thrash-test.mjs`**（6/6 通过，并入 `e2e/run-regression.sh`）：验证交替访问不重建容器、issuer 不被浏览行为改动、未登录调用 prepare 被拒（401）、浏览器走 `/sso/:id` 中转页能免密进入 Quantum。
- **Tailscale 端口自检脚本** `e2e/tailscale-port-check.sh` / `.bat`（已放到前端 `public/`，门户可直接下载）：`tailscale ping` + 11 个端口探测 + 判读建议。
- **模型 API 巡检改用 MagicDNS**：`lab-health` 第 4 段由写死的 `100.64.0.10:7997` 改为解析 `wsd509.tail5817aa.ts.net`（当前解析到 `100.100.161.104`，该 Windows 主机已离线 19 天）→ 告警文案可区分“主机离线”与“端口被拦”。

### 验证

- `ip-adaptive-test.mjs` 17/17、`sso-no-thrash-test.mjs` 6/6、`sso-flow.mjs` 6 个服务全免密、`tailscale-access-test.mjs` 5/5。
- 交替访问后 `docker inspect lab-open-webui lab-quantum` 的 `StartedAt` **完全不变**（修复前会变）。
- 服务端 Tailscale 放行逐层核实：nftables `svc_ports` 含全部端口、`ts_net=100.64.0.0/10`、iptables `ts-input` 放行 `tailscale0`、Tailscale tailnet ACL 允许全端口、监听地址均 `0.0.0.0`、Casdoor `redirect_uris` 与 `LABSPACE_ALLOWED_ORIGINS` 均含 `198.51.100.71`。

## 2026-11-04（晚）— 从 CNB 拉取适配：Go 核心跑通 PostgreSQL、CropGenome 上线、语料接线、清理旧服务

### 新增

- **CropGenome Toolkit 接入**（CNB 新项目：Go 网关 + Python 离线导入管线）：
  - 服务 `cropgenome-api.service` / `cropgenome-worker.service`（用户 `cropapi` / `cropworker`，
    库 `cropgenome` 位于 `lab-postgres`，监听 `127.0.0.1:8095`，`CROP_DEV_MODE` 不开启）。
  - `go-core/internal/httpapi/cropgenome.go`：Go 核心充当 **OIDC 感知反向代理** ——
    校验门户会话 → 注入 `X-OIDC-Subject` / `X-OIDC-Issuer` / `X-OIDC-Audience` / `X-OIDC-Role` →
    转发到工具服务；客户端自带的 `X-OIDC-*` / `X-Crop-Dev-*` 头会被剥离，写操作还必须带 CSRF 证明。
  - nginx 新增 `location /cropgenome/`（透传 Host）；服务目录新增「CropGenome 作物基因组工具箱」条目。
  - 新增 E2E `e2e/cropgenome-test.mjs`（6/6 通过）。
  - 七物种数据集 manifest 全部 `not_provisioned`（不伪造 checksum），当前仅 API 契约可用。
- **`go-core/internal/pgwire`**：纯标准库实现的 PostgreSQL v3 wire 驱动（支持 trust / cleartext /
  md5 / SCRAM-SHA-256；**不支持 TLS**，需 `sslmode=disable`），使 Go 核心在零外部依赖前提下直连现网库。
- **E2E `e2e/workbench-parity.mjs`**：Go 工作台与 Python 旧实现的逐字段对照。

### 修复

- **`internal/pgwire` 的 4 个真实缺陷**（详见 `docs/GO_CORE_REPLACEMENT.md` 8.1）：
  DSN URI 被当成键值对解析；SCRAM 握手缺 GS2 头 `n,,`；Execute 消息少 1 字节；ErrorResponse 后
  未读到 ReadyForQuery 导致连接失步。
- **Go 工作台与 Python 对齐**：裸 NULL 参数改为 `CAST(? AS text) IS NULL`；会话 `UserID` 改用 JWT `sub`；
  可空字段改为 `*string`（输出 `null` 而非省略）；时间戳统一 ISO-8601。
- **Python `workbench.summary()` 500**（`PoolError: connection pool exhausted`）：
  `db.py` 新增 `query_many()`，`summary()` 的 12 路并发查询改为单连接批量执行。
- **语料索引未接线**：CNB 版本 `Build(nil, nil, nil)` + 缺 `LABGO_CORPUS_DATA` → 本地命中为 0。
  现按语料包设计接线（服务来自 Go 目录、命令来自命令索引、SnapOtter 工具来自工具目录），
  启动日志打印 `corpus: 1012 entries`。
- **上游二次 gzip**（`proteinatlas.org`）：`app/http.py` 新增 `strip_residual_gzip()`，
  最多解 3 层并修正 `Content-Encoding`；`hpa` 适配器恢复真实返回。

### 变更

- Go 核心补齐语料三源环境变量：`LABGO_CORPUS_DATA`、`LABGO_COMMANDS_FILE`、
  `SNAPOTTER_BASE_URL`（宿主地址 `http://127.0.0.1:8092`）、`SNAPOTTER_API_KEY`。
- `internal/catalog` 服务目录新增 `cropgenome` 条目（学生可见 13 条、导出 14 条），单测计数同步。

### 清理（已确认不再使用）

- 停止 8 个僵留 `bioinfo-term-*` 终端会话单元（数据库里状态已是 `stopped`、无客户端）。
- 删除含凭据的旧备份 `deploy/.env.bak.1793517976`。
- 删除未使用镜像 `openwebui/open-webui:0.12.2-slim`、`alpine:3.20`；删除同 image ID 的冗余标签 2 个。
- 删除孤立网络 `lab-quantum_default`、`labspace`；删除 4 个未使用匿名卷；删除测试 netns `labtest`。
- 清理 `/tmp` 残留：`node26.tar.xz`、`snapotter.tar.gz`、`pmt`、`labspace-venv`（保留 Go 构建缓存 `/tmp/gocache`）。
- 保留仍在使用：Tika（Open WebUI 文档抽取）、oikb 同步、`lab-backup` / `lab-health` / `lab-sync-passwords` 定时器。

## 2026-11-04 — Go 核心（LabGo）接管统一语料 / 全局搜索

### 新增

- **共享静态语料文件** `/opt/labspace/shared/corpus-data.json`（52KB，version=1）：
  数据库目录 107 条、门户页面 15 条、浏览器工具 12 条、SnapOtter 分区中文名与别名 139 条、
  热搜词 15 条、检索分类 8 条。
  由 `ops/export-corpus-data.py` 只读现网模块导出（`python3 ../ops/export-corpus-data.py`）。
- **`backend/app/searchconfig.py`**：检索分类与别名的单一来源（`SEARCH_CATEGORIES`、
  `CATEGORY_ALIASES`、`normalize_category()`），Python 与 Go 共用。
- **Go 新包**：`internal/corpus`（语料索引：打分 / 类型配额 / overflow / 分桶 / 联想 / 数据库检索）、
  `internal/commands`（Linux 命令索引）、`internal/snapotter`（SnapOtter openapi.yaml 解析）、
  `internal/websearch`（SearXNG 联网检索）。
- **Go 新接口**：`GET /v1/corpus`、`/v1/corpus/suggest`、`/v1/corpus/databases`、
  `/v1/portal/search`、`/v1/portal/search/categories`。
- **`ops/corpus-parity.py`**：Go 核心与 Python 旧实现的逐项对照脚本（容器内执行）。
- **`internal/httpapi` 服务令牌**：请求头 `X-Lab-Service-Token` + `LABSPACE_SERVICE_TOKEN`
  （常量时间比较），供 pi 插件等内部只读调用，与 Python 的服务令牌语义一致。

### 变更

- **统一语料 / 全局搜索改由 Go 接管**：
  - nginx 新增精确匹配转发：`/api/corpus`、`/api/search`、`/api/search/suggest`、
    `/api/search/categories` → LabGo（均透传 Host）。
  - `backend/app/golink.py` 新增 `corpus_query` / `corpus_suggest` / `corpus_databases` /
    `portal_search` / `search_categories`；Python 的 4 个路由改为「先调 Go，不可达才回退本地实现」。
  - Go 的分类别名表与 Python 对齐（「scholarly」→ `scientific publications`）；
    `scope` 默认值统一为 `web`；`engines` / `error` 无值时输出 `null`（与 Python 的 `None` 一致）。
  - 完整替换矩阵与回滚步骤见 `docs/GO_CORE_REPLACEMENT.md` 第 2、4.1 节。
- **Go 不可用时自动兼顶**：Python 侧为 9 个处理函数额外注册 `/v1/*` 同路径别名，
  nginx 上游改为 `labgo_fallback`（Go 主 + Python `backup`）并启用 `proxy_next_upstream`；
  实测停掉 `labgo` 后 `/api/services` 仍返回 200。

### 修复

- **Go 语料分词未做小写化**：Python 的 `_tokens()` 会 `.lower()`，Go 漏了 → 大写查询（`NCBI`）搜不到。
- **SnapOtter 工具标题串位**：Go 的 openapi.yaml 逐行解析遇到三段式路径
  （`/api/v1/tools/image/strip-metadata/inspect`）不结束当前工具块 →
  下一个工具的 summary 覆盖上一个工具的标题（`image/html-to-image` 被写成 `Inspect metadata`）。
- **命令索引顺序随机**：Go 的 map 迭代顺序随机 → 命令分桶顺序不稳定；现按名称排序（与 Python 的 JSON 字母序一致）。
- **YAML 引号未剥离**：`summary: "AAC to FLAC"` 在 Go 侧保留了引号（PyYAML 会剥）；新增 `cleanScalar()`。
- **Python 侧 SnapOtter 目录只预热一次**：启动瞬间未就绪 → 语料永久缺 243 个文件处理工具；
  现启动重试 3 次 + 每 600 秒后台刷新。
- **后台刷新任务阻塞启动**：把无限循环直接挂在 `@app.on_event("startup")` 上会让应用启动永远不完成
  （容器 healthy 失败、页面登录超时）；改为 `asyncio.create_task`。

### 测试

- Go：`go build ./...`、`go vet ./...`、`go test ./...` 全绿（新增 `internal/snapotter` 5 例）。
- 一致性对照：`ops/corpus-parity.py` → 语料检索 / 空查询分桶 / 搜索建议 / 热搜 / 数据库目录全部 0 差异。
- `e2e/api-integration.mjs` → 51/51（含 `/api/search`、`/api/corpus`）。

## 2026-11-03 — Go 核心（LabGo）替换 Python 服务目录模块

### 新增

- **Go 核心服务 LabGo**（`/opt/labspace/go-core`，systemd `labgo`）：纯标准库、零外部依赖。
  - 监听 `127.0.0.1:8122`（nginx / 宿主机）与 `172.28.0.1:8122`（Docker 网桥，供后端容器调用，
    与 pi RPC 网关同一模式）；不使用时关闭网桥监听即可。
  - 自带会话校验（复用门户 `LABSPACE_SESSION_SECRET`，手写 HS256 + CSRF 双提交校验），
    浏览器请求不再经过 Python 网关。
  - 新增包：`internal/session`（会话/CSRF）、`internal/labfiles`（量子目录只读索引与授权）、
    `internal/health`（服务探活）、`internal/embed`（iframe 可嵌入探测）、`internal/catalog`（服务注册表）、
    `internal/endpoints`（容器地址占位符）、`internal/platform`、`internal/guard`、`internal/policy` 等。
  - 运维：`/usr/local/bin/labgo-acl-sync`（从量子 sqlite 导出 scope ACL）、
    `/usr/local/bin/labgo-endpoint-sync`（systemd 定时器，维护容器 IP 映射）、
    `/etc/lab-go/labgo.env`（0640 root:labuser）。

### 变更

- **服务目录 / 健康检查 / 内嵌探测改由 Go 接管**（替换 Python 实现）：
  - `GET /api/services`、`/api/services/health`、`/api/services/<id>/health`、
    `/api/services/<id>/embed`、`/api/services/<id>/sso` → nginx 直转 LabGo（`/v1/services*`）。
  - `backend/app/catalog.py` 不再持有服务清单，改为读取 Go 导出的
    `/srv/labdata/labgo/catalog.json`（容器内只读挂载 `/srv/labgo`，15 秒缓存 + 解析失败保留旧值）。
  - `backend/app/embed.py` **已删除**，探测由 `internal/embed` 执行。
  - `backend/app/golink.py` 新增：Python → Go 调用桥（`LABSPACE_LABGO_BASE`，默认 `http://172.28.0.1:8122`）。
  - `GET /api/admin/health` 改为委托 Go 逐服务探测。
  - 完整替换矩阵与回滚步骤见 `docs/GO_CORE_REPLACEMENT.md`。
- `lab-health` 新增「3.0 Go 核心」巡检段：服务状态、`/healthz`、网桥监听、目录导出新鲜度、
  端点同步定时器。

### 修复

- **目录字段被单个请求的主机污染**：`adaptItem()` 直接改写与注册表共享底层数组的 `Guide` 切片，
  某次访问的主机（如 `127.0.0.1`）会永久写进目录并被导出到文件。修复：适配前深拷贝切片。
- **nginx 未透传 Host**：Go 侧收到 `Host: labgo`（nginx 默认 `$proxy_host`），
  服务地址被改成不可达的 `http://labgo:8082/`。修复：location 内显式 `proxy_set_header Host $host;`。
- **空值形状不一致**：Go 输出 `roles: null` / `embedUrl: ""`，与 Python 的 `[]` / 回退到 url 不一致；
  现已对齐。
- **`external-down` 语义位置放错**：外部内网服务故障归外部主机，只应在批量健康接口改写，
  单条接口不改写——替换时一度反了，现与原实现一致。
- **Origin 白名单残留废弃域名**：`LABSPACE_ALLOWED_ORIGINS` 仍含 `http://portal.lab.internal`，
  且缺 Tailscale 入口（导致从 Tailscale 发起的写操作被拒）。现统一为
  `http://192.0.2.10,http://198.51.100.71`（后端与 Go 核心一致）。

### 测试

- Go：`go build` / `go vet` / `go test ./...` 全绿（新增 `internal/embed` 9 例）。
- `e2e/catalog-parity.mjs`（新增）：Go 与 Python 兼容实现的 16 字段逐项对照，学生/管理员两角色 0 差异。
- `e2e/go-next-api.mjs`：14/14（匿名 401、目录隔离、预览/下载、越权 404、CSRF 403、管理员可见）。

## 2026-11-02（晚） — 入口自适应（IP 自适应）+ 重置初始化 + 生信平台终端链路修复

### 新增

- **入口自适应（IP 自适应）**：从哪个入口进入，门户内所有服务地址就跟随同一个主机。
  - 后端：`backend/app/catalog.py::adapt_host()` + `main.py::_client_host()`，作用于
    `/api/services`、`/api/services/health`、`/api/network/entries`、`/api/search`、`/api/corpus`。
  - 前端：新增 `frontend/src/utils/host.ts`（`currentHost()` / `hostUrl()`），清除 27 处硬编码 IP。
  - 第三方服务 OIDC：新增宿主机辅助服务 `ops/oidc-sync.py`（systemd `lab-oidc-sync`，
    监听 `172.28.0.1:8111`，`X-Ops-Token` 鉴权）+ 后端 `backend/app/sso.py`
    （`GET /api/sso/status`、`GET /api/sso/{id}/prepare`）+ 前端 `/sso/:serviceId` 中转页。
  - 测试：`e2e/ip-adaptive-test.mjs`(15/15)、`e2e/sso-e2e-test.mjs`(4/4)。

### 修复

- **Open WebUI / Quantum 的 OIDC issuer 写死**：两者都把 Casdoor 地址写死，远程用户（经 Tailscale
  进入）会被指向不可达的内网 IP。现改为点「一键登录」时按当前入口主机切换，并自动把回调地址
  登记进 Casdoor `application.redirect_uris`。
  - 关键事实：Open WebUI 的 `oauth.*` 真值是**容器环境变量**（`ENABLE_OAUTH_PERSISTENT_CONFIG`
    未开启时数据库里的 `oauth.*` 不生效）；Quantum 的 issuer 真值是
    `/etc/lab-quantum/quantum.env`；两者改动后必须重建容器（Quantum 不支持 SIGHUP 热加载）。
- **工作台删除接口恒 404**：`DELETE /api/workbench/items|projects|plans/{id}` 先删后查，
  行已删除导致 SELECT 恒空 → 改为「先查后删」。
- **生信平台 `/api/v1/courses` 500**：`routers/courses.py` 未导入 `ROLE_STUDENT`；
  **`/api/v1/users/me` 500**：`routers/users.py` 未导入 `Workspace`（pyflakes 全量扫描已无未定义名）。
- **生信平台终端会话创建 500**：helper socket 设了非阻塞 accept → `BlockingIOError`；
  且 session id 用了 16 位截断 UUID 而非完整 UUID。修复后真实建立 PTY 会话，
  cgroup 限额实测 `memory.max=1.5GiB` / `pids.max=256` / `cpu.max=1 核`。
- **重置脚本未等后端就绪**：`lab-reset-init` 脚本现等待 `/api/health` 就绪后再校验。

### 变更

- `lab-reset-init` 清空范围扩展到工作台与 Agent 会话表，并删除 `agent_config`（模型白名单回落默认）。
- 生信平台 Phase 1 六份文档与四个实操清单种子数据交付（`rnaseq-fastp-introduction` 等）。

## 2026-11-02 — 个人工作台 / Agent 助手 / 生物医学数据库扩充 / 出站 IPv4 修复

### 新增

- **个人工作台** `/workbench`：后端 `backend/app/workbench.py`（16 个接口，捕获→分类→确认写入），
  前端 `frontend/src/pages/Workbench.tsx`；新表 `workbench_items` / `workbench_projects` /
  `workbench_plans` / `workbench_briefs`。
- **Agent 助手** `/agent`（底层 pi）：`agent/gateway.mjs`（Node 22，pi RPC over stdio/JSONL，
  监听 172.28.0.1:8110）+ systemd `lab-agent-gateway.service` + 插件
  `agent/extensions/lab-portal.js`（5 个 `lab_*` 工具）；后端 `backend/app/agent.py`
  （会话/消息/配额/管理员配置/SSE 中继）；管理端「Agent 模型与配额」面板。
- **文本论文翻译** `/translation`（Hy-MT2）+ **文档解析** `/docparse`（OXR-1.0，Docling 回退）
  + **天气** `/weather`（Open-Meteo）。
- **数据库 API 集成**：目录 72 → **107** 条、分类 9 → **13** 个；适配器 15 → **32** 个
  （新增 ChEMBL / PubChem / ClinVar / Open Targets / STRING / HPA / Cellosaurus / ENCODE /
  cBioPortal / openFDA / Europe PMC / ChEBI / Taxonomy / HGNC / PRIDE / Enrichr / Brain Atlas）。
- 测试脚本：`agent-integration.mjs`(20)、`new-features-test.mjs`(16)、`db-api-integration.mjs`(24)、
  `biomed-api-test.mjs`(17)、`biomed-search-test.mjs`、`i18n-full.mjs`(10)、
  `embed-test.mjs`(37)、`jbrowse-i18n.mjs`(5)、`home-layout.mjs`、`run-regression.sh`（一键全量）。

### 修复

- **出站 IPv6 黑洞**：容器内 IPv6 出口对部分公网站点不可达，DNS 返回 AAAA 时 asyncio 会先试 IPv6
  并挂到超时，导致 OXR / ENCODE 等外部接口「时好时坏」。新增 `backend/app/http.py`
  （`httpx.AsyncHTTPTransport(local_address="0.0.0.0")` 强制 IPv4），外部服务模块统一改用它。
- **Agent SSE 丢增量**：pi 启动阶段也会发 `agent_settled`，中继提前断流 → 表现为「消息已落库但前端收不到字」。
  改为只有收到 `assistant_message` 后才允许按 settled 结束。
- **pi 模型名**：网关现在把裸模型名补全为 `provider/id`（`minimax-cn/MiniMax-M3.1-Flash`）。
- **Agent 配额误判**：最大会话数原本在每次发消息时都校验 → 改为只在建会话时校验。
- **Docling 回退失效**：`/v1/convert/file` 的表单字段应为 `files`（数组），原来用 `file` → HTTP 422。
- **ChEMBL 超时**：该接口在本机房实测需 25~30 秒 → 超时放宽到 70 秒并允许重试一次。
- **pdf2zh 路由冲突**：新增的 `/api/translate/*` 遮蔽了 PDFMathTranslate 队列状态端点 →
  PDF 队列端点改名为 `/api/pdf-translate/*`（前端与文档同步更新）。
- **`/api/search/suggest` 500**：corpus 取植物库条目时用了 `title` 字段，实际字段是 `name`。
- **首页重叠检测误报**：检测脚本把「外层卡片内嵌子卡片」判为重叠 → 已排除包含关系。

### 变更

- 统一搜索扩大本地命中（local limit 24 → 30，database 类型配额 6 → 10，目录检索 limit 100 → 300）。
- 首页重新设计（Hero 指标面板 / 快捷入口磁贴 / 常用服务网格 / 今日面板侧栏 / 工具箱行），三档视口实测通过。
- `AntD 6` 弃用清理：`Space` 用 `orientation`、`Drawer` 用 `size`、`Spin` 用 `description`；
  `antd lint` 38 文件 0 问题、`antd doctor` 14/14。

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

## 2026-11-02（下午）— 设计系统自检 / AntV 图表 / Node 26 + pnpm 统一 / Quantum 结论

### 设计系统与动效（按 landing.ant.design、motion.ant.design、theme-editor-cn 自检）
- 新增 `/opt/labspace/docs/DESIGN_SPEC.md`（298 行）：设计理念（简约·美观·好用·自主）、Token 全表、
  动效规范、AntV 图表规范、6 种页面骨架、16 条组件改造清单、3 天落地计划。
  - 抓取结果如实记录：`kitchen.alipay.com` 只取到 SPA 外壳；`utooland/utoo` 实为 **Rust 包管理器**（不是组件库），
    不纳入设计依据。
- 新增 `src/styles/motion.css`（4 档时长 120/200/340/520ms + 4 条缓动 + 40ms 错峰，
  `.d509-enter` / `.d509-stagger` / `.d509-hover-lift` / `.d509-expand` / `.d509-skeleton`，
  `prefers-reduced-motion` 下位移与缩放全关）；新增 `src/styles/prose.css`（行内代码与 `pre` 排版）。
- `src/theme/tokens.ts` 扩充 spacing / radii / shadows / focusRing / motion / typography / brandGradient；
  `colorTextTertiary` 由 `#6E7887` 调到 `#636D7B`（白底对比度 4.47:1 → 5.24:1）。
- `src/styles.css` 重写：8px 间距栅格、圆角 8/10/14、阴影三档全部变量化；统一 `:focus-visible` 2px 描边 + 3px 品牌光晕；
  深色模式 `html[data-theme="dark"]` 与 `prefers-color-scheme` 双轨；Hero 收敛为**一层**品牌渐变（删掉网格纹理动画与彩色光斑）。
- 新增 `e2e/design-selfcheck.mjs`：7 页 × 390/768/1440 三档，检查控制台错误、横向溢出、主标题、focus 可见性、
  入场终态，并对 `reducedMotion:'reduce'` 复跑 —— **88 项通过 / 0 失败**（截图 23 张）。

### Node 26 + pnpm 统一依赖管理
- Node 升级到 **v26.13.0 LTS**（`/usr/local/lib/node/current`；npm 11.20.0）。Node 26 不再捆绑 corepack，
  改用 `npm i -g --allow-scripts=pnpm pnpm@latest` → **pnpm 12.16.1**。
- 弃用 uv：按 pnpm 官方 Python 支持（pnpm ≥ 12.4.0）改为 pnpm 工作区管理。
  `pnpm-workspace.yaml`：`packages: [frontend, agent, backend]` + `python.enabled: true` + `python.versions: ["3.12","3.13"]`。
  `backend/pyproject.toml` 成为唯一真源（fastapi 0.136.3 / uvicorn 0.51.0 / httpx 0.28.1 / PyJWT[crypto] 2.13.0 /
  psycopg2-binary 2.9.12 / python-multipart 0.0.32 + dev: pytest 8.3.4、pytest-asyncio 0.25.0）。
  `pnpm install` 生成 `pnpm-lock.yaml`、`backend/pylock.toml` 与 `backend/.venv`（fastapi 导入校验通过）。
- 新增 `/usr/local/bin/lab-pyproject-sync`：从 pyproject.toml 生成 `backend/requirements.txt` 与
  `backend/requirements-runtime.txt`（`--check` 只比对）。容器 Dockerfile 改为安装 requirements-runtime.txt，
  依赖真源收敛到 pyproject.toml。**限制说明**：容器内是 Python 3.11 且 pnpm 拉独立解释器需访问外网（当前不通），
  故容器仍用 pip 安装该文件。

### Quantum（FileBrowser Quantum）界面语言 —— 结论与证据
- 上游前端**自带中文语言包**（`zh-cn-CAe7MO8v.js.gz`），但服务端不提供写入用户设置的接口：
  `PUT /files/api/settings` 与 `PUT /files/api/users?username=self` 均 **405**，前端保存设置走的正是该接口。
- 数据库侧多种写法（顶层 `locale`、`user_data.settings.locale`、`settings.ui.locale`、`profile.ui.locale`，
  值 `zhCN` / `zh-cn` / `zh-CN`）实测 `GET /files/api/users?username=self` 一律返回 `locale:"en"`。
- **结论：Quantum 界面语言保持英文（上游限制，非本地缺陷）**；门户侧提供中文操作指引与中文共享目录名
  （公共资料（只读）/课程资料/项目文件/个人文件）。
- 顺带修复一个真实故障：OIDC 回调 500 `failed to generate authentication token ... <nil>`，
  根因是 `docker cp` 覆盖 sqlite 后文件属主变成 root:root（容器进程 uid 1000 无法写库）；
  改为**在宿主机原地编辑** `/opt/lab-quantum/data/database.sqlite` 并保持 `1000:1000`。

### 其它
- Agent 插件致命缺陷修复：`lab-portal.js` 调用了从未定义的 `getBearer()`，导致助手**每次工具调用都抛异常**；
  补齐实现并改为同时携带 `Authorization` 与 `X-Lab-Service-Token`。
- 服务令牌鉴权从契约落到实现：`LABSPACE_SERVICE_TOKEN` + `require_user_or_service`，
  服务令牌只开放公共只读接口（数据库目录/查询、搜索、服务目录），用户级接口仍只认会话。
- 网关自动补问：模型若只调工具不给结论，pi 网关自动追问「直接基于检索结果给出最终中文答复」，
  配合系统提示词「一次最多连调 3 次工具」终结工具死循环。
- ChEMBL 主接口被上游维护（HTTP 500 + HTML 错误页），新增 EBI Search 回退通道，来源标注「ChEMBL（经 EBI 检索回退）」。
