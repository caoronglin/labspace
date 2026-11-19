"""AgentScope 能力代理：白名单、身份覆盖、状态码透传、路径防护。

不连真实 AgentScope：用 ``httpx.MockTransport`` 打桩上游，只断言「门户这一侧
的行为」——出站地址、身份头、状态码、请求体。
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
import jwt
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import agentscope_router, db, main
from app.config import settings

CSRF = "csrf-token-for-test"
SUB = "u1"

EXPECTED_GROUPS = frozenset(
    {
        "agent",
        "channels",
        "credential",
        "hub",
        "knowledge_bases",
        "mcp",
        "schedule",
        "sessions",
        "skill",
        "sop",
        "workspace",
        "embedding-model",
        "model",
        "tts-model",
        "realtime",
    }
)
"""文档里承诺暴露给前端的能力组。"""


@dataclass
class Upstream:
    """打桩的上游：记录收到的请求，并按需返回指定状态码。"""

    requests: list[httpx.Request] = field(default_factory=list)
    status: int = 200
    payload: Any = field(default_factory=lambda: {"ok": True})
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes | None = None


@pytest.fixture()
def upstream(monkeypatch: pytest.MonkeyPatch) -> Upstream:
    stub = Upstream()

    def handler(request: httpx.Request) -> httpx.Response:
        stub.requests.append(request)
        if stub.body is not None:
            return httpx.Response(stub.status, content=stub.body, headers=stub.headers)
        return httpx.Response(stub.status, json=stub.payload, headers=stub.headers)

    def fake_build_client(timeout: httpx.Timeout) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=timeout, transport=httpx.MockTransport(handler))

    monkeypatch.setattr(agentscope_router, "_build_client", fake_build_client)
    # 会话吊销检查要查库；这里直接打成「未吊销」，不连 PostgreSQL。
    monkeypatch.setattr(db, "revoked_before", lambda subject: None)
    return stub


@pytest.fixture()
def client() -> TestClient:
    return TestClient(main.app)


@pytest.fixture()
def cookies() -> dict[str, str]:
    token = jwt.encode(
        {"sub": SUB, "email": "a@b.c", "name": "木林森", "roles": [], "exp": int(time.time()) + 3600},
        settings.session_secret,
        algorithm="HS256",
    )
    # 双提交 CSRF：Cookie 与请求头必须一致
    return {"labspace_session": token, settings.csrf_cookie: CSRF}


def write_headers() -> dict[str, str]:
    return {"X-CSRF-Token": CSRF, "Origin": settings.allowed_origins[0]}


# ------------------------------------------------------------------ 白名单


def test_whitelist_is_exactly_the_documented_groups() -> None:
    """白名单是显式清单：多一个少一个都会改变暴露面，必须有人明确决定。"""
    assert agentscope_router.ALLOWED_GROUPS == EXPECTED_GROUPS


@pytest.mark.parametrize("group", ["chat", "health", "openapi.json", "..", "AGENT"])
def test_group_outside_whitelist_returns_404(
    client: TestClient, cookies: dict[str, str], upstream: Upstream, group: str
) -> None:
    resp = client.get(f"/api/agent/as/{group}", cookies=cookies)
    assert resp.status_code == 404, resp.text
    # 白名单外的组连上游都不该碰到
    assert upstream.requests == []


def test_whitelisted_group_is_forwarded(client: TestClient, cookies: dict[str, str], upstream: Upstream) -> None:
    resp = client.get("/api/agent/as/agent", cookies=cookies)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True}
    assert len(upstream.requests) == 1
    assert upstream.requests[0].method == "GET"
    assert upstream.requests[0].url.path == "/agent/"
    assert upstream.requests[0].url.host == "agentscope"
    assert upstream.requests[0].url.port == 8100


def test_sub_path_and_query_are_forwarded(
    client: TestClient, cookies: dict[str, str], upstream: Upstream
) -> None:
    resp = client.get("/api/agent/as/sessions/s1/messages?agent_id=a1&x=1&x=2", cookies=cookies)
    assert resp.status_code == 200, resp.text
    sent = upstream.requests[0]
    assert sent.url.path == "/sessions/s1/messages"
    assert sent.url.params.get_list("x") == ["1", "2"]
    assert sent.url.params["agent_id"] == "a1"


# ------------------------------------------------------------------ 身份


def test_user_id_header_is_overridden(client: TestClient, cookies: dict[str, str], upstream: Upstream) -> None:
    """客户端伪造的 X-User-ID 不生效：出站头永远取门户会话的 sub。"""
    resp = client.get(
        "/api/agent/as/agent",
        cookies=cookies,
        headers={"X-User-ID": "somebody-else"},
    )
    assert resp.status_code == 200, resp.text
    assert upstream.requests[0].headers["X-User-ID"] == SUB


def test_client_authorization_is_not_forwarded(
    client: TestClient, cookies: dict[str, str], upstream: Upstream
) -> None:
    resp = client.get(
        "/api/agent/as/agent",
        cookies=cookies,
        headers={"Authorization": "Bearer leaked-token"},
    )
    assert resp.status_code == 200, resp.text
    assert "authorization" not in upstream.requests[0].headers


def test_proxy_requires_login(client: TestClient, upstream: Upstream) -> None:
    resp = client.get("/api/agent/as/agent")
    assert resp.status_code == 401
    assert upstream.requests == []


# ------------------------------------------------------------------ 状态码


def test_upstream_400_is_passed_through(client: TestClient, cookies: dict[str, str], upstream: Upstream) -> None:
    upstream.status = 400
    upstream.payload = {"detail": "invalid_request: agent_id 缺失"}
    resp = client.get("/api/agent/as/sessions", cookies=cookies)
    assert resp.status_code == 400, resp.text
    assert resp.json() == {"detail": "invalid_request: agent_id 缺失"}


def test_upstream_500_is_passed_through(client: TestClient, cookies: dict[str, str], upstream: Upstream) -> None:
    upstream.status = 503
    upstream.payload = {"detail": "model unavailable"}
    resp = client.get("/api/agent/as/model", cookies=cookies)
    assert resp.status_code == 503, resp.text
    assert resp.json() == {"detail": "model unavailable"}


# ------------------------------------------------------------------ 路径防护


def test_path_with_parent_segments_is_rejected(
    client: TestClient, cookies: dict[str, str], upstream: Upstream
) -> None:
    resp = client.get("/api/agent/as/sessions/%2e%2e/secret", cookies=cookies)
    assert resp.status_code == 400, resp.text
    assert upstream.requests == []


def test_path_with_backslash_traversal_is_rejected(
    client: TestClient, cookies: dict[str, str], upstream: Upstream
) -> None:
    resp = client.get("/api/agent/as/sessions/..%5Csecret", cookies=cookies)
    assert resp.status_code == 400, resp.text
    assert upstream.requests == []


@pytest.mark.parametrize("raw", ["../secret", "a/../b", "..\\secret", "..%2Fsecret", "x/.."])
def test_clean_path_rejects_parent_segments(raw: str) -> None:
    """路径清洗是最后一道闸：任何形态的 '..' 都不能进上游地址。"""
    with pytest.raises(HTTPException) as excinfo:
        agentscope_router._clean_path(raw)
    assert excinfo.value.status_code == 400


def test_proxy_target_is_always_the_agentscope_base(
    client: TestClient, cookies: dict[str, str], upstream: Upstream
) -> None:
    """客户端不能把代理指向别的地址（即便它伪造查询参数也不行）。"""
    resp = client.get(
        "/api/agent/as/agent?next=http://evil.example.com/x",
        cookies=cookies,
    )
    assert resp.status_code == 200, resp.text
    sent = upstream.requests[0]
    assert sent.url.host == "agentscope"
    assert sent.url.port == 8100


# ------------------------------------------------------------------ 写操作


def test_post_requires_csrf(client: TestClient, cookies: dict[str, str], upstream: Upstream) -> None:
    resp = client.post("/api/agent/as/sessions", cookies=cookies, json={"name": "x"})
    assert resp.status_code == 403, resp.text
    assert upstream.requests == []


def test_post_forwards_body_to_group_root(
    client: TestClient, cookies: dict[str, str], upstream: Upstream
) -> None:
    resp = client.post(
        "/api/agent/as/sessions",
        cookies=cookies,
        headers=write_headers(),
        json={"name": "新会话"},
    )
    assert resp.status_code == 200, resp.text
    sent = upstream.requests[0]
    assert sent.method == "POST"
    assert sent.url.path == "/sessions/"
    assert json.loads(sent.content) == {"name": "新会话"}
    assert sent.headers["content-type"].startswith("application/json")
    assert sent.headers["X-User-ID"] == SUB


def test_patch_and_delete_are_forwarded(client: TestClient, cookies: dict[str, str], upstream: Upstream) -> None:
    resp = client.patch(
        "/api/agent/as/sessions/s1",
        cookies=cookies,
        headers=write_headers(),
        json={"name": "改名"},
    )
    assert resp.status_code == 200, resp.text
    assert upstream.requests[0].method == "PATCH"
    assert upstream.requests[0].url.path == "/sessions/s1"

    resp = client.delete("/api/agent/as/sessions/s1", cookies=cookies, headers=write_headers())
    assert resp.status_code == 200, resp.text
    assert upstream.requests[1].method == "DELETE"
    assert upstream.requests[1].url.path == "/sessions/s1"


def test_oversized_body_is_rejected(client: TestClient, cookies: dict[str, str], upstream: Upstream) -> None:
    big = {"blob": "x" * (1024 * 1024 + 16)}
    resp = client.post("/api/agent/as/sessions", cookies=cookies, headers=write_headers(), json=big)
    assert resp.status_code == 413, resp.text
    assert upstream.requests == []


# ------------------------------------------------------------------ 原始 SSE


def test_raw_stream_forwards_agentscope_events(
    client: TestClient, cookies: dict[str, str], upstream: Upstream
) -> None:
    upstream.body = b'event: reply\ndata: {"type":"REPLY_START"}\n\n'
    upstream.headers = {"content-type": "text/event-stream"}
    with client.stream(
        "GET", "/api/agent/as/sessions/s1/stream?agent_id=a1", cookies=cookies
    ) as resp:
        assert resp.status_code == 200, resp.status_code
        text = "".join(resp.iter_text())
    assert "REPLY_START" in text
    sent = upstream.requests[0]
    assert sent.url.path == "/sessions/s1/stream"
    assert sent.url.params["agent_id"] == "a1"
    assert sent.headers["X-User-ID"] == SUB
    assert sent.headers["accept"] == "text/event-stream"
