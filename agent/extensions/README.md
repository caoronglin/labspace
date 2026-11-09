# 实验室能力插件（lab-portal）

pi 编码代理的实验室门户扩展：让 pi 助手可以直接调用内网实验室门户（FastAPI）的数据库 API、
统一搜索与个人工作台。

## 用途

| 工具 | 作用 | 后端路由 |
|---|---|---|
| `lab_services` | 查询内网服务清单（名称/URL/说明），支持关键词本地过滤 | `GET /api/services` |
| `lab_database_query` | 按中文名/英文名/id 解析数据库后执行真实检索 | `GET /api/databases`、`POST /api/databases/{id}/query` |
| `lab_web_search` | 联网搜索，返回前 8 条标题/链接/摘要 | `GET /api/search?scope=web&q=…` |
| `lab_workbench_capture` | 一句话智能捕获进个人工作台，返回条目与分类结果 | `POST /api/workbench/capture` |
| `lab_workbench_list` | 列出当前用户工作台条目，可按 kind 过滤 | `GET /api/workbench/items?kind=&limit=` |

> 注意：上述后端路由由主代理实现，`/api/workbench/*` 目前可能尚未上线（调用会返回 HTTP 404/501，
> 插件会转成中文错误提示而不是抛栈）。`/api/services`、`/api/databases`、`/api/search` 已在
> `backend/app/main.py` 中存在。

## 加载方式

```bash
# 开发/调试：直接以扩展文件方式加载
pi --extension /opt/labspace/agent/extensions/lab-portal.js

# 或者放进扩展目录后由 pi 自动发现
mkdir -p ~/.pi/agent/extensions && cp /opt/labspace/agent/extensions/lab-portal.js ~/.pi/agent/extensions/
```

pi 通过 jiti 加载扩展，`.js`/`.ts` 均可；本插件是纯 ESM JavaScript，无第三方依赖。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `LAB_PORTAL_URL` | 否 | `http://192.0.2.10` | 门户地址（nginx 对外暴露的 http 端口 80） |
| `LAB_PORTAL_TOKEN` | 是 | — | 内部服务令牌，作为 `X-Lab-Service-Token` 请求头发送 |

令牌缺失时，工具返回中文提示「未配置环境变量 LAB_PORTAL_TOKEN…」，不会崩溃；
令牌本身不会出现在任何工具输出或错误信息中。

示例：

```bash
export LAB_PORTAL_URL=http://192.0.2.10
export LAB_PORTAL_TOKEN=...   # 由管理员下发
pi --extension /opt/labspace/agent/extensions/lab-portal.js
```

## 请求约定

- 所有请求带 `X-Lab-Service-Token: <LAB_PORTAL_TOKEN>`，仅对契约 §3 白名单路径有效：
  `/api/workbench/*`、`/api/databases*`、`/api/search*`、`/api/services*`。
- 超时 15 秒（AbortController）。
- 非 2xx 与网络错误统一转成中文错误说明返回给模型（结果带 `isError: true`），不抛未捕获异常。
- 数据库目录（`GET /api/databases`）结果在内存中缓存 5 分钟，用于「中文名 → id」映射。

## 自测

```bash
node /opt/labspace/agent/extensions/test-lab-portal.mjs
```

脚本会 mock 一个最小的 pi 上下文（只实现 `registerTool`），捕获注册到的工具，然后：

1. 断言 5 个工具都已注册，且 `parameters` 为合法 JSON Schema（object/properties/description/required 自洽）；
2. 把 `LAB_PORTAL_URL` 临时指向 `http://127.0.0.1:1`，逐个工具走「网络失败」路径，断言返回中文错误文本而不是抛异常；
3. 断言缺少 `LAB_PORTAL_TOKEN` 时返回明确的中文环境变量提示；
4. 若本机门户可达（`http://192.0.2.10/api/services` 非 000），再对 `lab_services` 做一次真实调用。

## 文件

- `lab-portal.js` — 插件本体（`export default function (pi) { … }`，用 `pi.registerTool` 注册 5 个工具）
- `README.md` — 本文件
- `test-lab-portal.mjs` — 自测脚本（node 直接 import 插件模块）
