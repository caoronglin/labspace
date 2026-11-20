# GO_CORE_REPLACEMENT.md — Go 核心（LabGo）替换 Python 模块

> 状态：已落地并实测（2026-11-03；2026-11-04 追加「统一语料 / 全局搜索」一组）
> 目标：把门户里「服务目录 / 健康检查 / 内嵌探测」以及「统一语料 / 全局搜索」这两组
> Python 模块整体替换为 Go 实现，让浏览器请求路径上不再有 Python 参与，
> 同时保证现有前端行为逐字段不变。

---

## 1. 为什么换

原实现散落在三个 Python 文件里：

| Python 文件 | 职责 | 问题 |
| --- | --- | --- |
| `backend/app/catalog.py` | 服务注册表 + 健康探测（`_probe_http` / `_probe_tcp` / `check_health`） | 注册表与探测逻辑各写一份；健康地址是「容器内地址」，只有后端容器能访问 |
| `backend/app/embed.py` | iframe 可嵌入探测（X-Frame-Options / CSP frame-ancestors） | 独立实现，与目录里的字段各维护一份 |
| `backend/app/main.py` | 5 个 `/api/services*` 路由 | 路由层再包一层 `adapt_host` |

换到 Go 之后的收益：

1. **单一权威源**：服务注册表只存在于 `internal/catalog`，Python 侧只读导出的 JSON，不再维护第二份清单。
2. **探测位置正确**：Go 跑在宿主机上，可以直接探 `127.0.0.1:3000`、`192.0.2.10:8091` 等真实入口，
   不再依赖「容器内地址 / 需要 docker exec」这类绕路。
3. **浏览器链路更短**：`/api/services*` 由 nginx 直接转给 Go，Python 网关不在链路上。
4. **可回归**：Go 侧有单元测试（`go test ./...` 全绿），行为变更会被测试挡住。

---

## 2. 替换矩阵

| 原 Python 实现 | 新 Go 实现 | 对外路由（浏览器路径） | 状态 |
| --- | --- | --- | --- |
| `catalog.py::CATALOG`（13 条服务定义） | `internal/catalog.Default()` | 导出为 `/srv/labdata/labgo/catalog.json`，容器只读挂载到 `/srv/labgo/catalog.json` | ✅ 已替换 |
| `catalog.py::visible_services()` | `internal/catalog.Live(host, roles)` | `GET /api/services` | ✅ 已替换（Python 保留兼容路由） |
| `catalog.py::check_health()` + `_probe_http` / `_probe_tcp` | `internal/health.Prober` | `GET /api/services/health`、`GET /api/services/<id>/health` | ✅ 已替换 |
| `embed.py::probe_embed()` / `embed_info()` | `internal/embed.Prober` | `GET /api/services/<id>/embed` | ✅ 已替换（`embed.py` 已删除） |
| `main.py::api_service_sso()` | `internal/catalog` 的 `ssoUrl` 字段 | `GET /api/services/<id>/sso` | ✅ 已替换 |
| `main.py::api_admin_health()`（遍历 CATALOG 探活） | 调用 Go 的 `/v1/services/<id>/health` | `GET /api/admin/health` | ✅ 改为委托 |
| `main.py::api_add_favorite()` 的「服务是否存在」校验 | 读 Go 导出的目录 | `POST /api/favorites/<id>` | ✅ 改为读导出文件 |
| `corpus.py::build_corpus()`（服务 + 数据库 + 页面 + 工具 + 命令 + SnapOtter 工具，共 1011 条） | `internal/corpus.Index.Build()` | `GET /api/corpus` | ✅ 已替换（Python 保留兼容路由） |
| `corpus.py::suggest()` / `hot_keywords()` | `internal/corpus.Index.Suggest()` / `Hot()` | `GET /api/search/suggest` | ✅ 已替换 |
| `corpus.py::search_corpus()`（打分 / 类型配额 / overflow） | `internal/corpus.Index.Search()` | `GET /api/corpus?q=` | ✅ 已替换 |
| `databases.py::search_databases()`（featured 优先 + 精确 > 前缀 > 包含） | `internal/corpus.Index.Databases()` | `GET /api/corpus/databases` | ✅ 已替换 |
| `main.py::api_search()`（本地语料 + SearXNG 联网结果） | `internal/websearch` + `internal/corpus` | `GET /api/search` | ✅ 已替换（Python 保留兼容路由） |
| `main.py::api_search_categories()` / `normalize_category()` | `internal/httpapi` 分类别名表 | `GET /api/search/categories` | ✅ 已替换（分类清单集中在 `app/searchconfig.py` 与共享 JSON） |
| `main.py::api_workbench_*()`（工作台 16 个接口） | `internal/workbench` + `internal/pgwire`（手写 PostgreSQL v3 wire 驱动） | `GET /api/next/v1/workbench/*` | ✅ 已替换（Python 保留兼容路由） |
| `db_apis.py`（32 个科研 API 适配器） | `internal/dbapis` | `GET /api/next/v1/databases*` | ✅ 已替换（Python 保留兼容路由） |
| `snapotter.py`（工具目录 / 提交任务） | `internal/snapotter` | `GET /api/next/v1/snapotter/*` | ✅ 已替换 |
| ~~新增：CropGenome Toolkit 接入~~ | ~~`internal/httpapi/cropgenome.go`（OIDC 感知反向代理）~~ | ~~`GET /cropgenome/api/v1/*`~~ | ⛔ 2026-11 已下架，见 `docs/RETIRE-CROPGENOME.md` |

### 保留在 Python 的部分（有意为之）

* `backend/app/catalog.py` 的 **读取器**（`load_catalog()` / `visible_services()` / `adapt_host()`）：
  语料检索（`corpus.py`）与收藏校验仍需要服务清单，改为读 Go 导出的 JSON。
* `backend/app/golink.py`：Python → Go 的调用桥（容器内经 Docker 网桥 `172.28.0.1:8122` 访问）。
* Python 的 5 个 `/api/services*` 兼容路由：仅服务**直连后端端口**（`127.0.0.1:8088`）的旧客户端，
  浏览器流量全部由 nginx 交给 Go。

---

## 3. 部署形态

```
浏览器 ──HTTP──▶ nginx (192.0.2.10:80)
                   ├── /api/services*      ──▶ LabGo 127.0.0.1:8122   ← 替换后
                   ├── /api/corpus         ──▶ LabGo 127.0.0.1:8122   ← 替换后
                   ├── /api/search         ──▶ LabGo 127.0.0.1:8122   ← 替换后
                   ├── /api/search/suggest ──▶ LabGo 127.0.0.1:8122   ← 替换后
                   ├── /api/search/categories ─▶ LabGo 127.0.0.1:8122 ← 替换后
                   ├── /api/next/*          ──▶ LabGo 127.0.0.1:8122   ← Go 原生命名空间
                   └── /api/*               ──▶ lab-labspace-backend  (Python, 127.0.0.1:8088)
                                                 └── 内部调用 ──▶ LabGo 172.28.0.1:8122（网桥）
LabGo（systemd labgo，User=labuser）
  ├── 监听 127.0.0.1:8122       （nginx / 宿主机本地）
  └── 监听 172.28.0.1:8122       （Docker 网桥，供后端容器调用；pi RPC 网关同一模式）
```

### 目录导出契约

`internal/catalog.WriteExport()` 每 60 秒（以及启动时）写出：

```
/srv/labdata/labgo/catalog.json     # version=2，13 条服务 + 4 条 Go 原生项
/srv/labdata/labgo/endpoints.json   # 容器 IP 占位符映射（labgo-endpoint-sync 维护）
```

后端容器以 **只读** 方式挂载 `/srv/labdata/labgo:/srv/labgo:ro`，
Python 侧 15 秒缓存 + mtime 检查，**写盘瞬间的半截 JSON 不会让门户服务目录整体不可用**
（解析失败时保留上一次成功的结果）。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LABGO_ADDR` | `127.0.0.1:8122` | 本地监听地址 |
| `LABGO_BRIDGE_ADDR` | `172.28.0.1:8122` | Docker 网桥监听地址（置空则关闭） |
| `LABGO_LAB_ROOT` | `/srv/lab` | 实验文件根目录（只读索引） |
| `LABGO_ACL_FILE` | `/etc/lab-go/acl/labgo-acl.json` | 文件权限 ACL（可写目录，账号创建时原子更新；旧路径为符号链接） |
| `LABGO_CATALOG_EXPORT` | `/srv/labdata/labgo/catalog.json` | 目录导出路径 |
| `LABGO_ENDPOINTS_FILE` | `/srv/labdata/labgo/endpoints.json` | 容器地址占位符映射 |
| `LABGO_HEALTH_TTL` | `30` | 健康检查缓存秒数 |
| `LABGO_CORPUS_DATA` | `/opt/labspace/shared/corpus-data.json` | 共享静态语料（数据库目录 / 页面 / 工具 / 分类 / 别名） |
| `LABGO_SNAPOTTER_URL` | `http://127.0.0.1:8092` | SnapOtter 快照地址（用于解析 openapi.yaml） |
| `LABGO_SNAPOTTER_TOKEN_FILE` | `/etc/lab-openwebui/credentials.snapotter` | SnapOtter 令牌文件（只读） |
| `SEARXNG_BASE_URL` | — | SearXNG 基址（宿主机可达地址，容器内为 `lab-searxng:8080`） |
| `LABSPACE_SERVICE_TOKEN` | — | 内部服务令牌（pi 插件等只读调用；对应 Python 的 `X-Lab-Service-Token`） |
| `LABSPACE_SESSION_SECRET` | — | 与门户后端共用的会话密钥（Go 直接校验浏览器会话） |
| `LABSPACE_ALLOWED_ORIGINS` | — | Origin 白名单（CSRF 校验） |

---

## 4. 行为一致性

用 `e2e/catalog-parity.mjs` 做逐字段对照（16 个字段 × 13 条服务 × 学生/管理员两种角色）：

```
[student] Go 12 项 / Python 12 项
[admin]   Go 13 项 / Python 13 项
结论：Go 与 Python 服务目录字段完全一致
```

对照方法：Go 侧走浏览器经 nginx 的 `/api/services`；Python 侧直连后端容器端口
`127.0.0.1:8088/api/services`（绕过 nginx，保证比对的是 Python 实现本身），
两侧使用同一 Host 头（`192.0.2.10`）。

### 替换过程中修掉的 3 个真实缺陷

1. **切片别名污染**：`adaptItem()` 直接改写 `it.Guide[i]`，与目录原项共享底层数组 →
   某次请求的 Host 会永久写进目录（实测 it-tools 的指引变成 `http://127.0.0.1:8084/` 并被导出到文件）。
   修复：适配前先深拷贝 `Tags/Roles/Guide`。
2. **nginx 未透传 Host**：`proxy_set_header` 默认 `$proxy_host` → Go 收到 `Host: labgo`，
   服务地址被改成 `http://labgo:8082/`。修复：location 内显式 `proxy_set_header Host $host;`。
3. **空值形状不一致**：Go 输出 `roles: null`（Python 是 `[]`）、`embedUrl: ""`（Python 回退为 `url`）。
   修复：适配后保证切片非 nil；`EmbedURL` 为空时回退 `URL`。

另外一处语义对齐：`external-down`（外部内网服务故障归外部主机）原本只在批量接口里改写，
替换时一度在 Go 侧放错了位置，现已与原实现一致——**批量接口改写、单条接口不改写**。

### 兼顶（failover）：Go 挂了自动回 Python

浏览器路径虽然只打 Go 核心，但不能让 Go 短暂不可用就整站检索失效，因此：

- Python 侧为 9 个处理函数**额外注册了 `/v1/*` 同路径别名**（`/v1/services`、`/v1/services/health`、
  `/v1/services/<id>/health`、`/v1/services/<id>/embed`、`/v1/services/<id>/sso`、
  `/v1/corpus`、`/v1/corpus/suggest`、`/v1/portal/search`、`/v1/portal/search/categories`），
  响应结构与 Go 端一致（已用同一套对照脚本验证）。
- nginx 新增上游 `labgo_fallback`：`server 127.0.0.1:8122 max_fails=1 fail_timeout=10s;`
  加 `server 127.0.0.1:8088 backup;`，并在对应 location 里启用
  `proxy_next_upstream error timeout http_502 http_503 http_504;`。
- 实测：`systemctl stop labgo` 后 `/api/services` 仍返回 **200**（来自 Python 兼顶）；
  Go 恢复后自动切回（`max_fails=1 fail_timeout=10s` 控制探测频率）。
- 注意：`/api/next/*`（Go 独有的文件浏览接口）**不做兼顶**，Python 侧没有对应实现。

### 语料 / 搜索组的对照结果

用 `ops/corpus-parity.py` 做逐项对照（在后端容器内执行，先复现服务端的 SnapOtter 目录预热）：

```
[OK] 语料检索 ncbi / NCBI / 拟南芥 / 单细胞 / fastp / BLAST / 表达组 / 截图 / 空词  —— 两侧顺序一致
[OK] 空查询分桶：30 条，两侧顺序一致
[OK] 搜索建议 / 热搜：suggestions=9/4/8，hot=15
[OK] 数据库目录：ncbi 5 条 / 拟南芥 2 条 / 单细胞 8 条 / 全量 107 条，顺序一致
结论：Go 核心与 Python 旧实现的语料 / 搜索结果完全一致
```

### 语料 / 搜索替换过程中修掉的 6 个真实缺陷

1. **Go 分词未 lower**：Python 的 `_tokens()` 会 `.lower()`，Go 版最初漏了 → 大写查询（`NCBI`）搜不到。
2. **OpenAPI 解析器不结束工具块**：遇到三段式路径（`/api/v1/tools/image/strip-metadata/inspect`）
   不匹配工具正则 → 不 flush → 下一个工具的 summary 覆盖了上一个工具的标题
   （实测 `image/html-to-image` 标题被写成 `Inspect metadata`）。修复：遇到任意路径键都 flush。
3. **命令索引顺序随机**：Go 的 map 迭代顺序随机 → 命令桶顺序不稳定（Python 保持 JSON 字母序）。
   修复：`internal/commands.Load()` 按名称排序。
4. **工具目录未排序**：Python 按 `(section, id)` 排序，Go 未排 → 快照桶顺序不同。
5. **YAML 引号未剥离**：Go 逐行解析保留 `summary: "AAC to FLAC"` 的引号，PyYAML 会剥掉。
   修复：新增 `cleanScalar()`。
6. **Python 侧 SnapOtter 目录只预热一次**：启动瞬间 SnapOtter 未就绪 → 语料永久缺 243 个工具。
   修复：启动重试 3 次 + 每 600 秒后台刷新（注意后台任务必须 `asyncio.create_task`，
   直接 await 会让应用启动永远不完成，表现为容器 healthy 失败）。

---

## 4.1 共享数据与单一数据源

| 文件 | 作用 | 生成方式 |
| --- | --- | --- |
| `/opt/labspace/shared/corpus-data.json` | 数据库目录（107）、页面（15）、浏览器工具（12）、SnapOtter 分区中文名与别名（139）、热搜词（15）、检索分类（8） | `python3 ops/export-corpus-data.py`（只读现网模块） |
| `/opt/labspace/backend/app/searchconfig.py` | 检索分类与别名（Python 侧唯一来源） | 手工维护，与共享 JSON 同源 |
| `/srv/labdata/labgo/catalog.json` | 服务目录（13 + 4 条 Go 原生项） | Go 每 60 秒导出 |

Go 的 `internal/corpus` 读取共享 JSON，Python 的 `corpus.py` 仍读自己的模块常量，
两者内容由同一份导出文件保证一致（对照脚本即基于此）。

---

## 5. 验证

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| Go 构建 / 静态检查 | `go build ./... && go vet ./...` | 通过 |
| Go 单测 | `go test ./...` | 全包 ok（新增 `internal/embed` 9 例、`internal/snapotter` 5 例） |
| 目录一致性 | `node e2e/catalog-parity.mjs` | 0 差异 |
| 语料 / 搜索一致性 | `docker exec lab-labspace-backend python /tmp/corpus-parity.py` | 0 差异 |
| Go 文件访问 | `node e2e/go-next-api.mjs` | 14/14 |
| API 集成体检 | `node e2e/api-integration.mjs` | 51/51 |
| 全量回归 | `e2e/run-regression.sh` | 见 `docs/TEST.md` |

接口冒烟（`curl`，Host = `192.0.2.10`）：

```
GET /api/services                    → count=11（匿名：terminal / pdf-translate 按角色隐藏）
GET /api/services/open-webui/health  → {"status":"up","latency_ms":3,"detail":"HTTP 200"}
GET /api/services/drawio/embed       → {"embeddable":true,"reason":"允许嵌入（未设置 X-Frame-Options / frame-ancestors）"}
GET /api/services/quantum/sso        → {"hasSso":true,"ssoUrl":"http://192.0.2.10:8080/files/api/auth/oidc/login"}
```

---

## 6. 回滚

```bash
# 1) nginx 摘掉 Go 转发（恢复 Python 实现）
sed -i '/location = \/api\/services {/,/^    }$/d; /location \/api\/services\/ {/,/^    }$/d' \
    /opt/labspace/deploy/nginx/labspace.conf
sed -i '/location = \/api\/corpus {/,/^    }$/d; /location = \/api\/search {/,/^    }$/d; \
        /location = \/api\/search\/suggest {/,/^    }$/d; /location = \/api\/search\/categories {/,/^    }$/d' \
    /opt/labspace/deploy/nginx/labspace.conf
/usr/sbin/nginx -t && systemctl reload nginx

# 2) 后端回到替换前的镜像（镜像标签保留在 docker 中）
cd /opt/labspace/deploy && docker compose up -d --force-recreate backend
```

Go 核心可以继续运行而不影响 Python 路径（两者互不依赖，只有 Python 的
`/api/admin/health` 与 `golink.py` 会调用它）。

---

## 7. 后续可继续替换的 Python 模块

> **2026-11-04 更新**：`db_apis.py` / `snapotter.py` / `workbench.py` 三组已在 CNB 版本中完成迁移
> （见 `internal/dbapis`、`internal/snapotter`、`internal/workbench`）。
> PostgreSQL 驱动不再依赖外部包，而是手写了 `internal/pgwire`（标准库实现 PostgreSQL v3 wire 协议），
> 因此「Go 核心零外部依赖」这一前提仍然成立。

| Python 模块 | 现状 | Go 对应 |
| --- | --- | --- |
| `backend/app/db_apis.py`（32 个科研 API 适配器） | 已迁出 | `internal/dbapis` + `/v1/databases*` |
| `backend/app/snapotter.py`（工具目录） | 已迁出 | `internal/snapotter` + `/v1/snapotter/*` |
| `backend/app/workbench.py`（16 个工作台接口） | 已迁出 | `internal/workbench` + `internal/pgwire` |
| `backend/app/db.py` 的收藏/最近访问 | 仍在 Python | 可复用 `internal/pgwire` 实现，尚未开工 |
| `backend/app/agent.py`（助手会话） | 仍在 Python | 依赖 Pi RPC 网关（Node），短期仍在 Python |

> 约束：**Go 核心保持纯标准库、零外部依赖**。引入数据库驱动前需要先决定依赖策略
> （vendored 驱动 vs 走 HTTP 调用 Python），否则会破坏「无外网也能构建」这一前提。
> （`internal/pgwire` 的做法是手写驱动，从而同时满足两个约束。）

---

## 8. 2026-11-04：CNB 拉取后的适配与修复

从 CNB `main`（`b9e4734`）拉取后，仓库版本领先现网，新增了 `internal/pgwire`、`internal/workbench`、
`internal/dbapis`、`internal/snapotter`，并带来 `backend/app/debug_api.py`、`backend/app/preview_inline.py`。
适配过程中实测出并修复了以下真实缺陷（均有回归用例）：

### 8.1 `internal/pgwire`：手写 PostgreSQL 驱动的 4 个缺陷

| 缺陷 | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| DSN 解析 | `pgwire: user is required` | `parseConnString()` 先按 `=` 拆键值，URI 里的 `sslmode=disable` 让 URI 分支永不执行 | 先判 `postgres://` / `postgresql://` 前缀再走 URI 分支，删除重复的 `parseURI` |
| SCRAM 握手 | `malformed SCRAM message` | `saslInitialResponse` 只发 client-first-**bare**，缺 RFC 5802 的 GS2 头 `n,,` | 补上 GS2 头，mock 服务器同步校验 |
| Execute 消息 | `insufficient data left in message` | Execute body 少 1 字节（portal 名 cstring 1 + maxRows int32 4 = 5 字节，原为 4） | 改为 5 字节，mock 侧加长度校验 |
| 错误后连接失步 | 一次报错后同一连接后续查询恒空 | `ErrorResponse` 后未继续读到 `ReadyForQuery` | 记下错误并读到 `Z` 再返回 |

> mock 服务器最初按同样的错误方式解析，因此测不出 Execute 长度问题；修复 mock 后该类错误立刻可复现。

### 8.2 Go 工作台与 Python 的行为对齐

| 问题 | 修复 |
| --- | --- |
| `(? IS NULL OR kind=?)` 的裸 NULL 参数让 PG 无法推断类型（`42P18`） | 改为 `CAST(? AS text) IS NULL` |
| 会话把 `UserID` 填成邮箱，而工作台表存的是 JWT `sub` | `actor.UserID = actor.Sub`，邮箱保留在 `Actor.Email` |
| 可空字段被 `omitempty` 省略（Python 输出 `null`） | 改为 `*string` 且不加 `omitempty` |
| 时间戳格式不一致（PG 文本 vs ISO-8601） | 新增 `isoTimestamp()` 统一成 `2026-11-04T22:07:47.078721+08:00` |
| Python `workbench.summary()` 并发 12 条查询打爆 `ThreadedConnectionPool(1, 8)` → 500 | `db.py` 新增 `query_many()`，`summary()` 改为单连接批量执行 |

### 8.3 语料索引没有接线（CNB 版本的 `Build(nil, nil, nil)`）

仓库版本在 `main.go` 里用 `Build(nil, nil, nil)` 建语料，且 `LABGO_CORPUS_DATA` 未设置，
导致语料索引整体失效——`GET /api/search` 只剩联网结果，本地库命中为 0
（`api-integration.mjs` 的「全局搜索并入本地植物库」因此失败）。
修复：`main.go` 按语料包的设计意图接线（服务来自 Go 目录、命令来自命令索引、SnapOtter 工具来自工具目录），
并补充环境变量：

```
LABGO_CORPUS_DATA=/srv/labdata/labgo/corpus-data.json
LABGO_COMMANDS_FILE=/opt/labspace/frontend/linux-command/src/dist/data.json
SNAPOTTER_BASE_URL=http://127.0.0.1:8092
SNAPOTTER_API_KEY=…
```

启动日志会打印 `corpus: 1012 entries (services+commands+tools+databases)`。

### 8.4 CropGenome Toolkit 接入（**已下架，2026-11**）

这一节保留为历史记录：CropGenome Toolkit（Go 网关 + Rust worker）已于 2026-11 下架，
`/cropgenome/*` 路由与 `internal/httpapi/cropgenome.go` 一并移除。序列层面的分析改由
门户 `/bio-tools` 页面调用后端 `/api/biotools/*`（Biopython + scikit-bio）。
原因、操作步骤与回滚方式见 `docs/RETIRE-CROPGENOME.md`。

当时的接入形状（仅供考古）：服务 `cropgenome-api.service` / `cropgenome-worker.service` 监听
`127.0.0.1:8095`；工具服务只信任 `X-OIDC-*` 头，Go 核心校验门户会话后注入；
浏览器路径 `/cropgenome/*` → nginx → `labgo` → `127.0.0.1:8095`。

### 8.5 Python 侧：上游二次 gzip（`proteinatlas.org`）

上游在 gzip 之上再套一层 gzip（且部分情况下不带 `Content-Encoding` 头），httpx 最多解一层，
剩余内容仍是 gzip，`resp.json()` 报 `utf-8 codec can't decode byte 0x8b`。
修复：`app/http.py` 新增 `strip_residual_gzip()`，在共享出站客户端上按上限（最多 3 层）继续解压，
并把 `Content-Encoding` 修正为 `identity`。修复后 `hpa` 适配器恢复真实返回。
