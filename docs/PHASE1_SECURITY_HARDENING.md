# Phase 1：安全止血与热修（验收记录）

> 对应规格书 v2.0 §2「7 项实证 BUG」与 §8「Phase 1 门禁」。
> 本文件只记录**可复现的证据**：命令 + 实测输出。环境：`/opt/labspace`，
> 双入口 `192.0.2.10`（LAN，实际部署值见 `deploy/.env`）与 Tailscale。

## 门禁总览

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 后端单测 | `cd backend && .venv/bin/python -m pytest -q` | **303 passed**（≥290） |
| Go 竞态 | `cd go-core && GOPROXY=off go test -race ./...` | **全绿**，`go vet` 无告警，无 `go.sum`（零依赖） |
| 前端类型 | `cd frontend && npx tsc -b` | **0 error** |
| 前端构建 | `cd frontend && npx vite build` | **✓ built** |
| 慢速大文件上传 | 100 MB @ 2 MB/s → `POST /api/files/upload?source=public` | **HTTP 200，50.3 s**，落盘 SHA-256 与源一致 |
| SSRF | 伪造 `X-Forwarded-Host` → `GET /api/network/entries` | 伪造值全被丢弃，回落到白名单主机 |
| 未改密穿透 | 带 `pwd_reset` 的会话访问 6 条旁路 | `428`/`428`/`403`/`403`/`428`/`428` |

## BUG-01 入口主机白名单（P0）

- 新增 `LABSPACE_ALLOWED_HOSTS` / `LABSPACE_DEFAULT_ENTRY_HOST`；`_client_host` 与
  `_request_base` 共用一套判定，伪造 Host 回落默认入口。
- `/api/network/entries` 探针 `follow_redirects=False`。
- 单测：`tests/test_network_entries_host.py`（8 例）。

实测：

```text
XFH=169.254.169.254          → host=127.0.0.1
XFH=10.0.0.1                 → host=127.0.0.1
XFH=metadata.google.internal → host=127.0.0.1
```

## BUG-02 强制改密贯通三端（P0）

- 会话 JWT 增加 `pwd_reset` claim（登录置位、改密后重签复位）。
- Go `session.Actor.PwdReset` + `httpapi.pwdResetGate`（仅放行 `/api/me*`、`/api/auth/*`）。
- `/api/auth/check` 按 `X-Original-URI` 判豁免、按 `X-Original-Method` 做 CSRF 双提交。
- 中间件不再每请求查库，异常也不会缓存成「放行」。
- 管理员重置口令同样置 `must_change` 并吊销会话。
- 单测：`tests/test_auth_check_gate.py`(5) + `internal/httpapi/pwdreset_test.go` + session 用例。

实测（未改密会话）：

```text
/api/files 428   /api/next/v1/workbench 428   /api/workbench/summary 428
/api/baserow/overview 428   /pdf-api/ 403   /mail/ 403
/api/me 200（豁免路径）
```

## BUG-03 口令/密钥出库 + 容器加固（P0）

- `git grep labspace-local-dev-pw` → **0**；DSN、Qdrant API Key、Baserow 站点 URL、
  内网向量模型地址、Mailbox 对外地址全部由 `deploy/.env`（0600，不入库）注入，
  `.env.example` 只放占位符。
- Qdrant 开启 API Key：无 key `401`、带 key `200`（容器内实测）。
- 五个容器 `docker inspect`：`CapDrop=[ALL]`、`no-new-privileges:true`、
  `mem_limit`、`pids_limit`、`json-file 10m×3`。Stirling 因 LibreOffice 沙箱
  需降权，精确加回 `CHOWN/DAC_OVERRIDE/FOWNER/FSETID/SETGID/SETUID`。
- `qdrant/casdoor/drawio/pdfmathtranslate/stirling` 的 `:latest` 全部锁 digest。

## BUG-04 大文件上传超时（P1）

- 服务器级 `ReadTimeout/WriteTimeout` 置 0，只留 `ReadHeaderTimeout:5s`。
- 新增 `httpapi.WithDeadlines`：普通 API 15 s/120 s，`/v1/files/*`、`/api/files*`、
  `/v1/snapotter/*`、`/v1/downloads/*` 用 3600 s。
- 单测：`internal/httpapi/deadlines_test.go`。

实测：100 MB @ 2 MB/s → `HTTP 200`，50.3 s，`72375dcb…` 与源文件一致（修复前 15 s 即断）。

## BUG-05 Nginx 限流与 /pdf-api/ CSRF（P1）

- `limit_conn lab_conn 200` 提到 `server` 级（`error.log` 出现
  `limiting connections by zone "lab_conn"`）。
- 新增 `lab_pdf`(10r/m burst=5) 与 `lab_mail`(30r/s)：`/pdf-api/` 连发第 5 个起 `503`。
- `/api/search` 400 并发 → 大量 `503`。
- `/pdf-api/` 写请求经 `_portal_auth` 校验 CSRF：无 `X-CSRF-Token` 的 POST → `403`。
- **踩坑记录**：`/etc/nginx/sites-enabled/labspace.conf` 是拷贝而非软链，改仓库配置
  不自动生效（配置写好了但线上仍是旧拷贝）。新增 `ops/nginx-sync.sh`
  （同步 + `nginx -t` + reload，支持 `--check`）。

## BUG-06 AgentScope SSE 401 与 Mailbox 跨段（P1）

- `agentscope.conf` 拆出 `location ^~ /api/`、`^~ /chat/` 透传 401，只有页面跳登录。
- Mailbox `MAILBOX_SERVICE_PUBLIC_URL=/mail`（相对）+ `/mail/` 的 `proxy_redirect`
  跟随 `$host`。

实测：

```text
8104/api/agent/sessions/x/stream → 401（修复前 302）
8104/                            → 302（页面仍跳登录）
127.0.0.1 与 LAN IP 两个入口 /mail/health、/mail/openapi.json 均 200，无跨段地址
```

## BUG-07 lifedb 超时与学生可达（P2）

- `lifedb` 兜底客户端不再回落 `http.DefaultClient`，改 15 s 专用客户端。
- `/research`、`/meetings` 去掉 `RequireTeacher`（页面内 `canManage` 已按角色隐藏管理按钮）。

实测：

```text
学生 /research 200   /meetings 200   /api/research/mine 200   /api/meetings/weeks 200
学生 research/mine 只返回自己那一份：2026-11-10-杨志宁 granted:true
```

## 遗留（Phase 2/3 范围，未在本期处理）

- ACL 巡检接口、审计导出、前端巨石拆分、设计令牌零漂移
- 统一任务中心（`lab_jobs` + 顶栏 SSE）、ELN 血缘、模型降级与配额
- 数据库口令轮换（当前仅做到「出库 + 环境注入」，未更换在用口令）
