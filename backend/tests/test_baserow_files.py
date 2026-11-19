"""多维表格附件上传：白名单、大小上限、上游透传。

不打真实 Baserow：上游用 httpx.MockTransport 打桩，
断言的是门户自己的校验与对外响应形状（含"不把令牌泄露给前端"）。
"""
from __future__ import annotations

import time
from typing import Any

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient

from app import baserow as baserow_mod
from app import db, main
from app.config import settings

CALLER_JWT = "caller-jwt-not-a-real-token"
UPSTREAM_URL = "http://baserow.local/media/user_files/abc123.txt"


@pytest.fixture()
def upstream(monkeypatch: pytest.MonkeyPatch) -> list[httpx.Request]:
    """把上游 Baserow 换成 MockTransport，并记录收到的请求。"""
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        path = request.url.path
        if path == "/api/database/tables/42/":
            return httpx.Response(200, json={"id": 42, "name": "工作表"})
        if path == "/api/user-files/upload-file/":
            return httpx.Response(
                200,
                json={
                    "size": 12,
                    "mime_type": "text/plain",
                    "is_image": False,
                    "image_width": None,
                    "image_height": None,
                    "thumbnails": None,
                    "uploaded_at": "2026-01-01T00:00:00Z",
                    "url": UPSTREAM_URL,
                    "name": "abc123.txt",
                    "original_name": "note.txt",
                },
            )
        return httpx.Response(404, json={"error": "URL_NOT_FOUND", "detail": path})

    monkeypatch.setattr(
        baserow_mod,
        "_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )

    async def fake_token(user: dict[str, Any], force: bool = False) -> str:
        return CALLER_JWT

    monkeypatch.setattr(baserow_mod, "_token", fake_token)
    monkeypatch.setattr(db, "revoked_before", lambda subject: None)
    return calls


@pytest.fixture()
def client() -> TestClient:
    return TestClient(main.app)


@pytest.fixture()
def auth() -> dict[str, str]:
    """用 Bearer 方式带会话：内部服务同款，CSRF 双提交对 Bearer 豁免。"""
    token = jwt.encode(
        {"sub": "u1", "email": "a@b.c", "name": "木林森", "roles": ["lab-admin"], "exp": int(time.time()) + 3600},
        settings.session_secret,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def test_rejects_extension_outside_allowlist(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.post(
        "/api/baserow/tables/42/files",
        headers=auth,
        files={"file": ("payload.exe", b"MZ\x90\x00", "application/octet-stream")},
    )
    assert resp.status_code == 400, resp.text
    assert ".exe" in resp.json()["detail"]
    # 校验在本地完成，不该打到上游
    assert upstream == []


def test_accepts_allowlisted_extension(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.post(
        "/api/baserow/tables/42/files",
        headers=auth,
        files={"file": ("seq.fasta", b">chr1\nACGT\n", "text/plain")},
    )
    assert resp.status_code == 200, resp.text
    assert [r.url.path for r in upstream] == ["/api/database/tables/42/", "/api/user-files/upload-file/"]


def test_rejects_oversize_upload(client: TestClient, auth: dict[str, str], upstream) -> None:
    payload = b"0" * (baserow_mod.FILE_MAX_BYTES + 1)
    resp = client.post(
        "/api/baserow/tables/42/files",
        headers=auth,
        files={"file": ("big.zip", payload, "application/zip")},
    )
    assert resp.status_code == 413, resp.text
    assert "20 MB" in resp.json()["detail"]
    assert upstream == []


def test_upload_passes_through_upstream_result(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.post(
        "/api/baserow/tables/42/files",
        headers=auth,
        files={"file": ("note.txt", b"hello world\n", "text/plain")},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["url"] == UPSTREAM_URL
    assert body["name"] == "abc123.txt"  # 写回文件字段时必须带的校验名
    assert body["visible_name"] == "note.txt"  # 界面展示用的原始文件名
    assert body["size"] == 12
    assert body["mime"] == "text/plain"


def test_upload_never_leaks_token(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.post(
        "/api/baserow/tables/42/files",
        headers=auth,
        files={"file": ("note.txt", b"hello world\n", "text/plain")},
    )
    assert resp.status_code == 200, resp.text
    raw = resp.text
    assert CALLER_JWT not in raw
    assert "JWT" not in raw
    # 上游请求用调用者自己的令牌，门户不换管理员令牌
    upload = [r for r in upstream if r.url.path == "/api/user-files/upload-file/"][0]
    assert upload.headers["authorization"] == f"JWT {CALLER_JWT}"
