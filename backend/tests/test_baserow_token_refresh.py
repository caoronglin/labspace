"""数据表令牌刷新：过期令牌必须真的被换掉。

回归的是一类很难复现的线上故障：账号在「多维表格 / 种子台账」停留 20 分钟后
所有请求开始 401（`ERROR_INVALID_ACCESS_TOKEN`），刷新页面也不好。

原因是 `_token(force=True)` 按**门户邮箱**（`x@local`）清缓存，而 `_user_token`
按**数据表身份**（`x@labspace.local`，因为 Baserow 不接受 `@local`）写缓存。
两者不是同一个键，于是“刷新”拿回的仍是那个过期令牌，401 一路抛给前端。

这里不打真实 Baserow：上游用 httpx.MockTransport 打桩，只断言
「过期令牌只被拒绝一次，第二次请求带的是登录换来的新令牌」。
"""
from __future__ import annotations

import time
from typing import Any

import httpx
import pytest

from app import baserow as baserow_mod
from app import db

#: 会话里的门户账号（Baserow 不接受这种邮箱）。
PORTAL_EMAIL = "stu01@local"
#: 真正写进 baserow_accounts 的数据表身份。
BASEROW_EMAIL = "stu01@labspace.local"
STALE = "stale-token"
FRESH = "fresh-token"


@pytest.fixture()
def fake_upstream(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """上游桩：只有 FRESH 能通过；记录每次请求带的令牌。"""
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        auth = request.headers.get("Authorization", "")
        token = auth.removeprefix("JWT ").strip()
        seen.append(token)
        if request.url.path == "/api/user/token-auth/":
            return httpx.Response(200, json={"token": FRESH})
        if token != FRESH:
            return httpx.Response(
                401,
                json={"error": "ERROR_INVALID_ACCESS_TOKEN", "detail": "Access token is expired or invalid."},
            )
        return httpx.Response(200, json={"ok": True})

    monkeypatch.setattr(
        baserow_mod,
        "_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    # 让 DB 与解密都走桩：这里只关心缓存键的行为。
    monkeypatch.setattr(db, "query", lambda *a, **k: [{"secret": "enc"}])
    monkeypatch.setattr(
        baserow_mod,
        "_fernet",
        lambda: type("F", (), {"decrypt": staticmethod(lambda raw: b"pw")})(),
    )
    return seen


def _user() -> dict[str, Any]:
    return {"sub": "u1", "email": PORTAL_EMAIL, "name": "张三", "roles": ["lab-student"]}


def test_refresh_clears_the_right_cache_key(fake_upstream: list[str], monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    # 模拟“令牌已经过期，但缓存还没到点”的真实状态。
    baserow_mod._user_cache.clear()
    baserow_mod._user_cache[BASEROW_EMAIL] = (STALE, time.time())

    payload = asyncio.run(baserow_mod._call("GET", "/api/workspaces/", _user()))
    assert payload == {"ok": True}
    # 头部必须是重新登录换来的新令牌，不能是缓存里那个过期的。
    assert fake_upstream[-1] == FRESH, fake_upstream
    # 缓存也要更新成新令牌，否则下一次请求又要重试一次。
    assert baserow_mod._user_cache[BASEROW_EMAIL][0] == FRESH
    # 端口邮箱不该被当成缓存键（写错键正是这起故障的根因）。
    assert PORTAL_EMAIL not in baserow_mod._user_cache


def test_account_email_maps_invalid_domains() -> None:
    assert baserow_mod._account_email({"email": PORTAL_EMAIL}) == BASEROW_EMAIL
    # 真邮箱原样使用，不能给外部邮箱加个假域名。
    assert baserow_mod._account_email({"email": "a@b.com"}) == "a@b.com"
