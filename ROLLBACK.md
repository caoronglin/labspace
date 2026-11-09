# ROLLBACK.md — 回滚

## 1. LabSpace 门户（新增，可整体下线）

```bash
cd /opt/labspace/deploy
docker compose down                     # 移除 backend/casdoor/drawio/it-tools
docker network rm labspace-net          # 若无其他使用者
systemctl disable --now nginx            # 若实验室不需要统一入口
systemctl disable --now dnsmasq
rm -f /etc/nginx/sites-enabled/labspace.conf && nginx -t && systemctl reload nginx
```

数据保留：`casdoor` / `labspace` 两个 database（在既有 PostgreSQL 容器内）、`/opt/labspace` 全部文件。
彻底清理（破坏性，需确认）：
```bash
docker exec lab-postgres psql -U postgres -c "DROP DATABASE IF EXISTS labspace;"
docker exec lab-postgres psql -U postgres -c "DROP DATABASE IF EXISTS casdoor;"
docker exec lab-postgres psql -U postgres -c "DROP ROLE IF EXISTS labspace; DROP ROLE IF EXISTS casdoor;"
```

## 2. Nginx 站点

```bash
rm -f /etc/nginx/sites-enabled/labspace.conf
cp /etc/nginx/sites-available/default /etc/nginx/sites-enabled/ 2>/dev/null
nginx -t && systemctl reload nginx
```

## 3. Casdoor 对既有服务的影响

- Quantum：未启用 OIDC（仍为口令登录），无需回滚。
- Open WebUI：OIDC 配置写在运行时内存（`ENABLE_OAUTH_PERSISTENT_CONFIG=false` 时不落库），
  如需彻底关闭：Admin → Settings → OAuth 关闭或
  `POST /api/v1/auths/admin/config/oauth {"ENABLE_OAUTH": false}`。
  口令登录始终保留（`ENABLE_LOGIN_FORM=true`），既有用户与知识库不受影响。

## 4. 宿主机 DNS / 解析

```bash
rm -f /etc/dnsmasq.d/labspace.conf && systemctl restart dnsmasq
# 恢复原 resolv.conf（备份在 /root/resolv.conf.bak.*）
```

## 5. Docker 守护进程配置

```bash
# 移除 daemon.json 中的 dns 覆盖（恢复前先备份）
cp /etc/docker/daemon.json /etc/docker/daemon.json.bak
systemctl restart docker
```

## 6. 既有组件（未改动，无需回滚）

Open WebUI 容器与数据卷、Quantum、SearXNG、Tika、Docling、科研 API/MCP、Open Terminal、oikb 定时器
均按原样保留；本次只对 lab-core 的 compose 追加了 `extra_hosts` 与 `ENABLE_OAUTH_PERSISTENT_CONFIG`
（下次重建才生效，当前运行实例未变）。
