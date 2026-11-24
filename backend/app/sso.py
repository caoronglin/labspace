"""一键登录（SSO）兼容入口。

Casdoor 与旧 OIDC 同步服务已下线；当前没有需要宿主机级切换的第三方服务。
保留 /api/sso/status 与 /api/sso/{id}/prepare 供旧客户端探测，未知服务返回 404。
"""
from __future__ import annotations

import ipaddress
import os
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from .security import require_user

router = APIRouter(prefix="/api/sso", tags=["sso"])

SYNC_URL = os.getenv("LABSPACE_OIDC_SYNC_URL", "http://172.28.0.1:8111").rstrip("/")
SYNC_TOKEN = os.getenv("LABSPACE_OPS_TOKEN", "")

# 服务 id -> (端口, 登录路径)。当前没有需要宿主机级 OIDC 同步的服务；
# 保留空映射让 /api/sso/{id}/prepare 对任何 id 都返回 404。
SERVICES: dict[str, tuple[int, str]] = {}

LAN_HOST = os.getenv("LABSPACE_LAN_HOST", "192.0.2.10")
TS_HOST = os.getenv("LABSPACE_TAILSCALE_HOST", "198.51.100.71")
TS_NET = ipaddress.ip_network("100.64.0.0/10")

# 自动跟随的节流：两次自动切换之间至少间隔这么久（秒）
AUTO_MIN_INTERVAL = float(os.getenv("LABSPACE_SSO_AUTO_INTERVAL", "90"))
_auto_state = {"host": "", "at": 0.0, "last_error": "", "last_seen_ip": "", "last_seen_host": ""}


def _client_host(request: Request) -> str:
    raw = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    return raw.split(":")[0].strip()


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for") or ""
    if fwd:
        return fwd.split(",")[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return ""


def desired_host(client_ip: str) -> str:
    """按客户端 IP 判断它应当使用哪个入口主机。"""
    try:
        addr = ipaddress.ip_address(client_ip)
    except ValueError:
        return LAN_HOST
    if addr in TS_NET:
        return TS_HOST
    return LAN_HOST


async def _call_sync(payload: dict) -> dict:
    token = _sync_token()
    if not token:
        raise HTTPException(status_code=503, detail="OIDC 自适应服务未配置令牌")
    try:
        async with httpx.AsyncClient(timeout=200.0) as client:
            resp = await client.post(
                f"{SYNC_URL}/sync", json=payload, headers={"X-Ops-Token": token}
            )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=503, detail=f"OIDC 自适应服务不可用：{type(exc).__name__}"
        ) from exc
    data = resp.json() if resp.content else {}
    if not data.get("ok"):
        raise HTTPException(status_code=503, detail=data.get("error") or "切换失败")
    return data


async def ensure_auto(client_ip: str) -> dict:
    """按客户端网段自动把第三方服务的 OIDC issuer 切到对应主机（带节流）。"""
    want = desired_host(client_ip)
    now = time.time()
    if _auto_state["host"] == want:
        return {"host": want, "changed": False, "skipped": "同一网段"}
    if now - _auto_state["at"] < AUTO_MIN_INTERVAL:
        return {"host": _auto_state["host"], "changed": False, "skipped": "节流"}
    # 先占位，避免并发请求重复触发容器重建
    _auto_state["host"] = want
    _auto_state["at"] = now
    try:
        data = await _call_sync({"service": "all", "host": want})
    except HTTPException as exc:
        _auto_state["last_error"] = str(exc.detail)
        _auto_state["host"] = ""
        return {"host": want, "changed": False, "error": str(exc.detail)}
    _auto_state["last_error"] = ""
    return {"host": want, "changed": bool(data.get("changed")), "detail": data.get("results")}


def _sync_token() -> str:
    if SYNC_TOKEN:
        return SYNC_TOKEN
    try:
        import json
        from pathlib import Path

        cfg = json.loads(Path("/etc/labspace/oidc-sync.json").read_text(encoding="utf-8"))
        return str(cfg.get("token", ""))
    except Exception:  # noqa: BLE001
        return ""


@router.get("/status")
async def sso_status(request: Request, user: dict = Depends(require_user)) -> dict:
    """返回当前入口主机与各服务的一键登录目标。"""
    host = _client_host(request)
    items = []
    for sid, (port, path) in SERVICES.items():
        items.append(
            {
                "id": sid,
                "host": host,
                "loginUrl": f"http://{host}:{port}{path}",
                "prepareUrl": f"/api/sso/{sid}/prepare",
            }
        )
    return {
        "host": host,
        "clientIp": _client_ip(request),
        "desiredHost": desired_host(_client_ip(request)),
        "auto": {
            "host": _auto_state["host"],
            "at": _auto_state["at"],
            "lastError": _auto_state["last_error"],
            "lastSeenIp": _auto_state.get("last_seen_ip", ""),
            "lastSeenHost": _auto_state.get("last_seen_host", ""),
        },
        "syncAvailable": bool(_sync_token()),
        "items": items,
    }


@router.get("/{service_id}/prepare")
async def sso_prepare(
    service_id: str, request: Request, user: dict = Depends(require_user)
) -> dict:
    """把目标服务的 OIDC 配置切到当前入口主机，并返回登录地址。"""
    if service_id not in SERVICES:
        raise HTTPException(status_code=404, detail=f"不支持的服务: {service_id}")
    host = _client_host(request)
    if not host:
        raise HTTPException(status_code=400, detail="无法识别访问主机")
    port, _path = SERVICES[service_id]
    payload = {"service": service_id, "host": host}
    data = await _call_sync(payload)
    _auto_state["host"] = host
    _auto_state["at"] = time.time()
    login_url = data.get("loginUrl") or f"http://{host}:{port}/"
    return {
        "ready": True,
        "service": service_id,
        "host": host,
        "changed": bool(data.get("changed")),
        "issuer": data.get("issuer"),
        "redirectUri": data.get("redirectUri"),
        "loginUrl": login_url,
    }
