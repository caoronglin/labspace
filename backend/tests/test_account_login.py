"""本地登录安全：一次性口令、审计与联合限流。"""
from __future__ import annotations

import json
import secrets

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app import accounts
from app.routers import auth


@pytest.fixture(autouse=True)
def clear_login_failures():
    auth._LOGIN_FAILS.clear()
    yield
    auth._LOGIN_FAILS.clear()


def _request(
    username: str = "alice",
    password: str | None = None,
    ip: str = "192.0.2.10",
) -> Request:
    body = json.dumps(
        {"username": username, "password": password or f"wrong-{secrets.token_urlsafe(8)}"}
    ).encode()

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/auth/login-direct",
            "headers": [(b"x-real-ip", ip.encode()), (b"x-forwarded-for", b"203.0.113.99")],
            "query_string": b"",
            "scheme": "http",
            "server": ("127.0.0.1", 80),
            "client": ("127.0.0.1", 1234),
        },
        receive,
    )


def test_one_time_passwords_are_strong_and_unique():
    values = {accounts.generate_one_time_password() for _ in range(20)}
    assert len(values) == 20
    for value in values:
        assert len(value) == 16
        assert any(c.islower() for c in value)
        assert any(c.isupper() for c in value)
        assert any(c.isdigit() for c in value)
        assert any(not c.isalnum() for c in value)


def test_client_ip_prefers_proxy_written_real_ip():
    request = _request(ip="192.0.2.10")
    assert auth._client_ip(request) == "192.0.2.10"


def test_rate_limit_combines_account_and_source_ip():
    for _ in range(auth._LOGIN_MAX_FAILS):
        auth._login_failed("alice", "192.0.2.10")
    assert auth._login_locked("alice", "192.0.2.10") is True
    assert auth._login_locked("alice", "192.0.2.11") is False

    auth._LOGIN_FAILS.clear()
    for index in range(auth._LOGIN_IP_MAX_FAILS):
        auth._login_failed(f"user{index}", "192.0.2.20")
    assert auth._login_locked("fresh-user", "192.0.2.20") is True
    assert auth._login_locked("fresh-user", "192.0.2.21") is False


@pytest.mark.asyncio
async def test_successful_login_records_time_and_audit(monkeypatch: pytest.MonkeyPatch):
    row = {
        "id": "user-id-1",
        "name": "alice",
        "email": "alice@lab.local",
        "display_name": "Alice",
        "groups": ["lab-student"],
        "is_forbidden": False,
        "is_deleted": False,
    }
    calls: list[tuple] = []
    monkeypatch.setattr(accounts, "get_account", lambda _name: row)
    monkeypatch.setattr(accounts, "verify_password", lambda _name, _password: True)
    monkeypatch.setattr(accounts, "record_login", lambda name: calls.append(("login", name)))
    monkeypatch.setattr(auth.audit, "record", lambda *args: calls.append(("audit", args)))
    monkeypatch.setattr(auth, "issue_session", lambda *_args, **_kwargs: "token")
    monkeypatch.setattr(auth, "set_session_cookies", lambda *_args: None)

    async def no_change(_name: str) -> bool:
        return False

    monkeypatch.setattr(auth, "_must_change_now", no_change)
    response = await auth.api_login_direct(
        _request(password=f"correct-{secrets.token_urlsafe(8)}")
    )

    assert response.status_code == 200
    assert ("login", "alice") in calls
    assert any(item[0] == "audit" and item[1][1] == "auth.login.success" for item in calls)


@pytest.mark.asyncio
async def test_recent_login_write_failure_does_not_block_login(monkeypatch: pytest.MonkeyPatch):
    row = {
        "id": "user-id-1",
        "name": "alice",
        "email": "alice@lab.local",
        "display_name": "Alice",
        "groups": ["lab-student"],
        "is_forbidden": False,
        "is_deleted": False,
    }
    monkeypatch.setattr(accounts, "get_account", lambda _name: row)
    monkeypatch.setattr(accounts, "verify_password", lambda _name, _password: True)

    def fail_login_write(_name: str) -> None:
        raise RuntimeError("timestamp write failed")

    monkeypatch.setattr(accounts, "record_login", fail_login_write)
    monkeypatch.setattr(auth.audit, "record", lambda *_args: None)
    monkeypatch.setattr(auth, "issue_session", lambda *_args, **_kwargs: "token")
    monkeypatch.setattr(auth, "set_session_cookies", lambda *_args: None)

    async def no_change(_name: str) -> bool:
        return False

    monkeypatch.setattr(auth, "_must_change_now", no_change)
    response = await auth.api_login_direct(
        _request(password=f"correct-{secrets.token_urlsafe(8)}")
    )
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_failed_login_is_audited_without_account_enumeration(monkeypatch: pytest.MonkeyPatch):
    audits: list[tuple] = []
    monkeypatch.setattr(accounts, "get_account", lambda _name: None)
    monkeypatch.setattr(auth.audit, "record", lambda *args: audits.append(args))

    with pytest.raises(HTTPException) as exc:
        await auth.api_login_direct(_request(username="missing-user"))
    assert exc.value.status_code == 401
    assert exc.value.detail == "账号或口令不正确"
    assert audits[0][1] == "auth.login.failed"
    assert audits[0][4] == "192.0.2.10"


@pytest.mark.asyncio
async def test_locked_login_is_rejected_before_password_check(monkeypatch: pytest.MonkeyPatch):
    for _ in range(auth._LOGIN_MAX_FAILS):
        auth._login_failed("alice", "192.0.2.10")
    monkeypatch.setattr(accounts, "get_account", lambda _name: pytest.fail("locked login must not query account"))

    with pytest.raises(HTTPException) as exc:
        await auth.api_login_direct(_request())
    assert exc.value.status_code == 429
