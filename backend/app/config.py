"""LabSpace 后端：环境配置与常量。"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _bool(name: str, default: bool = False) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _list(name: str, default: str = "") -> list[str]:
    raw = os.getenv(name, default)
    return [x.strip() for x in raw.split(",") if x.strip()]


def _positive_int(name: str, default: int, maximum: int = 512) -> int:
    """读取有正数边界的配置；写错时保留可用默认值而不是让服务启动失败。"""
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return max(1, min(value, maximum))


#: 双入口（LAN + Tailscale）默认白名单；可用 LABSPACE_ALLOWED_HOSTS 覆盖。
DEFAULT_ALLOWED_HOSTS = "192.0.2.10,198.51.100.71,127.0.0.1,localhost"


@dataclass(frozen=True)
class Settings:
    # 会话
    session_secret: str = os.getenv("LABSPACE_SESSION_SECRET", "")
    session_hours: int = int(os.getenv("LABSPACE_SESSION_HOURS", "8"))
    cookie_name: str = os.getenv("LABSPACE_COOKIE_NAME", "labspace_session")
    csrf_cookie: str = os.getenv("LABSPACE_CSRF_COOKIE", "labspace_csrf")
    cookie_secure: bool = _bool("LABSPACE_COOKIE_SECURE", False)
    public_url: str = os.getenv("LABSPACE_PUBLIC_URL", "http://portal.lab.example").rstrip("/")

    # 入口主机白名单：X-Forwarded-Host / Host 只在这份名单内被采信，
    # 其余一律回落到 default_entry_host，避免拿伪造主机拼出站地址（SSRF）。
    allowed_hosts: tuple[str, ...] = tuple(
        _list("LABSPACE_ALLOWED_HOSTS", DEFAULT_ALLOWED_HOSTS)
    )
    default_entry_host: str = os.getenv("LABSPACE_DEFAULT_ENTRY_HOST", "192.0.2.10")

    # 端到端测试账号（逗号分隔）。这些账号会：跳过新手引导、不在巡检里算「真人」。
    # 为什么要专门标出来：Playwright 每个浏览器上下文都是新的，localStorage 里
    # 没有「已看过引导」的标记，于是每个用例都被引导层挡在前面点不动。
    # 与其让 28 个脚本各自去写 localStorage，不如让服务端告诉前端「这是测试账号」。
    e2e_accounts: tuple[str, ...] = tuple(x.lower() for x in _list("LABSPACE_E2E_ACCOUNTS", ""))

    # 数据库
    db_dsn: str = os.getenv("LABSPACE_DB_DSN", "")
    # 门户库连接池：单 worker + 异步接口 + 线程池阻塞查询。
    # PostgreSQL max_connections=100，门户与账号库合计默认 36，留给 AgentScope/Baserow 等余量。
    db_pool_min: int = _positive_int("LABSPACE_DB_POOL_MIN", 4, 32)
    db_pool_max: int = _positive_int("LABSPACE_DB_POOL_MAX", 24, 48)
    account_db_pool_max: int = _positive_int("LABSPACE_ACCOUNT_DB_POOL_MAX", 12, 24)
    # FastAPI 同步端点线程池；提高 I/O 并发，但不启用多 worker，保留内存限流与 SSE 状态。
    threadpool_tokens: int = _positive_int("LABSPACE_THREADPOOL_TOKENS", 64, 128)
    # 每个出站 AsyncClient 的连接上限；只影响单客户端，不代表全局连接数。
    http_max_connections: int = _positive_int("LABSPACE_HTTP_MAX_CONNECTIONS", 128, 512)
    http_keepalive_connections: int = _positive_int("LABSPACE_HTTP_KEEPALIVE_CONNECTIONS", 32, 128)

    # 账号数据库（沿用原 Casdoor PostgreSQL 库；Casdoor 容器已下线，数据保留）
    casdoor_db_host: str = os.getenv("CASDOOR_DB_HOST", "lab-postgres")
    casdoor_db_port: int = int(os.getenv("CASDOOR_DB_PORT", "5432"))
    casdoor_db_name: str = os.getenv("CASDOOR_DB_NAME", "casdoor")
    casdoor_db_user: str = os.getenv("CASDOOR_DB_USER", "")
    casdoor_db_password: str = os.getenv("CASDOOR_DB_PASSWORD", "")

    # 角色
    # 管理员分两级：
    #   * lab-admin        平台管理员 —— 管业务（账号、用户组、公告、Agent 配置、备份、共享目录）
    #   * lab-superadmin   系统管理员 —— 在平台管理员之上，额外管**平台级**操作：
    #                       服务状态、运维任务、调试与诊断、全局配置与密钥
    # 分层的理由：出故障时需要能"重启服务、看日志、清缓存"的人，
    # 但这类能力不该和"改谁是什么角色"混在同一个账号里 —— 后者一旦被滥用
    # 会直接影响实验室的权限结构。系统管理员应由少数人持有。
    admin_roles: list[str] = field(default_factory=lambda: _list("LABSPACE_ADMIN_ROLES", "lab-admin"))
    superadmin_roles: list[str] = field(
        default_factory=lambda: _list("LABSPACE_SUPERADMIN_ROLES", "lab-superadmin")
    )
    teacher_roles: list[str] = field(default_factory=lambda: _list("LABSPACE_TEACHER_ROLES", "lab-teacher"))

    # 文件根目录（受控保存）
    users_root: str = os.getenv("LABSPACE_USERS_ROOT", "/srv/lab/users")
    max_upload_bytes: int = int(os.getenv("LABSPACE_MAX_UPLOAD_BYTES", str(2 * 1024 * 1024)))

    # 允许的前端来源（CSRF 之外的第二道校验）
    allowed_origins: list[str] = field(default_factory=lambda: _list("LABSPACE_ALLOWED_ORIGINS", "http://portal.lab.example,http://127.0.0.1,http://localhost"))

    # 服务健康检查开关
    enable_health: bool = _bool("LABSPACE_ENABLE_HEALTH", True)
    health_ttl: int = int(os.getenv("LABSPACE_HEALTH_TTL", "30"))

    # Go 核心（LabGo）：服务目录、健康检查、内嵌探测的权威实现
    labgo_base: str = os.getenv("LABSPACE_LABGO_BASE", "http://172.28.0.1:8122").rstrip("/")
    # AgentScope Agent Service（独立容器，只绑回环，经 docker 网桥访问）。
    # 门户只做鉴权与事件翻译，不重复实现它的会话/知识库/工具栈。
    agentscope_base: str = os.getenv("LABSPACE_AGENTSCOPE_BASE", "http://agentscope:8100").rstrip("/")
    # 平台级模型凭据（AgentScope 用）。管理员在「管理端 → Agent」里配置优先；
    # 没有配置时回落到这里，避免新用户第一次打开助手就 502。
    agent_model_base: str = os.getenv("LABSPACE_AGENT_MODEL_BASE", "").rstrip("/")
    agent_model_key: str = os.getenv("LABSPACE_AGENT_MODEL_KEY", "")
    agent_model_name: str = os.getenv("LABSPACE_AGENT_MODEL", "")

    # 知识库 RAG（宿主机 FlashRAG 服务，仅监听 docker 网桥地址）
    rag_base: str = os.getenv("LABSPACE_RAG_BASE", "http://172.28.0.1:8112").rstrip("/")
    rag_token: str = os.getenv("LABSPACE_RAG_TOKEN", "")
    tika_url: str = os.getenv("LABSPACE_TIKA_URL", "http://lab-tika:9998").rstrip("/")

    # LaTeX 编译（独立 sidecar，接收源码、返回 PDF，不接触门户数据卷）
    latex_worker: str = os.getenv("LABSPACE_LATEX_WORKER", "http://latex-compile:8131").rstrip("/")
    # 生信工具独立服务：科学计算依赖太重，单独成容器，门户只做代理
    biotools_url: str = os.getenv("LABSPACE_BIOTOOLS_URL", "http://biotools:8133").rstrip("/")
    latex_root: str = os.getenv("LABSPACE_LATEX_ROOT", "/srv/labdata/latex")
    latex_timeout: int = int(os.getenv("LABSPACE_LATEX_TIMEOUT", "120"))

    # 旧 pi 网关兼容配置（运行时默认走 AgentScope；仅为旧客户端显式选择保留）。
    agent_gateway: str = os.getenv("LABSPACE_AGENT_GATEWAY", "http://172.28.0.1:8110").rstrip("/")
    agent_token: str = os.getenv("LABSPACE_AGENT_TOKEN", "")
    agent_default_model: str = os.getenv("LABSPACE_AGENT_DEFAULT_MODEL", "minimax-cn/MiniMax-M3.1-Flash")
    agent_stream_timeout: int = int(os.getenv("LABSPACE_AGENT_STREAM_TIMEOUT", "600"))
    # SiliconFlow SystemOne 快速决策模型（未配置密钥时自动降级为本地规则）
    siliconflow_base: str = os.getenv("LABSPACE_SILICONFLOW_BASE", "https://api.siliconflow.cn").rstrip("/")
    siliconflow_key: str = os.getenv("LABSPACE_SILICONFLOW_KEY", "")
    systemone_model: str = os.getenv("LABSPACE_SYSTEMONE_MODEL", "Kev-4b")
    # 内部服务令牌（MCP 工具等可信内部调用使用 X-Lab-Service-Token 头）
    service_token: str = os.getenv("LABSPACE_SERVICE_TOKEN", "")
    # 宿主机运维服务（兼容旧配置；lab-oidc-sync 已下线，当前仅 restic 快照删除使用）。
    # 只用于必须在本机 root 环境执行的动作（目前是 restic 快照删除）。
    oidc_sync_url: str = os.getenv("LABSPACE_OIDC_SYNC_URL", "").rstrip("/")
    # Baserow 数据表（容器内网地址；管理员凭据仅从 600 权限文件读取）
    baserow_url: str = os.getenv("LABSPACE_BASEROW_URL", "http://lab-baserow").rstrip("/")
    baserow_host: str = os.getenv("LABSPACE_BASEROW_HOST", "192.0.2.10:8094")
    baserow_admin_file: str = os.getenv("LABSPACE_BASEROW_ADMIN_FILE", "/etc/labspace/baserow-admin.txt")


settings = Settings()
