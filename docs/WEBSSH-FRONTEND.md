# WebSSH 自绘前端 —— 协议与实现规格

> 目标：在门户里用 **antd + xterm.js** 重画 WebSSH 的终端界面，
> 不嵌它的 iframe、不用它自己的导航与配色（与 Baserow 多维表格同一原则）。
>
> 现状（2026-11-19 已部署并验证）：
> - 服务：Docker `ghcr.io/bifrost0x/webssh@sha256:ac2ee696…`，容器 `lab-webssh`，
>   宿主机只绑 `127.0.0.1:8115`，对外走 nginx `:8105`（`auth_request` 门户会话）。
> - 资源限制：会话配额、传输配额、连接限流、SSH 目标白名单（见 `deploy/compose.yaml`）。
> - 原生界面仍在 `:8105` 可用（首次需在该页注册账号）。

## 一、已探明的 socket.io 协议

WebSSH 用 **Flask-SocketIO**，不是原生 WebSocket。协议从镜像内的
`/app/app/socket_events.py` 与 `/app/static` 的前端 bundle 里确认。

### 上行（浏览器 → 服务端）

| 事件 | 载荷 | 说明 |
|---|---|---|
| `ssh_connect` | `{host, port, username, password \| key_id, auth_type, cols, rows, client_request_id}` | 发起连接。`auth_type` 为 `password` 或 `key` |
| `ssh_input` | `{session_id, data, acknowledge_backpressure}` | 往终端写数据。**有每会话输入预算**，超了返回 `{success:false, error:'ssh_input_too_large'}` |
| `ssh_resize` | `{session_id, cols, rows}` | 终端尺寸变化（浏览器缩放时必须上报） |
| `ssh_disconnect` | `{session_id}` | 断开 |
| `ssh_host_key_decision` | `{session_id, accept: bool}` | **主机指纹确认**（首次连接某台机器时服务端会问） |
| `ssh_auth_banner_decision` | `{session_id, decision}` | 认证 banner 策略（批量/交互） |

### 下行（服务端 → 浏览器）

| 事件 | 载荷 | 说明 |
|---|---|---|
| `ssh_connected` | `{session_id, cols, rows, …}` | 连上了 |
| `ssh_error` | `{error, client_request_id}` | 连接失败 |
| `ssh_disconnected` | `{session_id, reason}` | 断开 |
| `ssh_host_key` | `{session_id, hostname, fingerprint, …}` | **要用户确认指纹**（安全关键，不能自动接受） |
| `ssh_host_key_closed` | `{session_id}` | 指纹确认框关闭 |
| `ssh_auth_banner` | `{session_id, banner}` | 服务器认证提示 |

### 终端数据下行

静态 bundle 里出现的事件名有 `output` / `stdout` / `data` 三个候选，
**尚未确证**哪一个是终端字节流的通道。实现前必须先确证：

```bash
docker exec lab-webssh sh -c \
  "grep -ohE \"emit\\('[a-z_]+'\" /app/app/socket_events.py | sort -u" | grep -i out
```

或直接抓一次真实会话的 socket.io 帧（浏览器 DevTools → WS → Frames）。

> **在确证数据通道之前不要写终端**：写出来跑不通会让人以为是协议不支持。

## 二、前端实现要点

1. **依赖**：`socket.io-client`、`@xterm/xterm`、`@xterm/addon-fit`
   （生信平台已有 xterm 6.0.0，可对齐版本）。
2. **同源**：WebSocket 连 `ws://<host>:8105/socket.io/?EIO=4&transport=websocket`。
   - 端口不同即跨源；socket.io 有自己的握手与 polling 回退，**不要**走 nginx 的
     `/pdf-api/` 那种前缀改写，用 `path` 参数或独立 server 段更省事。
   - Cookie 按 host 作用域、不区分端口 → 用户在 `:8105` 登录一次后，
     门户页面（`:80`）的 WebSocket **会带上同一个 Cookie** ✓
3. **鉴权**：webssh 自己的会话仍是第一道门。门户的 `auth_request` 只保证
   「进了门户」，不能替代 webssh 的账号。两种做法：
   - 保留一次登录（用户点「连接」时若被弹到 webssh 的 `/login`，登录后回到门户）
   - 或让门户后端代持服务凭据（需要 webssh 提供票据换取接口 —— **它没有**）
4. **主机指纹**：必须自己画确认弹窗，展示服务端给的指纹并**默认不勾选**。
   这是防中间人的关键一步，不能图省事自动接受。
5. **断线**：心跳超时、`ssh_disconnected` 事件、重连按钮；重连时带上
   `client_request_id` 避免重复建会话。
6. **输入预算**：`ssh_input` 可能被拒（`ssh_input_too_large`）；前端要限速
   （例如每 16ms 最多发 4KB），否则快速粘贴会被服务端掐断。

## 三、权限与资源（已在服务端落地，前端只需如实呈现）

- `SSH_ALLOWED_TARGETS`：只允许实验室的 HPC 与桌面（Tailscale IP）
- `SSH_ALLOWED_INTERNAL_NETWORKS`：允许的内网网段
- `QUOTA_SSH_SESSION_GLOBAL/PER_USER`：6 / 2
- `SSH_CONNECT_RATELIMIT`：6 per minute
- 前端应在连接面板上显示这些数字（用户被拒时才知道原因，而不是看到一句"失败"）
