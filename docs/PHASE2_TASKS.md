# 第二阶段任务清单（Research Agent Core / AgentScope 2.0.11）

> 创建：2026-11-09
> 依据：本轮用户指令（收尾项 2+3、显示名改造、完成文档中计划未完成的任务、AgentScope 2.0.11 科研助手核心升级、Ant Design X 前端耦合、依赖升级、删除旧代码、推送合并 PR）
> 状态图例：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 完成 · `[!]` 阻塞（需人工决策/凭据）


---

## Phase F — 课题资料 / 组会汇报 / 在线编辑 / 种子管理（2026-11-10）

| ID | 任务 | 验收 | 状态 |
| --- | --- | --- | --- |
| F1 | Go 核心新增两个共享源：`research`（课题资料）、`meeting`（组会汇报）；`research` 目录名 = `{进组时间}-{姓名}`，学生一条 identity scope + 老师整源 scope（两人共用，学生只见自己） | 单测覆盖目录命名与权限 | [x] 目录名解析兼容 Casdoor 三种 `created_time` 格式；老师/学生 scope 已实测 |
| F2 | 组会汇报按 **ISO 周** 归档（`2026-W48`），周目录按需创建；`CompressOldMeetingFolders(keepWeeks)` 定期压缩旧周目录省空间 | 单测覆盖跨年周与压缩 | [x] `POST /v1/files/ensure-meeting-folder` 补齐（授权前必须先建目录，否则 ACL 报 unknown directory） |
| F3 | 文件在线编辑：`GET/PUT /v1/files/{id}/content`，文本白名单、1 MiB 上限、**etag 乐观并发**（冲突 409）、需 modify 权限 | 单测覆盖并发与权限 | [x] 双浏览器实测：A 保存成功、B 收到 409 并提示「内容已被他人修改」 |
| F4 | 后端接口：课题资料目录管理（建/撤/列出/我的）、组会周目录授权与上传、种子表模板（幂等） | pytest ≥ 200 且新增用例通过 | [x] pytest **216 passed**；Baserow 建表 409 锁冲突改为退避重试 |
| F5 | 前端：时间线视图组件化（按用途选用）、在线编辑弹窗（409 处理）、**种子管理**页（多维表格为核心：Statistic + 表格 + 抽屉表单 + 详情 + 附件 + 库存/位置/备份） | `tsc -b` 0 error | [x] 种子管理页再补：列设置、全选/恢复默认、仅看待备份筛选、删除记录、行内编辑、空行清理 |
| F6 | 视图分工：不同存储用途默认不同视图（个人文件=列表，公共基因组/资料=时间线，组会=周视图） | 侧栏切换后默认视图正确 | [x] `recommendedView()` 已按用途选默认视图；组会为独立「周视图」页面 |
| F7 | 组会汇报「只有授权人可见管理」：周目录 ACL 名单独立维护，不随组权限放开 | 未授权用户看不到也拿不到 | [x] 学生实测只见被授权的 2026-W48；未授权周请求文件返回 403 |

> **接口契约（跨子代理约定，避免互相等待）**
> - Go：`POST /v1/admin/file-access/{name}`（body `{"grants":[{source,path,view,download,create,modify,delete}]}`）、`PUT /v1/admin/file-groups/{group}`、`POST /v1/files/ensure-meeting-folder`（body `{yearWeek}`）、`POST /v1/files/compress-meetings`（body `{keepWeeks}`）、`GET/PUT /v1/files/{id}/content`
> - 后端：`GET /api/admin/research/folders`、`POST /api/admin/research/folders`、`DELETE /api/admin/research/folders/{name}`、`GET /api/research/mine`、`GET /api/meetings/weeks`、`POST /api/meetings/weeks/{yearWeek}/grant`、`DELETE .../grant/{userId}`、`POST /api/meetings/upload`、`GET /api/meetings/weeks/{yearWeek}/files`、`POST /api/meetings/compress`、`GET|POST /api/baserow/templates/seed`
> - 前端走同源 `/api/files/{id}/content`（nginx 转到 labgo `/v1/files/...`）

### Phase F 踩坑记录（均为真实故障，非推测）

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 课题资料建目录 502 `storage rejected the write` | Go 侧 `research`/`meeting` 源目录不存在，且 labgo 以 `labuser` 跑、`ProtectSystem=strict`，无法在 `/srv/lab` 下自建 | 预建目录（0770 + setgid，属主 labuser）并写进 `labgo.service` 的 `ExecStartPre` |
| 授权写入 `invalid request body` | 两边数据形状不一致：Go 要 `{source,path,access}`，后端发的是布尔位 `{view,download,create,modify}` | 后端加 `to_access_grant()` 转换，只回传 Go 认识的字段 |
| 组会授权 `unknown directory` | 目录级 ACL 要求目标目录先存在 | 先调 `ensure-meeting-folder` 再写 ACL |
| 「我的课题资料」提示缺少进组时间 | Casdoor `created_time` 有 RFC3339 / Unix 秒 / `YYYY-MM-DD HH:MM:SS` 三种历史写法 | `_join_date()` 三格式兼容 |
| 种子表模板 POST 409 `FAILED_TO_LOCK_TABLE` | Baserow 建表后仍在同步，字段改动被拒（暂态错误） | 自动退避重试 4 次，而不是直接报「创建失败」 |
| 种子台账出现两行全「—」的鬼行 | Baserow 自带模板行；空值判定漏了「空列表」（附件字段）与单选默认值（「否」） | `_is_blank` 覆盖 list/dict；单选默认值按空处理；GET 模板时也清理 |
| 学生打开组会页报 403 | 页面默认选中「当前周」，而学生未被授权该周 | 默认周改为「优先当前周，否则第一个可见周」 |

---

## 进度快照（2026-11-16，第七轮：运行时升级 + 每日维护 + 系统体检）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| **Node.js 26.13.0** | **完成** | 系统默认 `/usr/local/bin/node` v26.13.0（npm 11.20.0），**原生跑 TypeScript**（`node x.ts` 直接执行，无需 flag）；`frontend/package.json` 锁 `engines.node >= 26.13.0` + `.nvmrc`；`tsc -b` 与 `vite build` 在新版本下均通过 |
| **Python 3.15.2** | **完成** | 源码编译（`--enable-optimizations --with-lto`）装到 `/usr/local`；**五处全部 3.15.2**：系统默认、backend venv、backend 容器（`python:3.15-slim`）、bioinfo venv、Go 侧无影响；pytest 216 / bioinfo 12 全绿 |
| **每日 05:00 维护** | **完成** | `lab-daily-maintenance.timer`（Asia/Shanghai，05:00 + 5min 抖动）：备份 → GC（Docker 悬空镜像/停止容器/构建缓存、Postgres VACUUM、restic forget、journal 7d、/tmp、go/pip/npm 缓存）→ 拉镜像只重建变化容器 → 重启 labgo → 健康检查；磁盘不足 2G 时自动跳过更新，任一步失败不 down 现有服务 |
| **站点防火墙从未生效** | **修复** | `/etc/nftables.conf` 用 `delete table inet filter` 删一个不存在的表，`nft -f` 直接中止 → `nftables.service` 自 11-07 起一直 failed、**站点规则一条没加载**（只剩 Docker/Tailscale 的链）。改为「先声明再删」，现已 active，54 行规则生效，容器网络与 Tailscale 入口均未受影响 |
| **巡检脚本失效项** | **修复** | ① 检查已下线的 `lab-it-tools`/`:8084` → 换成实际在跑的 `lab-primer`/`lab-qdrant`/`lab-agentscope`；② restic 仓库路径仍指迁移前的 `/srv/labdata/backups/restic` → 改为 `/srv/labbackup/restic`。失败项 3 → **0** |
| **bioinfo 依赖缺口** | **修复** | `psycopg[binary]` 是 SQLAlchemy 的 PG 驱动，却不在 `requirements.txt` 里（虚拟机手装过所以能跑，按清单重建 venv 就 ImportError）。已补进清单 |
| **文件夹上传** | **完成** | 新增「上传文件夹」按钮 + 拖拽目录（`webkitGetAsEntry` 递归，`readEntries` 按 100 条循环）；按 `webkitRelativePath` 逐层 mkdir 再上传，服务端得到与本地一致的目录树；带实时进度条与失败明细清单 |
| **上传逻辑抽离** | **完成** | `Files.tsx` 2647 → **2509 行**；上传（单文件/批量/文件夹树/拖拽）整体移到 `hooks/useFileUpload.ts`；`fileErrorText` 抽到 `utils/fileError.ts` 供两处共用 |
| 幽灵容器与镜像 | **完成** | 删除 3 个 `soymutdb-*` 孤立容器（无 compose 项目、无仓库引用）、14 个无用镜像（含 9 个 `soymutdb-*:ci-amd64`）；开发缓存 uv/pip/pnpm 与 `/tmp` 里的 soymutdb/AgentScope 检查目录一并清理，根分区 84G → 81G |
| 回归 | 全绿 | pytest 216 · bioinfo 12 · go-core 0 FAIL · `tsc -b` 0 error · `vite build` ✓ · Playwright 11 个页面零 4xx/5xx · 巡检 0 失败 |

---

## 进度快照（2026-11-15 晚，第六轮：Phase F 收尾 + 入口简化 + 组员共享）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 课题资料页面 | **完成** | 新增 `/research`（`ResearchFolders.tsx`）：老师看全部目录并可开通/收回授权，学生只看到自己的 `{进组时间}-{姓名}` 目录；收回授权只删 ACL、**保留数据**，界面明说 |
| 组会汇报页面 | **完成** | 新增 `/meetings`（`MeetingReports.tsx`）：左侧 ISO 周列表（只列可见周）、右侧文件表、上传、授权抽屉、压缩旧目录 |
| 前端服务层 | **完成** | 新增 `services/labspaces.ts`（自带 CSRF + 401 跳登录，不改 api.ts） |
| 在线编辑 | **完成** | 行菜单「在线编辑」→ 读正文 → 改 → 存；双浏览器实测 ETag 冲突返回 409，界面提示「内容已被他人修改」并保留用户输入 |
| 种子管理 UX | **完成** | 列设置（默认 10 列，可全选/恢复默认，localStorage 记住）、「仅看待备份」筛选、删除记录、行内编辑、详情抽屉、附件；空模板行由后端自动清理 |
| **入口简化** | **完成** | 侧栏折叠态从 **23 个扁平图标 → 11 个分层入口**：高频页（首页/工作台/Agent/文件存储/文献检索）平铺，低频页收进「文件与数据 / 分析与写作 / 学习与实训 / 小工具 / 管理后台」五个子菜单；当前页所在子菜单自动展开。首页「快捷入口」从 9 个功能罗列换成 8 个按任务排的入口 |
| **组员共享（v26.11）** | **完成** | 新增 `/shared`：名册（13 位在研组员）+ 目录结构 + 权限；详见下方专节 |
| 幽灵账号清理 | **完成** | `labadmin` 已从 Casdoor（token 582 / record 515）与门户库（account_audit 214 / file_events 75）清除，备份在 `/root/labspace-backups/labadmin-cleanup-20261115/` |
| 备份清理 | **完成** | 找到保留策略失效的根因（暂存目录随机名 → restic 按路径分组，每快照自成一组 → `--keep-*` 全部空转）；改为固定暂存路径 + `--group-by ''`，快照 **55 → 17**；同时排掉可再生的基因组索引（25 GB）与 core 快照里的公共基因组 |
| Phase F 后端 | **完成** | `admin_research.py` / `meetings.py` / `seed_tables.py` 三个半成品补全并对齐真实契约 |
| 回归 | 全绿 | 后端 pytest 216 passed · go-core 0 FAIL · 前端 `tsc -b` 0 error + `vite build` ✓ · Playwright 导师/学生视角零 4xx/5xx · pi-lens 本批文件 0 blocking |
| 阻塞 | 仍在 | CNB token 已过期（`git push` / PR API 均 `Repository Not Found`），本轮变更仍只在本地 |

---

## 组员共享模块（v26.11）

### 需求口径与实现对照

| 需求 | 实现 | 验收 |
| --- | --- | --- |
| 每位成员固定 `01_组会汇报` / `02_论文` / `03_其他`，导师可自设、学生不可 | 目录建在导师家目录下 `共享文件-组员/{学号}_{当前姓名}/…`；导师可自行加目录 | 学生 mkdir → **403**；导师建目录 → 200 |
| 学生仅「文件上传、查看」 | 授权形状：`view=true, download=false, modify=false, create=true, no_dirs=true` | 学生上传 200；下载被拒 |
| 导师「上传、下载、编辑等」 | 导师家目录 scope 不受限 | 导师可下载/改名/删除 |
| 学生仅在对应目录上传，**2 天内允许删除** | `Scope.DeleteWithin="48h"`，文件核心在 `Trash` 里按条目修改时间判定 | 新传文件学生可删；3 天前文件学生删不掉（403），导师可删 |
| 链接放于学生工作台显著位置 | 工作台顶部横幅「组员共享文件 + 进入上传」 | Playwright 实测横幅可见且可点 |
| 名册（13 位在研） | `labspace.lab_roster` + 初始名单 | 名册页显示 13 人；4 人已开通门户账号 |

### 关键实现点（踩坑记录）

| 坑 | 现象 | 处置 |
| --- | --- | --- |
| 授权走错了通道 | 共享树在 **users 源**（导师家目录里），而共享源授权接口 `/v1/admin/file-access` 明确**不写 users 源** | 新增 `/v1/admin/personal-access/{name}`（GET/PUT），专写个人空间授权 |
| 授权接口抹掉了自己家目录 | `SetPersonalAccess` 最初是「替换全部 users 源授权」，把 3 个学生**自己家目录**的授权也删了 | 改为只替换「指向别人家目录」的那部分；补回归测试 `TestSetPersonalAccessKeepsOwnHome`；已用 provision 接口把 3 个学生的家目录授权补回 |
| 目录名用旧姓名会多出一棵目录 | 名册里 2509 登记为「李同学」，账号当前显示名是「陈同学」，同步时建出 `2509_李同学` | 目录名一律用**账号当前显示名**；已挂上 2509→adminlegacy 并删掉多余空目录 |
| 名册里存显示名当导师 | 早期把中文姓名存进 `advisor`，拼出「陈同学/共享文件-组员」 | 统一用**账号键**（邮箱前缀）；带一次性修正逻辑（`lab_shared._fix_legacy_advisor`） |
| 学生看得见目录却传不上去 | 界面只拿 `writePaths`（可写路径）判断，共享树的路径不在里面 → 「上传」按钮不显示 | Go 核心的 `WritePaths` 把**别人家目录里可写的共享子树**也算进去（新增 `MkdirPaths` 单独报「可建目录」） |

---


## 进度快照（2026-11-10 上午，第四轮）
---

## 进度快照（2026-11-10 上午，第三轮）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| AgentScope 接入 | 运行中 | 独立容器 `lab-agentscope`（:8103 内 / :8104 外），`create_app` 装配；13 张表在独立库 `agentscope` |
| **后端全线切换** | 完成 | `LABSPACE_AGENT_BACKEND=agentscope` 为默认；`/api/agent/sessions*` 已由 AgentScope 承载（契约不变，前端未改）；`pi` 仅作回滚开关 |
| 事件适配 | 完成 | `REPLY_START/DELTA/END` + `MODEL_CALL_END` → `ready/delta/tool/done/error`；**踩坑**：连接建立会回放上一轮 `REPLY_END`，见 `done` 就关流会把本轮增量掐掉 |
| 额度 | 完成 | `done` 里的真实 token 用量写入 `agent_sessions.tokens_in/out` |
| 平台模型凭据 | 完成 | `/etc/labspace/agent-model.env`（0600）→ 容器环境变量；`_platform_model()` 走「管理端配置 → 环境变量」两级回落 |
| 工具能力（MCP） | **完成** | `lab_mcp_server.py`/`lab_portal.py`/`lab_identity.py`，原生 `HttpMCPConfig`+`MCPClient`；实测 `mcp__lab__lab_services` 返回 10 个真实服务。修掉事件字段名（`tool_call_name`/分片 delta）导致工具卡片为空的问题 |
| 原生 RAG + 记忆 | 进行中 | 首个子代理超时零产出；已按「只装配 + 最小验证」重派 `196b6cd5`：Qdrant + `CollectionPerKbManager` + bge-m3（1024 维）+ `AgenticMemoryMiddleware` |
| 计划页签重构 | **完成** | `components/workbench/PlanPanel.tsx`（1009 行）：统计条 + 三段式（当前阶段/里程碑/待办网格），Modal+Form、Popconfirm、断点折叠；新增 `workbenchUpdatePlan`/`workbenchDeletePlan` |
| 能力中心前端 | **完成** | `/agent/hub` 六页签（IM/定时/SOP/知识库/工作区/技能-MCP），Ant Design X `Conversations/Bubble/Steps/Timeline`；`services/agentscope.ts` |
| 能力代理后端 | **完成** | `/api/agent/as/{group}` 15 组白名单、`X-User-ID` 强制覆盖、`..`/大 body 拒绝、4xx 透传；26 个新测试 |
| 去除 pi 源码 | **完成** | 已删 `agent/gateway.mjs`、`agent/extensions/**`、`agent/package.json`、systemd unit、`/etc/labspace/agent-gateway.json`；产出归档到 `/opt/_archived-2026-11-10/pi-agent/`；保留 `agent/skills/**`；后端 `pi` 分支改为显式 **410** |

## 进度快照（2026-11-10 凌晨，第二轮）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 文件移动/复制 | 完成 | Go `Move` + `Copy`（递归、不覆盖、拒复制进自身子树、跳过隐藏文件）；`/v1/files/move`、`/v1/files/copy`；前端行菜单 + 批量 + 粘贴到当前目录 |
| 共享视图移动 | 结论 | `SetPersonalShare` 只授予 view/download，共享内容**设计上只读**；已改为明确提示并提供「复制→粘贴」路径，隐藏必失败的移动按钮 |
| 目录大小 | 完成 | 列出时填充 `dirSize`（仅同源统计），列表目录列显示子树大小，空目录显示「空」 |
| 缩略图 | 完成 | 图片走鉴权 preview 接口，26px 懒加载，失败回落图标 |
| 保留期 | 完成 | 回收站 30→**7 天**、文件访问审计 90→**7 天**，测试期望同步 |
| 每日诗词 | 完成 | `/api/saying` 切到今日诗词（text/author/origin），按自然日缓存，已实测线上返回 |
| 公告叠层 | 完成 | antd 原生 `Masonry`，最多 6 条磨砂玻璃卡片 |
| 磨砂玻璃 / 流光边框 | 完成 | `.d509-glass`（color-mix + backdrop-filter，深色单独一档）；起始页搜索框用原生 `BorderBeam`，整页唯一动效焦点 |
| LaTeX 分栏 | 完成 | 源码/PDF 左右两栏、可整屏（Esc 退出）、元数据收进折叠面板；投稿状态筛选彻底移除 |
| DOCX → LaTeX | 完成 | python-docx 直接映射，图片/公式/合并单元格逐条 warning；`POST /api/latex/import-docx` 已实测在线（401） |
| 命令页 | 完成 | 去掉顶部横幅；分组小滚动区改整列单滚动 + 字母吸顶 |
| SnapOtter 参数 | 完成 | 裸 JSON 改键值对行编辑（键名建议 + 值类型推断 + 实时 JSON 预览） |
| 备份删除 | 完成 | 管理端 → 后端 → 宿主机 root ops 服务 → `restic forget --prune`；非法 ID 拒绝、无令牌 401 |
| 月度依赖更新 | 完成 | `.cnb.yml` 每月 1 日 + `deps-update.sh` + `ci-deps-pr.sh`（门禁绿了才开 PR） |
| main.py lint | 完成 | 25 条 blocking 清零（ruff --fix + 补日志 + strict zip） |
| 强制改密 | 未开始 | **有冲突需决策**：`accounts._hash_password` 要求口令 ≥10 位，与你要求的初始口令 `12345678`（8 位）冲突；且对存量账号生效会把人锁在改密页 |
| 权限组 | 未开始 | Casdoor `bioinfo-*` 是 /opt/bioinfo-training 的登录与角色来源，直接删组会让该平台登不上 |
| 共享目录可写协作 | 待决策 | 需要 ACL 语义变更（共享时可选授予 modify/create） |
| AgentScope 核心 | 未开始 | 子代理两次 429（Token Plan 额度）；API 已核实，落地方式定为 `create_app` 共用内核 |
| Primer 接入 | 未完成 | 镜像构建多次被网络拖死；自身无鉴权，须先套门户鉴权 |
| 统一搜索接文献源 | 未开始 | 文献源模块已就绪（PR #49） |
| 公共模板库 / 上下审稿 | 未开始 | — |

## 进度快照（2026-11-09 晚）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| A1 文档下线同步 | 部分完成 | 根 README/ARCHITECTURE/SERVICE_INTEGRATION 与 docs/ 三篇已改；`docs/SERVICE_INTEGRATION.md` 内残余章节待第二轮清理 |
| A2 残留清理 | 未做 | `/opt/lab-quantum`、`/opt/lab-core-stack`、`lab-sync-passwords` 依赖仍待处理 |
| A3 显示名 | 部分完成 | 后端 `accounts.py`/`workbench.py` 已有 displayName；Files/Knowledge/Workbench 前端回退写法待统一 |
| A4 Git 远端 | 已打通 | monorepo `cnb.cool/math-nwafu/labspace`，代码位于 `labspace/` 子目录；`ops/git-push-labspace.sh` 负责 rsync→分支→PR→合并 |
| A5 依赖升级 | 完成 | 前端 TS 7.0.2 / vite 8.3.7 / plugin-react 6.3.0 / react-query 5.107.1；后端 fastapi 0.162.2 / psycopg2 2.9.13；`tsc -b` 与 `vite build` 均通过 |
| A6 计划盘点 | 未做 | 见 `docs/PLANNED_GAP_AUDIT.md`（待生成） |
| B* AgentScope 核心 | 未开始 | 已装 2.0.11 到 /tmp/as-inspect 并完成类表面核实 |
| C* 前端耦合 | 未开始 | — |
| D1–D3 文献源/每日论文 | 未开始 | 子代理额度耗尽中断 |
| D4–D6 前端组件 | 未开始 | KaTeX/PDF.js3/JSZip/latex.js 未安装 |
| D9 文献库/文件夹 | 未开始 | 表结构设计已写入本文件 |
| 追加：文件存储移动 | 完成 | Go `Move` + `POST /v1/files/move` + 前端「移动到…」+ 批量移动 |
| 追加：弹窗居中 | 完成 | `ConfigProvider modal={{ centered: true }}` |
| 追加：页头文字移除 | 完成 | 只保留品牌图形，标题交给 Breadcrumb |
| 追加：备份快照删除 | 完成 | ops 脚本 + 宿主机 ops 服务路由 + 后端 DELETE + 管理端按钮 |
| 追加：月度依赖更新 | 完成 | `.cnb.yml` 月度 cron + `ops/deps-update.sh` + `ops/ci-deps-pr.sh` |
| 追加：Primer 引物平台 | 已接入 | 镜像 `primer-workbench:3.9.3`；容器只绑 `127.0.0.1:18097`；对外 `:8097` 经 nginx `auth_request` 校验门户会话，未登录 302 到登录页；目录条目 `http://<host>:8097/`；「文件夹=物种」与公共基因组联动**未做** |

---

## Phase E — 2026-11-09 晚（用户新增批次）

| ID | 任务 | 验收 | 状态 |
| --- | --- | --- | --- |
| E1 | SnapOtter 参数从裸 JSON 改成**键值对输入框**（视频/音频/图片/PDF/文件各有键名建议，值按 number/bool/JSON 推断），保留原始 JSON 预览 | 不再需要手写 `{"fps":12}`；`tsc` 通过 | [x] |
| E2 | `/commands` 布局：去掉每个首字母分组各自的 240px 小滚动区，改为整列单滚动 + 字母吸顶；补键盘可达与选中态 | 命令不再被截断 | [x] |
| E3 | LaTeX 写作：**下架投稿动态**（状态选择、投稿截止、事件时间线、「与项目/文献/知识库联动」卡片） | 页面只剩 源码 / 元数据 / PDF 预览 | [x] |
| E4 | LaTeX：DOCX → LaTeX 转换（借鉴 transpect/docx2tex 的思路，用 python-docx 直接映射，避免引入 Java/XSLT 流水线）；nwafuthesis 只生成调用骨架 | 上传 docx 得到 .tex；10 个单测通过；无法还原的部分逐条 warning | [x] |
| E5 | LaTeX：**上下审稿**（合作者批注/版本对比/接受-拒绝） | 双人可见批注与差异 | [ ] |
| E6 | LaTeX：**公共模板库**预置（nwafuthesis、article、中文期刊常见格式） | 新建文稿可从模板库选 | [ ] |
| E7 | 统一搜索接入新文献源（OpenAlex/S2/Crossref/arXiv）+ 每日论文 | 搜索结果有来源标记 | [ ] |
| E8 | 磨砂玻璃视觉（antd 原生 `theme.token` / `styles`，不引第三方玻璃库） | 页头/侧栏/卡片三处克制使用 | [ ] |
| E9 | 个人 Agent 暴露更多 AgentScope 能力（**共用内核**：直接 `agentscope.app.create_app` 挂载或复用其 routers/services，不另起一套会话/知识库/工具栈） | 门户 Agent 与 AgentScope Agent Service 共享同一存储与运行时 | [ ] |
| E10 | 暂存问题清零：pi-lens 全量报错收敛到 0（按文件分批） | `lens_diagnostics` 无 blocking | [ ] |

> **E9 的架构决定（用户明确要求）**：使用 AgentScope 2.0.11 官方
> [Agent Service](https://docs.agentscope.io/zh/versions/2.0.11/deploy/agent-service)
> 的 `create_app(storage, message_bus, workspace_manager, knowledge_base_manager, ...)`，
> 把业务能力做成它的 `extra_agent_tools` / `extra_agent_middlewares` / `resource_access_policy`
> 扩展点，**复用**同一份 Session / KnowledgeBase / SOP / Tool 存储与运行时；
> 不再自建平行的会话表、知识库表与工具注册表。额度、分享、审计作为中间件与 ACL 插件接入。

---

## 0. 范围与硬约束

| 约束 | 说明 |
| --- | --- |
| 不重写前端 | 前端仍用 React 19 + Ant Design 6 + **Ant Design X**；本阶段只做「与新后端耦合 + 替换旧逻辑」，不引入新 UI 框架 |
| 不重建账号体系 | 复用现有 Casdoor OIDC；不新写注册/口令体系 |
| 固定 AgentScope 2.0.11 | PyPI 最新版即 2.0.11（已核实 `pip index versions agentscope`：2.0.11 为 head），不混用 1.x / 2.0.12dev |
| 先核实再编码 | 所有 AgentScope 接口以 2.0.11 实际源码/类型定义为准，不按旧文档臆测 |
| 复用原生能力 | 会话/事件/记忆/RAG/SOP 优先用 AgentScope 原生；业务侧只补 ACL、额度、分享、审计 |
| 不删旧代码除非有替代 | 旧代码删除必须在「新实现通过测试」之后执行，且保留可回滚路径 |
| 不伪造能力 | 未实现/未验证的部分必须标为未完成，不允许空接口或固定返回 |

---

## Phase A — 收尾与一致性（可并行，先做完再动 B）

| ID | 任务 | 验收 | 状态 |
| --- | --- | --- | --- |
| A1 | 文档同步：把 Open WebUI / Quantum 从「在役拓扑」改为「已下线（历史）」，覆盖 `docs/ARCHITECTURE.md`、`docs/SERVICE_INTEGRATION.md`、`docs/PLATFORM-ARCHITECTURE.md`、根 `ARCHITECTURE.md`、`SERVICE_INTEGRATION.md`、`CHANGELOG.md` | 全文检索 `Open WebUI`/`Quantum` 无「在役/可用」表述；文档与 `docker ps` 一致 | [ ] |
| A2 | 残留清理：`/opt/lab-quantum/`、`/opt/lab-core-stack/`（含 data/compose）；`lab-sync-passwords.timer` 不再依赖 Quantum 凭据文件（只同步 Casdoor） | 定时器跑通且输出只含 Casdoor 账号；残留目录归档而非直接 rm（先备份） | [ ] |
| A3 | **显示名改造**：所有「共享 / 指派 / 作者 / 拥有者」一律显示 display name（中文姓名），不得显示用户名或邮箱 | 后端返回 `ownerName/creatorName/assigneeName`；前端无 `?? owner` 回退到用户名的写法 | [ ] |
| A4 | Git 远端同步：接回 `cnb.cool/math-nwafu/labspace` 历史（当前本地是孤立初始提交），按工作项开分支推 PR 并合并 | 远端 main 含本轮变更；PR/MR 已合并；凭据不入库 | [~] |
| A5 | 依赖升级核对：前端（antd / @ant-design/x / vite / react / icons / plots）与后端（fastapi / uvicorn / pyjwt / psycopg2 / pytest）逐项查最新并升级 | 版本清单 + 升级后 build/测试通过 | [ ] |
| A6 | 「文档中计划但未完成」的任务盘点与补齐：`docs/TASKS.md` 2 项「待外部条件」中可本地完成的（决策模型降级路径、RAG 生成模型降级提示）复核为已完成或明确仍待外部 | TASKS.md 状态与实际一致 | [ ] |

---

## Phase B — Research Agent Core（AgentScope 2.0.11）

### B0 设计基线

| ID | 任务 | 验收 | 状态 |
| --- | --- | --- | --- |
| B1 | 官方 API 核实：读 2.0.11 源码（`agentscope.session/memory/rag/sop/toolkit/pipeline/permission`）、官方文档 2.0.11 quickstart/rag/long-term-memory/sop/sharing/agent-service/permission，产出「原生复用清单」 | `docs/AGENTSCOPE_REUSE.md`：逐模块列出真实类名、构造参数、调用签名（来自源码，非臆测） | [~] |
| B2 | 架构与数据模型设计：领域划分（agents/sessions/memory/rag/tools/workflows/sharing/quotas/models/storage/middleware）、多租户模型、迁移方案 | `research-agent-core/docs/ARCHITECTURE.md` + ER 概览 | [ ] |
| B3 | 服务骨架 + Alembic 迁移：FastAPI 应用、配置、依赖注入、DB 会话 | `alembic upgrade head` 通过；`pytest` 冒烟通过 | [ ] |

### B1 组：多用户与身份（核心隔离）

| ID | 任务 | 验收 | 状态 |
| --- | --- | --- | --- |
| B4 | 认证：复用 Casdoor OIDC JWT（沿用 `backend/app/security.py` 的校验口径），替换 AgentScope 默认 `X-User-ID` 占位；服务令牌仅开放公共只读 | 伪造 `X-User-ID` 无效；未登录 401 | [ ] |
| B5 | 多用户隔离：会话/记忆/知识库/工具授权/工作流/额度全部按 owner 维度；读写强制所有权或显式授权 | 场景 A 测试：A 的数据 B 不可读（含列表接口） | [ ] |

### B2 组：会话、记忆、流式

| ID | 任务 | 验收 | 状态 |
| --- | --- | --- | --- |
| B6 | 会话生命周期：创建/多轮/历史/改名/删除/恢复/流式/中断/持久化/断线重连重放 | 10 项逐项有测试 | [ ] |
| B7 | 短期记忆：多轮消息 + 工具调用上下文 + 窗口管理 + 自动摘要/压缩 + 重启恢复 | 重启后会话可继续 | [ ] |
| B8 | 长期记忆：候选抽取 → 按用户隔离存储 → 相关性检索 → 更新/冲突/去重 → 用户查看编辑删除 → 可关闭；区分事实/偏好/推断 | 场景 C 测试：会话 A 保存偏好，会话 B 可检索到；删除后检索不到 | [ ] |
| B9 | SSE 事件协议：增量、工具开始/结果、状态变化、检索来源、工作流节点、人工审核、完成/错误；保留原生事件语义 + 适配层 | 前端可按稳定协议渲染；断线可续 | [ ] |

### B3 组：RAG 知识库（复用项目原生能力）

| ID | 任务 | 验收 | 状态 |
| --- | --- | --- | --- |
| B10 | RAG 服务：优先复用 AgentScope `CollectionPerKbManager` + `QdrantStore` + 原生 Parser/Chunker + 原生索引 Worker；检索后端优先接项目现有 `lab-rag`（FlashRAG + BGE-M3）与 `go-core/internal/knowledge` | 能建库、导入、索引、检索；不重复造已有能力 | [ ] |
| B11 | 科研元数据：标题/DOI/作者/来源文件 ID/页码/分块位置/年份/得分；关键词+语义混合；预留重排；引用可追溯；证据不足时显式声明 | 场景 B 测试：文档问答返回正确来源；无 DOI 伪造 | [ ] |
| B12 | 知识库权限：检索**前**完成访问校验（不是只在返回阶段过滤）；读/写/改/删独立判断；多库联合检索 | 未授权库不可检索、不可枚举 | [ ] |

### B4 组：模型、额度、工具

| ID | 任务 | 验收 | 状态 |
| --- | --- | --- | --- |
| B13 | 模型适配层：复用 AgentScope Model/Credential；管理员配置 provider/凭据/模型名/能力/上下文/价格/最大输出/是否可用/是否可调工具；返回给前端时脱敏 | 前端拿不到任何 API Key | [ ] |
| B14 | 额度与计费：Token（日/月）、费用、并发、请求量、存储、工作流并发；调用前检查、调用后按可信 usage 记账；原子预留→结算→失败释放；估算标记 | 场景 D 测试：超额拒绝、并发不超限、工作流内调用同样计费 | [ ] |
| B15 | 科研工具注册（四类）：文献（PubMed/Europe PMC/Crossref/DOI 校验/摘要）、生信只读（NCBI/基因/UniProt/ID 转换/授权库）、知识库（个人+被授权共享库/引用/元数据）、通用（联网搜索/结构化转换/摘要/研究计划/任务状态） | 场景 E 测试：真实来源可追溯；无权限不能调用 | [ ] |
| B16 | 工具治理：唯一名/参数 Schema/返回 Schema/错误类型/超时/权限声明/额度消耗/审计；禁用 Shell/Bash/任意代码执行/危险文件操作；禁止模型直连任意内部 URL（白名单） | 工具清单无危险工具；越权调用被拒 | [ ] |
| B17 | MCP：按 AgentScope 原生机制接入；服务器安装/配置/启用由管理员控制 | 非管理员无法启用 MCP | [ ] |

### B5 组：工作流与分享

| ID | 任务 | 验收 | 状态 |
| --- | --- | --- | --- |
| B18 | 工作流模型：workflow_id/owner/name/description/version/visibility/input_schema/output_schema/steps/permissions；定义与运行分离；运行绑定不可变版本快照 | 数据模型 + 迁移 | [ ] |
| B19 | 节点与执行：输入/Agent/工具/RAG/人工审核/输出六类节点；第一阶段用 AgentScope 顺序 SOP；条件/并行/DAG 只做扩展设计不冒充原生 | 3 个端到端工作流可跑 | [ ] |
| B20 | 运行状态机：pending/running/awaiting_approval/completed/failed/cancelled；失败重试、人工审核、运行历史、额度统计、执行日志；**核实原生 SOP 的取消/重启恢复限制**，不足部分自建状态协调 | 场景 G 测试；不支持的能力明确写为限制 | [ ] |
| B21 | 三个科研工作流实例：A 文献研究（检索→DOI 核验→筛选→总结→带引用报告）、B 知识库问答、C 研究方案制定（含人工审核） | 各自可端到端跑通，引用真实来源 | [ ] |
| B22 | 分享机制：`WorkflowTemplateService` + `WorkflowAccessPolicy`；owner/viewer/runner/editor；创建/查看/改权/撤销/使用/复制到个人/版本管理/权限校验 | 场景 F 测试：B 运行后记录归 B、额度扣 B、B 无法访问 A 的记忆/知识库/凭据 | [ ] |

### B6 组：API、部署、测试

| ID | 任务 | 验收 | 状态 |
| --- | --- | --- | --- |
| B23 | REST API 域：`/api/me`、`/api/agents`、`/api/sessions`、`/api/memories`、`/api/knowledge-bases`、`/api/tools`、`/api/workflows`、`/api/workflow-runs`、`/api/workflow-shares`、`/api/usage`、`/api/admin`；OpenAPI + 统一错误 + 分页过滤 + 幂等 + 限流 + 审计 | OpenAPI 文档可生成且被前端类型化 | [ ] |
| B24 | 测试：pytest 单测/集成/安全；覆盖场景 A–G | 全部通过；未支持能力给出明确结论而非虚报 | [ ] |
| B25 | 部署：systemd 单元 + env 模板 + 最小化部署说明 + 与现有门户栈的共存配置 | 新服务健康；门户可调用 | [ ] |

---

## Phase C — 前端耦合（Ant Design X）

| ID | 任务 | 验收 | 状态 |
| --- | --- | --- | --- |
| C1 | 事件协议对接层：SSE 客户端 + 断线重连 + 事件到 Ant Design X 组件的映射 | 前端能渲染增量/工具/来源/审核/错误 | [ ] |
| C2 | Agent 页重写：Ant Design X 承载会话与消息（含思考/工具/引用），与 `/api/sessions` 等新接口对接 | 页面可用；替换旧逻辑 | [ ] |
| C3 | 知识库问答耦合：`KnowledgeAsk` 接新 RAG 服务（引用、证据不足提示、多库检索） | 问答走新后端 | [ ] |
| C4 | 工作流 UI：定义、运行进度、人工审核、分享管理 | 三类工作流可从前端发起 | [ ] |
| C5 | **删除旧代码**：仅在新实现测试通过后删除被替代的旧后端模块与旧前端逻辑；保留回滚路径（git 分支/tag） | 无残留死代码；build + e2e 通过 | [ ] |
| C6 | 回归：`npm run build`、go-core 单测、后端 pytest、关键 e2e | 全绿 | [ ] |

---

## Phase D — 文献数据源与「每日论文」（新增，2026-11-09 用户指定）

> 用户指定组件与数据源。版本按用户给定的表执行；与现网依赖冲突处需在实现中标注并给出证据。

### D0 依赖与口径（已核实现状）

| 组件 | 用户指定版本 | npm 最新 | 现状与处置 |
| --- | --- | --- | --- |
| LiveTeX（实时预览） | — | 包名 `livetex` **不存在**（npm 404）；其内核为 `latex.js` 0.12.6 | 用 `latex.js` 实现同等的实时预览（KaTeX 兼容子集 + 增量编译），在交付说明中记录包名替换原因 |
| KaTeX | 0.16.9 | 0.19.1 | 新增，固定 0.16.9 |
| PDF.js | 3.11.174 | 6.5.438 | 现网 `frontend/package.json` 已用 6.5.438，且 `OpenFilePreview.tsx` / `office/PptPresentation.tsx` 依赖 v6 的 `build/pdf.worker.mjs` 路径。**并存方案**：以 npm alias `pdfjs-dist-v3@npm:pdfjs-dist@3.11.174` 供新阅读器使用，v6 保持不动；统一降级需同步改造两处并回归 |
| JSZip | 3.10.1 | 3.10.2 | 新增，固定 3.10.1（Overleaf 项目 ZIP 导入） |

| 数据源 | 定位 | 现状 |
| --- | --- | --- |
| OpenAlex API | 每日文献聚合**主力**，CORS 友好、无需 Key | 未接入（新增） |
| Semantic Scholar API | 论文搜索与元数据，**二级降级** | 未接入（新增） |
| Crossref API | 期刊论文元数据，**三级降级** | 已有单点 DOI 查询（`backend/app/labops.py:777`），需抽成统一 source |
| arXiv | 预印本直链与 PDF | 未接入（新增） |
| Pollinations AI | 默认免费 AI 接口（无需注册），用于每日论文的摘要/导读/要点生成 | 未接入（新增），须有超时与降级（失败则不生成 AI 文本，不伪造） |

### D 组任务

| ID | 任务 | 验收 | 状态 |
| --- | --- | --- | --- |
| D1 | 文献源统一层：实现 `literature_sources` 模块，OpenAlex → Semantic Scholar → Crossref 三级降级 + arXiv 预印本；统一输出结构（标题、作者、DOI、年份、期刊、摘要、引用数、来源标记、PDF/落地页链接、开放获取状态）；去重按 DOI 优先、无 DOI 用标题+年份归一 | 对同一查询，三级源各自可独立命中；降级链可观测（记录实际命中源） | [ ] |
| D2 | Pollinations AI 接入：作为免费默认 AI 接口（文本生成，用于论文中文导读/要点/摘要压缩）；超时、限流、错误全部降级为「不生成 AI 文本」，不得返回伪造内容 | 请求失败时接口返回明确 `aiGenerated:false`，不阻塞文献列表 | [ ] |
| D3 | 「每日论文」聚合与调度：按日聚合（主题/关键词/分类可配）→ 去重 → 相关性/新颖度排序 → 生成当日清单（落库 + 缓存）；提供 `/api/daily-papers`（按日期/主题分页）；配套 systemd timer 每日执行 | 同一天重复调用返回稳定结果；定时器可跑通；空结果有明确提示 | [ ] |
| D4 | 前端：新增「每日论文」页面（Ant Design 6），列表卡片 + 筛选 + 摘要 + AI 导读 + 原文链接 + PDF 预览；KaTeX 渲染摘要中的行内/块级公式；PDF.js 3.11.174 阅读器渲染 arXiv/开放获取 PDF | 页面可用；公式渲染正确；PDF 可翻页缩放 | [ ] |
| D5 | 前端：LiveTeX（latex.js）实时预览模式，接入现有 LaTeX 写作页（编辑区 → 预览区实时刷新、可切换「源码/预览/分屏」） | 实时预览无明显延迟；现有编译流程不受影响 | [ ] |
| D6 | 前端：JSZip Overleaf 项目导入 —— 解析上传的 .zip（main.tex + 依赖），列出文件树，逐文件写入用户工作区（走既有文件 API，需带鉴权） | 导入后可编辑并编译；路径穿越（../）被拒绝 | [ ] |
| D7 | 依赖安装与集成：按上表版本安装（`pdfjs-dist-v3` 用 alias），更新 pnpm-lock；与 A5 的依赖升级合并，避免同文件冲突 | `pnpm install` 成功；`npm run build` 通过 | [ ] |
| D8 | 测试：文献源降级链（mock 各源）、每日论文聚合（固定数据集）、KaTeX/PDF/JSZip 前端组件冒烟；禁止用 mock 结果冒充真实 API 成功 | pytest 通过；真实 API 至少各跑通一次（记录响应摘要） | [ ] |
| D9 | **文献库组织能力**（用户新增需求）：支持创建多个「文献库」并在库间切换；每个库内支持创建文件夹、文献归档到文件夹、跨文件夹/跨库移动；默认库兼容现有单库行为 | ① 可建库/切库，切换后列表只显示该库文献；② 可建文件夹（一级，必要时支持子级）、拖拽或菜单移动文献；③ 旧数据自动归属默认库，历史链接不失效；④ 所有操作按 owner 隔离 | [ ] |

### D9 数据模型（增量迁移，不破坏现有表）

```text
labspace.labops_literature_library(id, owner, name, description, color, is_default, created_at, updated_at)
labspace.labops_literature_folder(id, owner, library_id, parent_id, name, created_at, updated_at)
ALTER TABLE labspace.labops_literature ADD COLUMN library_id text NOT NULL DEFAULT ''   -- '' 表示默认库
ALTER TABLE labspace.labops_literature ADD COLUMN folder_id  text NOT NULL DEFAULT ''   -- '' 表示未分类
```

- 兼容策略：旧文献 `library_id=''` 归入「默认文献库」，前端不展示 `library_id` 参数时等价于默认库。
- 唯一约束：`(owner, library_id, folder_id, doi)` 去重仍在 owner 维度生效；同一 DOI 可在不同库各存一份（研究场景常见），但同一库内不重复。
- 文件夹删除：非空时需显式选择「移到上级/移到未分类」或级联删除，不允许静默丢文献。

---

## 执行顺序与并行策略

1. **Wave 0（立即并行）**：A1、A2、A3、A5、A6（子代理并行）+ B1（AgentScope 源码核实）+ D-backend（D1–D3 后端，不碰依赖清单）
2. **Wave 0.5**：D7 依赖安装（必须等 A5 完成，避免同时改 frontend/package.json 与 pnpm-lock.yaml）
3. **Wave 1**：A4（git 分支/PR 推送合并，依赖 A1–A3、A5、D 的改动入分支）+ B2/B3（架构与骨架）
3. **Wave 2**：B4–B9、B10–B12（身份/会话/记忆/RAG）
4. **Wave 3**：B13–B17、B18–B22（额度/工具/工作流/分享）+ D4–D6（前端组件）
5. **Wave 4**：B23–B25 + C1–C4 + D8（测试）
6. **Wave 5**：C5、C6（删旧代码 + 全量回归），A4 合并 PR

> 阻塞项：`[!]` 需要用户决策或凭据 —— 远端 PR 平台接口权限、模型密钥（SiliconFlow / 本地模型）、RAG 生成模型配置。

---

## 变更日志

- 2026-11-09：初版建立；Phase A 承接本轮收尾指令，Phase B/C 承接 Research Agent Core 与 Ant Design X 耦合升级目标。
- 2026-11-09：新增 Phase D —— 用户指定的 LiveTeX/KaTeX/PDF.js/JSZip 组件与 OpenAlex/Semantic Scholar/Crossref/arXiv/Pollinations 数据源，及「每日论文」功能。
- 2026-11-09：新增 D9 —— 文献库支持多库切换与文件夹组织。
