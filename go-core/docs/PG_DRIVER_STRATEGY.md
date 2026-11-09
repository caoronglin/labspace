# Go 零外部依赖下的 PostgreSQL 驱动策略

## 决策

Go core 保持 **`go.mod` 零依赖、`GOPROXY=off` 可编译**，同时业务层需要真实访问
PostgreSQL（workbench 的 16 个接口、policy ACL）。

采用：`database/sql` + **纯标准库实现的 PostgreSQL v3 线协议驱动**
（`internal/pgwire`），通过 `sql.Register("pgwire", ...)` 注入。

- 业务代码只依赖 `*sql.DB`，与具体驱动解耦；`policy.SQLPolicy{DB *sql.DB}` 无需改动即可复用。
- 不 vendor `lib/pq`、`pgx`、任何 `golang.org/x/*`；PBKDF2/SCRAM 用 `crypto/hmac` + `crypto/sha256` 自实现。
- `sql.Open("pgwire", dsn)` 即可，DSN 支持 `key=value` 与 `postgres://user:pass@host:port/dbname?sslmode=...`。

## 已实现（协议级集成测试覆盖）

| 能力 | 说明 |
| --- | --- |
| Startup | 协议版本 196608，SSLRequest 协商（prefer 时服务端拒绝则回退明文） |
| 认证 | trust / cleartext / **MD5** / **SCRAM-SHA-256**（PG10+ 默认） |
| 查询 | 扩展查询协议：Parse → Bind → Describe → Execute → Sync，文本格式参数与结果 |
| 参数 | `?` 占位符自动转 `$1/$2...`（跳过字符串字面量内的 `?`），支持 NULL、bool、time.Time、`[]string` 数组字面量 |
| 结果 | `int2/4/8`、`float4/8`、`numeric`、`bool` 原生转换，其余为文本 |
| 事务 | `Begin/BeginTx`（含 ReadOnly）、`Commit`、`Rollback` |
| 上下文 | `QueryContext/ExecContext/Ping`，deadline 映射为 socket deadline |
| 连接池 | 交给 `database/sql`（`SetMaxOpenConns` 等） |

`internal/pgwire/driver_test.go` 内置**协议级 mock backend**：真实收发 startup / SASL /
Parse / Bind / DataRow / CommandComplete 等消息，验证四种认证与参数绑定。因此
`go test ./...` 无需真实 PG 实例即可证明驱动可用。

## 明确限制（边界，非缺陷）

- **TLS 不在驱动内实现**：内网部署走 loopback / Docker 网络 / pgbouncer 终止 TLS；`sslmode=require` 显式报错而非静默降为明文。
- 不支持 COPY、LISTEN/NOTIFY、二进制格式、服务端预编译语句缓存、游标。
- 数组/JSON 列返回文本，由业务层 `encoding/json` 解析。
- `LastInsertId` 不支持（PG 用 `RETURNING`），业务层统一用 `SELECT ... RETURNING *`。

## 部署接线（增量，不改现网）

`cmd/labgo` 读取 `LABGO_PG_DSN`（为空则不挂载需要 DB 的路由，进程仍可启动）。
`internal/workbench` 与 `internal/policy` 通过 `*sql.DB` 注入，方便单测传 mock。
Python FastAPI 仍是现网写入方；Go 侧为增量基线，二者共用同一 `labspace` schema。
