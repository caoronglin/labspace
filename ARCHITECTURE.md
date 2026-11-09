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
        │   192.0.2.10:3000    → Open WebUI         │
        │   192.0.2.10:8080    → FileBrowser Quantum│
        │   192.0.2.10:8082    → draw.io            │
        │   192.0.2.10:8086    → Linux Command（静态）│
        │   192.0.2.10:8084    → IT-Tools           │
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
        │  │  lab-open-webui / lab-quantum /    │ │
        │  │  lab-searxng / lab-tika /          │ │
        │  │  lab-docling / lab-research-api /  │ │
        │  │  lab-research-mcp / lab-terminal   │ │
        │  └────────────────────────────────────┘ │
        │  JBrowse(:8091) / 静态与工具站点           │
        └──────────────────────────────────────────┘
```

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
| Open WebUI | `http://192.0.2.10:3000/` | 应用自身根路径，不做子路径改写 |
| Quantum | `http://192.0.2.10:8080/files/` | 基础路径 /files/ |
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
| 3000 | 0.0.0.0 | Open WebUI |
| 8080 | 0.0.0.0 | Quantum |
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
新增对外服务时**必须**把端口加进 `svc_ports`，否则外部客户端连接会被 DROP（本机回环自测仍会通过，是常见盲区）。

> 严禁使用 `flush ruleset`：那会清掉 Docker 注入的 iptables 链。修改后用
> `/usr/sbin/nft -c -f /etc/nftables.conf` 校验，再 `/usr/sbin/nft -f /etc/nftables.conf` 加载。

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
| LabSpace 业务数据 | 独立库 `labspace`（PG17 内新建，与 Open WebUI 的库完全隔离） | `labspace.favorites` / `labspace.recent` / `labspace.drawings` |
| Casdoor | 独立库 `casdoor`（同一 PG 实例，独立 database + 独立角色） | 组织、应用、组、用户 |
| 用户绘图文件 | `/srv/lab/users/<user>/drawio/*.drawio` | 与 Quantum 个人目录一致，Quantum 可直接管理 |
| 既有服务数据 | 未改动 | Open WebUI / Quantum / oikb / 科研 API 等原样保留 |

## 5. 服务目录与健康检查

服务目录是后端内置注册表（`backend/app/catalog.py`）：id、名称、简介、分类、入口 URL、图标、
打开方式（link/embed）、健康探测地址、允许角色、标签、使用指南。
健康检查在容器内按容器名/网关地址探测，TTL 30s，避免频繁轮询；探测失败只影响该卡片的“不可用”标记，
门户其余功能不受影响（已验证：9 个服务全部探测成功）。

## 6. 前端

- React 19 + TypeScript + Vite 8 + Ant Design 6.6 + @ant-design/icons 6 + React Router 7 + TanStack Query 5。
- 构建产物为静态文件，由 Nginx 直接托管（`/opt/labspace/frontend/dist`），后端只提供 API。
- 主题：ConfigProvider + defaultAlgorithm/darkAlgorithm，支持 light/dark/auto（跟随系统）。
- 页面：首页、全部服务、服务详情、我的收藏、统一搜索、科研文献、绘图、文档解析、管理端（仅管理员）。

## 7. 外部依赖

| 依赖 | 状态 | 影响 |
| --- | --- | --- |
| Windows Server 模型 API `100.64.0.10:7997` | 不可达 | Open WebUI 无向量/重排能力，RAG 相关验收无法完成 |
| 内网 DNS | 由 Debian 的 dnsmasq 提供 | 客户端需把 DNS 指向 192.0.2.10（或在 hosts 写映射）；未配置时可用 `http://192.0.2.10/` 兜底 |
| HTTPS 证书 | 未部署 | 当前仅 HTTP，认证凭据在内网链路上是明文传输（见 SECURITY.md 风险条目） |
