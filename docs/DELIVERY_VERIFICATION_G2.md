# G2 交付验收报告（本机实测）

验收日期：2026-11-03。验收对象：`LabSpace_GoCore_FullPlatform_G2_2026-11-03.zip`
（sha256 `2d573e23a500ee4cddd2e485fa7c05c37fc9af18156fcb48f4be67668a9cb0e9`，解压后校验一致）。

验收环境：Debian 12（192.0.2.10）、Go **1.24.4**（`apt-get install golang-go`，交付说明写的是 1.23.2）、
Python **3.13.5**、Node **22.23.3**、现网服务全部在线（门户 80、Casdoor 8090、Open WebUI 3000、
Quantum 8080、draw.io 8082、IT-Tools 8084、Linux 命令 8086、JBrowse 8091、SnapOtter 8092、生信 8102）。

> 本报告只记录**实际执行过的命令与真实输出**。未执行的项目一律列在「未验证项」，不计入通过。

## 1. 交付包单元测试（全部通过）

| 检查 | 命令 | 结果 |
|---|---|---|
| Go 编译 | `GOPROXY=off go build ./...` | 通过 |
| Go 静态检查 | `GOPROXY=off go vet ./...` | 通过 |
| Go 测试 | `GOPROXY=off go test ./...` | **32/32 passed**（16 个包全 ok） |
| Go 竞态 | `GOPROXY=off go test -race ./...` | 通过 |
| Python 后端 | `PYTHONPATH=backend python3 -m pytest -q backend/tests` | **61 passed, 1 warning** |
| Node Agent | `node --test agent/tool-policy.test.mjs agent/pi-native/projector.test.mjs` | **9 passed / 0 failed** |
| Gateway | `cd gateway && python3 -m unittest -v` | **2 passed**（Ran 2 tests / OK） |
| Go 消融实验 | `go run ./cmd/ablation` | `authorized_user_results:1, unauthorized_user_results:0, mitigated:true, unguarded_candidates:1` |
| Python 消融实验 | `PYTHONPATH=backend python3 experiments/run_ablation.py` | `policy_satisfies_security_expectations: true`（13 项策略断言全 true） |

Python 用例数由交付说明的 56 增至 61：新增 `backend/tests/test_route_guard.py` 5 例（见 §3.1）。

## 2. 交付包脚本验收

| 脚本 | 结果 |
|---|---|
| `ops/test_g2.sh` | **exit 0**（Go build/vet/test/-race → pytest → node → gateway → 双消融） |
| `ops/run_validation.sh` | **exit 0**（末行 `OpenAPI YAML parse: PASS`） |
| `ops/validate_g1.sh` | **exit 0** |
| `ops/check_existing_source.py /opt/labspace` | exit 0（10 个既有文件全部存在） |

**修复**：三个脚本原先硬编码 `python`，Debian 只有 `python3`，直接执行会 `行 10: python: 未找到命令` 并 exit 127。
现改为自动探测 `python3`/`python`，并优先使用 `backend/.venv/bin/python`；缺 pytest 时给出明确安装提示。

## 3. 验收过程中发现并修复的真实缺陷

### 3.1 FastAPI ≥0.116 路由摊平变更导致路由冲突检测失效（安全缺陷）
- **现象**：`labcore/integration.py::attach_to_existing` 返回空列表；`tests/test_wecom_selective.py` 抛
  `AttributeError: '_IncludedRouter' object has no attribute 'path'`。
- **根因**：FastAPI 0.162.0 / Starlette 1.10.0 起，`include_router()` 不再把子路由摊平进父容器，
  而是存入私有 `_IncludedRouter`（其 `original_router` 指回被 include 的 router，`routes` 为 `None`）。
  旧写法 `[route.path for route in app.routes if isinstance(route, APIRoute)]` 恒为空 →
  **整个被 include 子应用的路径冲突检测形同虚设**（两个 additive router 撞同一路径不会被发现）。
- **修复**（`backend/labcore/integration.py`）：新增 `iter_api_routes(container)`（visited 集合 + 栈遍历，
  遇 `original_router` 递归展开，只产出 `APIRoute`，兼容新旧 FastAPI）与 `route_table(container)`；
  `attach_to_existing` 改用 `route_table(app)` / `route_table(router)`。
  `tests/test_wecom_selective.py` 改用 `route_table`。
- **回归**：`backend/tests/test_route_guard.py` 5 例（included router 路由可发现 / path+method 表 /
  被 include 子应用内的冲突必须抛 `ValueError` / 非 `/api/next/` 前缀必须拒绝 / 干净 additive router 正常挂载）。

### 3.2 `pyproject.toml` 依赖声明缺失
`python-dateutil` 是 `labcore/planner.py` 的核心依赖但未声明；`test` extra 未带文档解析相关依赖，
导致 `pytest` 直接 collection error。已补 `python-dateutil>=2.9`、`fastapi>=0.115,<1`，
并把 python-docx/openpyxl/python-pptx/pillow/pypdf 放进 `test` extra。

### 3.3 Go 服务目录未覆盖现网服务
原 `catalog.go` 只有 12 条，且 `files` 指向 `/files/`（现实是 Quantum 在 `:8080/files/`，门户已不代理 `/files/`）、
`it-tools` 指向 `:8084`（现网门户实际入口是 `/devtools`）。现改为 17 条并与现网逐条对齐
（open-webui / quantum / literature-search / docling / drawing-board 补齐，jbrowse 指向中文配置
`/index.html?config=data/demo/config.zh.json`，drawio 带 `?lang=zh`）。
新增 `TestCatalogCoversEveryLiveService`（11 个现网服务 id）与 `TestCatalogURLsAreUniquePerService`。

### 3.4 ops 脚本的 `python` 硬编码
见 §2。

## 4. 与现网的对账（新增核验工具）

### 4.1 契约路由 vs 现网 OpenAPI —— `ops/verify_existing_services.py`（新增）
数据源：门户 `http://127.0.0.1:8088/api/openapi.json`（**89 个操作**）、
生信 API `http://127.0.0.1:8100/openapi.json`（55 操作）、
终端网关 `http://127.0.0.1:8101/openapi.json`（8 操作，独立 uvicorn app）。

- **`contracts/legacy-feature-route-map.yaml` 升到 version 2**：bioinfo 段改为真实 `/api/v1/*` 前缀，
  portal agent 段改为 `/api/agent/sessions/*/messages|stream|abort`、`/api/agent/quota`、`/api/agent/status`、
  `/api/workbench/capture`、`/api/translate/text`，documents 段 `/api/mt/*` → `/api/translate/*`，
  services_sso 段 `{id}` → `{service_id}`，并新增 `drift_notes` 记录 4 处与 D509 原图的漂移及原因。
- **结果：58/58 映射路由在现网全部存在，missing = 0，脚本 exit 0。**
- 实现要点：终端 WebSocket 用 `http.client` 手工发 Upgrade 头（urllib 会把 `Connection` 改写成 `close`，
  导致 WS 路由退化成普通 GET 而误报 404）；终端 WS 实测返回 403，恰好证明路由存在。

### 4.2 Go 服务目录 vs 现网服务列表 —— `ops/verify_service_catalog.py`（新增）
- 现网 `GET /api/services` → **11 个服务**；Go 目录 → **17 条**。
- **`live_not_in_go_catalog` = 空（11/11 全覆盖）**；**URL 差异 = 0**；脚本 exit 0。
- 唯一不可达条目是 `files` → `/api/next/files/`（catalog status = `planned`，Go 侧文件空间尚未上线），
  按交付说明的「planned/prototype/migration 不算故障」规则排除。
- 探活相对路径走 nginx 入口 `http://127.0.0.1`，绝对路径把 `127.0.0.1` 换成探测主机。

## 5. 现网回归（证明「覆盖现有服务」没有破坏线上）

`/opt/labspace/e2e/run-regression.sh`（25 个脚本，覆盖门户/生信/Agent/SSO/OIDC/嵌入/生信库/图表/设计规范）。

**过程中发现并修复的环境回归**：Playwright 无法启动，报
`chrome-headless-shell: error while loading shared libraries: libatk-1.0.so.0: cannot open shared object file`。
`ldd` 显示 13 个共享库缺失（libatk / libatk-bridge / libatspi / libasound / libgbm / libX11 / libxcb /
libXcomposite / libXdamage / libXext / libXfixes / libxkbcommon / libXrandr）——早前的 apt 清理把这些 X 依赖一并删了。
已重装对应 Debian 包，`ldd` 复查 `not found` 计数为 0，浏览器恢复正常。

> 提醒：`apt autoremove` 在本机会连同 Playwright 所需系统库一起清理；清理后必须 `ldd` 复查浏览器依赖，
> 否则所有 E2E 会集体失败并被误判成业务回归。

## 6. 未验证项（不计入通过）

- 未做 Go 与现网 FastAPI 的同负载 A/B 性能对比（p50/p95/p99、RPS、CPU、RSS）。
- 未做 PostgreSQL RLS、RustFS 对象存储、Casdoor→Go 完整接管、Pi RPC 真实重载、
  Haystack/pgvector 真实检索、OXR/Docling/Hy-MT2 版面重建、图片生成真实 provider 的联调。
- Go 侧 BLAST、下载中心、ACL 仍是原型/契约，未替换现网 Quantum 与下载链路。
- 未构建 React 宿主页面的完整生产包（`g2/frontend` 为组件原型）。
- Windows 模型 API `100.64.0.10:7997` 仍不可达（`lab-health` 唯一警告），
  外部图纸平台 `192.0.2.29:5244` 端口仍关闭（归类 `external-down`）。

## 7. 结论

- 交付包**单元测试与脚本全部通过**（Go 32、Python 61、Node 9、Gateway 2、消融 13 项断言）。
- 验收过程中发现并修复 **4 类真实缺陷**，其中 FastAPI 路由摊平导致的**冲突检测失效属安全缺陷**。
- 与现网对账：**契约路由 58/58 存在**、**Go 服务目录 11/11 覆盖**、**URL 零差异**。
- 现网回归在修复 Playwright 系统依赖后恢复正常。
- **但这仍不是生产发布**：Go 核心没有接管任何现网进程，数据库层、对象存储、真实 provider 全部未接通。
  生产切换必须按 `g2/docs/ACCEPTANCE_MATRIX_G2.md` 的 Gate 0–5 逐项验收。
