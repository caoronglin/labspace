"""BUG-01：入口主机白名单与 SSRF 收敛。

``X-Forwarded-Host`` / ``Host`` 是客户端可控的头。修复前 ``_client_host()``
原样采信它，``/api/network/entries`` 会拿这个值拼出站 URL 并跟随跳转，
伪造 ``169.254.169.254`` 就能让门户服务器去打云元数据地址（SSRF）。

这里锁三件事：
1. 白名单外的主机一律回落到默认入口主机；
2. 白名单内的双 IP 入口仍然自适应；
3. 自检探针不再跟随 302（避免重定向放大）。
"""
from __future__ import annotations

import pytest
from starlette.requests import Request

from app import main as main_mod
from app.config import settings


def _make_request(host: str | None, forwarded: str | None = None) -> Request:
    headers: list[tuple[bytes, bytes]] = []
    if host is not None:
        headers.append((b"host", host.encode()))
    if forwarded is not None:
        headers.append((b"x-forwarded-host", forwarded.encode()))
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/api/network/entries",
        "headers": headers,
        "query_string": b"",
        "scheme": "http",
        "server": ("127.0.0.1", 80),
        "client": ("127.0.0.1", 54321),
    }
    return Request(scope)


def test_whitelist_contains_dual_entry_hosts() -> None:
    """双入口（LAN + Tailscale）必须在默认白名单里，否则登录后拿不到正确服务地址。"""
    allowed = {h.lower() for h in settings.allowed_hosts}
    assert "192.0.2.10" in allowed
    assert "198.51.100.71" in allowed


def test_forged_forwarded_host_falls_back_to_default() -> None:
    """伪造 X-Forwarded-Host 指向云元数据地址 → 回落到默认入口主机。"""
    req = _make_request(host="192.0.2.10", forwarded="169.254.169.254")
    assert main_mod._client_host(req) == settings.default_entry_host
    assert main_mod._client_host(req) != "169.254.169.254"


def test_forged_host_falls_back_to_default() -> None:
    req = _make_request(host="evil.example.com")
    assert main_mod._client_host(req) == settings.default_entry_host


def test_allowed_hosts_adapt() -> None:
    """白名单内的入口仍然按访问主机自适应（LAN 与 Tailscale 各给各的地址）。"""
    assert main_mod._client_host(_make_request(host="192.0.2.10")) == "192.0.2.10"
    tail = main_mod._client_host(_make_request(host="198.51.100.71:80"))
    assert tail == "198.51.100.71"


def test_host_allowed_edge_cases() -> None:
    assert main_mod._host_allowed("192.0.2.10") is True
    assert main_mod._host_allowed("192.0.2.10.") is True
    assert main_mod._host_allowed("") is False
    assert main_mod._host_allowed("169.254.169.254") is False
    assert main_mod._host_allowed("192.0.2.10.evil.com") is False


@pytest.mark.parametrize("forged", ["169.254.169.254", "10.0.0.1", "metadata.google.internal"])
def test_network_entries_probe_only_whitelisted_host(monkeypatch, forged: str) -> None:
    """端到端：伪造头不会出现在任何出站请求里，且探针不跟随跳转。"""
    seen: list[tuple[str, bool]] = []

    class FakeResponse:
        status_code = 200

    class FakeClient:
        def __init__(self, *, timeout=None, follow_redirects=None):  # noqa: ANN001, D107
            self._follow = follow_redirects

        async def __aenter__(self):  # noqa: ANN204
            return self

        async def __aexit__(self, *exc):  # noqa: ANN002, ANN204
            return False

        async def get(self, target: str) -> FakeResponse:
            seen.append((target, bool(self._follow)))
            return FakeResponse()

    monkeypatch.setattr(main_mod.httpx, "AsyncClient", FakeClient)

    import asyncio

    req = _make_request(host="192.0.2.10", forwarded=forged)
    result = asyncio.run(main_mod.api_network_entries(req, _={"sub": "admin01"}))

    assert result["host"] == settings.default_entry_host
    assert seen, "应当至少探测一次入口"
    for target, follow in seen:
        assert forged not in target
        assert follow is False, "自检探针不得跟随上游 302"
        assert settings.default_entry_host in target
