# SECURITY.md

## 1. 已落实的措施

| 项 | 做法 |
| --- | --- |
| 统一身份源 | 仅 Casdoor；门户不实现第二套认证 |
| 会话 | 自签 HS256 JWT，HttpOnly + SameSite=Lax Cookie，8 小时过期；密钥在 `/opt/labspace/deploy/.env`（0600） |
| CSRF | 双提交令牌（`labspace_csrf` Cookie + `X-CSRF-Token` 头），并校验 `Origin` 白名单 |
| OIDC | 校验 id_token 签名（JWKS）、iss、aud、exp、nonce、state 一次性 |
| 前端密钥 | 前端不含任何 secret；Client Secret 只在后端 |
| 端口暴露 | 所有容器端口只发布到 127.0.0.1；对外仅 Nginx 80（内网） |
| Docker | `no-new-privileges`、`cap_drop: ALL`（按镜像需要最小加回）、read_only + tmpfs、mem/cpu/pids 限制、日志轮转 |
| Docker Socket | 未挂载给任何容器 |
| 数据访问 | LabSpace 后端只读/写挂载 `/srv/lab/users`（用户目录），路径白名单化后再落盘 |
| 路径穿越 | 绘图保存路径 realpath 校验必须在目标目录内；文件名白名单；隐藏文件与 `..` 拒绝 |
| 内容注入 | 拒绝 `<!DOCTYPE` / `<!ENTITY` / `<script>` / `javascript:`；上游文本标注“不可信内容” |
| iframe | draw.io 嵌入仅在反代层移除上游 X-Frame-Options（不改第三方源码），postMessage 严格校验 origin + source |
| 后端鉴权 | 每个 API 独立校验；管理接口需 `lab-admin`；未登录 401、角色不足 403 |
| 密码存储 | Casdoor 与 Open WebUI 均为 bcrypt；口令文件 0600 且不在仓库 |
| 日志 | 容器 json-file 轮转（10MB×3 / 20MB×5）；审计日志不含口令与令牌 |

## 2. 已知风险（必须由实验室决策）

| 风险 | 说明 | 建议 |
| --- | --- | --- |
| **HTTP 明文传输** | 当前仅 80 端口 HTTP，OIDC 授权码与 Cookie 在内网链路上是明文 | **实验室决策：内网可信网络，不部署 HTTPS**（无中间人场景）。风险记录在此：若将来接入访客 Wi-Fi、跨网段或经任何不可信链路，需补内网 CA 的 443 端口 |
| 客户端 DNS 未接入 | 未把 DNS 指向 192.0.2.10 的客户端无法解析 `192.0.2.10 + 端口` 入口 | 在路由器/DHCP 下发 DNS，或用 `http://192.0.2.10/` 兜底 |
| Open WebUI OIDC 未通 | 容器内 DNS + 客户端缓存导致 `/oauth/oidc/login` 500 | 维护窗口执行 `docker compose up -d`（compose 已含 extra_hosts 与持久化开关） |
| ~~宿主机无防火墙~~ | 已部署 nftables（`/etc/nftables.conf`）：默认 DROP，仅放行 lo/established、ICMP、22 与 80（内网 192.0.2.0/24、172.16/12、Docker 10.88/16、Tailscale 100.64/10）、53（仅内网）、tailscale0 与 Docker 网桥 | 规则随系统启动加载；**注意不要在规则里用 `flush ruleset`**（会清空 Docker 依赖的 iptables 链，导致端口发布失效） |
| Open Terminal 共享容器 | 免费版非 per-user 隔离 | 保持仅导师/管理员可用；向学生开放需 per-user 容器或商业许可 |
| Casdoor 口令为 plain 存储 | Casdoor 默认 `password_type=plain` | 若 Casdoor 版本支持 bcrypt/salt 模式，改用该模式并迁移 |
| 绘图文件属主为服务账号 | 由后端（uid 1000）写入，学生账号通过目录 ACL 访问 | 如需学生写入，应改由 Quantum 侧写或调整 ACL |
| 实验室 IP 段信任 | 防火墙按网段放行 | 物理隔离实验网段 + 交换机 ACL |
| Quantum 保留本地口令 | 除 OIDC 外仍保留管理员口令通道 | 仅管理员使用；学生日常走 Casdoor；口令存 0600 文件 |

## 3. 明确未做

- 未修改第三方源码以绕过安全限制（draw.io 的 X-Frame-Options 只在反代层处理）。
- 未给普通用户开放服务端 Python Functions（`workspace.tools=false`）。
- 未引入第二套账号体系或容器编排能力。
- 未把 Docker Socket / 宿主机根目录 / 密钥目录挂载给任何执行环境。
