"""统一的出站 HTTP 客户端。

容器内同时存在 IPv4 与 IPv6 路由，但 IPv6 出口对部分公网站点是黑洞：
DNS 返回 AAAA 记录时，asyncio 的 connect 会先尝试 IPv6 并一直挂到超时，
导致本可用的 IPv4 地址根本没被使用（例如 free-oxr.somark.ai）。

httpx 的 `local_address="0.0.0.0"` 可以强制只走 IPv4，这里统一封装，
所有访问公网/外部服务的客户端都应使用 `async_client()`。
"""
from __future__ import annotations

import gzip
import io
import zlib
from typing import Any

import httpx


def _ipv4_transport() -> httpx.AsyncHTTPTransport:
    return httpx.AsyncHTTPTransport(local_address="0.0.0.0")


def async_client(**kwargs: Any) -> httpx.AsyncClient:
    """创建强制 IPv4 的异步 HTTP 客户端（可覆盖 timeout / follow_redirects 等）。"""
    kwargs.setdefault("transport", _ipv4_transport())
    return httpx.AsyncClient(**kwargs)


MAX_RESIDUAL_GZIP_BYTES = 32 * 1024 * 1024
"""残留 gzip 层的解压上限（32 MiB）：超过就停止解压并保留原压缩体，
避免上游返回「压缩炸弹」时把内存打满。"""


def _gunzip_capped(body: bytes, limit: int = MAX_RESIDUAL_GZIP_BYTES) -> bytes:
    """带上限的 gzip 解压：边解边算，超过 limit 立即中止。"""
    out = bytearray()
    with gzip.GzipFile(fileobj=io.BytesIO(body)) as fh:
        while True:
            chunk = fh.read(64 * 1024)
            if not chunk:
                break
            out += chunk
            if len(out) > limit:
                raise ValueError("gzip 解压超过上限")
    return bytes(out)


def strip_residual_gzip(resp: httpx.Response) -> httpx.Response:
    """清掉上游响应体里残留的 gzip 压缩层。

    个别上游（例如 proteinatlas.org 的 search_download.php）会在 gzip 之上
    再套一层 gzip，或者返回 gzip 响应体却根本不带 Content-Encoding 头。
    httpx 最多解一层，剩余内容仍是 gzip，直接 json() 会报
    "utf-8 codec can't decode byte 0x8b"。这里按上限继续解压（最多 3 层），
    并把 Content-Encoding 修正为 identity，避免下游重复解码。

    解压总量受 MAX_RESIDUAL_GZIP_BYTES 限制：超出即停止并保留压缩体，
    防止恶意上游用「压缩炸弹」耗尽内存。
    """
    for _ in range(3):
        body = resp.content
        if body[:2] != b"\x1f\x8b":
            break
        try:
            body = _gunzip_capped(body)
        except (OSError, EOFError, zlib.error, ValueError):
            break
        resp._content = body
        resp.headers["content-length"] = str(len(body))
        resp.headers["content-encoding"] = "identity"
    return resp
