"""BUG-02：直连旁路服务（/pdf-api/、/mail/、AgentScope）的鉴权关口。

这些路径不经过 FastAPI 业务代码，nginx 的 ``auth_request`` 子请求是它们能看到的
全部鉴权。修复前 ``/api/auth/check`` 被列进改密豁免名单，于是「必须先改初始口令」
在 Python 路由上生效、在代理路径上完全不生效 —— 也就是后门。
"""
from __future__ import annotations

import pytest
from starlette.requests import Request

from app import main as main_mod
from app.routers.auth import api_auth_check  # 路由已迁出 main


def _request(path: str = "/api/auth/check", headers: dict[str, str] | None = None) -> Request:
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    scope = {
        "type": "http",
        "method": "GET",
        "path": path,
        "headers": raw,
        "query_string": b"",
        "scheme": "http",
        "server": ("127.0.0.1", 80),
        "client": ("127.0.0.1", 54321),
    }
    return Request(scope)


@pytest.mark.asyncio
async def test_flagged_session_blocked_for_proxied_service() -> None:
    """未改密会话访问 /pdf-api/（经 X-Original-URI）→ 403，不是 204。"""
    req = _request(headers={"x-original-uri": "/pdf-api/general/merge-pdfs"})
    resp = await api_auth_check(req, {"sub": "u1", "email": "student09@local", "pwd_reset": True})
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_flagged_session_allowed_for_password_change() -> None:
    """改密与探活本身不能被拦，否则用户被锁死。"""
    for path in ("/api/me", "/api/me/password", "/api/auth/logout", "/mail/"):
        req = _request(headers={"x-original-uri": path})
        resp = await api_auth_check(
            req, {"sub": "u1", "email": "student09@local", "pwd_reset": True}
        )
        assert resp.status_code == (204 if path != "/mail/" else 403), path


@pytest.mark.asyncio
async def test_normal_session_passes() -> None:
    req = _request(headers={"x-original-uri": "/pdf-api/general/merge-pdfs"})
    resp = await api_auth_check(req, {"sub": "u1", "email": "student01@local"})
    assert resp.status_code == 204
    assert resp.headers["x-auth-user"] == "u1"


@pytest.mark.asyncio
async def test_write_method_requires_csrf() -> None:
    """子请求带原始方法：非幂等且无 CSRF 双提交 → 403。"""
    req = _request(
        headers={
            "x-original-uri": "/mail/v1/send",
            "x-original-method": "POST",
        }
    )
    with pytest.raises(Exception) as exc:  # HTTPException(403)
        await api_auth_check(req, {"sub": "u1", "email": "student01@local"})
    assert "403" in str(exc.value) or getattr(exc.value, "status_code", None) == 403


@pytest.mark.asyncio
async def test_read_method_skips_csrf() -> None:
    """读请求不要求 CSRF，否则所有 GET 页面都会被判 403。"""
    req = _request(headers={"x-original-uri": "/mail/v1/inbox", "x-original-method": "GET"})
    resp = await api_auth_check(req, {"sub": "u1", "email": "student01@local"})
    assert resp.status_code == 204
