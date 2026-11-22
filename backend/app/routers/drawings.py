"""drawings 路由（由 ops/split_main_module.py 从 main.py 搬出）。"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from .. import db
from ..config import settings
from ..routers.deps import (
    safe_component as _safe_component,
)
from ..security import require_csrf, require_user
import json

router = APIRouter()


# draw.io 图形内容安全白名单（禁止 DOCTYPE/ENTITY/script/javascript:）
XML_FORBIDDEN = re.compile(r"<!DOCTYPE|<!ENTITY|<script|javascript:", re.IGNORECASE)


def _grant_user_acl(path: str) -> None:
    """给文件服务账号（UID 1000 / labuser）授予目录读写位。

    用 argv 调 setfacl，不走 shell；setfacl 不存在时静默跳过（不阻断主流程）。
    """
    if not shutil.which("setfacl"):
        return
    for args in (["-m", "u:1000:rwX", path], ["-d", "-m", "u:1000:rwX", path]):
        try:
            subprocess.run(["setfacl", *args], capture_output=True, timeout=5, check=False)
        except (OSError, subprocess.SubprocessError):
            return


def _ensure_user_dir(user: dict[str, Any]) -> str:
    path = _user_dir(user)
    try:
        os.makedirs(path, mode=0o700, exist_ok=True)
        # Go 文件服务以 UID 1000 运行，需要写权限。
        # 用 argv 形式而不是 shell 字符串：路径里出现空格/分号也不会被 shell 解释。
        _grant_user_acl(path)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"无法准备个人目录: {exc}") from exc
    return path


# ------------------------------------------------------------------ Linux 命令库

CMD_ROOT = os.getenv("LABSPACE_COMMANDS_DIR", "/opt/labspace/cmd")
CMD_INDEX = os.getenv("LABSPACE_COMMANDS_INDEX", "/opt/labspace/cmd-index.json")
_cmd_index: dict[str, dict[str, str]] | None = None


def _validate_drawing_xml(content: str) -> str:
    if len(content.encode()) > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="图形文件过大")
    if XML_FORBIDDEN.search(content):
        raise HTTPException(status_code=400, detail="图形内容包含不允许的构造")
    if "<svg" not in content and "<mxfile" not in content and "<mxGraphModel" not in content:
        raise HTTPException(status_code=400, detail="不是有效的 draw.io 图形内容")
    return content



def _user_dir(user: dict[str, Any]) -> str:
    """用户在实验室文件空间中的个人目录（/srv/lab/users/<name>）。"""
    candidates = [
        user.get("preferred_username"),
        user.get("name"),
        (user.get("email") or "").split("@")[0],
        user.get("id"),
    ]
    for c in candidates:
        if c:
            comp = _safe_component(str(c))
            path = os.path.join(settings.users_root, comp)
            if os.path.isdir(path):
                return path
    comp = _safe_component(str(user.get("email", "")).split("@")[0] or str(user.get("id")))
    return os.path.join(settings.users_root, comp)


# ------------------------------------------------------------------ 绘图路由
@router.get("/api/drawings")
async def api_list_drawings(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    return {"drawings": db.list_drawings(user["sub"])}


@router.get("/api/drawings/{drawing_id}")
async def api_get_drawing(drawing_id: str, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    row = db.get_drawing(user["sub"], drawing_id)
    if not row:
        raise HTTPException(status_code=404, detail="图形不存在")
    return row


@router.post("/api/drawings")
async def api_save_drawing(
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    payload = await request.json()
    name = _safe_component(str(payload.get("name") or "diagram"), "diagram")
    content = _validate_drawing_xml(str(payload.get("content") or ""))
    row = db.save_drawing(user["sub"], name, content)
    return {"ok": True, **row}


@router.put("/api/drawings/{drawing_id}")
async def api_update_drawing(
    drawing_id: str,
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    payload = await request.json()
    name = _safe_component(str(payload.get("name") or "diagram"), "diagram")
    content = _validate_drawing_xml(str(payload.get("content") or ""))
    db.update_drawing(user["sub"], _safe_component(drawing_id, "d"), name, content)
    return {"ok": True}


@router.post("/api/drawings/{drawing_id}/rename")
async def api_rename_drawing(
    drawing_id: str,
    request: Request,
    user: dict = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    payload = await request.json()
    name = _safe_component(str(payload.get("name") or "diagram"), "diagram")
    db.rename_drawing(user["sub"], _safe_component(drawing_id, "d"), name)
    return {"ok": True, "name": name}


@router.get("/api/drawings/{drawing_id}/download")
async def api_download_drawing(drawing_id: str, user: dict = Depends(require_user)):
    from fastapi.responses import Response

    row = db.get_drawing(user["sub"], _safe_component(drawing_id, "d"))
    if not row:
        raise HTTPException(status_code=404, detail="图形不存在")
    return Response(
        content=row["content"],
        media_type="application/xml",
        headers={"Content-Disposition": f'attachment; filename="{row["name"]}.drawio"'},
    )


@router.delete("/api/drawings/{drawing_id}")
async def api_delete_drawing(
    drawing_id: str, user: dict[str, Any] = Depends(require_user), _: None = Depends(require_csrf)
) -> dict[str, Any]:
    db.delete_drawing(user["sub"], drawing_id)
    return {"ok": True}


@router.post("/api/drawings/{drawing_id}/export")
async def api_export_drawing(
    drawing_id: str,
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    """把图形写入用户自己的实验室文件目录（受控路径 + 内容校验）。"""
    row = db.get_drawing(user["sub"], drawing_id)
    if not row:
        raise HTTPException(status_code=404, detail="图形不存在")
    payload = await request.json()
    content = _validate_drawing_xml(str(payload.get("content") or row["content"]))
    name = _safe_component(str(payload.get("name") or row["name"]), "diagram")
    if not name.endswith(".drawio"):
        name += ".drawio"
    target_dir = os.path.join(_ensure_user_dir(user), "drawio")
    try:
        os.makedirs(target_dir, mode=0o700, exist_ok=True)
        _grant_user_acl(target_dir)
        path = os.path.join(target_dir, name)
        real = os.path.realpath(path)
        if not real.startswith(os.path.realpath(target_dir) + os.sep):
            raise HTTPException(status_code=400, detail="非法路径")
        with open(real, "w", encoding="utf-8") as fh:
            fh.write(content)
        os.chmod(real, 0o640)
    except HTTPException:
        raise
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"无法写入个人目录：{exc}") from exc
    return {"ok": True, "path": real, "note": "已写入个人目录，可在文件管理中查看"}


# ------------------------------------------------------------------ 管理端


