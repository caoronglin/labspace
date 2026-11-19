"""SnapOtter REST 代理。

门户不使用 iframe 内嵌 SnapOtter，而是通过本模块直接调用它的 REST API，
把鉴权（API Key）留在服务端，前端只拿到门户自己的会话 Cookie。

SnapOtter API 约定（见官方 llms.txt）：
    Base URL          http://<host>:1349/api/v1
    鉴权              Authorization: Bearer si_<key>
    工具目录           GET  /api/v1/tools
    单文件处理         POST /api/v1/tools/:section/:toolId   (multipart)
    批量处理           POST /api/v1/tools/:section/:toolId/batch
    任务进度           GET  /api/v1/jobs/:jobId/progress     (SSE)
    流水线             POST /api/v1/pipeline/execute | /pipeline/save
                      GET  /api/v1/pipeline/list
                      DELETE /api/v1/pipeline/:id
    OpenAPI           GET  /api/v1/openapi.yaml
"""
from __future__ import annotations

import logging
import os
import re
import time
from typing import Any
from urllib.parse import urlsplit

import httpx

from .http import async_client

log = logging.getLogger("labspace.snapotter")

SNAPOTTER_BASE = os.getenv("SNAPOTTER_BASE_URL", "http://lab-snapotter:1349").rstrip("/")
SNAPOTTER_API = f"{SNAPOTTER_BASE}/api/v1"
#: 用于拼接已规范化的 `/api/v1/...` 路径（download 里只换路径、不换主机）
SNAPOTTER_API_ROOT = SNAPOTTER_BASE
SNAPOTTER_API_KEY = os.getenv("SNAPOTTER_API_KEY", "")
SNAPOTTER_TIMEOUT = float(os.getenv("SNAPOTTER_TIMEOUT", "120"))
# 单次上传上限（字节），与门户自身上传限制保持一致的安全值
MAX_UPLOAD = int(os.getenv("SNAPOTTER_MAX_UPLOAD", str(200 * 1024 * 1024)))
MAX_DOWNLOAD = int(os.getenv("SNAPOTTER_MAX_DOWNLOAD", str(200 * 1024 * 1024)))
"""下载结果文件的大小上限（避免被超大响应打满内存）。"""


def _headers() -> dict[str, str]:
    if SNAPOTTER_API_KEY:
        return {"Authorization": f"Bearer {SNAPOTTER_API_KEY}"}
    return {}


def is_configured() -> bool:
    return bool(SNAPOTTER_BASE)


async def probe() -> tuple[bool, str]:
    """探活：GET /api/v1/health，失败时返回原因文本。"""
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get(f"{SNAPOTTER_API}/health", headers=_headers())
            if r.status_code < 500:
                return True, f"HTTP {r.status_code}"
            return False, f"HTTP {r.status_code}"
    except Exception as exc:  # noqa: BLE001
        return False, type(exc).__name__


async def list_tools() -> dict[str, Any]:
    """工具目录（备用接口，官方可能不提供 /tools 列表）。"""
    async with httpx.AsyncClient(timeout=20) as client:
        for path in ("/tools", "/tools/list"):
            try:
                r = await client.get(f"{SNAPOTTER_API}{path}", headers=_headers())
                if r.status_code == 200:
                    return r.json()
            except Exception as exc:  # noqa: BLE001 - 单点工具查询失败不影响其它工具
                log.debug("查询 SnapOtter 工具 %s 失败：%s", path, exc)
                continue
    return {"tools": []}


_TOOL_PATH_RE = re.compile(r"^/api/v1/tools/([^/]+)/([^/]+)$")
_catalog_cache: dict[str, Any] = {"at": 0.0, "items": []}

#: 供统一语料同步读取的工具快照（由 get_tool_catalog 填充）
_catalog_snapshot: list[dict[str, Any]] = []


def catalog_snapshot() -> list[dict[str, Any]]:
    """同步读取当前已缓存的工具目录（不触发网络请求）。"""
    return list(_catalog_snapshot)


async def get_tool_catalog() -> list[dict[str, Any]]:
    """从 OpenAPI 规范里抽取工具目录。

    SnapOtter 没有稳定的“工具列表”接口，权威来源是 `/api/v1/openapi.yaml`，
    其中每个 `POST /api/v1/tools/{section}/{toolId}` 就是一个可执行工具。
    结果缓存 10 分钟，避免每次打开页面都解析 600KB 的 YAML。
    """
    now = time.monotonic()
    if _catalog_cache["items"] and now - _catalog_cache["at"] < 600:
        return _catalog_cache["items"]

    try:
        import yaml  # PyYAML 在后端镜像中已预装
    except Exception:  # noqa: BLE001
        yaml = None  # type: ignore[assignment]

    raw = ""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.get(f"{SNAPOTTER_API}/openapi.yaml", headers=_headers())
            r.raise_for_status()
            raw = r.text
    except Exception as exc:  # noqa: BLE001 - 网络抖动时回退到旧缓存，不让接口 500
        if _catalog_cache["items"]:
            return _catalog_cache["items"]
        raise RuntimeError(f"openapi.yaml 获取失败: {type(exc).__name__}") from exc

    if yaml is None:
        return []
    spec = yaml.safe_load(raw) or {}
    paths = spec.get("paths") or {}

    out: list[dict[str, Any]] = []
    for path, ops in paths.items():
        if not isinstance(ops, dict):
            continue
        m = _TOOL_PATH_RE.match(path)
        if not m:
            continue
        post = ops.get("post")
        if not isinstance(post, dict):
            continue
        section, tool_id = m.group(1), m.group(2)
        settings_hint = ""
        accept = ""
        body = post.get("requestBody") or {}
        content = body.get("content") or {}
        form = content.get("multipart/form-data") or content.get("application/json") or {}
        props = (form.get("schema") or {}).get("properties") or {}
        file_prop = props.get("file") or {}
        accept = str(file_prop.get("description") or "")[:120]
        settings_hint = str((props.get("settings") or {}).get("description") or "")[:600]
        out.append(
            {
                "section": section,
                "id": tool_id,
                "name": str(post.get("summary") or tool_id),
                "description": str(post.get("description") or "")[:240],
                "icon": "",
                "accept": accept,
                "settingsHint": settings_hint,
                "path": path,
            }
        )

    out.sort(key=lambda t: (t["section"], t["id"]))
    _catalog_cache["items"] = out
    _catalog_cache["at"] = now
    global _catalog_snapshot
    _catalog_snapshot = out
    return out


async def submit_tool(
    section: str,
    tool_id: str,
    filename: str,
    content: bytes,
    settings_json: str = "{}",
    content_type: str = "application/octet-stream",
) -> dict[str, Any]:
    """提交单文件处理任务。"""
    if len(content) > MAX_UPLOAD:
        raise ValueError(f"文件超过上限 {MAX_UPLOAD // (1024 * 1024)} MB")

    files = {"file": (filename, content, content_type)}
    data = {"settings": settings_json}
    async with httpx.AsyncClient(timeout=SNAPOTTER_TIMEOUT) as client:
        r = await client.post(
            f"{SNAPOTTER_API}/tools/{section}/{tool_id}",
            files=files,
            data=data,
            headers=_headers(),
        )
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:300]}")
    return r.json()


async def job_status(job_id: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(f"{SNAPOTTER_API}/jobs/{job_id}", headers=_headers())
    if r.status_code == 404:
        return {"jobId": job_id, "status": "unknown"}
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
    return r.json()


async def list_pipelines() -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(f"{SNAPOTTER_API}/pipeline/list", headers=_headers())
    if r.status_code >= 400:
        return {"pipelines": []}
    return r.json()


#: 允许的下载目标主机。注意 urlsplit().hostname 返回的是小写、去掉方括号的
#: IP 字面量（IPv6 为 `::1` 而非 `[::1]`），原实现的集合里写的是 `[::1]`，
#: 导致 IPv6 回环永远匹配不上，白名单实际只剩三个域名条目。
_ALLOWED_DOWNLOAD_HOSTS = {"localhost", "127.0.0.1", "::1", "snapotter", "lab-snapotter"}
_ALLOWED_DOWNLOAD_SUFFIX = (".internal", ".local")


def _allowed_download_host(host: str) -> bool:
    h = (host or "").lower()
    if not h:
        return False
    if h in _ALLOWED_DOWNLOAD_HOSTS:
        return True
    # SnapOtter 自身部署在同一 compose 网络里，容器名会被解析成 172.16/12 私网地址；
    # 只放行私网/回环字面量，避免门户变成任意 URL 代理。
    if re.fullmatch(r"127\.\d+\.\d+\.\d+", h) or re.fullmatch(r"10\.\d+\.\d+\.\d+", h):
        return True
    if re.fullmatch(r"192\.168\.\d+\.\d+", h):
        return True
    if re.fullmatch(r"172\.(1[6-9]|2\d|3[01])\.\d+\.\d+", h):
        return True
    return any(h.endswith(sfx) for sfx in _ALLOWED_DOWNLOAD_SUFFIX)


def resolve_download(url: str) -> str:
    """把 SnapOtter 返回的下载地址规整成同源可取的路径。

    只允许指向 SnapOtter 自身的相对路径，或 host 属于白名单的绝对地址，
    避免门户变成任意 URL 的代理（SSRF）。返回值统一是 `SNAPOTTER_BASE` 上的路径，
    调用方不再拿原始 URL 去拼主机。
    """
    raw = (url or "").strip()
    if not raw:
        raise ValueError("下载地址为空")
    if raw.startswith("/"):
        return raw if raw.startswith("/api/v1") else f"/api/v1{raw}"
    try:
        parsed = urlsplit(raw)
    except ValueError as exc:
        raise ValueError("下载地址无法解析") from exc
    if parsed.scheme not in ("http", "https"):
        raise ValueError("下载地址协议不被允许")
    if not _allowed_download_host(parsed.hostname or ""):
        raise ValueError("下载地址不属于 SnapOtter 服务")
    path = parsed.path or "/"
    if not path.startswith("/api/v1"):
        path = f"/api/v1{path}"
    return path + (f"?{parsed.query}" if parsed.query else "")


async def download(url: str) -> tuple[bytes, str]:
    """下载处理结果，返回 (内容, 文件名)。"""
    path = resolve_download(url)
    async with async_client(timeout=SNAPOTTER_TIMEOUT, follow_redirects=False) as client:
        r = await client.get(f"{SNAPOTTER_API_ROOT}{path}", headers=_headers())
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
    if len(r.content) > MAX_DOWNLOAD:
        raise RuntimeError(f"结果文件超过上限 {MAX_DOWNLOAD // (1024 * 1024)} MB")
    name = "snapotter-result.bin"
    disp = r.headers.get("content-disposition", "")
    if "filename=" in disp:
        name = disp.split("filename=")[-1].strip().strip('";') or name
    return r.content, name
