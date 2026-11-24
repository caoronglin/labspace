"""network 路由（由 ops/split_main_module.py 从 main.py 搬出）。"""
from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import (
    APIRouter,
    Body,
    Depends,
    HTTPException,
    Query,
    Request,
)

from .. import (
    db_apis,
)
from ..catalog import adapt_host, load_catalog
from ..config import settings
from ..routers.deps import (
    client_host as _client_host,
)
from ..security import (
    has_role,
    require_csrf,
    require_user,
    require_user_or_service,
)

router = APIRouter()


# 服务目录 / 收藏 / 最近的路由实现在 catalog.py（拆分时装饰器曾误留此处成孤儿链，已迁回）

# ------------------------------------------------------------------ 植物数据库目录

@router.get("/api/databases")
async def api_databases(
    q: str = Query("", max_length=100),
    category: str = Query(""),
    _: dict = Depends(require_user_or_service),
) -> dict[str, Any]:
    """植物领域数据库/资源目录检索（本地数据，不出网）。"""
    from ..databases import CATEGORIES, PLANT_DATABASES, search_databases
    items = search_databases(q, category)
    api_map = {entry["id"]: entry for entry in db_apis.api_index()}
    for item in items:
        entry = api_map.get(item["id"])
        item["api"] = {
            "hasApi": bool(entry and entry["hasApi"]),
            "name": entry["api"]["name"] if entry and entry["api"] else "",
            "summary": entry["api"]["summary"] if entry and entry["api"] else "",
            "queryHint": entry["api"]["queryHint"] if entry and entry["api"] else "",
            "kind": entry["api"]["kind"] if entry and entry["api"] else "",
            "note": entry["note"] if entry else "",
        }
    return {"total": len(PLANT_DATABASES), "matched": len(items), "categories": CATEGORIES, "items": items}

@router.get("/api/databases/apis")
async def api_databases_apis(_: dict = Depends(require_user_or_service)) -> dict[str, Any]:
    """数据库 API 能力清单（含无 API 的原因说明）。"""
    entries = db_apis.api_index()
    statuses = await db_apis.probe_all()
    for entry in entries:
        if entry["hasApi"]:
            ok, detail = statuses.get(entry["id"], (False, "未探测"))
            entry["api"]["available"] = ok
            entry["api"]["statusDetail"] = detail
    summary = db_apis.api_summary()
    summary["items"] = entries
    return summary

@router.post("/api/databases/{db_id}/query")
async def api_databases_query(
    db_id: str,
    payload: dict[str, Any] = Body(default_factory=dict),
    _: dict = Depends(require_user_or_service),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    """对指定数据库执行一次真实 API 查询（服务端代理）。"""
    query = str(payload.get("query") or "").strip()
    # limit 来自请求体：脏值不能让整个接口 500
    try:
        limit = int(payload.get("limit") or 5)
    except (TypeError, ValueError):
        limit = 5
    limit = max(1, min(limit, 200))
    params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
    result = await db_apis.run_query(db_id, query, limit, params)
    return result

@router.get("/api/databases/{db_id}/probe")
async def api_databases_probe(db_id: str, _: dict = Depends(require_user_or_service)) -> dict[str, Any]:
    """探测单个数据库 API 的可用性。"""
    ok, detail = await db_apis.probe(db_id)
    spec = db_apis.ADAPTERS.get(db_id)
    return {"id": db_id, "ok": ok, "detail": detail, "api": spec.as_dict(ok) if spec else None}

# ------------------------------------------------------------------ 网络 / 入口自检

SERVICE_ENTRIES = [
    ("门户 D509 工作台", "/", "/"),
    ("生信实训平台", "/apps/bioinfo/", "/"),
    ("draw.io 绘图", "/apps/drawio/", "/"),
    ("Linux 命令速查", "/apps/commands/", "/"),
    ("JBrowse 2 基因组浏览器", "/jbrowse/index.html?config=data/demo/config.zh.json", "/jbrowse/index.html?config=data/demo/config.zh.json"),
    ("Primer3 引物设计", "/apps/primer/", "/"),
]


def _probe_base() -> str:
    """容器内探测宿主机 Nginx 的基址。

    后端运行在 Docker 容器内，``127.0.0.1`` 是容器自身；LabGo 环境里的
    ``LABSPACE_LABGO_BASE`` 已包含可达的宿主机网关主机，复用其主机名并
    强制走 HTTP 80，避免把内部探测地址暴露给浏览器。
    """
    parsed = urlsplit(settings.labgo_base)
    scheme = parsed.scheme if parsed.scheme in {"http", "https"} else "http"
    host = parsed.hostname or "172.28.0.1"
    return f"{scheme}://{host}"


@router.get("/api/network/entries")
async def api_network_entries(request: Request, _: dict = Depends(require_user)) -> dict[str, Any]:
    """同源入口的实时可用性自检；返回浏览器 URL，内部走宿主机网关探测。"""

    host = _client_host(request) or settings.default_entry_host
    public_base = f"http://{host}"
    entries = [
        {"name": name, "url": public_base + path, "path": probe_path}
        for name, path, probe_path in SERVICE_ENTRIES
    ]
    probe_base = _probe_base()

    async def probe(path: str) -> tuple[bool, str]:
        target = probe_base + path
        try:
            # 不跟随跳转：路径固定且 Host 来自白名单，避免重定向放大。
            async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
                resp = await client.get(target, headers={"Host": host})
                return resp.status_code < 400 or resp.status_code in {401, 403}, f"HTTP {resp.status_code}"
        except Exception as exc:  # noqa: BLE001
            return False, type(exc).__name__

    results = await asyncio.gather(*[probe(e["path"]) for e in entries])
    items = [
        {"name": e["name"], "url": e["url"], "up": up, "detail": detail}
        for e, (up, detail) in zip(entries, results, strict=True)
    ]
    return {"items": items, "host": host}

def _service_for_user(service_id: str, user: dict[str, Any]):
    """服务存在且当前用户满足其角色限制，否则 404/403。"""
    svc = next((s for s in load_catalog() if s.id == service_id), None)
    if not svc:
        raise HTTPException(status_code=404, detail="服务不存在")
    if svc.roles and not has_role(user, svc.roles):
        raise HTTPException(status_code=403, detail="无权访问该服务")
    return svc

@router.get("/api/services/{service_id}/embed")
@router.get("/v1/services/{service_id}/embed")
async def api_service_embed(service_id: str, request: Request, user: dict = Depends(require_user)) -> dict[str, Any]:
    """探测某服务是否允许 iframe 内嵌。

    实际探测由 Go 核心完成（``internal/embed``）：它读取目标站点的
    ``X-Frame-Options`` 与 CSP ``frame-ancestors``，并缓存 5 分钟。
    """
    from ..golink import embed_info

    svc = _service_for_user(service_id, user)
    info = await embed_info(svc.id)
    if not info:
        raise HTTPException(status_code=404, detail="服务不存在")
    return adapt_host(info, _client_host(request))

@router.get("/api/services/{service_id}/sso")
@router.get("/v1/services/{service_id}/sso")
async def api_service_sso(service_id: str, request: Request, user: dict = Depends(require_user)) -> dict[str, Any]:
    """返回服务的免密登录入口（门户 OIDC 起跳地址）。

    已由 Go 核心接管，此处保留仅为兼容直连后端端口的旧客户端。
    """
    svc = _service_for_user(service_id, user)
    return adapt_host(
        {
            "id": svc.id,
            "name": svc.name,
            "ssoUrl": svc.sso_url or "",
            "url": svc.url,
            "hasSso": bool(svc.sso_url),
        },
        _client_host(request),
    )
