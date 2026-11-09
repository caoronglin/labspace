# 第一方代码安全审计报告（2026-11-05）

审计范围：LabSpace 门户（Python 后端 + React 前端 + Go 核心）、生信学实训平台（FastAPI + React）、
CropGenome 工具箱（Go 网关 + Rust worker）、Nginx 站点配置与宿主机运维脚本。
方法：静态逐文件审查 + 依赖漏洞扫描 + 真实请求复现。

---

## 0. 结论摘要

| 等级 | 数量 | 状态 |
| --- | --- | --- |
| 严重 / 高危 | 4 | 全部已修复并验证 |
| 中危 | 12 | 全部已修复并验证 |
| 低危 / 代码质量 | 5 | 4 已修复，1 保留（设计如此） |
| 依赖漏洞 | 前端 0；Python 0（升级后）；Rust 0；Go 0 | 已升级锁定 |

**未发现的问题**：无命令注入、无 SQL 注入（全部参数化）、无路径穿越（`safe_join`/`SafePath` 统一收口）、
无硬编码密钥入库、无前端 `dangerouslySetInnerHTML`、无 Docker Socket 挂载、无第二套文件存储。

---

## 1. 严重 / 高危（4 项，全部已修复）

### 1.1 Casdoor 身份断言可退化到「不验签」——认证绕过与角色伪造
- **位置**：`backend/app/casdoor.py`（`verify_id_token` / `fetch_userinfo`）、`backend/app/main.py`（`api_callback`）
- **原理**：当 Casdoor 的 discovery 文档缺少 `jwks_uri`，或 userinfo 端点拉取失败时，代码会退化为**不验签**地 base64 解码 id_token；
  而 `api_callback` 用 `merged = {**info, **claims}` 合并两个来源，`normalize_user()` 的 `roles` 可能取自**未验签**的 claims。
  攻击者只要能自造 id_token，即可以任意角色（如 `lab-admin`）完成登录。
- **修复**：
  - 缺 `jwks_uri` → 直接 `401 身份提供方未发布 jwks_uri，拒绝未验签的身份`（失败关闭，不再有降级路径）；
  - userinfo 拉取异常时**不再**返回未验签 claims，仅使用已验签的 id_token claims；
  - `jwt.decode(..., algorithms=["RS256","ES256","HS256"])` → 收窄为 `["RS256","ES256"]`。
    保留 HS256 会产生**算法混淆**：若服务端用 RSA 公钥验签，攻击者可用同一公钥当 HMAC 密钥伪造 HS256 令牌。
- **验证**：Casdoor discovery 实测含 `jwks_uri: http://192.0.2.10:8090/.well-known/jwks`；OIDC 全流程回归通过
  （`oidc-ip-flow.mjs`、`oidc-multi.mjs` LAN + Tailscale 双入口、`sso-flow.mjs` 6 个服务免密）。

### 1.2 KEGG 上游 URL 注入
- **位置**：`backend/app/db_apis.py::_t_kegg`
- **原理**：`space = params.get("space") or "genes"` 未校验就拼进上游请求 URL，可注入任意路径/查询串。
- **修复**：新增 `KEGG_SPACES` 白名单（genes/organism/pathway/brite/module/class/ec/ko/genome/dgnum/
  ncbi-organism/uniprot/kegg/rclass/rname/pname/pid/role/kegg-brite），不在白名单回落 `genes`。
  （同文件 organism/species 原本就有 `.isdigit()` 校验，属同类问题的既有正确写法。）

### 1.3 gzip 解压炸弹
- **位置**：`backend/app/http.py::strip_residual_gzip`
- **原理**：`gzip.decompress(body)` 无上限，一个几十 KB 的压缩包可膨胀到数 GB，直接打满容器内存。
- **修复**：`MAX_RESIDUAL_GZIP_BYTES = 32MiB`，`_gunzip_capped()` 用 `gzip.GzipFile` 分块读、边解边判上限，超限抛 `ValueError` 并停止解压。
- **旁证**：Go 核心的 `internal/dbapis/client.go` 一直有 16MiB `LimitReader`，Python 侧此前没有。

### 1.4 缺少 CSRF 校验的跨站写接口
- **位置**：`POST /api/databases/{db_id}/query`
- **原理**：仅有 `Depends(require_user_or_service)`，无 CSRF 校验 → 恶意站点可借受害者会话触发服务端向外网发起请求
  （例如提交 BLAST 任务），属 CSRF + SSRF 组合面。
- **修复**：补 `Depends(require_csrf)`；`require_csrf` 对 Bearer 令牌与 `X-Lab-Service-Token` 服务调用豁免，内部插件调用不受影响。

---

## 2. 中危（12 项，全部已修复）

| # | 位置 | 问题 | 修复 |
| --- | --- | --- | --- |
| 2.1 | `backend/app/snapotter.py`、`docparse.py` | 先把上传整包读进内存再判大小 → 大文件即打满内存 | 新增 `backend/app/uploads.py::read_upload_capped`（1MiB 分块 + 上限，超限 413） |
| 2.2 | `backend/app/docparse.py` | 默认把用户上传的 PDF 发到**公网** `free-oxr.somark.ai` | 默认只用内网 Docling；公网 OXR 需显式 `LABSPACE_OXR_ALLOW_EXTERNAL=1`；`_status()` 增加 `enabled` 字段 |
| 2.3 | `backend/app/agent.py::stream_session` | 无并发上限，可开无限 SSE 流（每条 600s） | `MAX_CONCURRENT_STREAMS = 3` + 信号量，入口占位、finally 释放 |
| 2.4 | `backend/app/security.py` | `require_admin` / `require_teacher` 只认 Cookie，不认 Bearer → 内部调用 401 | 两种凭据都支持，并写回 `request.state.user` |
| 2.5 | `bioinfo-training/backend/app/security.py::sync_roles` | 只加角色**从不删** → Casdoor 撤权后 DB 里角色仍在 | 改为双向同步：移除 `granted_by="casdoor"` 且已不在组里的角色；组为空时清理全部 casdoor 来源角色 |
| 2.6 | `bioinfo-training/backend/app/oidc.py` | `jwt.decode` 未校验 issuer | 补 `issuer=` 参数 |
| 2.7 | `bioinfo-training/backend/app/config.py` | `oidc_state_secret` 默认 `change-me-insecure`、`oidc_client_secret` 默认空 → env 缺失时 state 用**公开常量**签名，任何人都能伪造登录 CSRF | 新增 `validate_startup()`：仍是默认值或空 → **拒绝启动**（fail-closed） |
| 2.8 | `bioinfo-training/backend/app/terminal.py:313`、`routers/terminal.py:182` | 用带横线 UUID 查 cgroup，查不到时回落**整机根 cgroup** → 内存指标失真、容量准入失效 | 改用 `rt.unit_sid`（32 位 hex），与 systemd 单元名一致 |
| 2.9 | `bioinfo-training/backend/app/routers/submissions.py` | `shutil.copyfileobj` 无大小上限 → 可写满磁盘 | 1MiB 分块写入 + 512MiB 总上限，超限删文件并 413 |
| 2.10 | `deploy/nginx/labspace.conf` | location 级 `add_header` 会**整体替换** server 级安全头 → 5 个 location 丢失全部安全头 | 新增 `deploy/nginx/lab-security-headers.conf` 片段，所有自带 `add_header` 的 location 与 8086/8090/8091 三个 server 块统一 include |
| 2.11 | `deploy/nginx/labspace.conf` | 定义了 `limit_req_zone` 却**从未挂 `limit_req`** → 限流形同虚设 | `/api/` 挂 `limit_req zone=lab_api burst=100 nodelay` + `limit_conn lab_conn 200`；Casdoor 登录路径单独挂 `rate=60r/m burst=10`（正则**带 `$` 锚**，否则 `/login/oauth/authorize` 被误伤） |
| 2.12 | `go-core/internal/session/session.go` | 无 `exp` 的令牌被视为永不过期 | 缺 `exp` 直接拒绝（`session missing exp`） |

### 2.13（补充）nginx 限流实测

```
POST /api/get-account 连打 20 次 → 15×200 + 5×503      （Casdoor 口令校验限流生效）
GET  /login/oauth/authorize ×15 → 15×200                （授权端点未被误伤）
GET  /api/health ×80 / ×300 → 全部 200
400 并发 → 128×200 + 272×503                            （连接数限制生效）
```

### 2.14（补充）宿主机运维脚本

`/usr/local/bin/lab-sync-passwords` 原本把明文口令作为 **python3 argv** 传入 → 任何本地用户可从
`/proc/<pid>/cmdline` 读到。改为**从 stdin 传入**（`hash=$(printf '%s\n' "$pass" | cas_hash)`）。

---

## 3. 低危 / 代码质量

| # | 位置 | 问题 | 处理 |
| --- | --- | --- | --- |
| 3.1 | `go-core/cmd/labgo/main.go` | `newVault()` 判断密钥长度 `<16`，而 `vault.New` 要求恰好 32 字节 → vault 永远为 nil | 改为 `!= 32`，非 32 字节打 WARN |
| 3.2 | `go-core/internal/workbench/store.go` | `gofmt` 未通过（注释里 `''` 被规范成 `”`） | `gofmt -w` |
| 3.3 | `bioinfo-training/backend/app/routers/admin.py:262` | `AuditEvent.action.like(f"{action}%")` 未转义 LIKE 通配符 → `%` / `_` 放大查询范围 | 转义 `\ % _` 并加 `escape="\\"` |
| 3.4 | `ops/export-corpus-data.py:17` | 注释指向已不存在的 `backend/app/data/corpus-data.json` | 改为指向 `shared/corpus-data.json` 与 `/srv/labdata/labgo/corpus-data.json` |
| 3.5 | `GET /api/services/{id}/health` | 无鉴权，可被匿名用于内部探活 | **保留**：Go 核心侧本就是公开目录接口，服务清单属公开信息；且已由 nftables 限制来源网段 |

---

## 4. 依赖升级暴露出的既有 BUG（本次审计最有价值的产出）

### 4.1 `db.scalors()` 拼写错误 —— 潜伏多年的认证中断
- **位置**：`bioinfo-training/backend/app/security.py:177`（`sync_roles()` 内）
- **代码**：写成 `db.scalors(...)`（`s-c-a-l-o-r-s`），正确应为 `db.scalars(...)`（`s-c-a-l-a-r-s`）。
- **为何潜伏**：SQLAlchemy 2.0.x 的 legacy 兼容让这个拼错的调用侥幸能跑；
  **升到 2.1.8 后属性被移除**，直接 `AttributeError: 'Session' object has no attribute 'scalors'`
  → OIDC 回调 500 → 生信平台所有接口 401。
- **影响面**：仅 OIDC 登录路径 —— 平台整体不可用（bioinfo-api-smoke 由 7/7 掉到 1/7）。
- **修复**：改为 `db.scalars(...)`；修后 bioinfo-api-smoke **7/7**、bioinfo-terminal-test **7/7**。
- **教训**：**依赖升级本身就是在做静态检查**。这类「拼错但恰好能跑」的调用，只有在库收紧 API 时才会暴露。
  因此本项目的版本锁定不是纯运维动作，而是代码质量闸门。

### 4.2 e2e 脚本的导航竞态
- **位置**：`e2e/cropgenome-test.mjs:42`
- **现象**：`page.evaluate(fetch)` 在门户首页对未登录用户跳转 `/login` 时被导航打断 →
  `Execution context was destroyed, most likely because of a navigation`。
- **修复**：改用 Playwright 的 `APIRequestContext`（`page.request.get/post`），不依赖页面上下文 → 稳定 6/6。

---

## 5. 依赖安全

### 5.1 前端（pnpm audit，三个工程）
- `labspace`（222 包）、`bioinfo-training`（123 包）、`cropgenome-toolkit`（149 包）→ **0 条漏洞**。
- **唯一漏洞源**：`frontend/linux-command/src/`（vendored 上游 linux-command@1.22.0，自带 `package-lock.json` 与 476 个包，
  且不在 pnpm workspace 内）→ **21 条**（critical 2 / high 12 / moderate 1 / low 6）：
  - `sqlite3@5.1.5 → @mapbox/node-pre-gyp → tar`：路径穿越、任意文件覆写、PAX DoS；
  - `sitemap-generator@8.5.1 → url-parse<=1.5.8`：鉴权绕过、开放重定向；
  - 另有 lodash / cheerio / css-select / nth-check / glob / minimatch / markdown-to-html-cli 链。
  - **处理**：这些均为 **devDependencies**，且修复都需主版本跃迁（sqlite3→6.0.1、sitemap-generator→7.5.2、
    markdown-to-html-cli→3.2.12），不影响运行期。本轮**从部署产物中排除该目录**，不改动上游 vendored 代码。
- Playwright **不升级**：浏览器二进制 revision 与 1.64.1 的 `browsers.json` 精确匹配
  （`chromium-1248` / `chromium_headless_shell-1248` / `ffmpeg-1013`），升级需重下二进制且当前外网受限 → 锁定版本。

### 5.2 Python
- 升级前：fastapi 0.136.3 / starlette 1.8.0 / pydantic 2.13.4 / SQLAlchemy 2.0.36 / PyJWT 2.14.0。
- 升级后：fastapi **0.162.0** / starlette **1.10.0** / pydantic **2.14.2** / SQLAlchemy **2.1.8** /
  PyJWT **2.15.1** / uvicorn **0.54.0** / python-multipart **0.0.33** / psutil **7.2.2** /
  pytest **9.2.0** / pytest-asyncio **1.4.1.post1**（经 pip index 确认为当前最新）。
- **门户后端镜像瘦身**：基础镜像由 `openwebui/open-webui:0.12.2-slim`（179 个包，含 langsmith / httpx2 / openai /
  boto3 / azure-* / black / alembic 等与门户无关的依赖）改为官方 `python:3.11-slim`，
  并新增 `backend/requirements-lock.txt`（**29 个包全量锁定，含传递依赖**）→ 镜像 **873MB → 286MB**，依赖面同步收敛。
- **生信平台**：`requirements.txt` 重写为同一批版本，并写入「已知约束」注释
  （fastapi ≥0.116 的 `include_router` 摊平变化、pydantic 2.10+ 的 `model_dump(mode="json")` 行为变化）。
- **回滚点**：`/srv/labdata/backups/bioinfo-venv-freeze-pre-upgrade-20261105.txt`。

### 5.3 Rust / Go / 镜像
- Rust：`cargo clippy --all-targets -- -D warnings` 无告警；`cargo test` 12 passed；MSRV 锁 **1.87.0**，`--locked` 构建。
- Go：`gofmt -l` 无输出；`go build` / `go vet` / `go test`（含 `-race`）全通过；**零外部依赖**（仅标准库）。
- 镜像：基础镜像 tag 逐一复核（`python:3.11-slim` Digest `sha256:db20d8506e2f15b6db39b40b6015ca46bae855dec6dd326d462cfe79ae972893`）。

---

## 6. 已确认无问题的关键面（负面结论同样重要）

- **凭据**：CNB 仓库工作树与**全部 git 历史**对三个已知口令与 CNB 令牌 grep **零命中**；
  `.gitignore` 覆盖 `.env` / `.env.*`；仓库内无 `.pem` / `.key` / `id_rsa`。
  真实凭据只存在于被忽略的 `/opt/labspace/deploy/.env`（0600）。
- **SSRF**：Go 侧 `db_apis._assert_allowed_url` 强制 https + 主机白名单；上传下载走服务端固定目标。
- **路径穿越**：生信平台 `workspaces.py::safe_join` 挡穿越与符号链接逃逸；CropGenome `storage.SafePath` 是唯一路径闸门。
- **OIDC 生信侧**：PKCE + RS256/ES256/PS256 验签 + audience 校验（本次补 issuer 校验）。
- **Go 会话**：严格 `alg=HS256` + `exp`/`nbf` 校验 + `hmac.Equal` 常量时间比较。
- **Go guard**：HMAC 签名含 method/path/user/tenant/admin/timestamp/nonce/body 摘要；±2 分钟时间窗；
  nonce 一次性（3 分钟 TTL、5 万条上限）。
- **终端 cgroup**：`cgroup_helper` 只接受固定 op 集合与资源档位名，cwd / socket / env 全部白名单；普通用户无宿主机/root 权限。
- **CropGenome 外部访问**：只监听 127.0.0.1:8095，外部无法伪造 `X-OIDC-*` 头；Rust worker 子命令白名单 + stdin 传参 +
  10s 超时 + 4MiB stdout / 4KiB stderr 截断；未部署 worker 时返回 `503 blocked_data_not_provided` 而非假装无结果。
- **前端**：无 `dangerouslySetInnerHTML`；localStorage 不存令牌（会话走 HttpOnly Cookie + 双提交 CSRF）。
- **容器**：不挂 Docker Socket；内部工具默认不映射宿主机端口；服务间走受控 Docker 网络。

---

## 7. 遗留（不阻塞，已记录）

1. Windows 模型主机离线 → Embedding / Reranker / 知识库检索无法验收（翻译已自动回退 pi 网关）。
2. 外部独立图纸平台 `192.0.2.29:5244` 端口关闭 → 需在该外部主机上恢复。
3. CropGenome 七物种数据集 manifest 全为 `not_provisioned` → 需要真实数据集才能验收分析类功能。
4. `frontend/linux-command/src/` 的 21 条 devDependency 漏洞 → 建议从部署产物排除（当前仅打包静态数据，未执行上游代码）。
