# AgentScope 2.0.11 接入说明（共用内核）

> 状态：**P1 最小闭环已可运行**（服务健康、库表已建）。pi 网关仍在服役，切换是后续阶段的事。

## 为什么是独立容器而不是塞进门户后端

`agentscope==2.0.11` 的依赖很重，且带硬版本约束：`mcp>=2.0.0`、`httpx2>=2.5.0`、
`anthropic`、`dashscope`、`opentelemetry-*`、`aiortc`。门户后端锁着 `httpx==0.28.1`
等版本，塞进同一个镜像会直接打架，并把镜像再撑大几百 MB。

但**内核仍然是同一份**：同样的 `agentscope.app.create_app`、同样的 Session /
KnowledgeBase / SOP 存储，只是进程边界清楚。业务侧不再自建平行的会话表。

## 组成

| 文件 | 作用 |
| --- | --- |
| `deploy/agentscope/Dockerfile` | `python:3.11-slim` + `agentscope[service,storage-sql]==2.0.11` |
| `deploy/agentscope/requirements.txt` | 依赖与 extras（**extras 不能省**，否则 import 期就缺 `apscheduler`） |
| `deploy/agentscope/app.py` | 装配层：`create_app(storage, message_bus, workspace_manager)` + `/healthz` |
| `deploy/nginx/agentscope.conf` | 对外 8104：`auth_request` → 门户 `/api/auth/check`，再注入 `X-User-ID` |

## 身份：X-User-ID 不可伪造

```text
浏览器 ──cookie──▶ nginx :8104 ──auth_request──▶ 门户 :8088 /api/auth/check
                        │                               └─ 204 + X-Auth-User: <sub>
                        └──proxy_set_header X-User-ID $auth_user──▶ AgentScope :8103
```

`proxy_set_header` 是**无条件覆盖**：客户端自己带的 `X-User-ID` 会被替换掉，
所以伪造无效。AgentScope 侧沿用官方 `get_current_user_id` 依赖，不需要改它的代码。

## 存储

* 独立库 `agentscope`（与门户同实例、不同库）。
  不用「同库不同 schema」是因为 AgentScope 自带 alembic，`search_path` 需要在
  asyncpg 与 alembic 两侧都配好，漏一侧就会写到 `public`。
* 当前单实例，`create_tables=True` 启动即建表（已建 13 张表）。
  **多副本时必须改成独立迁移步骤**，否则两个副本会并发跑同一份 DDL。

## 运维命令

```bash
# 构建 / 启动
cd /opt/labspace/deploy && docker compose build agentscope && docker compose up -d agentscope

# 探活（只绑回环）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8103/healthz

# 库表
docker exec lab-postgres psql -U labspace -d agentscope -c '\dt'
```

## 后续阶段（未做）

1. **事件适配**：把 AgentScope 事件映射成前端认的 `ready/delta/tool/done/error`。
   `ToolCallStart/Result` 的字段名必须逐个核对 `agentscope/event/_event.py`，不要按猜测写。
2. **工具**：现有 13 个 `lab_*` 工具（`agent/extensions/lab-portal.js`）迁成 MCP server，
   用 `MCPHubBase` 接入；不足的用 `extra_agent_tools` 补。
3. **额度**：`MiddlewareBase` 钩子上做预留/结算，与门户 `/api/agent/quota` 统一口径。
4. **知识库**：`CollectionPerKbManager` + `QdrantStore`；`lab-rag` 保持现状不重建。
5. **灰度下线 pi**：按用户/会话分流，观察期后再移除 `agent/gateway.mjs`。
