"""snapotter 路由（由 ops/split_main_module.py 从 main.py 搬出）。"""
from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Response,
    UploadFile,
)

from .. import (
    snapotter as snapotter_mod,
)
from ..config import settings
from ..security import (
    has_role,
    require_csrf,
    require_user,
)
from ..uploads import read_upload_capped as _read_upload_capped

log = logging.getLogger("labspace.routers.snapotter")

router = APIRouter()


# ------------------------------------------------------------------ SnapOtter 代理

#: SnapOtter 作业归属（只在内存里记近期的，重启后旧作业仅管理员可查）。
_SNAPOTTER_JOB_OWNERS: dict[str, str] = {}
_SNAPOTTER_JOB_OWNERS_MAX = 4096

def _remember_snapotter_owner(job_id: str, user: dict[str, Any]) -> None:
    if not job_id:
        return
    if len(_SNAPOTTER_JOB_OWNERS) >= _SNAPOTTER_JOB_OWNERS_MAX:
        _SNAPOTTER_JOB_OWNERS.pop(next(iter(_SNAPOTTER_JOB_OWNERS)), None)
    _SNAPOTTER_JOB_OWNERS[job_id] = str(user.get("sub") or "")

def _snapotter_job_allowed(job_id: str, user: dict[str, Any]) -> bool:
    if has_role(user, settings.admin_roles):
        return True
    owner = _SNAPOTTER_JOB_OWNERS.get(job_id)
    return bool(owner) and owner == str(user.get("sub") or "")

@router.get("/api/snapotter/status")
async def api_snapotter_status(_: dict = Depends(require_user)) -> dict[str, Any]:
    """SnapOtter 服务探活 + 工具总数。"""
    ok, detail = await snapotter_mod.probe()
    tools: list[dict[str, Any]] = []
    if ok:
        try:
            tools = await snapotter_mod.get_tool_catalog()
        except Exception as exc:  # noqa: BLE001 - 目录拉取失败只影响工具计数
            log.debug("snapotter 工具目录不可用: %s", exc)
            tools = []
    return {
        "configured": snapotter_mod.is_configured(),
        "up": ok,
        "detail": detail,
        "toolCount": len(tools),
        "baseUrl": snapotter_mod.SNAPOTTER_BASE,
    }

@router.get("/api/snapotter/tools")
async def api_snapotter_tools(_: dict = Depends(require_user)) -> dict[str, Any]:
    """工具目录（原生 REST 调用，不使用 iframe）。"""
    try:
        tools = await snapotter_mod.get_tool_catalog()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"SnapOtter 工具目录不可用（{type(exc).__name__}）") from exc
    return {"tools": tools, "count": len(tools)}

@router.post("/api/snapotter/run")
async def api_snapotter_run(
    section: str = Query(..., min_length=1, max_length=64),
    tool_id: str = Query(..., min_length=1, max_length=96),
    file: UploadFile = File(...),
    settings_json: str = Form("{}"),
    user: dict = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    """上传单个文件并提交 SnapOtter 处理任务。"""
    # 分块读取并在超限时立即中断：避免先把整个文件读进内存再检查大小
    content = await _read_upload_capped(file, snapotter_mod.MAX_UPLOAD)
    if not content:
        raise HTTPException(status_code=400, detail="上传文件为空")
    try:
        result = await snapotter_mod.submit_tool(
            section=section,
            tool_id=tool_id,
            filename=file.filename or "input.bin",
            content=content,
            settings_json=settings_json or "{}",
            content_type=file.content_type or "application/octet-stream",
        )
    except ValueError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"SnapOtter 处理失败（{type(exc).__name__}）") from exc
    _remember_snapotter_owner(str(result.get("jobId") or result.get("job_id") or ""), user)
    return result

@router.get("/api/snapotter/jobs/{job_id}")
async def api_snapotter_job(job_id: str, user: dict = Depends(require_user)) -> dict[str, Any]:
    """任务状态（门户轮询用，替代 SnapOtter 的 SSE）。"""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", job_id or ""):
        raise HTTPException(status_code=400, detail="作业 ID 非法")
    if not _snapotter_job_allowed(job_id, user):
        raise HTTPException(status_code=404, detail="作业不存在")
    try:
        return await snapotter_mod.job_status(job_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"任务状态查询失败（{type(exc).__name__}）") from exc

@router.get("/api/snapotter/pipelines")
async def api_snapotter_pipelines(_: dict = Depends(require_user)) -> dict[str, Any]:
    """流水线列表。"""
    try:
        return await snapotter_mod.list_pipelines()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"流水线查询失败（{type(exc).__name__}）") from exc

@router.get("/api/snapotter/download")
async def api_snapotter_download(url: str = Query(..., min_length=1), _: dict = Depends(require_user)):
    """代理下载 SnapOtter 处理结果（API Key 不下发到浏览器）。"""
    try:
        content, name = await snapotter_mod.download(url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"结果下载失败（{type(exc).__name__}）") from exc
    return Response(
        content=content,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )
