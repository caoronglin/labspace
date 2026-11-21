"""catalog 路由（由 ops/split_main_module.py 从 main.py 搬出）。"""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
)

from .. import (
    db,
    db_apis,
)
from ..catalog import load_catalog, visible_services
from ..config import settings
from ..databases import CATEGORIES, PLANT_DATABASES, search_databases
from ..golink import service_health as go_service_health
from ..routers.deps import (
    client_host as _client_host,
)
from ..security import (
    current_user,
    require_csrf,
    require_user,
    require_user_or_service,
)

router = APIRouter()


async def api_services(request: Request, user: dict[str, Any] | None = Depends(current_user)) -> dict[str, Any]:
    """服务目录。

    已由 Go 核心接管：nginx 将 ``/api/services`` 转发到 LabGo 的 ``/v1/services``。
    本路由保留仅为兼容直连后端端口（127.0.0.1:8088）的旧客户端。
    """
    services = visible_services(user, host=_client_host(request))
    return {"services": services, "count": len(services)}

async def api_service_health(service_id: str) -> dict[str, Any]:
    """单服务健康状态（由 Go 核心 ``internal/health`` 执行探测）。"""
    if not any(s.id == service_id for s in load_catalog()):
        raise HTTPException(status_code=404, detail="服务不存在")
    if not settings.enable_health:
        return {"status": "unknown", "detail": "健康检查已关闭"}
    return await go_service_health(service_id)

async def api_services_health(request: Request, user: dict[str, Any] | None = Depends(current_user)) -> dict[str, Any]:
    """批量健康状态（外部服务故障归外部主机）。"""

    services = visible_services(user, host=_client_host(request))
    results = await asyncio.gather(*[go_service_health(svc["id"]) for svc in services])
    out = []
    for svc, health in zip(services, results, strict=True):
        # 外部内网服务的故障归外部主机，不计入本机巡检失败
        if svc.get("external") and health.get("status") == "down":
            health = {**health, "status": "external-down", "detail": (health.get("detail") or "") + "（外部内网服务，需在 192.0.2.29 上恢复）"}
        out.append({**svc, "health": health})
    return {"services": out}

async def api_favorites(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    return {"favorites": db.list_favorites(user["sub"])}

async def api_add_favorite(service_id: str, user: dict = Depends(require_user), __: None = Depends(require_csrf)) -> dict[str, Any]:
    if not any(s.id == service_id for s in load_catalog()):
        raise HTTPException(status_code=404, detail="服务不存在")
    db.add_favorite(user["sub"], service_id)
    return {"ok": True, "favorites": db.list_favorites(user["sub"])}

async def api_remove_favorite(
    service_id: str, user: dict[str, Any] = Depends(require_user), __: None = Depends(require_csrf)
) -> dict[str, Any]:
    db.remove_favorite(user["sub"], service_id)
    return {"ok": True, "favorites": db.list_favorites(user["sub"])}

async def api_recent(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    return {"recent": db.list_recent(user["sub"])}

async def api_touch_recent(
    service_id: str, user: dict[str, Any] = Depends(require_user), __: None = Depends(require_csrf)
) -> dict[str, Any]:
    db.touch_recent(user["sub"], service_id)
    return {"ok": True}

async def api_databases(
    q: str = Query("", max_length=100),
    category: str = Query(""),
    _: dict = Depends(require_user_or_service),
) -> dict[str, Any]:
    """植物领域数据库/资源目录检索（本地数据，不出网）。"""
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
