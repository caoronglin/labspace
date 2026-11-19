# 项目审计报告（Issue #1）

范围：`labspace/backend/app/*.py`（现网 Python，已含 PR #2「审计加固」的成果）、
`labspace/go-core`（Go 增量基线）。
方法：静态阅读 + 真实编译/测试验证。Go 侧全部结论均由 `go test ./...`、
`go vet ./...`、`go test -race`（新增包）、`go build ./cmd/labgo` 实测（`GOPROXY=off`）。

> 基线说明：本次 checkout 的 `main` 已合入 PR #2（审计加固）与 PR #3（前端可扩展性）。
> 因此 Python 侧的 SSRF 白名单、下载文件名、workbench `asyncio.to_thread`、
> `CASE WHEN` 精简等**已经修过**。本报告不再把它们列为"现存问题"，
> 只记录本次新发现的问题，以及 Go 迁移时对齐/加固的安全语义。

---

## A. 本次新发现并修复的事实性问题

| # | 位置 | 问题 | 修复 |
| --- | --- | --- | --- |
| A1 | `backend/app/main.py` `/api/literature` | `q` 直接 f-string 拼进上游 URL（`query={q}` 等 5 处），`&`/`#`/空格会篡改查询串、可注入额外参数。PR #2 未覆盖此处 | 改用 `httpx` 的 `params=` 交由库做 URL 编码 |
| A2 | 根 `.gitignore` | 规则 `labgo`（裸名、无斜杠）匹配**任意层级**同名文件/目录，把源码目录 `cmd/labgo/` 一并忽略，导致 `cmd/labgo/main.go` 永远无法入库 | 改为带路径规则 `/labspace/go-core/labgo`，只忽略编译产物 |
| A3 | `labspace/go-core` | 缺 `cmd/labgo/main.go`，但 `README.md` 明确要求 `go build ./cmd/labgo`，构建必然失败；A2 是它一直没被发现的根因 | 补齐构建入口，env 驱动、fail-closed，接线全部能力 |
| A4 | `httpapi.Server` 新路由 | `guard.ReadBounded` 消费 `r.Body` 做 HMAC 后，下游 handler 再读得到空 body → JSON 路由 400 | 把缓冲字节回填 `r.Body`；大文件上传走流式路径；`TestDBAPIQueryRoute` 覆盖 |
| A5 | Go `db_apis` 通用分支（防御性） | Python 通用分支 `endpoint.format(q,limit)` 只填两个占位符；现在 32 个含 `{program}/{database}/{space}/{organism}` 的 spec 都走 transform 所以不触发，但**未来新增通用 spec 必然 KeyError** | Go `render()` 一次性填满全部已知占位符，并有回归测试 `TestRenderFillsEveryPlaceholder` |

### Go 迁移时对齐并进一步加固的安全语义（Python 侧已由 PR #2 修复，Go 侧等价实现 + 测试）

- **SSRF**：Python `resolve_download` 已做协议/私网白名单 + 不跟随重定向。Go
  `ResolveDownload` 额外要求绝对 URL 的 host 必须等于**配置的 SnapOtter 主机**，
  测试覆盖 `169.254.169.254` 云元数据与 `file://`。
- **文件名注入**：Python 下载已净化。Go `sanitizeFilename` 去掉控制字符/引号/
  分号/冒号/路径分隔符/`..`，并有单测。
- **数据隔离**：workbench 16 接口全部 `user_id` 作用域；Go 用参数化查询
  （`? → $1`）+ `RETURNING`，单测逐条断言 SQL 含 `user_id=$1`。
- **稀疏更新**：Python `patch_*` 已改动态列。Go `buildPatch` 只 `SET` 实际提供的列，
  单测断言不会重写未触及列（无写放大）。
- **阻塞调用**：Python 已用 `asyncio.to_thread`。Go 侧天生同步 + `database/sql` 连接池，
  `context` 可取消，无事件循环阻塞。

---

## B. 待评估 / 建议排期（未改现网，避免越界回归）

### 安全
- **B1 `os.system` 命令拼接**（`main.py:169,170,1094`）：`setfacl ... {path}` 走 shell。
  `path` 经 `SAFE_NAME` 过滤了元字符，但组件仍可能以 `-` 开头被当成 setfacl 选项，
  且 fork shell 本身多余。建议：`subprocess.run(["setfacl","-m","u:1000:rwX","--",path], check=False)`。
- **B2 Host 头自适应**（`_client_host`/`adapt_host`，`main.py:413`）：从
  `X-Forwarded-Host`/`Host` 取主机名拼进服务 URL；Host 客户端可控。若 nginx 未强制覆写
  `X-Forwarded-Host`，可造成开放重定向 / SSRF 探测面 / 缓存键污染。
  建议：入口 nginx 固定 `Host`/`X-Forwarded-*`；后端只接受白名单两个入口 IP
  （192.0.2.10 / 198.51.100.71）。
- **B3 明文 HTTP**：`SECURITY.md` 已记录——会话 Cookie / CSRF / OIDC code 在内网明文传输。
  建议内网也上自签 TLS，或至少把会话 Cookie 标 `Secure` 走 HTTPS。
- **B4 `/api/network/entries`**（`main.py:640`）自检用 `follow_redirects=True`：
  目标来自固定表 + 自适应 host，风险低于 B2，但重定向跟随放大影响面。建议不跟随。

### 逻辑 / 一致性
- **B5 `db_apis.probe`** 把 `<500` 都算"可用"，一个稳定返回 404 的接口会被标
  `available=true`。建议以 `<400` 为准（Go `Prober.fetch` 已用 `<400`）。
- **B6 `workbench.create_brief`** `INSERT ... ON CONFLICT` 后再 `SELECT` 未包事务，
  两语句间可能被同用户另一请求插队拿到旧值。建议 `RETURNING *` 单语句
  （Go `CreateBrief` 已用 `RETURNING`）。
- **B7 通用分支占位符**：见 A5；建议 Python 侧也改成统一 renderer，消除脆弱耦合。

### 性能
- **B8 `/api/databases/apis`** 首次请求并发探测 32 个上游、EBI 慢站点 35s 超时，
  长尾阻塞明显。建议后台定时预热 + 接口直接读缓存（Go `ProbeAll` 已并发，仍建议预热）。
- **B9 snapotter 工具目录**：600KB YAML 冷启动解析耗时；Python 已有
  `_refresh_snapotter_catalog` 雏形，建议启动时异步预热并固化缓存。

### 框架整理
- **B10 两套 `go-core` 并存**：`g2/go-core`（归档交付包）与 `labspace/go-core`（现网演进）
  大量重复包（`policy/postgres.go` 完全相同），README 却都要求构建。建议明确 `g2/`
  为只读快照，仅维护 `labspace/go-core`。
- **B11 `go-core/README.md`** 原写"caller supplies a pgx/libpq compatible *sql.DB"，
  与"零依赖自研 pgwire 驱动"冲突 → **本次已改为指向 `docs/PG_DRIVER_STRATEGY.md`**。
- **B12 `db.py`** 把 `CREATE TABLE` DDL 放在 `get_pool()` 首次调用里，启动即执行，
  与 Alembic 职责重叠。建议迁移统一由 migration 管理。

---

## C. 本次 Go 迁移交付物

- `internal/pgwire/`：零外部依赖 PostgreSQL v3 线协议驱动（`database/sql` 接口），
  支持 trust/cleartext/MD5/**SCRAM-SHA-256**、扩展查询协议、参数化、事务、context；
  内置**协议级 mock backend**，4 种认证 + NULL 参数 + 占位符转换全覆盖，无需真实 PG。
- `internal/workbench/`：16 接口 + 纯本地 capture 规则引擎 + summary 聚合；
  capture 10 组表驱动用例；store/handler 走真实 `sql.DB → pgwire → mock` 全链路。
- `internal/snapotter/`：REST 代理 + OpenAPI 工具目录解析 + 缓存 + SSRF/文件名加固。
- `internal/dbapis/`：32 适配器（数据驱动 `specs.json`）+ 30 个 transform + 通用分支 + probe；
  完整性测试保证 32 spec ↔ transform 一一对应。
- `internal/httpapi/`：接入三组新路由，保留既有 HMAC/会话/CSRF 鉴权。
- `cmd/labgo/main.go`：补齐构建入口，env 驱动、fail-closed。
- `docs/PG_DRIVER_STRATEGY.md`：PG 驱动策略决策与边界；`docs/AUDIT_REPORT_ISSUE1.md`：本报告。

验证命令（均 `GOPROXY=off` 通过，`go.mod` 仍零依赖、无 `go.sum`）：
```
go test ./...
go vet ./...
go test -race ./internal/pgwire ./internal/workbench ./internal/snapotter ./internal/dbapis
go build -trimpath -o /usr/local/bin/labgo ./cmd/labgo
```
