# DEPLOY.md — 部署手册

前置：Debian 13、docker + compose v2、`/srv/labdata` 数据盘已挂载、既有组件（Open WebUI / Quantum / SearXNG / Tika / Docling / 科研 API / oikb）已就绪。

## -1. 两个访问入口（IP + 端口，无域名）

所有服务都走 **IP + 端口**，同一端口在两个入口上完全一致；链接跟随用户实际进入的入口自动切换。

| 服务 | 端口 | 内网入口 | Tailscale 入口 |
|---|---|---|---|
| 门户（D509 工作台） | 80 | http://192.0.2.10/ | http://198.51.100.71/ |
| 统一认证（门户） | 80 | http://192.0.2.10/login | http://198.51.100.71/login |
| Open WebUI | 3000 | http://192.0.2.10:3000/ | http://198.51.100.71:3000/ |
| Quantum 文件（唯一权威存储） | 8080 | http://192.0.2.10:8080/files/ | http://198.51.100.71:8080/files/ |
| draw.io 绘图 | 8082 | http://192.0.2.10:8082/ | http://198.51.100.71:8082/ |
| IT-Tools 原版 | 8084 | http://192.0.2.10:8084/ | http://198.51.100.71:8084/ |
| Linux 命令速查 | 8086 | http://192.0.2.10:8086/ | http://198.51.100.71:8086/ |
| JBrowse 2 | 8091 | http://192.0.2.10:8091/ | http://198.51.100.71:8091/ |
| SnapOtter 文件工坊 | 8092 | http://192.0.2.10:8092/ | http://198.51.100.71:8092/ |
| 生物信息学实习实训平台 | 80 | http://192.0.2.10/apps/bioinfo/ | http://198.51.100.71/apps/bioinfo/ |
| SSH/SFTP 工作台 | 80 | http://192.0.2.10/ssh | http://198.51.100.71/ssh |
| 引物设计 Primer3 | 80 | http://192.0.2.10/apps/primer/ | http://198.51.100.71/apps/primer/ |

要点：

- **Tailscale 客户端**只要装好 tailscale 并登录同一账号，直接用 `198.51.100.71` 即可；
  访问门户后所有服务链接自动变成 Tailscale 地址，不会把你导回内网 IP。
- nftables 对 `tailscale0` 接口整体放行，平台端口集合 `svc_ports` 同时含 `100.64.0.0/10`。
- **改监听地址必须 `systemctl restart nginx`**：`reload` 不会改绑 socket
  （生信平台 8102 早期只绑 `192.0.2.10`，导致 Tailscale 访问 000）。
- 认证已收口到门户自身：账号口令在 `/login` 校验；生信与 Primer3 使用门户 OIDC Provider。Casdoor 与 `lab-oidc-sync` 已下线。

## 0. 内网 DNS（可选但推荐）

```bash
install -m 0644 /opt/labspace/deploy/dnsmasq-labspace.conf /etc/dnsmasq.d/labspace.conf
systemctl enable --now dnsmasq
# 客户端：把 DNS 指向 192.0.2.10，或在客户端 hosts 写入：
#   192.0.2.10   # 仅本机回环需要；所有服务均以 192.0.2.10 + 端口访问，不使用域名
```
未配置 DNS 时可用 `http://192.0.2.10/`（Nginx default_server 即门户）。

Docker 容器解析内网主机名：daemon.json 已设置 `"dns": ["192.0.2.10","192.0.2.1"]`，
**新建**的容器会自动生效；早于该设置创建的容器需重建或手工写 `/etc/hosts`。

## 1. 门户统一认证

```bash
cd /opt/labspace/deploy
# 账号数据库沿用原 Casdoor PostgreSQL 库（容器已下线、数据保留）
docker compose up -d lab-postgres
docker compose build backend && docker compose up -d backend
curl -fsS http://127.0.0.1:8088/api/health
```

- 登录：`POST /api/auth/login-direct`（账号 + 口令，bcrypt）。
- 会话：门户自签 HS256 JWT，HttpOnly + SameSite=Lax Cookie。
- 内网服务 SSO：Go OIDC Provider，`/oidc/.well-known/openid-configuration`。
- 原 Casdoor 容器、8090 监听与 `lab-oidc-sync` 均已移除；不要重新启动。

## 2. LabSpace 后端

```bash
cd /opt/labspace/deploy
cp .env.example .env   # 若不存在，按需填写并 chmod 600
docker compose build backend && docker compose up -d backend
curl -fsS http://127.0.0.1:8088/api/health
```

`.env` 关键项：`LABSPACE_SESSION_SECRET`（`openssl rand -hex 32`）、
`LABSPACE_DB_DSN`（`postgresql://labspace:<pwd>@lab-postgres:5432/labspace`）、
`CASDOOR_DB_*`（沿用账号数据库连接；名称保留是为了兼容既有数据）。

## 3. 前端

```bash
cd /opt/labspace/frontend
npm ci --registry=https://registry.npmmirror.com
npm run build           # 产物 dist/，由 Nginx 托管
```

## 4. 第三方组件

```bash
cd /opt/labspace/deploy
docker compose up -d drawio it-tools
# Linux Command：官方仓库静态构建（供独立站点 + 门户命令库数据源）
cd /opt/labspace/frontend/linux-command/src && npm ci && npm run build && cp -r .deploy ../dist
# 命令库数据源：src/dist/data.json + src/command/*.md（后端只读挂载）
```

## 4.1 SnapOtter 文件工坊（端口 8092）

```bash
# 镜像 12.3GB：GHCR 比镜像源快很多
docker pull ghcr.io/snapotter-hq/snapotter:latest
docker tag ghcr.io/snapotter-hq/snapotter:latest snapotter/snapotter:latest
docker pull postgres:17-alpine redis:8-alpine

cd /opt/lab-snapotter
# .env（0600）：POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_APP_PASSWORD /
#               REDIS_PASSWORD / SNAPOTTER_ADMIN_USER / SNAPOTTER_ADMIN_PASSWORD
docker compose up -d

# 关键：应用角色 snapotter_app 不由镜像自动创建，必须自备 init 脚本
#   /srv/labdata/snapotter/initdb/10-app-role.sh
#   CREATE ROLE snapotter_app LOGIN PASSWORD '...';
#   GRANT ALL PRIVILEGES ON DATABASE snapotter TO snapotter_app;
#   ALTER SCHEMA public OWNER TO snapotter_app;

# 创建给门户后端用的 API Key（si_ 前缀）
curl -s -X POST http://127.0.0.1:8092/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"<admin>","password":"<admin 口令>"}' -c /tmp/so.jar
curl -s -X POST http://127.0.0.1:8092/api/v1/api-keys -b /tmp/so.jar \
  -H 'Content-Type: application/json' -d '{"name":"labspace-portal"}'

# 门户后端需要的环境变量（/opt/labspace/deploy/.env）
#   SNAPOTTER_BASE_URL=http://lab-snapotter:1349
#   SNAPOTTER_API_KEY=si_xxxx
cd /opt/labspace/deploy && docker compose up -d backend

# 新增对外端口后必须同步 nftables 的 svc_ports 集合，否则外部客户端被 DROP
grep -n svc_ports /etc/nftables.conf
/usr/sbin/nft -c -f /etc/nftables.conf && /usr/sbin/nft -f /etc/nftables.conf
```

## 4.2 AgentScope 2.0.12（独立容器）

```bash
cd /opt/labspace/deploy
docker compose build agentscope
docker compose up -d agentscope
curl -fsS http://127.0.0.1:8103/healthz
```

- 服务只绑回环 `127.0.0.1:8103`，外部请求经 Nginx `auth_request` 鉴权后注入 `X-User-ID`。
- 模型凭据放 `/etc/labspace/agent-model.env`（0600），由 compose 注入容器。
- 知识库向量库存放于 Qdrant；长期记忆与工作区位于 `/srv/agentscope/workspaces`。
- 工具确认与 AskUser 走 HITL；前端不能自行批准任意工具。
- 旧 pi 网关与 `lab-agent-gateway.service` 已下线，不要再部署。

## 4.3 自研 SSH/SFTP 网关

```bash
cd /opt/labspace/deploy
# 生成 Fernet 密钥并写入 deploy/.env（0600）；只保留在部署机
../backend/.venv/bin/python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
docker compose build ssh-gateway
docker compose up -d ssh-gateway
curl -fsS http://127.0.0.1:8118/healthz
nginx -t && systemctl reload nginx
```

`.env` 关键项：`SSH_GATEWAY_SECRET_KEY`（Fernet 密钥）、`SSH_GATEWAY_ALLOWED_HOSTS`、
`SSH_GATEWAY_ALLOWED_CIDRS`、`SSH_GATEWAY_ALLOWED_PORTS`。默认只允许私网、回环与 Tailscale CGNAT，
端口默认 22；服务仅绑定 `127.0.0.1:8118`，浏览器统一走门户 `/ssh` 与同源 `/ssh-api/`。

- 门户 Nginx `auth_request` 校验会话后注入 `X-User-ID`，网关按该 ID 隔离连接、主机密钥、会话和审计。
- SSH 口令/私钥加密保存在 PostgreSQL `ssh_gateway` schema；不要将 `.env` 或密钥提交到仓库。
- 首次连接必须确认服务器主机指纹；指纹变化会拒绝连接。
- 单 worker 保留 WebSocket 会话状态；默认单人 2 个、全局 8 个会话，空闲 30 分钟回收。
- SFTP 上传先写临时文件再改名；失败会清理临时文件，不覆盖目标文件。

## 4.4 门户 OIDC Provider（LabGo，无独立同步服务）

LabGo 同时提供服务目录与最小 OIDC Provider：

```bash
cd /opt/labspace/go-core
CGO_ENABLED=0 GOPROXY=off go build -trimpath -ldflags='-s -w' -o /tmp/labgo ./cmd/labgo
install -m 0755 /tmp/labgo /usr/local/bin/labgo
systemctl restart labgo
curl -fsS http://127.0.0.1:8122/v1/oidc/.well-known/openid-configuration
```

- 对外路径是 `/oidc/*`，Nginx 映射到 LabGo 内部 `/v1/oidc/*`。
- 未登录授权回跳必须使用公开 `/oidc/authorize`，不能泄露内部前缀。
- issuer 跟随白名单入口 Host；生信回调使用当前同源 `/apps/bioinfo/api/v1/auth/callback`。
- Casdoor、8090 监听与 `lab-oidc-sync` 均已下线；不需要 issuer 同步脚本或第三方容器重建。

## 5. Nginx

```bash
cp /opt/labspace/deploy/nginx/labspace.conf /etc/nginx/sites-available/labspace.conf
ln -sf /etc/nginx/sites-available/labspace.conf /etc/nginx/sites-enabled/labspace.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

## 5.1 前端质量检查（Ant Design 官方 CLI）

```bash
npm install -g @ant-design/cli
cd /opt/labspace/frontend
antd doctor          # 环境/依赖/主题配置诊断
antd lint ./src      # 弃用 API、a11y、性能、最佳实践
antd usage ./src     # 组件用量分析
antd info Button     # 组件 Props/Token 速查（离线）
```
当前状态：`antd doctor` 14 项全过；`antd lint ./src` **0 问题**（38 个文件）。

## 6. 验收

```bash
cd /opt/labspace/e2e
export LAB_PASS='<门户账号口令>'      # 不带这个变量，登录会静默失败、断言全红
node e2e.mjs                          # 浏览器端到端 + 截图
node api-integration.mjs              # API 集成体检（含 SnapOtter 与统一语料断言）
node snapotter-integration.mjs        # 文件工坊全链路（含真实图片处理）
node agent-integration.mjs            # 工作台 / Agent / 翻译 / 天气 / 文档解析
node sso-flow.mjs                     # 六个服务的单点登录免密
node home-layout.mjs                  # 首页三档视口排版
node i18n-full.mjs                    # 全站中文化
./run-regression.sh                    # 或者一键跑全部 16 个脚本
node oidc-multi.mjs                   # LAN / Tailscale 双入口 OIDC
curl -sI http://192.0.2.10/ | head -1
for p in 80 8082 8086 8091 8092; do
  printf ":%-5s " $p; curl -s -o /dev/null -w "%{http_code}\n" http://192.0.2.10:$p/
done
```

## 7. 常用运维

```bash
docker compose ps                     # LabSpace 栈
docker compose logs -f backend
docker compose restart backend
labctl health                         # 既有组件探活
```
