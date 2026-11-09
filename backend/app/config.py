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


@dataclass(frozen=True)
class Settings:
    # OIDC / Casdoor
    issuer: str = os.getenv("LABSPACE_ISSUER", "http://auth.lab.example").rstrip("/")
    # Casdoor 对外端口（IP 专属端口，授权地址不含域名）
    casdoor_port: int = int(os.getenv("LABSPACE_CASDOOR_PORT", "8090"))
    client_id: str = os.getenv("LABSPACE_CLIENT_ID", "")
    client_secret: str = os.getenv("LABSPACE_CLIENT_SECRET", "")
    redirect_uri: str = os.getenv("LABSPACE_REDIRECT_URI", "http://portal.lab.example/api/auth/callback")
    scopes: str = os.getenv("LABSPACE_SCOPES", "openid email profile groups")

    # 会话
    session_secret: str = os.getenv("LABSPACE_SESSION_SECRET", "")
    session_hours: int = int(os.getenv("LABSPACE_SESSION_HOURS", "8"))
    cookie_name: str = os.getenv("LABSPACE_COOKIE_NAME", "labspace_session")
    csrf_cookie: str = os.getenv("LABSPACE_CSRF_COOKIE", "labspace_csrf")
    cookie_secure: bool = _bool("LABSPACE_COOKIE_SECURE", False)
    public_url: str = os.getenv("LABSPACE_PUBLIC_URL", "http://portal.lab.example").rstrip("/")

    # 数据库
    db_dsn: str = os.getenv("LABSPACE_DB_DSN", "")

    # Casdoor 数据库（统一账号管理：仅管理员 API 使用的受控读写）
    casdoor_db_host: str = os.getenv("CASDOOR_DB_HOST", "lab-postgres")
    casdoor_db_port: int = int(os.getenv("CASDOOR_DB_PORT", "5432"))
    casdoor_db_name: str = os.getenv("CASDOOR_DB_NAME", "casdoor")
    casdoor_db_user: str = os.getenv("CASDOOR_DB_USER", "")
    casdoor_db_password: str = os.getenv("CASDOOR_DB_PASSWORD", "")

    # 角色
    admin_roles: list[str] = field(default_factory=lambda: _list("LABSPACE_ADMIN_ROLES", "lab-admin"))
    teacher_roles: list[str] = field(default_factory=lambda: _list("LABSPACE_TEACHER_ROLES", "lab-teacher"))

    # 文件根目录（受控保存）
    users_root: str = os.getenv("LABSPACE_USERS_ROOT", "/srv/lab/users")
    max_upload_bytes: int = int(os.getenv("LABSPACE_MAX_UPLOAD_BYTES", str(2 * 1024 * 1024)))

    # 允许的前端来源（CSRF 之外的第二道校验）
    allowed_origins: list[str] = field(default_factory=lambda: _list("LABSPACE_ALLOWED_ORIGINS", "http://portal.lab.example"))

    # 服务健康检查开关
    enable_health: bool = _bool("LABSPACE_ENABLE_HEALTH", True)
    health_ttl: int = int(os.getenv("LABSPACE_HEALTH_TTL", "30"))

    # Go 核心（LabGo）：服务目录、健康检查、内嵌探测的权威实现
    labgo_base: str = os.getenv("LABSPACE_LABGO_BASE", "http://172.28.0.1:8122").rstrip("/")

    # 知识库 RAG（宿主机 FlashRAG 服务，仅监听 docker 网桥地址）
    rag_base: str = os.getenv("LABSPACE_RAG_BASE", "http://172.28.0.1:8112").rstrip("/")
    rag_token: str = os.getenv("LABSPACE_RAG_TOKEN", "")
    tika_url: str = os.getenv("LABSPACE_TIKA_URL", "http://lab-tika:9998").rstrip("/")

    # LaTeX 编译（独立 sidecar，接收源码、返回 PDF，不接触门户数据卷）
    latex_worker: str = os.getenv("LABSPACE_LATEX_WORKER", "http://latex-compile:8131").rstrip("/")
    latex_root: str = os.getenv("LABSPACE_LATEX_ROOT", "/srv/labdata/latex")
    latex_timeout: int = int(os.getenv("LABSPACE_LATEX_TIMEOUT", "120"))

    # Agent 助手（宿主机 pi RPC 网关，仅监听 docker 网桥地址）
    agent_gateway: str = os.getenv("LABSPACE_AGENT_GATEWAY", "http://172.28.0.1:8110").rstrip("/")
    agent_token: str = os.getenv("LABSPACE_AGENT_TOKEN", "")
    agent_default_model: str = os.getenv("LABSPACE_AGENT_DEFAULT_MODEL", "minimax-cn/MiniMax-M3.1-Flash")
    agent_stream_timeout: int = int(os.getenv("LABSPACE_AGENT_STREAM_TIMEOUT", "600"))
    # SiliconFlow SystemOne 快速决策模型（未配置密钥时自动降级为本地规则）
    siliconflow_base: str = os.getenv("LABSPACE_SILICONFLOW_BASE", "https://api.siliconflow.cn").rstrip("/")
    siliconflow_key: str = os.getenv("LABSPACE_SILICONFLOW_KEY", "")
    systemone_model: str = os.getenv("LABSPACE_SYSTEMONE_MODEL", "Kev-4b")
    # 内部服务令牌（pi 插件等可信内部调用使用 X-Lab-Service-Token 头）
    service_token: str = os.getenv("LABSPACE_SERVICE_TOKEN", "")
    # Baserow 数据表（容器内网地址；管理员凭据仅从 600 权限文件读取）
    baserow_url: str = os.getenv("LABSPACE_BASEROW_URL", "http://lab-baserow").rstrip("/")
    baserow_host: str = os.getenv("LABSPACE_BASEROW_HOST", "192.0.2.10:8094")
    baserow_admin_file: str = os.getenv("LABSPACE_BASEROW_ADMIN_FILE", "/etc/labspace/baserow-admin.txt")


settings = Settings()
