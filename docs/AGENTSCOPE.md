# AgentScope 2.0.12 接入说明

> 状态：**生产运行中**。门户个人助手、知识库、长期记忆、HITL 与能力中心均由 AgentScope 2.0.12 承载；旧 pi 网关已下线。

## 架构

```text
浏览器 → Nginx `/api/agent/*` → 门户后端 → AgentScope 2.0.12（lab-agentscope）
                                      │              │
                                      │              ├─ PostgreSQL 库 agentscope
                                      │              ├─ Qdrant 向量库
                                      │              └─ 每用户工作区 / 长期记忆
                                      └─ 会话、模型白名单、配额、审计、SSE 事件翻译
```

AgentScope 依赖较重且与门户后端的 `httpx` 版本约束不同，因此运行在独立容器中。门户不重复实现 AgentScope 的会话、知识库、工具与工作区栈，只负责鉴权、配额和统一事件契约。

## 组成

| 文件 | 作用 |
| --- | --- |
| `deploy/agentscope/Dockerfile` | 独立运行镜像 |
| `deploy/agentscope/requirements.txt` | 锁定 `agentscope[service,storage-sql,vdb-qdrant,rag,channel]==2.0.12` |
| `deploy/agentscope/app.py` | `create_app` 装配、MCP 工具、身份注入、HITL 权限策略、长期记忆 |
| `deploy/agentscope/lab_mcp_server.py` | 门户业务 MCP 工具，使用签名用户断言回调门户 |
| `deploy/agentscope/lab_access.py` | 教师/管理员跨用户只读助手与知识库；凭据永不共享 |
| `deploy/nginx/agentscope.conf` | 回环入口、门户会话鉴权、无条件覆盖 `X-User-ID` |
| `backend/app/agentscope_adapter.py` | AgentScope 事件 → `ready/delta/tool/done/error` |
| `frontend/src/pages/agent/` | Ant Design X 会话、消息、输入区、HITL 与知识记忆组件 |

## 身份与权限

- Nginx 先调用门户 `/api/auth/check`，再用 `X-Auth-User` 无条件覆盖 `X-User-ID`；客户端不能伪造身份。
- AgentScope 的 `lab_*` MCP 工具使用进程内密钥签发短期用户断言，模型不能指定其它用户。
- 普通用户只能访问自己的资源；教师/管理员可跨用户**只读**助手与知识库，不能改写或删除。
- `credential` 资源永不共享；门户或角色读取失败时按无共享权限处理（fail closed）。
- 工具确认与 AskUser 走 HITL：前端只展示服务端问题，门户后端重建事件后回传，不允许前端批准任意工具。

## 存储

- PostgreSQL 库 `agentscope`：AgentScope 业务表。
- Qdrant：知识库向量集合，API Key 仅从部署环境注入。
- `/srv/agentscope/workspaces`：每用户工作区与长期记忆。
- `/srv/agentscope/blobs`：知识库文档原件。

## 门户事件契约

| AgentScope 事件 | 门户 SSE |
| --- | --- |
| 会话就绪 | `ready` |
| 文本增量 | `delta` |
| 工具调用 / 结果 | `tool` |
| 人工确认 / AskUser | `confirm` / `ask` |
| 完成 | `done` |
| 错误 | `error` |

AgentScope 原始流与门户翻译流路径不同，前端只依赖统一后的五类事件，不直接耦合上游私有事件形状。

## 运维

```bash
cd /opt/labspace/deploy
docker compose build agentscope
docker compose up -d agentscope
curl -fsS http://127.0.0.1:8103/healthz
docker exec lab-postgres psql -U labspace -d agentscope -c '\dt'
```

多副本部署前必须把 AgentScope 的建表步骤改为独立迁移，不能依赖两个副本同时执行 `create_tables=True`。
