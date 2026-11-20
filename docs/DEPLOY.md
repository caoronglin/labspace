# DEPLOY.md — 部署手册

前置：Debian 13、docker + compose v2、`/srv/labdata` 数据盘已挂载、既有组件（Open WebUI / Quantum / SearXNG / Tika / Docling / 科研 API / oikb）已就绪。

## -1. 两个访问入口（IP + 端口，无域名）

所有服务都走 **IP + 端口**，同一端口在两个入口上完全一致；链接跟随用户实际进入的入口自动切换。

| 服务 | 端口 | 内网入口 | Tailscale 入口 |
|---|---|---|---|
| 门户（D509 工作台） | 80 | http://192.0.2.10/ | http://198.51.100.71/ |
| 统一认证 Casdoor | 8090 | http://192.0.2.10:8090/ | http://198.51.100.71:8090/ |
| Open WebUI | 3000 | http://192.0.2.10:3000/ | http://198.51.100.71:3000/ |
| Quantum 文件（唯一权威存储） | 8080 | http://192.0.2.10:8080/files/ | http://198.51.100.71:8080/files/ |
| draw.io 绘图 | 8082 | http://192.0.2.10:8082/ | http://198.51.100.71:8082/ |
| IT-Tools 原版 | 8084 | http://192.0.2.10:8084/ | http://198.51.100.71:8084/ |
| Linux 命令速查 | 8086 | http://192.0.2.10:8086/ | http://198.51.100.71:8086/ |
| JBrowse 2 | 8091 | http://192.0.2.10:8091/ | http://198.51.100.71:8091/ |
| SnapOtter 文件工坊 | 8092 | http://192.0.2.10:8092/ | http://198.51.100.71:8092/ |
| 生物信息学实习实训平台 | 8102 | http://192.0.2.10:8102/ | http://198.51.100.71:8102/ |

要点：

- **Tailscale 客户端**只要装好 tailscale 并登录同一账号，直接用 `198.51.100.71` 即可；
  访问门户后所有服务链接自动变成 Tailscale 地址，不会把你导回内网 IP。
- nftables 对 `tailscale0` 接口整体放行，平台端口集合 `svc_ports` 同时含 `100.64.0.0/10`。
- **改监听地址必须 `systemctl restart nginx`**：`reload` 不会改绑 socket
  （生信平台 8102 早期只绑 `192.0.2.10`，导致 Tailscale 访问 000）。
- OIDC issuer 随入口自动切换：Casdoor 按请求 Host 回显；Open WebUI / Quantum 由
  `lab-oidc-sync` 按来访客户端网段改写 issuer（见 4.3）。

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

## 1. Casdoor（统一身份源）

```bash
cd /opt/labspace/deploy
docker compose up -d casdoor
# Casdoor 以 IP 专属端口对外（8090），授权地址不含域名，容器/客户端均无需 DNS
# 注意：不再配置任何 *.lab.internal 域名，全部走 192.0.2.10 + 端口
```

初始化（组织/组/应用/用户，见 `lab-casdoor-init`）：

```bash
lab-casdoor-init            # 幂等；管理员口令写入 /etc/labspace/casdoor-admin.txt
```
Casdoor 使用 beego `app.conf`，Postgres 连接串通过**同名环境变量**覆盖（`driverName` / `dataSourceName` / `dbName`），
注意 `dataSourceName` 必须自带 `dbname=casdoor`（Casdoor 不会为 postgres 追加库名）。

已注册的 OIDC 客户端：

| client_id | 用途 | 回调地址 |
| --- | --- | --- |
| `labspace` | LabSpace 门户 | `http://192.0.2.10/api/auth/callback` |
| `openwebui` | Open WebUI | `http://192.0.2.10:3000/oauth/oidc/callback` |
| `quantum` | FileBrowser Quantum | `http://192.0.2.10:8080/files/api/auth/oidc/callback` |

## 2. LabSpace 后端

```bash
cd /opt/labspace/deploy
cp .env.example .env   # 若不存在，按需填写并 chmod 600
docker compose build backend && docker compose up -d backend
curl -fsS http://127.0.0.1:8088/api/health
```

`.env` 关键项：`LABSPACE_ISSUER`（Casdoor issuer）、`LABSPACE_CLIENT_ID/SECRET`、
`LABSPACE_REDIRECT_URI`、`LABSPACE_SESSION_SECRET`（`openssl rand -hex 32`）、
`LABSPACE_DB_DSN`（`postgresql://labspace:<pwd>@lab-postgres:5432/labspace`）。

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

## 4.2 Agent 网关（pi）与插件（宿主机服务，不进 Docker）

```bash
# 1) 配置文件（0600）：网关令牌、会话目录、插件路径、默认模型
install -m 600 /dev/null /etc/labspace/agent-gateway.json
cat >/etc/labspace/agent-gateway.json <<'JSON'
{
  "token": "<随机 48 位 hex>",
  "session_dir": "/srv/labdata/labspace/agent/sessions",
  "extensions": ["/opt/labspace/agent/extensions/lab-portal.js"],
  "default_model": "minimax-cn/MiniMax-M3.1-Flash",
  "system_prompt": "你是 D509 实验室门户的内置助手……只能使用 lab_* 工具……"
}
JSON

# 2) 目录与 systemd 单元
mkdir -p /srv/labdata/labspace/agent/{sessions,work}
chmod 700 /srv/labdata/labspace/agent
install -m 755 /opt/labspace/agent/gateway.mjs /opt/labspace/agent/gateway.mjs
install -m 644 /etc/systemd/system/lab-agent-gateway.service /etc/systemd/system/lab-agent-gateway.service

# 3) 启动（node 路径必须运行时解析：/root/.local/share/pi-node/current/bin/node）
systemctl daemon-reload && systemctl enable --now lab-agent-gateway
systemctl status lab-agent-gateway

# 4) 门户后端需要知道网关地址与令牌（/opt/labspace/deploy/.env）
#   LABSPACE_AGENT_GATEWAY=http://172.28.0.1:8110
#   LABSPACE_AGENT_TOKEN=<与网关 json 相同的 token>
#   LABSPACE_AGENT_DEFAULT_MODEL=minimax-cn/MiniMax-M3.1-Flash
cd /opt/labspace/deploy && docker compose build backend && docker compose up -d backend

# 5) 插件自测（需要门户服务令牌 + 一个用户会话 JWT）
cd /opt/labspace/agent/extensions
LAB_PORTAL_URL=http://192.0.2.10 \
LAB_PORTAL_TOKEN=<服务令牌> \
LAB_PORTAL_BEARER=<用户会话 JWT> \
node test-lab-portal.mjs
```

> **注意**
> - 网关只监听 `172.28.0.1:8110`（docker 网桥地址），**外部客户端无法直连**；所有调用都经门户后端中继。
> - pi 的 `--model` 必须是 `provider/id` 形式；网关会把裸模型名自动补全。
> - 插件工具只能通过门户 API 取数据，**无法读写宿主机文件系统**。
> - 用户的会话 JWT 由门户后端在建会话时透传给网关，网关注入为 `LAB_PORTAL_BEARER`。

## 4.3 OIDC 入口自适应服务（宿主机服务，不进 Docker）

让 Open WebUI / Quantum 的 OIDC issuer 与回调地址跟随用户当前访问入口主机
（内网 `192.0.2.10` 或 Tailscale `198.51.100.71`），保证远程用户也能免密登录。

```bash
# 1) 配置文件（0600）：监听地址与令牌
install -m 600 /dev/null /etc/labspace/oidc-sync.json
cat >/etc/labspace/oidc-sync.json <<JSON
{
  "listen_host": "172.28.0.1",
  "listen_port": 8111,
  "token": "$(openssl rand -hex 24)"
}
JSON

# 2) 脚本与 systemd 单元
install -m 755 /opt/labspace/ops/oidc-sync.py /opt/labspace/ops/oidc-sync.py
install -m 644 /etc/systemd/system/lab-oidc-sync.service /etc/systemd/system/lab-oidc-sync.service

# 3) 启动
systemctl daemon-reload && systemctl enable --now lab-oidc-sync
systemctl status lab-oidc-sync
curl -s http://172.28.0.1:8111/health        # {"ok":true,"service":"lab-oidc-sync"}

# 4) 门户后端需要知道同步服务地址与令牌（/opt/labspace/deploy/.env）
#   LABSPACE_OIDC_SYNC_URL=http://172.28.0.1:8111
#   LABSPACE_OPS_TOKEN=<与 oidc-sync.json 相同的 token>
cd /opt/labspace/deploy && docker compose build backend && docker compose up -d backend

# 5) 手动切换（通常由门户「一键登录」自动触发）
TOKEN=$(python3 -c "import json;print(json.load(open('/etc/labspace/oidc-sync.json'))['token'])")
curl -s -X POST http://172.28.0.1:8111/sync \
  -H "X-Ops-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"service":"open-webui","host":"198.51.100.71"}'
```

> **注意**
> - 服务只监听 `172.28.0.1:8111`（docker 网桥），外部无法直连；调用方是门户后端。
> - Open WebUI 的真值是容器环境变量（`/opt/lab-core-stack/.env`），Quantum 是
>   `/etc/lab-quantum/quantum.env`；两者改动后**必须重建容器**（Quantum 不支持热加载）。
> - 切换会自动把新的回调地址登记进 Casdoor `application.redirect_uris`（幂等）。
> - 每次切换会重建容器（约 10~30 秒），期间服务短暂不可用。

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
export LAB_PASS='<casdoor 口令>'      # 不带这个变量，登录会静默失败、断言全红
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
for p in 80 8090 3000 8080 8082 8084 8086 8091 8092; do
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
