> 当前状态提示：Casdoor 与 8090 已下线，认证改由门户自身提供；本文保留历史拓扑说明，当前入口以 README.md 为准。

# ARCHITECTURE.md

## 1. 拓扑

```
                     浏览器（内网）
                          │  HTTP 80
                          ▼
        ┌────────── Debian 192.0.2.10 ──────────┐
        │  Nginx（宿主机 apt 安装，host-based 路由） │
        │   192.0.2.10:80      → LabSpace 门户 + /api 反代 │
        │   192.0.2.10:8090     → Casdoor（IP 专属端口）│
        │   192.0.2.10:8082    → draw.io            │
        │   192.0.2.10:8086    → Linux Command（静态）│
        │   192.0.2.10:8084    → IT-Tools           │
        │   192.0.2.10:8092   → SnapOtter（文件工坊）│
        │   192.0.2.10:8091    → JBrowse 2（静态）   │
        │   （未匹配主机名 / IP 直连 → 门户 default_server）│
        │                                          │
        │  ┌──────────── Docker 网络 ───────────┐ │
        │  │ labspace-net                       │ │
        │  │  lab-labspace-backend (8080)       │ │
        │  │  lab-casdoor (8000)                │ │
        │  │  lab-drawio (8080)                 │ │
        │  │  lab-it-tools (80)                 │ │
        │  │  lab-postgres（既有，PG17）        │ │
        │  │ lab-tools（既有）                  │ │
        │  │  lab-searxng / lab-tika /          │ │
        │  │  lab-docling / lab-research-api /  │ │
        │  │  lab-research-mcp / lab-terminal   │ │
        │  └────────────────────────────────────┘ │
        │  JBrowse(:8091) / 静态与工具站点           │
        │                                          │
        │  ┌──── 宿主机 systemd 服务 ──────────┐   │
        │  │ labgo (Go 核心, :8122)            │   │  ← 服务目录/健康/内嵌探测
        │  │   127.0.0.1:8122  ← nginx        │   │
        │  │   172.28.0.1:8122  ← 后端容器      │   │
        │  │ lab-oidc-sync (:8111, issuer 同步) │   │
        │  │ bioinfo-api (:8100) / bioinfo-    │   │
        │  │   terminal (:8101)                │   │
        │  └────────────────────────────────────┘   │
        └──────────────────────────────────────────┘
```

> **Open WebUI（:3000）与 Quantum（:8080）已下线（2026-11-04 清理）**：容器、镜像与 `lab-quantum_default`
> 网络均已清理，服务目录（Go 核心 `catalog.go`，唯一权威源）也不再收录这两个条目。
> 文件能力由门户原生网盘 `/files` 与文件工坊 SnapOtter（:8092）承担，
> 聊天/知识库问答能力由门户 Agent 助手 `/agent` 承担。

> **Go 核心（LabGo）**：服务注册表、健康探测、内嵌探测、实验文件只读索引的权威实现，
> 纯 Go 标准库、零外部依赖。浏览器请求的 `/api/services*` 直接由 nginx 转给它，
> 不再经过 Python 网关。详见 `docs/GO_CORE_REPLACEMENT.md`。

## 2. 端口

### 访问方式（IP 优先，域名可选）

| 目标 | 地址 | 说明 |
| --- | --- | --- |
| 门户 | `http://192.0.2.10/` | **推荐**，无需任何 DNS 配置 |
| Casdoor | `http://192.0.2.10:8090/` | 统一身份源（IP 专属端口） |
| draw.io | `http://192.0.2.10:8082/` | 绘图编辑器（原 `/draw/` 会 302 到此） |
| IT-Tools | `http://192.0.2.10:8084/` | 原版 IT-Tools（原 `/tools/` 会 302 到此） |
| Linux Command | `http://192.0.2.10:8086/` | 静态站点（原 `/commands/` 会 302 到此） |
| JBrowse 2 | `http://192.0.2.10:8091/index.html?config=data/demo/config.zh.json` | 基因组浏览器（原 `/jbrowse/` 会 302 到此） |
| SnapOtter | `http://192.0.2.10:8092/` | 文件工坊官方界面（门户页 `/snapotter`） |
| 图纸平台 | `http://192.0.2.29:5244/` | 外部内网服务（当前端口关闭，标记 `external-down`） |
| PDF 论文翻译 | `http://192.0.2.10/translate` | 门户内页面（AntD 重写），后端为 PDFMathTranslate 工作进程 |
| 文件管理（门户原生网盘） | `http://192.0.2.10/files` | 门户内页面（Go 核心 `labfiles` 按用户 ACL 授权） |
| Agent 助手 | `http://192.0.2.10/agent` | 门户内页面（pi RPC 网关），AI 对话与知识库问答 |
| Tailscale | `http://198.51.100.71/` | 同一套服务，跨网访问（nftables 放行 100.64.0.0/10） |

> **全部服务一律使用 `192.0.2.10 + 端口` 访问，不使用任何域名**：客户端无需 DNS 解析、
> 无需 hosts、无需改路由器设置。
> 域名不是访问的前提条件。

| 端口 | 绑定 | 用途 |
| --- | --- | --- |
| 80 | 0.0.0.0 | Nginx 统一入口（内网） |
| 8090 | 0.0.0.0 | Casdoor（IP 专属端口） |
| 8088 | 127.0.0.1 | LabSpace 后端（仅 Nginx 访问） |
| 8000 | 127.0.0.1 | Casdoor 容器（仅 Nginx 访问） |
| 8082 | 0.0.0.0 | draw.io |
| 8084 | 0.0.0.0 | IT-Tools |
| 8086 | 0.0.0.0 | Linux Command（静态） |
| 8091 | 0.0.0.0 | JBrowse 2（静态） |
| 8092 | 0.0.0.0 | SnapOtter 文件工坊 |
| 8081 | 127.0.0.1 | SearXNG（容器间访问） |

**没有任何业务端口暴露到公网**：所有对外端口由 nftables 限制为仅内网 `192.0.2.0/24` 与
Tailscale `100.64.0.0/10` 可达，公网入口由路由器 NAT 与本机策略共同阻断。

### 防火墙（nftables）

`/etc/nftables.conf` 的 `table inet filter` 中 `chain input` 策略为 **drop**，对外服务端口统一走
集合 `svc_ports`（`type inet_service`）：

```
set svc_ports { type inet_service
                 elements = { 80, 8090, 3000, 8080, 8082, 8084, 8086, 8091, 8092 } }
```

放行规则：`tcp dport @svc_ports ip saddr @lan_net accept` 与 `tcp dport @svc_ports ip saddr @ts_net accept`。
（3000 / 8080 是已下线服务遗留的白名单条目，当前无进程监听，可择机从集合中删除。）
新增对外服务时**必须**把端口加进 `svc_ports`，否则外部客户端连接会被 DROP（本机回环自测仍会通过，是常见盲区）。

> 严禁使用 `flush ruleset`：那会清掉 Docker 注入的 iptables 链。修改后用
> `/usr/sbin/nft -c -f /etc/nftables.conf` 校验，再 `/usr/sbin/nft -f /etc/nftables.conf` 加载。

### 入口自适应（IP 自适应）

同一套服务有两个入口主机：内网 `192.0.2.10` 与 Tailscale `198.51.100.71`。
**用户从哪个入口进入，门户里所有其它服务的地址就自动换成同一个主机**：

| 层次 | 实现 | 说明 |
| --- | --- | --- |
| 门户后端 | `backend/app/catalog.py::adapt_host()` + `main.py::_client_host()` | 按请求 `Host`/`X-Forwarded-Host` 改写服务地址（url / embedUrl / ssoUrl / 描述），影响 `/api/services`、`/api/services/health`、`/api/network/entries`、`/api/search`、`/api/corpus` |
| 门户前端 | `frontend/src/utils/host.ts`（`currentHost()` / `hostUrl()`） | 页面内所有绝对地址按当前 `window.location.hostname` 生成，无硬编码 IP（仅 `DEFAULT_HOST` 兜底） |
| 门户自身 OIDC | `backend/app/casdoor.py` | issuer 按请求 Host 推导；`state` 内固化 `redirect_uri` 与 `issuer` |
| 门户内原生页面（文件管理 `/files`、Agent 助手 `/agent` 等） | 门户自身路由 + `backend/app/catalog.py::adapt_host()` | 全部按当前入口主机生成地址，无需任何外部服务配合 |

自适应的原因：远程用户经 Tailscale 进入时，内网 IP `192.0.2.10` 对其不可达
（`tailscale status` 提示未接受子网路由），因此服务地址必须跟随入口主机。

切换细节：

- 已下线的 Open WebUI / Quantum 曾用静态 issuer + 重建容器的方式切换（`ops/oidc-sync.py`、
  `OPENID_*` 环境变量、`FILEBROWSER_OIDC_ISSUER_URL`），随 2026-11-04 清理一并失效，现行架构不再依赖；
- 其余服务的 issuer 均为**动态**：门户与生信实训平台按请求 Host 推导，无需重启任何容器；

## 3. 身份流

```
浏览器 ──▶ /api/auth/login (LabSpace 后端)
          └─ 302 → Casdoor /login/oauth/authorize?client_id=labspace&state&nonce
浏览器 ──▶ Casdoor 登录页（本地口令 / 后续可切 OIDC）
          └─ 302 → /api/auth/callback?code&state
后端 ──▶ POST Casdoor /api/login/oauth/access_token  → id_token
       └─ 用 Discovery 的 JWKS 校验签名/iss/aud/exp/nonce
       └─ 归一化用户（id/email/name/roles=groups）
       └─ 签发自有会话 JWT（HS256，HttpOnly Cookie labspace_session，8h）
       └─ 同时下发 labspace_csrf（非 HttpOnly，供双提交 CSRF）
```

- 前端从不接触 Client Secret / 会话密钥。
- 所有写操作要求 `X-CSRF-Token` 与 Cookie 一致，并校验 `Origin`。
- 角色来自 Casdoor 的 `groups`：`lab-admin` / `lab-teacher` / `lab-student` / `project-*`。

## 4. 数据流与存储

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| LabSpace 业务数据 | 独立库 `labspace`（PG17 内新建，与 `casdoor` 库完全隔离） | `labspace.favorites` / `labspace.recent` / `labspace.drawings` |
| Casdoor | 独立库 `casdoor`（同一 PG 实例，独立 database + 独立角色） | 组织、应用、组、用户 |
| 用户绘图文件 | `/srv/lab/users/<user>/drawio/*.drawio` | 门户原生网盘按用户 ACL 管理，Go 核心 `labfiles` 负责授权 |
| 既有服务数据 | 未改动 | oikb / 科研 API / SearXNG / Docling 等原样保留 |

## 5. 服务目录与健康检查

服务目录是后端内置注册表（`backend/app/catalog.py`）：id、名称、简介、分类、入口 URL、图标、
打开方式（link/embed）、健康探测地址、允许角色、标签、使用指南。
健康检查在容器内按容器名/网关地址探测，TTL 30s，避免频繁轮询；探测失败只影响该卡片的“不可用”标记，
门户其余功能不受影响（已验证：9 个服务全部探测成功）。

## 6. 前端

- React 19 + TypeScript + Vite 8 + Ant Design 6.6 + @ant-design/icons 6 + React Router 7 + TanStack Query 5。
- 构建产物为静态文件，由 Nginx 直接托管（`/opt/labspace/frontend/dist`），后端只提供 API。
- 主题：ConfigProvider + defaultAlgorithm/darkAlgorithm，支持 light/dark/auto（跟随系统）。
- 页面：首页、全部服务、服务详情、我的收藏、统一搜索、科研文献、数据库速查、绘图、文档解析、
  PDF 论文翻译、文本论文翻译、天气、个人工作台、Agent 助手、文件工坊、浏览器主页、网络诊断、
  内嵌页 `/embed/:id`、管理端（仅管理员，含「Agent 模型与配额」）。

## 7. Agent 网关（pi）

```
浏览器 ──SSE──▶ Nginx :80 ──▶ LabSpace 后端 /api/agent/sessions/{id}/stream
                                  │  (X-User-ID = 会话解出的 sub，客户端不可伪造)
                                  ▼
                   AgentScope 2.0.11 Agent Service（容器 lab-agentscope :8100）
                                  │  create_app(storage/message_bus/workspace_manager/mcp_hubs)
                                  ▼
                   Postgres 库 agentscope（13 张表）+ 内置 MCP 工具进程
                                  │  mcp__lab__lab_services 等工具回调门户 API
                                  ▼
                   openai 兼容端点（平台模型凭据 /etc/labspace/agent-model.env）
```

- 每个会话一个 pi 子进程；会话目录 `/srv/labdata/labspace/agent/sessions`，cwd 指向空目录
  `/srv/labdata/labspace/agent/work`；15 分钟空闲回收。
- 插件工具只能通过门户 API 访问数据，**不能读写宿主机文件系统**。

## 8. 外部依赖

| 依赖 | 状态 | 影响 |
| --- | --- | --- |
| Windows Server 模型 API `100.64.0.10:7997` | 不可达 | 门户无向量/重排能力，RAG 相关验收无法完成 |
| 内网 DNS | 由 Debian 的 dnsmasq 提供 | 客户端需把 DNS 指向 192.0.2.10（或在 hosts 写映射）；未配置时可用 `http://192.0.2.10/` 兜底 |
| HTTPS 证书 | 未部署 | 当前仅 HTTP，认证凭据在内网链路上是明文传输（见 SECURITY.md 风险条目） |
| Windows 宿主机 `100.64.0.10` | 整机不可达 | Hy-MT2 文本翻译模型无法部署（门户自动回退到本机引擎） |
| OXR 官方免费实例 `free-oxr.somark.ai` | 可用但为共享实例 | 偶发超时/限流；门户自动回退到内网 Docling |
| 出站 IPv6 | 部分站点为黑洞 | 后端统一强制 IPv4 出站（`backend/app/http.py`），避免外部接口随机 ConnectTimeout |
