"""docs 路由（由 ops/split_main_module.py 从 main.py 搬出）。"""
from __future__ import annotations

import json
import logging
import os
from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
)
from starlette.datastructures import UploadFile

from ..config import settings
from ..routers.deps import (
    safe_component as _safe_component,
)
from ..security import (
    has_role,
    require_csrf,
    require_user,
)

log = logging.getLogger("labspace.routers.docs")

router = APIRouter()


# ------------------------------------------------------------------ Linux 命令库

CMD_ROOT = os.getenv("LABSPACE_COMMANDS_DIR", "/opt/labspace/cmd")
CMD_INDEX = os.getenv("LABSPACE_COMMANDS_INDEX", "/opt/labspace/cmd-index.json")
_cmd_index: dict[str, dict[str, str]] | None = None

def _load_cmd_index() -> dict[str, dict[str, str]]:
    """加载 linux-command 官方命令索引（621 条）。"""
    global _cmd_index
    if _cmd_index is not None:
        return _cmd_index
    import json

    idx: dict[str, dict[str, str]] = {}
    data_path = CMD_INDEX
    if os.path.isfile(data_path):
        try:
            with open(data_path, encoding="utf-8") as fh:
                raw = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            # 索引文件损坏/读不到时退化成空索引：命令库只是辅助资料，
            # 不该让整个门户因为一个静态文件挂掉。
            log.warning("命令索引不可用（%s）：%s", data_path, exc)
            raw = {}
        for name, meta in (raw.items() if isinstance(raw, dict) else []):
            idx[str(name)] = {
                "name": str(name),
                "desc": str(meta.get("d", "")),
                "path": str(meta.get("p", f"/{name}")),
            }
    _cmd_index = idx
    return idx

@router.get("/api/commands")
async def api_commands(
    q: str = Query("", max_length=100),
    limit: int = Query(60, ge=1, le=2000),
    _: dict = Depends(require_user),
) -> dict[str, Any]:
    """Linux 命令检索：返回官方命令库中匹配的条目。"""
    idx = _load_cmd_index()
    kw = q.strip().lower()
    items = list(idx.values())
    if kw:
        items = [c for c in items if kw in c["name"].lower() or kw in c["desc"].lower()]
        items.sort(key=lambda c: (0 if c["name"].lower() == kw else 1, len(c["name"])))
    else:
        items.sort(key=lambda c: c["name"])
    return {"total": len(idx), "matched": len(items), "items": items[:limit]}

@router.get("/api/commands/{name}")
async def api_command_detail(name: str, _: dict = Depends(require_user)) -> dict[str, Any]:
    """返回某条命令的完整官方说明（Markdown 原文，前端安全渲染）。"""
    safe = _safe_component(name, "cmd")
    path = os.path.join(CMD_ROOT, f"{safe}.md")
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="未找到该命令的说明")
    try:
        with open(path, encoding="utf-8") as fh:
            md = fh.read()
    except OSError as exc:
        raise HTTPException(status_code=404, detail="未找到该命令的说明") from exc
    meta = _load_cmd_index().get(safe, {})
    return {"name": safe, "desc": meta.get("desc", ""), "markdown": md[:200000]}

# ------------------------------------------------------------------ PDF 翻译作业

TRANSLATE_DIR = os.getenv("LABSPACE_TRANSLATE_DIR", "/srv/labdata/translate")
def _env_int(name: str, default: int) -> int:
    """读整数型环境变量；配错时退回默认值并记警告。

    直接 int() 的话，一个写错的环境变量会让**整个模块 import 失败**，
    表现是后端容器起不来（而不是"这个功能用不了"）。
    """
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError:
        log.warning("%s 不是合法整数（%r），使用默认值 %d", name, raw, default)
        return default
    return value if value > 0 else default

TRANSLATE_MAX_BYTES = _env_int("LABSPACE_TRANSLATE_MAX_BYTES", 30 * 1024 * 1024)
TRANSLATE_TIMEOUT = _env_int("LABSPACE_TRANSLATE_TIMEOUT", 900)

TRANSLATE_META_DIR = os.path.join(TRANSLATE_DIR, "meta")

def _job_paths(job_id: str) -> tuple[str, str, str]:
    return (
        os.path.join(TRANSLATE_DIR, "pending", f"{job_id}.pdf"),
        os.path.join(TRANSLATE_DIR, "done", f"{job_id}.json"),
        os.path.join(TRANSLATE_DIR, "done", f"{job_id}.zip"),
    )

def _translate_meta_path(job_id: str) -> str:
    return os.path.join(TRANSLATE_META_DIR, f"{job_id}.json")

def _remember_translate_owner(job_id: str, user: dict[str, Any]) -> None:
    """记录作业归属（工作进程只处理 pending/ 与 done/，不会碰 meta/）。"""
    try:
        os.makedirs(TRANSLATE_META_DIR, exist_ok=True)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"无法准备作业归属目录：{exc}") from exc
    path = _translate_meta_path(job_id)
    try:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(
                {"owner": str(user.get("sub") or ""), "name": str(user.get("name") or "")},
                fh,
            )
        os.chmod(path, 0o644)
    except OSError as exc:
        # 归属信息写不进去就意味着作业会变成"无主"，后台无法按人过滤；
        # 这种情况下必须让请求失败，而不是排一个谁都能看的作业。
        raise HTTPException(status_code=500, detail=f"无法记录作业归属：{exc}") from exc

def _translate_job_allowed(job_id: str, user: dict[str, Any]) -> bool:
    if has_role(user, settings.admin_roles):
        return True
    try:
        with open(_translate_meta_path(job_id), encoding="utf-8") as fh:
            owner = str((json.load(fh) or {}).get("owner") or "")
    except (OSError, json.JSONDecodeError, AttributeError):
        return False
    return bool(owner) and owner == str(user.get("sub") or "")

@router.get("/api/pdf-translate/status")
async def api_translate_status(_: dict = Depends(require_user)) -> dict[str, Any]:
    """翻译服务运行状态（容器、队列深度）。"""
    pending = 0
    pdir = os.path.join(TRANSLATE_DIR, "pending")
    if os.path.isdir(pdir):
        try:
            pending = len([f for f in os.listdir(pdir) if f.endswith(".pdf")])
        except OSError as exc:
            log.debug("读取翻译队列失败: %s", exc)
            pending = 0
    return {"service": "pdf2zh", "pending": pending, "max_bytes": TRANSLATE_MAX_BYTES, "timeout": TRANSLATE_TIMEOUT}

@router.post("/api/pdf-translate/jobs")
async def api_translate_job(
    request: Request,
    user: dict = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    """上传 PDF 排队翻译（大小与类型均受限）。"""
    import uuid

    form = await request.form()
    upload = form.get("file")
    # request.form() 返回 Starlette UploadFile；FastAPI UploadFile 是其子类，
    # 反向 isinstance 会把有效上传误判成字符串。
    if not isinstance(upload, UploadFile):
        raise HTTPException(status_code=400, detail="缺少文件")
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail="文件为空")
    if len(data) > TRANSLATE_MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"文件超过上限 {TRANSLATE_MAX_BYTES // 1024 // 1024} MB")
    if not data.startswith(b"%PDF"):
        raise HTTPException(status_code=400, detail="仅支持 PDF 文件")
    job_id = str(uuid.uuid4())
    pdir = os.path.join(TRANSLATE_DIR, "pending")
    try:
        os.makedirs(pdir, exist_ok=True)
        path, _, _ = _job_paths(job_id)
        with open(path, "wb") as fh:
            fh.write(data)
        # 工作进程容器以非 root 用户运行，需可读
        os.chmod(path, 0o644)
    except OSError as exc:
        # 写不进去就必须让请求失败：否则会出现"排队成功"但工作进程永远等不到文件。
        raise HTTPException(status_code=500, detail=f"无法写入翻译队列：{exc}") from exc
    _remember_translate_owner(job_id, user)
    return {"job_id": job_id, "status": "queued", "size": len(data)}

@router.get("/api/pdf-translate/jobs/{job_id}")
async def api_translate_job_status(job_id: str, user: dict = Depends(require_user)) -> dict[str, Any]:
    import time as _t

    safe = _safe_component(job_id, "job")
    if not _translate_job_allowed(safe, user):
        raise HTTPException(status_code=404, detail="作业不存在")
    pending_path, done_json, done_zip = _job_paths(safe)
    if os.path.isfile(done_json):
        try:
            with open(done_json, encoding="utf-8") as fh:
                loaded = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            # 元数据损坏：按"已完成但内容未知"处理，比报 500 更贴近实际。
            log.warning("翻译作业元数据不可用 %s: %s", done_json, exc)
            loaded = {"status": "done"}
        # json.load 的静态类型是 Any；显式收窄成 dict 后再写入布尔字段，
        # 既让类型检查说得清，也避免 JSON 顶层不是对象时直接崩。
        meta: dict[str, Any] = loaded if isinstance(loaded, dict) else {"status": "done"}
        meta["has_result"] = os.path.isfile(done_zip)
        return meta
    if os.path.isfile(pending_path):
        try:
            age = max(0.0, _t.time() - os.path.getmtime(pending_path))
        except OSError as exc:
            log.warning("读取翻译作业时间失败: %s", exc)
            age = 0.0
        # age 已是 float，用 round 直接得到整数秒（避免再套一层 int()）
        return {"status": "processing" if age > 5 else "queued", "age": round(age)}
    raise HTTPException(status_code=404, detail="作业不存在")

@router.get("/api/pdf-translate/jobs/{job_id}/result")
async def api_translate_result(job_id: str, user: dict = Depends(require_user)):
    from fastapi.responses import FileResponse

    safe = _safe_component(job_id, "job")
    if not _translate_job_allowed(safe, user):
        raise HTTPException(status_code=404, detail="作业不存在")
    _, _, done_zip = _job_paths(safe)
    if not os.path.isfile(done_zip):
        raise HTTPException(status_code=404, detail="结果尚未生成")
    return FileResponse(done_zip, media_type="application/zip", filename=f"translated-{safe}.zip")
