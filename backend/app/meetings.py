"""组会汇报（meeting 源）：按 ISO 周分目录、授权名单与上传入口。

周目录命名：``{ISO 年}-W{周}``（如 ``2026-W48``）。

"谁能看见某周目录"由门户侧的授权名单决定（``labspace.meeting_week_grants``），
"放行谁的读写"由文件核心的 ACL 决定（``PUT /v1/admin/file-access/{name}``）。
两处都要写：名单管界面可见性，ACL 管文件实际读写。老师与管理员默认拥有
全部周目录。

Go 核心那一侧（meeting 源、ISO 周目录创建、压缩）是并行实现的，本模块
通过 ``admin_research`` 里的薄封装调用它；Go 侧未就绪时明确报错，不静默成功。
"""
from __future__ import annotations

import asyncio
import logging
import re
from datetime import date, datetime
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field

from . import db
from .admin_research import (
    casdoor_user_by_id,
    casdoor_user_by_name,
    file_key,
    go_detail_zh,
    identity_grants,
    labgo_admin,
    labgo_user_request,
    merge_grants,
    source_dirs,
    source_entries,
    write_identity_grants,
)
from .config import settings
from .security import has_role, require_csrf, require_user
from .uploads import read_upload_capped

log = logging.getLogger("labspace.meetings")

router = APIRouter(prefix="/api/meetings", tags=["meetings"])

#: 文件核心里的共享源 id（Go 侧与 /srv/lab/meeting 一一对应）。
SOURCE = "meeting"

#: 上传上限（组会材料多为 PDF / 幻灯片，比门户默认上限宽）。
UPLOAD_MAX_BYTES = 50 * 1024 * 1024

_WEEK_RE = re.compile(r"^(\d{4})-W(\d{1,2})$", re.IGNORECASE)


# ------------------------------------------------------------------ 周目录命名

def iso_week_label(moment: date | None = None) -> str:
    """ISO 周目录名：``{年}-W{周}``（如 ``2026-W48``）。

    规则是 ISO-8601：周一为一周之始，含 1 月 4 日的那一周记作该年的第 1 周。
    文件核心（``labfiles.ISOWeekFolder``）必须用同一条规则，否则同一周会出现
    两个目录名，压缩任务会把刚落盘的那一周当成旧周处理。
    """
    day = moment or date.today()
    iso = day.isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def parse_year_week(value: str) -> str:
    """校验并规范化周目录名（``2026-w48`` → ``2026-W48``）。"""
    match = _WEEK_RE.match(str(value or "").strip())
    if not match:
        raise HTTPException(status_code=400, detail="周目录名格式应为 2026-W48")
    year, week = int(match.group(1)), int(match.group(2))
    if not 1 <= week <= 53:
        raise HTTPException(status_code=400, detail="周序号超出范围（1-53）")
    return f"{year}-W{week:02d}"


# ------------------------------------------------------------------ 授权名单（门户库）

def _db_grants(year_week: str) -> list[dict[str, Any]]:
    return db.query(
        "SELECT year_week, user_id, granted_by, created_at"
        " FROM labspace.meeting_week_grants WHERE year_week = %s ORDER BY user_id",
        (year_week,),
    )


def _db_all_weeks() -> list[str]:
    rows = db.query(
        "SELECT DISTINCT year_week FROM labspace.meeting_week_grants ORDER BY year_week"
    )
    return [str(r["year_week"]) for r in rows]


def _db_granted_weeks(user_id: str) -> set[str]:
    rows = db.query(
        "SELECT year_week FROM labspace.meeting_week_grants WHERE user_id = %s",
        (str(user_id or ""),),
    )
    return {str(r["year_week"]) for r in rows}


def _db_add_grant(year_week: str, user_id: str, granted_by: str) -> None:
    db.execute(
        "INSERT INTO labspace.meeting_week_grants (year_week, user_id, granted_by, created_at)"
        " VALUES (%s, %s, %s, now())"
        " ON CONFLICT (year_week, user_id) DO UPDATE SET granted_by = EXCLUDED.granted_by",
        (year_week, str(user_id), str(granted_by or "")),
    )


def _db_remove_grant(year_week: str, user_id: str) -> None:
    db.execute(
        "DELETE FROM labspace.meeting_week_grants WHERE year_week = %s AND user_id = %s",
        (year_week, str(user_id)),
    )


def _db_week_state(year_week: str) -> dict[str, Any]:
    rows = db.query(
        "SELECT compressed, compressed_at FROM labspace.meeting_week_state WHERE year_week = %s",
        (year_week,),
    )
    if not rows:
        return {"compressed": False, "compressed_at": None}
    row = rows[0]
    return {
        "compressed": bool(row.get("compressed")),
        "compressed_at": row.get("compressed_at"),
    }


def _db_mark_compressed(year_weeks: list[str]) -> None:
    for week in year_weeks:
        db.execute(
            "INSERT INTO labspace.meeting_week_state (year_week, compressed, compressed_at, updated_at)"
            " VALUES (%s, true, now(), now())"
            " ON CONFLICT (year_week) DO UPDATE SET compressed = true,"
            " compressed_at = now(), updated_at = now()",
            (week,),
        )


# ------------------------------------------------------------------ 权限判定

def _is_teacher(user: dict[str, Any]) -> bool:
    """教师默认拥有全部周目录。

    刻意**不含管理员**：管理员的职责是平台运维，教师视图（全部组会目录、
    课题资料目录）是另一类职责，两者不应互相穿透。
    需要兼具的话，给账号同时加上 lab-teacher 组。
    """
    return has_role(user, settings.teacher_roles)


def _actor(user: dict[str, Any]) -> str:
    return str(user.get("name") or user.get("email") or user.get("sub") or "")


async def _visible_weeks(user: dict[str, Any]) -> set[str] | None:
    """调用者可见的周目录；None 表示不限（老师 / 管理员）。"""
    if _is_teacher(user):
        return None
    return await asyncio.to_thread(_db_granted_weeks, str(user.get("sub") or ""))


async def _require_week_access(user: dict[str, Any], week: str) -> str:
    """访问某周目录：老师 / 管理员，或该周的授权人。返回周目录名。"""
    if _is_teacher(user):
        return week
    granted = await asyncio.to_thread(_db_granted_weeks, str(user.get("sub") or ""))
    if week in granted:
        return week
    raise HTTPException(status_code=403, detail="没有该周目录的访问权限")


async def _require_week_manager(user: dict[str, Any], week: str) -> str:
    """管理某周目录：老师 / 管理员，或该周的授权人。返回周目录名。"""
    if _is_teacher(user):
        return week
    granted = await asyncio.to_thread(_db_granted_weeks, str(user.get("sub") or ""))
    if week in granted:
        return week
    raise HTTPException(status_code=403, detail="没有该周目录的管理权限")


# ------------------------------------------------------------------ ACL 同步

def _week_grant(week: str) -> dict[str, Any]:
    """某个账号在某个周目录上的授权（查看 / 下载 / 上传 / 修改）。"""
    return {
        "source": SOURCE,
        "path": week,
        "view": True,
        "download": True,
        "create": True,
        "modify": True,
    }


async def _sync_week_grant(
    account: dict[str, Any], week: str, *, grant: bool
) -> tuple[bool, str]:
    """把某个账号在某个周目录上的授权同步到文件核心。

    文件核心的写接口是全量替换语义，因此必须把该账号的其它授权一起回写。
    """
    key = file_key(account)
    existing = await identity_grants(key)
    if existing is None:
        return False, "无法读取文件核心的授权状态，未改动授权"
    if grant:
        merged = merge_grants(existing, [_week_grant(week)])
    else:
        merged = [
            g
            for g in merge_grants(existing, [])
            if not (
                str(g.get("source") or "") == SOURCE and str(g.get("path") or "") == week
            )
        ]
    ok, detail = await write_identity_grants(key, merged)
    return ok, "" if ok else detail


async def _ensure_meeting_folder(request: Request, week: str) -> tuple[bool, str, str]:
    """确保周目录存在（文件核心的目录级授权要求目录先存在）。

    先按调用者身份调用（目录由谁建谁负责），文件核心若把该能力放在管理
    接口上则退回服务令牌再试一次；两边都不行才报错。

    返回 ``(是否成功, 目录名, 错误原因)``：目录名以文件核心返回的为准
    （它是文件树命名的主人）。
    """
    status, payload = await labgo_user_request(
        "POST",
        "/v1/files/ensure-meeting-folder",
        request,
        json_body={"yearWeek": week},
    )
    if status == 200:
        path = str((payload or {}).get("path") or week) if isinstance(payload, dict) else week
        return True, path or week, ""
    ok, detail = await labgo_admin(
        "POST", "/v1/files/ensure-meeting-folder", {"yearWeek": week}
    )
    if ok:
        path = str(detail.get("path") or week) if isinstance(detail, dict) else week
        return True, path or week, ""
    message = ""
    if isinstance(payload, dict):
        message = str(payload.get("error") or "")
    return False, week, message or str(detail) or f"文件核心返回 {status}"


def _upload_name(display_name: str, fallback: str, moment: datetime) -> str:
    """归档文件名：``{上传人姓名}_{时间戳}``（便于按人按周汇总）。"""
    who = str(display_name or fallback or "未署名").strip() or "未署名"
    who = re.sub(r"[/\\]+", "_", who)
    return f"{who}_{moment.strftime('%Y%m%d-%H%M%S')}"


def _casdoor_display_name(user_id: str) -> str:
    """取账号的显示名（上传文件名里用）。"""
    account = casdoor_user_by_id(user_id)
    if not account:
        return ""
    return str(account.get("display_name") or account.get("name") or "")


def _split_name(filename: str) -> tuple[str, str]:
    """拆出 (基名, 扩展名)；没有扩展名时返回 ("", "")。"""
    base = str(filename or "")
    if "." not in base:
        return base, ""
    stem, ext = base.rsplit(".", 1)
    return stem, f".{ext}"


# ------------------------------------------------------------------ 接口

class GrantBody(BaseModel):
    userId: str = Field(min_length=1, max_length=64)


class CompressBody(BaseModel):
    keepWeeks: int = Field(default=8, ge=1, le=520)


def _resolve_account(user_id: str) -> dict[str, Any] | None:
    """按 Casdoor 用户 id 或登录名取账号。"""
    account = casdoor_user_by_id(user_id)
    if account:
        return account
    return casdoor_user_by_name(user_id)


@router.get("/weeks")
async def list_weeks(
    request: Request, user: dict[str, Any] = Depends(require_user)
) -> dict[str, Any]:
    """列出已有周目录：授权名单、文件数、占用空间与是否已压缩。"""
    visible = await _visible_weeks(user)
    entries = await source_entries(request, SOURCE)
    dirs, sizes = source_dirs(entries)
    weeks = set(dirs) | set(await asyncio.to_thread(_db_all_weeks))
    if visible is not None:
        weeks &= visible

    out: list[dict[str, Any]] = []
    for week in sorted(weeks):
        grants = []
        for row in await asyncio.to_thread(_db_grants, week):
            account = casdoor_user_by_id(str(row.get("user_id") or ""))
            grants.append(
                {
                    "userId": str(row.get("user_id") or ""),
                    "name": str((account or {}).get("display_name") or (account or {}).get("name") or ""),
                    "account": str((account or {}).get("name") or ""),
                    "grantedBy": str(row.get("granted_by") or ""),
                    "createdAt": str(row.get("created_at") or ""),
                }
            )
        files = [
            e
            for e in (entries or [])
            if not e.get("dir") and str(e.get("path") or "").startswith(f"{week}/")
        ]
        state = await asyncio.to_thread(_db_week_state, week)
        out.append(
            {
                "yearWeek": week,
                "grants": grants,
                "fileCount": len(files),
                "sizeBytes": sizes.get(week, 0),
                "compressed": bool(state.get("compressed")),
                "compressedAt": str(state.get("compressed_at") or ""),
            }
        )
    return {
        "weeks": out,
        "total": len(out),
        "currentWeek": iso_week_label(),
        "storageAvailable": entries is not None,
    }


@router.post("/weeks/{year_week}/grant")
async def grant_week(
    year_week: str,
    body: GrantBody,
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    """给某个账号开通某个周目录的访问权（名单 + ACL 同时写）。"""
    week = parse_year_week(year_week)
    week = await _require_week_manager(user, week)
    account = await asyncio.to_thread(_resolve_account, body.userId)
    if not account:
        raise HTTPException(status_code=404, detail="账号不存在")

    target_id = str(account.get("id") or "")
    # 目录级授权要求**目录先存在**（文件核心写 ACL 时会 stat 目标路径），
    # 所以先确保周目录已建好，再写名单与 ACL。
    ready, _, folder_detail = await _ensure_meeting_folder(request, week)
    if not ready:
        raise HTTPException(status_code=502, detail=f"组会目录准备失败：{folder_detail}")
    ok, detail = await _sync_week_grant(account, week, grant=True)
    if not ok:
        raise HTTPException(status_code=502, detail=f"组会目录授权写入失败：{detail}")
    await asyncio.to_thread(_db_add_grant, week, target_id, _actor(user))
    return {
        "ok": True,
        "yearWeek": week,
        "user": {
            "userId": target_id,
            "name": str(account.get("display_name") or account.get("name") or ""),
            "account": str(account.get("name") or ""),
        },
    }


@router.delete("/weeks/{year_week}/grant/{user_id}")
async def revoke_week(
    year_week: str,
    user_id: str,
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    """收回某个账号在某个周目录上的访问权（名单 + ACL 同时删）。"""
    week = parse_year_week(year_week)
    week = await _require_week_manager(user, week)
    account = await asyncio.to_thread(_resolve_account, user_id)
    target_id = str((account or {}).get("id") or user_id)

    ok, detail = await _sync_week_grant(account, week, grant=False) if account else (True, "")
    if not ok:
        raise HTTPException(status_code=502, detail=f"组会目录授权收回失败：{detail}")
    await asyncio.to_thread(_db_remove_grant, week, target_id)
    return {"ok": True, "yearWeek": week, "userId": target_id}


@router.get("/weeks/{year_week}/files")
async def list_week_files(
    year_week: str,
    request: Request,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """某个周目录的文件列表（仅授权人可见，未授权返回 403）。"""
    week = parse_year_week(year_week)
    week = await _require_week_access(user, week)
    entries = await source_entries(request, SOURCE)
    files = []
    for entry in entries or []:
        path = str(entry.get("path") or "")
        if entry.get("dir") or not path.startswith(f"{week}/"):
            continue
        files.append(
            {
                "name": str(entry.get("name") or path.rsplit("/", 1)[-1]),
                "path": path,
                "size": int(entry.get("size") or 0),
                "modified": str(entry.get("modified") or ""),
            }
        )
    files.sort(key=lambda f: (f["modified"], f["name"]), reverse=True)
    return {
        "yearWeek": week,
        "files": files,
        "total": len(files),
        "sizeBytes": sum(f["size"] for f in files),
        "storageAvailable": entries is not None,
    }


class WeekFileDelete(BaseModel):
    """删除周目录里的一个文件。"""

    path: str = Field(min_length=1, max_length=512)


@router.post("/weeks/{year_week}/delete")
async def delete_week_file(
    year_week: str,
    body: WeekFileDelete,
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    """删除周目录里的一个文件（进回收站，7 天内可恢复）。

    权限：需要该周目录的**管理权**（教师或该周授权人）；
    文件核心那一层还会再按 ACL 判一次 delete。

    路径校验是安全关键：只允许删除**本周目录下的一级文件**，
    不接受 ``..``、不接受子目录、不接受跨周——否则等于给了一个
    "按路径删任意文件"的入口。
    """
    week = parse_year_week(year_week)
    week = await _require_week_manager(user, week)
    raw = str(body.path or "").strip().replace("\\", "/")
    if ".." in raw or raw.startswith("/"):
        raise HTTPException(status_code=400, detail="路径不合法")
    prefix = f"{week}/"
    if not raw.startswith(prefix):
        raise HTTPException(status_code=400, detail="只能删除本周目录下的文件")
    rest = raw[len(prefix):]
    if not rest or "/" in rest:
        raise HTTPException(status_code=400, detail="只能删除本周目录下的一级文件，不支持子目录")

    # 先按路径找条目 id：文件核心的删除接口接受 id。
    entries = await source_entries(request, SOURCE)
    target = None
    for entry in entries or []:
        if str(entry.get("path") or "") == raw and not entry.get("dir"):
            target = entry
            break
    if target is None:
        raise HTTPException(status_code=404, detail="文件不存在或已被删除")

    status, payload = await labgo_user_request(
        "DELETE", f"/v1/files/{target.get('id')}", request
    )
    if status != 200:
        detail = ""
        if isinstance(payload, dict):
            detail = str(payload.get("error") or "")
        raise HTTPException(
            status_code=502 if status >= 500 else status,
            detail=f"删除失败：{go_detail_zh(detail) or status}",
        )
    return {"ok": True, "yearWeek": week, "path": raw, "name": target.get("name")}


async def _store_meeting_file(
    request: Request, folder_path: str, name: str, raw: bytes, mime: str
) -> tuple[int, Any]:
    """把文件写进周目录（权限判定在文件核心）。"""
    return await labgo_user_request(
        "POST",
        "/v1/files/upload",
        request,
        params={"source": SOURCE, "dir": folder_path},
        files={"file": (name, raw, mime)},
    )


@router.post("/upload")
async def upload_meeting_file(
    request: Request,
    file: UploadFile = File(...),
    yearWeek: str = Form(""),
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    """组会材料上传入口：落到 ``meeting/<年-周>/``，文件名带上传人姓名与时间戳。"""
    week = parse_year_week(yearWeek) if yearWeek.strip() else iso_week_label()
    week = await _require_week_access(user, week)

    raw = await read_upload_capped(
        file, UPLOAD_MAX_BYTES, message="组会材料超过 50 MB 上限"
    )
    if not raw:
        raise HTTPException(status_code=400, detail="文件内容为空")

    ok, folder_path, detail = await _ensure_meeting_folder(request, week)
    if not ok:
        raise HTTPException(status_code=502, detail=f"组会目录准备失败：{detail}")
    if folder_path != week:
        # 文件核心是文件树命名的主人：它给的目录名与本地算的不一致时以它为准。
        log.warning("组会周目录名不一致：本地 %s，文件核心 %s", week, folder_path)

    account = await asyncio.to_thread(_casdoor_display_name, str(user.get("sub") or ""))
    stem, ext = _split_name(str(file.filename or ""))
    name = _upload_name(account, str(user.get("name") or ""), datetime.now()) + ext
    mime = str(file.content_type or "application/octet-stream")
    status, payload = await _store_meeting_file(request, folder_path, name, raw, mime)
    if status != 200:
        message = str(payload.get("error") or "") if isinstance(payload, dict) else ""
        if status == 403:
            raise HTTPException(status_code=403, detail="当前账号没有该周目录的写入权限")
        raise HTTPException(status_code=502, detail=message or f"文件核心返回 {status}")
    entry = payload.get("entry") if isinstance(payload, dict) else {}
    entry = entry if isinstance(entry, dict) else {}
    return {
        "ok": True,
        "yearWeek": week,
        "path": str(entry.get("path") or f"{folder_path}/{name}"),
        "file": {
            "name": str(entry.get("name") or name),
            "size": int(entry.get("size") or len(raw)),
            "modified": str(entry.get("modified") or ""),
            "originalName": stem + ext,
        },
        "uploadedBy": account or str(user.get("name") or ""),
    }


@router.post("/compress")
async def compress_meetings(
    body: CompressBody,
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    """压缩历史周目录（由文件核心执行，门户只转发并记录结果）。"""
    if not _is_teacher(user):
        raise HTTPException(status_code=403, detail="需要教师或管理员权限")

    status, payload = await labgo_user_request(
        "POST",
        "/v1/files/compress-meetings",
        request,
        json_body={"keepWeeks": body.keepWeeks},
    )
    compressed: list[str] = []
    if status == 200 and isinstance(payload, dict):
        raw = payload.get("compressed")
        if isinstance(raw, list):
            compressed = [str(x) for x in raw]
    else:
        ok, detail = await labgo_admin(
            "POST", "/v1/files/compress-meetings", {"keepWeeks": body.keepWeeks}
        )
        if not ok:
            raise HTTPException(
                status_code=502,
                detail=f"文件核心尚未提供组会压缩能力（待 Go 侧就绪）：{detail}",
            )
        raw = detail.get("compressed") if isinstance(detail, dict) else None
        compressed = [str(x) for x in raw] if isinstance(raw, list) else []

    if compressed:
        await asyncio.to_thread(_db_mark_compressed, compressed)
    return {
        "ok": True,
        "keepWeeks": body.keepWeeks,
        "compressed": compressed,
    }
