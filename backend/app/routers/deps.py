"""路由模块共用的请求辅助函数。

这些函数原本住在 main.py 里。拆路由时必须先搬出来，否则 routers/* 反过来
`import app.main` 会形成循环依赖（main → routers → main）。
"""
from __future__ import annotations

import re

from fastapi import Request

from ..config import settings

#: 用户/文件名里允许出现的字符（中英文、数字、点、下划线、连字符）
SAFE_NAME = re.compile(r"[^A-Za-z0-9._\-一-鿿]+")


def safe_component(name: str, fallback: str = "user") -> str:
    name = (name or "").strip().replace("/", "-")
    name = SAFE_NAME.sub("-", name).strip("-.")
    return name[:64] or fallback


def host_allowed(host: str) -> bool:
    """入口主机是否在白名单内。

    只采信 ``LABSPACE_ALLOWED_HOSTS`` 里的主机名：门户应用统一走同源路径，
    合法入口就那几个 IP / localhost，没必要把任意 Host 当成可拼接入站地址的输入。
    白名单为空（未配置）时退回“只认默认入口主机”，宁严不宽。
    """
    h = (host or "").lower().strip().strip(".")
    if not h:
        return False
    allowed = tuple(x.lower().strip() for x in settings.allowed_hosts) or (
        settings.default_entry_host.lower(),
    )
    return h in allowed


def client_host(request: Request) -> str:
    """用户当前实际访问的主机名（不含端口）。

    用于“服务地址自适应”：从 192.0.2.10 进来就给出 192.0.2.10 的服务地址，
    从 Tailscale IP 进来就给出 Tailscale IP 的服务地址。

    只采信白名单内的主机：``X-Forwarded-Host`` / ``Host`` 是客户端可控的头，
    未经校验就拼进后续出站 URL 会变成 SSRF（比如伪造 ``169.254.169.254``）。
    非法值一律回落到默认入口主机。
    """
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    name = host.split(":")[0].strip()
    if host_allowed(name):
        return name
    return settings.default_entry_host
