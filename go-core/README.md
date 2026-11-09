# LabGo · D509 门户 Go 核心

纯标准库实现的业务内核：`GOPROXY=off` 可直接编译，`go.mod` 没有任何 `require`。
本目录同时是 Python → Go 迁移的落地实现，下一节先回答「Go 零外部依赖如何访问
PostgreSQL」这个前置问题。

## 1. PostgreSQL 驱动策略（零外部依赖）

**结论：用 `database/sql` 包住自写的 PostgreSQL 协议 v3 驱动 `internal/pgwire`
（注册驱动名 `pgwire`），不引入 pgx / lib/pq / `golang.org/x/*`。**

业务层只依赖标准库的 `*sql.DB`，所以 `policy.SQLPolicy` 等既有代码无需改动；
`go.mod` 仍为零 `require`，`GOPROXY=off` 可编译，不产生 `go.sum`。

| 方案 | 结论 | 原因 |
|---|---|---|
| `github.com/jackc/pgx` | 否 | 需要 `require`；`GOPROXY=off` 无法构建，违背内核的零依赖约束 |
| `database/sql` + 外部驱动 | 否 | `database/sql` 本身是标准库，但没有内置驱动，仍要拉外部模块 |
| **`database/sql` + 自写 driver** | **是** | 驱动即 `internal/pgwire`，协议是文档化的字节流，只实现门户需要的子集 |
| `internal/pgwire` 裸客户端（不经 `database/sql`） | 否 | 与标准库重复实现一遍池化与类型适配，无法复用既有 `*sql.DB` 代码 |

### 1.1 实现范围

- 启动握手：参数协商、`ParameterStatus`、`BackendKeyData`
- 认证：`trust` / `cleartext` / `MD5` / **`SCRAM-SHA-256`**（RFC 5802 + 自实现 PBKDF2，
  因为 `crypto/pbkdf2` 只有 Go 1.24+ 才有，内核目标版本是 1.23）
- TLS：`sslmode=disable|prefer|require|verify-*`，`require` 语义与 libpq 一致
  （加密但不校验证书），`verify-*` 才校验
- 查询：简单查询 + 扩展查询（Parse/Bind/Describe/Execute/Sync）
- 结果解码：文本格式，支持 `text` / `int` / `float` / `bool` / `timestamptz` /
  `text[]` / `jsonb`
- 连接池：有界（默认 8）、上下文可取消、出错连接直接丢弃不回收

### 1.2 安全边界（这是选择自写协议的主要原因）

1. **参数从不拼进 SQL**：所有值走 `Bind` 的文本参数，语句文本对调用方不可变，
   注入面为 0（`TestLiveInjectionIsParameterised` 用真实库验证）。
2. **连接损坏即废弃**：协议交换异常时连接不回到池里，避免状态错位的连接被复用。
3. **不做动态 SQL**：`workbench` 的 `UPDATE` 只拼接**列名白名单**，值全部参数化。

### 1.3 验证方式

- 单元测试：`internal/pgwire/pgwire_test.go` 内置一个**协议级 mock backend**，
  覆盖 trust / cleartext / md5 / scram 四种认证、扩展查询参数布局、占位符转换、
  NULL、数组、错误恢复。
- 真机测试：设置 `LABGO_TEST_PG_DSN` 后跑 `-run Live`，连真实 PostgreSQL 15，
  覆盖 SCRAM 认证、参数化、注入、错误恢复、用户隔离。

```bash
# 本地起一个一次性实例
initdb -D /tmp/pgdata -A scram-sha-256 -U lab --pwfile=<(echo labpass)
pg_ctl -D /tmp/pgdata -o '-p 55432' start

cd labspace/go-core
LABGO_TEST_PG_DSN='postgresql://lab:labpass@127.0.0.1:55432/postgres?sslmode=disable' \
  go test ./internal/pgwire/ ./internal/workbench/ -run Live -v
```

未设置 DSN 时相关用例自动 `t.Skip`，CI 保持无外部依赖。

## 2. 本次迁移的模块

| Go 包 | 取代的 Python 模块 | 内容 |
|---|---|---|
| `internal/researchdb` | `backend/app/db_apis.py` | **32 个**科研 API 适配器 + 归一化 + 探活缓存 + 无 API 原因表 |
| `internal/snapotter` | `backend/app/snapotter.py` | REST 代理、OpenAPI 工具目录解析（含缓存与降级）、下载 SSRF 白名单、流式 multipart 提交 |
| `internal/workbench` | `backend/app/workbench.py` | **16 个**接口的数据层 + 本地规则捕获引擎 |
| `internal/pgwire` | —（新增） | 零依赖 PostgreSQL 协议客户端 |
| `internal/httpapi` | `backend/app/main.py` 相应路由 | `/v1/databases/*`、`/v1/workbench/*`、`/v1/snapotter/*` |

### 2.1 迁移中修掉的 Python 缺陷

| 位置 | 问题 | Go 侧处理 |
|---|---|---|
| `db_apis._t_panther` | `list(genes.values())` 分支下元素可能是字符串，`gene.get(...)` 必然抛 `AttributeError`（已用最小用例复现） | 四种上游形状统一归一成 `[]map`，非对象元素直接跳过 |
| `db_apis._t_uniprot` | `genes[0]` 只在 `genes` 为真时兜底，上游把 `genes` 返回成 dict 时会取到错误形状 | `Objects()` 归一再取首个 |
| `db_apis._t_chembl` | ATC 分类元素形状不固定（str / dict / 其他） | 两类形状分别处理 |
| `db_apis._t_hpa` | 只解一层 gzip；链路再压缩一次就 `json.loads` 失败 | `decodeLenient` 解两层 |
| `snapotter.resolve_download` | 白名单没包含**用户自己配置的 host**，自定义域名部署后下载全挂 | 白名单 + 比较 `BaseURL` 主机 |
| `snapotter.resolve_download` | 不认 `//host/path` 协议相对写法，会把外部主机当路径代理 | 显式拒绝 |
| `snapotter.download` | `Content-Disposition` 文件名未净化，可带头注入 | `SanitizeFilename` |
| `workbench` | 4 次 `CASE WHEN %s` 巨型 UPDATE，参数顺序极易错位 | 白名单列 + 只拼列名 |
| `workbench.summary` | 单次渲染 9 条列表查询 + 4 条独立 count | 5 列表 + 1 聚合（9 条固定） |
| `workbench` | 无 `(user_id, due_date)` 索引，到期查询全表扫 | `Schema` 增加部分索引 |

### 2.2 数据契约

Go 侧沿用 Python 的 JSON 字段名（`snake_case` 用于持久化字段、`camelCase` 用于
聚合统计），因此前端与既有 OpenAPI 不需要改动即可切流。

## 3. 构建与测试

```bash
cd labspace/go-core

GOPROXY=off go build ./...          # 零外部依赖
GOPROXY=off go vet ./...
GOPROXY=off go test ./...           # 全部包
CGO_ENABLED=1 go test -race ./...   # 竞态
```

实测（2026-11-04，Debian 12 / Go 1.23.11 / PostgreSQL 15.19）：

- `go vet ./...`：通过
- `go test ./...`：**24 个包全部 ok**
- `go test -race ./...`：全部 ok
- 真实 PG 15 + SCRAM-SHA-256：`Live` 用例全部 ok（含跨用户隔离、注入回存）

## 4. 尚未接入的部分

- `cmd/labgo` 尚未根据环境变量装配 `pgwire` 连接池与 SnapOtter 客户端（下一步：
  读取 `LABSPACE_DB_DSN` / `SNAPOTTER_BASE_URL`，失败时降级为 503 而不是启动失败）。
- Nginx 尚未把 `/api/workbench/*` 等前缀切到 Go；切换前需先跑一轮影子流量对账。
