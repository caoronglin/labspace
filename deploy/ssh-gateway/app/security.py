"""SSH 网关的凭据加密、目标白名单和用户身份。"""

# FastAPI/cryptography 装在 deploy/ssh-gateway/.venv，Lens 根环境不加载该子 venv。
# pyright: reportMissingImports=false
from __future__ import annotations

import asyncio
import ipaddress
import json
import posixpath
import socket
from dataclasses import dataclass
from typing import Any

from cryptography.fernet import Fernet
from fastapi import HTTPException, Request

from .config import Settings


def _fernet(settings: Settings) -> Fernet:
    return Fernet(settings.secret_key.encode("ascii"))


def encrypt_secret(settings: Settings, payload: dict[str, Any]) -> bytes:
    return _fernet(settings).encrypt(json.dumps(payload, ensure_ascii=False).encode("utf-8"))


def decrypt_secret(settings: Settings, ciphertext: bytes) -> dict[str, Any]:
    try:
        value = json.loads(_fernet(settings).decrypt(bytes(ciphertext)).decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail="SSH 凭据解密失败，请联系管理员") from exc
    if not isinstance(value, dict):
        raise HTTPException(status_code=500, detail="SSH 凭据格式无效")
    return value


def current_user_id(request: Request) -> str:
    """只认 Nginx 会话校验后覆盖注入的头；服务本身不提供第二套登录。"""
    user_id = (request.headers.get("x-user-id") or "").strip()
    if not user_id:
        raise HTTPException(status_code=401, detail="缺少门户身份")
    return user_id


@dataclass(frozen=True)
class Target:
    host: str
    port: int
    addresses: tuple[str, ...]


def _ip_allowed(settings: Settings, ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if ip.is_unspecified or ip.is_multicast or ip.is_reserved or ip.is_link_local:
        return False
    if str(ip) in settings.allowed_hosts:
        return True
    for raw in settings.allowed_cidrs:
        try:
            if ip in ipaddress.ip_network(raw, strict=False):
                return True
        except ValueError:
            continue
    return False


async def validate_target(settings: Settings, host: str, port: int) -> Target:
    host = (host or "").strip()
    if not host or len(host) > 253 or any(ch in host for ch in "@/\\\x00\n\r"):
        raise HTTPException(status_code=400, detail="SSH 主机地址无效")
    if port not in settings.allowed_ports:
        raise HTTPException(status_code=400, detail=f"SSH 端口不在白名单内：{port}")
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        if not _ip_allowed(settings, literal):
            raise HTTPException(status_code=403, detail="目标 IP 不在内网白名单内")
        return Target(host=host, port=port, addresses=(str(literal),))

    # 域名必须解析到内网；显式配置的主机名也只是放行名字，不能绕过地址检查。
    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise HTTPException(status_code=400, detail="SSH 主机名无法解析") from exc
    addresses = sorted({str(info[4][0]) for info in infos})
    if not addresses:
        raise HTTPException(status_code=400, detail="SSH 主机名没有可用地址")
    for raw in addresses:
        try:
            ip = ipaddress.ip_address(raw)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="SSH 主机名解析结果无效") from exc
        if not _ip_allowed(settings, ip):
            raise HTTPException(status_code=403, detail="目标主机解析到非内网地址，已拒绝")
    return Target(host=host, port=port, addresses=tuple(addresses))


def normalize_remote_path(path: str | None) -> str:
    value = (path or ".").strip()
    if "\x00" in value or len(value) > 4096:
        raise HTTPException(status_code=400, detail="远程路径无效")
    return posixpath.normpath(value)
