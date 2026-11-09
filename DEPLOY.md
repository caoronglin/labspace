# DEPLOY.md — 部署手册

前置：Debian 13、docker + compose v2、`/srv/labdata` 数据盘已挂载、既有组件（Open WebUI / Quantum / SearXNG / Tika / Docling / 科研 API / oikb）已就绪。

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
当前状态：`antd doctor` 14 项全过；`antd lint ./src` **0 问题**（35 个文件）。

## 6. 验收

```bash
cd /opt/labspace/e2e
export LAB_PASS='<casdoor 口令>'      # 不带这个变量，登录会静默失败、断言全红
node e2e.mjs                          # 浏览器端到端 + 截图
node api-integration.mjs              # API 集成体检（含 SnapOtter 与统一语料断言）
node snapotter-integration.mjs        # 文件工坊全链路（含真实图片处理）
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
