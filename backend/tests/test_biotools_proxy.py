"""`/api/biotools/*` 代理层：鉴权、转发、原样回传。

生信计算跑在独立的 `biotools` 容器里（科学计算依赖太重），门户后端只做代理。
这一层是**唯一**的鉴权点：内网那台不做鉴权、也不暴露宿主端口。
所以这里断言三件事：

1. 没登录 → 401，且**不会**打到上游；
2. 转发时 method / query / body / Content-Type 都原样过去（含 multipart 上传）；
3. 上游挂了 → 503 + 中文提示，不把 httpx 异常抛给浏览器。

不打真实上游：用 `httpx.MockTransport` 拦截。
"""
from __future__ import annotations

import time
from typing import Any

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient

from app import biotools_proxy, main
from app.config import settings


@pytest.fixture()
def client() -> TestClient:
    return TestClient(main.app)


@pytest.fixture()
def upstream(monkeypatch: pytest.MonkeyPatch) -> list[httpx.Request]:
    """把上游换成桩，记录收到的请求。"""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/plasmid/map"):
            return httpx.Response(200, content=b"\x89PNG\r\n\x1a\nfake", headers={"content-type": "image/png"})
        if request.url.path.endswith("/health"):
            return httpx.Response(200, json={"ok": True, "service": "biotools"})
        if request.url.path.endswith("/abi/parse"):
            return httpx.Response(200, json={"received": request.headers.get("content-type", "")})
        return httpx.Response(200, json={"method": request.method, "query": str(request.url.query)})

    real_client = httpx.AsyncClient

    def fake_client(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs.setdefault("transport", httpx.MockTransport(handler))
        return real_client(*args, **kwargs)

    monkeypatch.setattr(biotools_proxy.httpx, "AsyncClient", fake_client)
    return seen


def _headers() -> dict[str, str]:
    token = jwt.encode(
        {"sub": "u1", "email": "stu01@local", "name": "张三", "roles": ["lab-student"], "exp": int(time.time()) + 3600},
        settings.session_secret,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}", "X-CSRF-Token": "t"}


def test_anonymous_is_rejected_before_upstream(client: TestClient, upstream: list[httpx.Request]) -> None:
    resp = client.get("/api/biotools/meta")
    assert resp.status_code in (401, 403), resp.text
    assert upstream == []


def test_get_is_forwarded_with_query(client: TestClient, upstream: list[httpx.Request]) -> None:
    resp = client.get("/api/biotools/entrez/search?db=nuccore&term=brca1", headers=_headers())
    assert resp.status_code == 200, resp.text
    assert upstream[0].url.path == "/api/biotools/entrez/search"
    assert "term=brca1" in upstream[0].url.query.decode()


def test_post_body_and_content_type_preserved(client: TestClient, upstream: list[httpx.Request]) -> None:
    payload = b'{"ids":["a","b"],"matrix":[[0,1],[1,0]]}'
    resp = client.post(
        "/api/biotools/diversity/pcoa",
        headers={**_headers(), "Content-Type": "application/json"},
        cookies={"labspace_csrf": "t"},
        content=payload,
    )
    assert resp.status_code == 200, resp.text
    assert upstream[0].content == payload
    assert upstream[0].headers["content-type"].startswith("application/json")


def test_multipart_upload_is_passed_through(client: TestClient, upstream: list[httpx.Request]) -> None:
    resp = client.post(
        "/api/biotools/abi/parse",
        headers={**_headers(), "X-CSRF-Token": "t"},
        cookies={"labspace_csrf": "t"},
        files={"file": ("x.ab1", b"ABIF\x00\x01fake", "application/octet-stream")},
    )
    assert resp.status_code == 200, resp.text
    assert upstream[0].headers["content-type"].startswith("multipart/form-data")
    assert b"ABIF" in upstream[0].content


def test_binary_response_keeps_media_type(client: TestClient, upstream: list[httpx.Request]) -> None:
    resp = client.post(
        "/api/biotools/plasmid/map?format=png",
        headers={**_headers(), "Content-Type": "application/json"},
        cookies={"labspace_csrf": "t"},
        content=b"{}",
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("image/png")
    assert resp.content.startswith(b"\x89PNG")


def test_upstream_down_returns_actionable_503(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom", request=request)

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        biotools_proxy.httpx,
        "AsyncClient",
        lambda *a, **k: real_client(transport=httpx.MockTransport(handler)),
    )
    resp = client.get("/api/biotools/meta", headers=_headers())
    assert resp.status_code == 503, resp.text
    assert "生信" in resp.json()["detail"]
