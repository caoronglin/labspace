"""admin 路由（由 ops/split_main_module.py 从 main.py 搬出）。"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
)

from ..catalog import load_catalog
from ..config import settings
from ..golink import service_health as go_service_health
from ..security import (
    require_admin,
)

log = logging.getLogger("labspace.routers.admin")

router = APIRouter()


@router.get("/api/admin/info")
async def api_admin_info(user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    import platform

    def run(cmd: list[str]) -> str:
        try:
            return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout.strip()
        except Exception as exc:  # noqa: BLE001 - 管理端信息降级为空串
            log.debug("命令执行失败 %s: %s", cmd[:1], exc)
            return ""

    disk = shutil.disk_usage("/srv/labdata") if os.path.isdir("/srv/labdata") else shutil.disk_usage("/")
    containers = []
    if os.path.exists("/var/run/docker.sock"):
        out = run(["docker", "ps", "--format", "{{.Names}}\t{{.Status}}\t{{.Image}}"])
        containers = [line for line in out.splitlines() if line.strip()]
    return {
        "host": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "hostname": platform.node(),
        },
        "disk": {
            "total": disk.total,
            "used": disk.used,
            "free": disk.free,
        },
        "containers": containers,
        "casdoor": {"issuer": settings.issuer, "clientId": settings.client_id},
        "roles": {"admin": settings.admin_roles, "teacher": settings.teacher_roles},
    }

@router.get("/api/admin/backups")
async def api_admin_backups(user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    """备份状态由宿主机备份脚本写入只读目录，容器不接触仓库与口令。"""
    status_path = "/srv/labgo/backup-status.json"
    try:
        with open(status_path, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return {"available": False, "detail": "尚未产生备份记录", "snapshots": []}
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"备份状态读取失败：{exc}") from exc
    data["available"] = True
    return data

@router.get("/api/admin/backups/git")
async def api_admin_backup_git(user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    """异地归档（Git LFS）的状态。

    本地 restic 仓库在同一块盘上，盘坏了一起没；异地归档是第二条腿。
    这里只读状态文件，**不接触归档口令，也不触发推送**——
    推送由每日维护在宿主机执行（见 ops/backup-git-archive.sh），
    后端不持有 git-lfs 凭据。
    """
    status_path = "/srv/labgo/backup-git-status.json"
    try:
        with open(status_path, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return {"available": False, "detail": "尚未产生异地归档记录", "archives": []}
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"异地归档状态读取失败：{exc}") from exc
    data["available"] = True
    return data

@router.delete("/api/admin/backups/{snapshot}")
async def api_admin_backup_forget(
    snapshot: str, user: dict[str, Any] = Depends(require_admin)
) -> dict[str, Any]:
    """删除一个备份快照（管理员显式操作）。

    备份是最后一道恢复手段，因此这里坚持「一次一个、必须给出完整或前缀 ID」，
    不做「清空全部备份」的批量入口；真正的 restic 调用留在宿主机脚本里，
    后端只做参数转发与错误透传。
    """
    from .golink import backup_forget

    snap = (snapshot or "").strip()
    if not snap or not all(c in "0123456789abcdefABCDEF" for c in snap):
        raise HTTPException(status_code=400, detail="快照 ID 必须是十六进制")
    if not 8 <= len(snap) <= 64:
        raise HTTPException(status_code=400, detail="快照 ID 长度应为 8–64 位")
    ok, detail = await backup_forget(snap)
    if not ok:
        raise HTTPException(status_code=502, detail=f"删除备份失败：{detail}")
    return {"ok": True, "snapshot": snap}

@router.get("/api/admin/health")
async def api_admin_health(user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    """全量服务健康（探测由 Go 核心执行）。"""

    services = load_catalog()
    results = await asyncio.gather(*[go_service_health(s.id) for s in services])
    return {
        "services": [
            {"id": s.id, "name": s.name, "category": s.category, "health": h} for s, h in zip(services, results, strict=True)
        ]
    }
