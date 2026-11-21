# Phase 2 进度与阻塞说明

> 对应规格书 v2.0 §6/§7/§8「清理、ACL 统一与前端解耦」。
> 本文件只写**当前真实状态**，包括没做完的部分和为什么。

## 已完成（6/10）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 仓库垃圾清理 | `.retired`、`labgo.service.bak` 已删；unit 归档 `deploy/systemd/labgo.service`；nginx 死注释清掉；`nft -c -f` 通过 | commit `e0e7053` |
| 文档单一真源 | 根目录只留 README，9 份重复文档删除；`ops/check-docs-links.py` 校验链接与 digest | `OK：28 份文档` |
| 裸 hex 清零 | 24 个页面 124 处 → 0；新增 `theme/palette.ts`；`ops/ci-frontend.sh` 加门禁 | `grep` = 0，CI 打印「✓ 裸 hex 检查：0 处」 |
| 版本化迁移 | 608 行 DDL 迁到 `migrations/0001_init.sql`，`app/migrate.py` 带账本/单事务 | 容器内启动即应用，`/api/admin/audit` 由 500 → 200 |
| ACL 巡检 + 审计 | `POST /v1/admin/acl/audit`（孤儿/悬空/组越权三类）+ `app/audit.py` 统一埋点 + `/api/admin/audit` 导出 | `go test -race ./internal/labfiles` 绿；`pytest tests/test_audit_export.py` 4 例 |
| 路由与重定向债 | 10 条旧别名集中登记 + 埋点；侧栏改「工作区/文件与课题/分析与写作/科研工具/系统」（条目 7/6/9/8/4） | 8 条旧链接 curl 全 200；`/api/legacy-hit` 204 |

## 阻塞：e2e 全量回归（`e2e-triage`）

脚本从 167 个 `_*.mjs` 收敛到 6 个（其余删除，历史留在 git），新增 `e2e/README.md`
写明保留规则，12 个一直手工跑、没进 `ALL` 的脚本补进套件。

**但 `run-regression.sh` 仍有 28 个脚本失败**，根因不是代码缺陷，而是**套件里写死的
实验室数据形状与当前部署不一致**：

- `go-next-api.mjs`：`课程资料存在可预览文件 — 未找到文件`、`管理员可见 student02 目录 — 未找到 student02`
- 其余 UI 用例：首次登录会弹出引导层（`d509:tour:v1:<账号>` 只存在 localStorage，
  Playwright 每个上下文都是新的），阻塞点击；此外大量断言绑定了旧账号名与旧服务
  （Quantum/Open WebUI 已下线，相关段落已逐处清理）

已修的相关项（都已提交）：

- 36 个脚本的 `BASE` 改成 `process.env.BASE`（脱敏把地址换成了不可路由的 `192.0.2.10`，
  这是套件全红的直接原因）
- 修掉批量改写产生的自引用坏行（`const BASE = process.env.X || \`${BASE}\``）
- Quantum/OpenWebUI 的断言逐处清掉或换到在线的 `drawio`/`linux-command`
- 上游依赖（NCBI/EBI/UniProt 适配器、天气、外部模型）失败记 **SKIP** 而不是 FAIL
- `/api/weather` 上游失败原本直接 500，已改为「有缓存回旧值、无缓存回 available=false」

**要让它全绿，还差两件事**（都需要实验室数据/账号配合，不是改断言能解决的）：

1. 造出套件期望的账号与共享内容（`student02`、课程资料目录里的可预览文件）；
2. 让引导层对 e2e 账号不出现（建议：`/api/me` 对 `LABSPACE_E2E_ACCOUNTS` 里的账号
   返回 `e2e: true`，`OnboardingTour` 见到就跳过 —— 一处改动，28 个脚本都不用动）。

## 未开始（2/10）

### split-backend（`main.py` 2209 行 → ≤400）

下线观测那半已交付：`/api/services*`、`/api/corpus`、`/api/search*`、`/api/favorites*`、
`/api/recent*` 已加 `Deprecation` 头与命中计数（`/api/admin/deprecated-hits`）。

拆分部分**试了三次都没成**，教训写下来以免下次重踩：

1. 按「注释标题」切：切点选错，把中间件一起搬走（`Body` 未定义）；
2. 按「函数名 + 相邻行」切：把不相干的 `wecom`/`httpx` 段落带进新模块；
3. 按 AST 切（`ops/split_main_module.py`，工具已留在仓库）：函数边界是准的，
   但**跨模块引用**（`_safe_component`、`log`、`_parse_day_param`）还得人工接，
   接的过程中又把 `daily-papers` 路由弄成 403。

结论：这个文件要拆，得**一次只搬一个域、每次跑完 pytest 再搬下一个**，
且先把 `routers/deps.py`（`client_host`/`safe_component`/日志）立起来。工具在，
下个人（或下一轮）从 `announcements` 这种最独立的域开始即可。

### split-frontend（`BaserowPage` 3882 / `Files` 2716 / `api.ts` 2790 → ≤1000）

同样试过一次 `api.ts` 拆分并**完整回滚**：整体搬 `request` 系列 helpers 时，
`FileContentConflictError` 与 `Labops*` 类型分居两处，搬完 `tsc` 报一串
「implicitly any」。正确顺序应是：

1. 先把 `api.ts` 顶部的**类型**按域搬到 `api-types-*.ts`（纯类型，风险最低）；
2. 再把 `request/requestBlob/requestFileContentPut` 与两个自定义 Error 搬到 `api-http.ts`；
3. 最后按域搬 `api` 对象成员（Baserow / Plot+LaTeX 各自成块），`api.ts` 只留 barrel；
4. 每步 `tsc -b` 必须 0 error 才进下一步。

## 门禁现状（可复现）

| 门禁 | 当前 |
| --- | --- |
| `pytest -q` | 307 passed |
| `tsc -b` | 0 error |
| `vite build` | ✓ built |
| `GOPROXY=off go test ./...` | 25 个包全绿 |
| 业务页面裸 hex | 0 |
| `e2e/run-regression.sh` | **28 个失败**（原因见上，非代码缺陷） |
| 前/后端 >1000 行文件 | `BaserowPage.tsx` 3882、`Files.tsx` 2716、`api.ts` 2790、`main.py` 2209 |
