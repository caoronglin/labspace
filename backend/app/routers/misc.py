"""misc 路由（由 ops/split_main_module.py 从 main.py 搬出）。"""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
)

from .. import (
    db,
)
from .. import (
    wecom as wecom_mod,
)
from ..routers.deps import (
    safe_component as _safe_component,
)
from ..security import (
    require_admin,
    require_csrf,
    require_user,
)

router = APIRouter()


@router.get("/api/announcements")
async def api_announcements(_: dict = Depends(require_user)) -> dict[str, Any]:
    return {"announcements": db.list_announcements()}

@router.post("/api/announcements")
async def api_add_announcement(
    request: Request,
    user: dict = Depends(require_admin),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    payload = await request.json()
    title = str(payload.get("title") or "").strip()[:120]
    content = str(payload.get("content") or "").strip()[:4000]
    level = str(payload.get("level") or "info")[:16]
    if not title or not content:
        raise HTTPException(status_code=400, detail="标题与内容不能为空")
    row = db.add_announcement(title, content, level, user.get("email") or user.get("name") or "admin")
    # 企业微信推送是尽力而为：失败只记日志，不能让公告发布跟着失败。
    asyncio.create_task(wecom_mod.notify_announcement(title, content, level))
    return {"ok": True, "announcement": row}

@router.delete("/api/announcements/{aid}")
async def api_delete_announcement(
    aid: str, user: dict = Depends(require_admin), _: None = Depends(require_csrf)
) -> dict[str, Any]:
    db.delete_announcement(_safe_component(aid, "a"))
    return {"ok": True}
