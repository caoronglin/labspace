"""SSH 网关配置：只从部署环境读取秘密与内网目标范围。"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _required(name: str) -> str:
    value = (os.getenv(name) or "").strip()
    if not value:
        raise RuntimeError(f"{name} 未设置（应由 deploy/.env 注入）")
    return value


def _csv(name: str, default: str = "") -> tuple[str, ...]:
    return tuple(x.strip() for x in os.getenv(name, default).split(",") if x.strip())


def _int(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except TypeError, ValueError:
        return default
    return max(low, min(value, high))


@dataclass(frozen=True)
class Settings:
    db_dsn: str = _required("SSH_GATEWAY_DB_DSN")
    secret_key: str = _required("SSH_GATEWAY_SECRET_KEY")
    allowed_hosts: tuple[str, ...] = _csv("SSH_GATEWAY_ALLOWED_HOSTS")
    allowed_cidrs: tuple[str, ...] = _csv(
        "SSH_GATEWAY_ALLOWED_CIDRS",
        "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,100.64.0.0/10",
    )
    allowed_ports: tuple[int, ...] = tuple(
        int(x) for x in _csv("SSH_GATEWAY_ALLOWED_PORTS", "22") if x.isdigit()
    ) or (22,)
    max_sessions_per_user: int = _int("SSH_GATEWAY_MAX_SESSIONS_PER_USER", 2, 1, 8)
    max_sessions_global: int = _int("SSH_GATEWAY_MAX_SESSIONS_GLOBAL", 8, 1, 32)
    idle_timeout_seconds: int = _int("SSH_GATEWAY_IDLE_TIMEOUT", 1800, 300, 7200)
    connect_timeout_seconds: int = _int("SSH_GATEWAY_CONNECT_TIMEOUT", 12, 3, 60)
    connect_rate_per_minute: int = _int("SSH_GATEWAY_CONNECT_RATE_PER_MINUTE", 6, 1, 60)
    max_upload_bytes: int = _int(
        "SSH_GATEWAY_MAX_UPLOAD_BYTES",
        50 * 1024 * 1024,
        1024 * 1024,
        200 * 1024 * 1024,
    )
    max_preview_bytes: int = _int(
        "SSH_GATEWAY_MAX_PREVIEW_BYTES",
        256 * 1024,
        1024,
        2 * 1024 * 1024,
    )


settings = Settings()
