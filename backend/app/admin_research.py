"""课题资料（research 源）：目录命名、清单与 ACL 同步。

目录名规则：``{进组时间YYYY-MM-DD}-{学生姓名}``。
「进组时间」直接取 Casdoor ``public."user".created_time``（不新增字段）；
姓名取 ``display_name``，为空时退回登录名。

授权写入复用「用户和权限」同一条通道：``PUT /v1/admin/file-access/{name}``
（``X-Lab-Service-Token``）。老师与管理员对整源的 scope 由 Go 核心的预配置
组（lab-teacher / lab-admin）提供，本模块不重复写，只写学生那一条。

Go 核心那一侧（research 源、目录创建）是并行实现的，因此本模块与
``meetings.py`` 共用的文件核心调用集中在这里的薄封装里：
``labgo_admin`` / ``labgo_user_request`` / ``source_entries`` /
``ensure_source_dir``。Go 侧未就绪时统一报错并说明原因，不静默成功。
"""
from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import accounts
from .config import settings
from .security import has_role, require_csrf, require_user

log = logging.getLogger("labspace.research")

router = APIRouter(prefix="/api/admin/research", tags=["research"])
student_router = APIRouter(prefix="/api/research", tags=["research"])

#: 文件核心里的共享源 id（Go 侧与 /srv/lab/research 一一对应）。
SOURCE = "research"

_DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")
_UNSAFE_NAME_RE = re.compile(r"[/\\]+")


# ------------------------------------------------------------------ 命名规则

def _person_name(display_name: str, name: str) -> str:
    """姓名：``display_name`` 优先，为空退回登录名；路径分隔符换成下划线。"""
    for candidate in (display_name, name):
        cleaned = _UNSAFE_NAME_RE.sub("_", str(candidate or "").strip()).strip(". ")
        if cleaned:
            return cleaned
    return ""


def _join_date(created_at: str) -> str:
    """把 Casdoor 的进组时间解析成 ``YYYY-MM-DD``。

    Casdoor 的 ``created_time`` 有三种历史写法，必须都认：
    * RFC3339：``2026-11-06T19:41:39+08:00``（新建账号）
    * Unix 秒：``1792933144``（早期通过脚本建的账号）
    * 日期：``2026-11-06 19:41:39``（手工导入）
    解析不出来就返回空串，由调用方给出"缺少进组时间"的明确提示，
    而不是拼一个错误的目录名。
    """
    raw = str(created_at or "").strip()
    if not raw:
        return ""
    m = _DATE_RE.match(raw)
    if m:
        return m.group(1)
    if raw.isdigit():
        # Unix 秒（10 位）或毫秒（13 位）
        value = int(raw)
        if value > 10_000_000_000:
            value //= 1000
        try:
            return datetime.fromtimestamp(value).astimezone().strftime("%Y-%m-%d")
        except (OSError, OverflowError, ValueError):
            return ""
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d")
    except ValueError:
        return ""


def research_folder_name(created_at: str, display_name: str, name: str) -> str:
    """课题资料目录名：``{进组时间YYYY-MM-DD}-{姓名}``。

    进组时间取 Casdoor 的 ``created_time``。缺时间或缺姓名时抛 ValueError，
    由调用方转成 400 —— 目录名写错比不给目录更糟。
    """
    day = _join_date(str(created_at or "").strip())
    person = _person_name(display_name, name)
    if not day:
        raise ValueError("账号缺少进组时间，无法生成课题资料目录名")
    if not person:
        raise ValueError("账号缺少姓名，无法生成课题资料目录名")
    return f"{day}-{person}"


# ------------------------------------------------- 文件核心薄封装（research / meeting 共用）

async def labgo_admin(
    method: str, path: str, payload: dict[str, Any] | None = None
) -> tuple[bool, Any]:
    """调用文件核心的管理接口（服务令牌）。

    与「用户和权限」页面走同一条通道。返回 ``(成功?, 数据或错误原因)``；
    失败不抛异常，由调用方决定提示文案。
    """
    token = (settings.service_token or "").strip()
    if not token:
        return False, "内部服务令牌未配置"
    headers = {"X-Lab-Service-Token": token}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.request(
                method, f"{settings.labgo_base}{path}", json=payload, headers=headers
            )
    except Exception as exc:  # noqa: BLE001
        return False, f"文件核心不可达（{exc.__class__.__name__}）"
    if resp.status_code != 200:
        detail = ""
        try:
            detail = str((resp.json() or {}).get("error") or "")
        except Exception:  # noqa: BLE001
            detail = (resp.text or "")[:200]
        return False, detail or f"文件核心返回 {resp.status_code}"
    try:
        return True, resp.json()
    except Exception:  # noqa: BLE001
        return False, "文件核心返回了无法解析的响应"


def upstream_headers(request: Request) -> dict[str, str]:
    """转发调用者的会话（写操作同时转发 CSRF 头）。

    权限判定始终由文件核心按调用者身份做，后端不代替它放行。
    """
    headers = {"cookie": request.headers.get("cookie", "")}
    csrf = request.headers.get("x-csrf-token", "")
    if csrf:
        headers["X-CSRF-Token"] = csrf
    return headers


async def labgo_user_request(
    method: str,
    path: str,
    request: Request,
    *,
    params: dict[str, Any] | None = None,
    json_body: Any = None,
    files: Any = None,
) -> tuple[int, Any]:
    """以调用者身份调用文件核心的公开接口，返回 ``(状态码, 响应体)``。"""
    if not settings.labgo_base:
        return 503, {"error": "文件核心尚未配置"}
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.request(
                method,
                f"{settings.labgo_base}{path}",
                params=params,
                json=json_body,
                files=files,
                headers=upstream_headers(request),
            )
    except Exception as exc:  # noqa: BLE001
        return 503, {"error": f"文件核心暂不可用（{exc.__class__.__name__}）"}
    try:
        payload = resp.json()
    except ValueError:
        payload = {"error": (resp.text or "")[:200]}
    return resp.status_code, payload


async def source_entries(request: Request, source: str) -> list[dict[str, Any]] | None:
    """列出某个共享源的可见条目；源尚未启用或不可达时返回 None。"""
    status, payload = await labgo_user_request(
        "GET", "/v1/files", request, params={"source": source}
    )
    if status != 200 or not isinstance(payload, dict):
        return None
    entries = payload.get("entries")
    if not isinstance(entries, list):
        return None
    return [e for e in entries if isinstance(e, dict)]


def source_dirs(entries: list[dict[str, Any]] | None) -> tuple[set[str], dict[str, int]]:
    """从条目列表里取出顶层目录与各自的占用空间。"""
    dirs: set[str] = set()
    sizes: dict[str, int] = {}
    for entry in entries or []:
        path = str(entry.get("path") or "")
        if not path:
            continue
        top = path.split("/", 1)[0]
        dirs.add(top)
        if not entry.get("dir"):
            sizes[top] = sizes.get(top, 0) + int(entry.get("size") or 0)
    return dirs, sizes


async def ensure_source_dir(request: Request, source: str, path: str) -> tuple[bool, str]:
    """确保共享源下的目录存在；已存在视为成功。

    文件核心的目录级授权要求目录先存在，因此开课题资料时先建目录再写 ACL。
    """
    status, payload = await labgo_user_request(
        "POST", "/v1/files/mkdir", request, json_body={"source": source, "path": path}
    )
    if status == 200:
        return True, ""
    if status == 409:
        return True, ""
    detail = ""
    if isinstance(payload, dict):
        detail = str(payload.get("error") or "")
    if status == 404:
        return False, f"文件核心尚未启用 {source} 源（待 Go 侧就绪）"
    return False, detail or f"文件核心返回 {status}"


# ------------------------------------------------------------------ ACL 读写

#: 文件核心的英文拒绝原因 → 中文提示（未收录的原样回显）。
_GO_DETAIL_ZH = {
    "access must be read, write or deny": "文件核心尚未支持目录级布尔授权（待 Go 侧就绪）",
    "unknown shared source": "文件核心尚未启用该共享源（待 Go 侧就绪）",
    "unknown directory": "目录不存在，请先在文件管理中创建",
    "invalid user name": "账号名称不合法",
    "permission denied": "当前账号没有该目录的写入权限",
}


def go_detail_zh(detail: Any) -> str:
    """把文件核心的英文原因翻成中文（未收录的原样回显）。"""
    text = str(detail or "").strip()
    if not text:
        return "未知原因"
    for needle, chinese in _GO_DETAIL_ZH.items():
        if needle in text:
            return chinese
    return text


async def _acl_state() -> dict[str, Any] | None:
    ok, data = await labgo_admin("GET", "/v1/admin/file-access")
    return data if ok and isinstance(data, dict) else None


def identity_grants_of(state: dict[str, Any] | None, key: str) -> list[dict[str, Any]]:
    """某账号在文件核心里的全部目录授权。"""
    scopes = (state or {}).get("scopes")
    if not isinstance(scopes, dict):
        return []
    grants = scopes.get(key)
    if not isinstance(grants, list):
        return []
    return [g for g in grants if isinstance(g, dict)]


def normalize_grant(grant: dict[str, Any]) -> dict[str, Any]:
    """把既有授权补齐成布尔权限形状。

    文件核心的新旧两版授权字段不同（``access`` 档位 / 布尔权限位）。回写时
    必须把两种形状都带上，否则升级过程中会把别人的权限悄悄清空。
    """
    out: dict[str, Any] = {
        "source": str(grant.get("source") or ""),
        "path": str(grant.get("path") or ""),
    }
    access = str(grant.get("access") or "").strip().lower()
    if access == "deny":
        out.update(
            {
                "view": False,
                "download": False,
                "create": False,
                "modify": False,
                "delete": False,
                "deny": True,
                "access": access,
            }
        )
        return out
    if grant.get("view") is None:
        writable = access == "write"
        out.update(
            {
                "view": True,
                "download": True,
                "create": writable,
                "modify": writable,
                "delete": writable,
            }
        )
    else:
        out.update(
            {
                "view": bool(grant.get("view")),
                "download": bool(grant.get("download")),
                "create": bool(grant.get("create")),
                "modify": bool(grant.get("modify")),
                "delete": bool(grant.get("delete")),
            }
        )
    if access:
        out["access"] = access
    return out


def merge_grants(
    existing: list[dict[str, Any]], managed: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """受管授权覆盖同一 ``(source, path)`` 的旧条目，其余原样保留。"""
    replaced = {
        (str(g.get("source") or ""), str(g.get("path") or "")) for g in managed
    }
    out = [
        normalize_grant(g)
        for g in existing
        if (str(g.get("source") or ""), str(g.get("path") or "")) not in replaced
    ]
    out.extend(managed)
    return out


async def identity_grants(key: str) -> list[dict[str, Any]] | None:
    """读取某账号当前的目录授权；读不到时返回 None（调用方必须中止写入）。"""
    state = await _acl_state()
    if state is None:
        return None
    return identity_grants_of(state, key)


def to_access_grant(grant: dict[str, Any]) -> dict[str, Any]:
    """把内部权限形状转成文件核心要的形状。

    门户内部用布尔位（view/download/create/modify/deny）表达权限，
    而文件核心的授权接口只认 ``{source, path, access}``，access ∈
    read/write/deny。两边形状不一致时写入会被直接拒收（400）。
    """
    scope = normalize_grant(grant)
    if scope.get("deny"):
        access = "deny"
    elif scope.get("create") or scope.get("modify") or scope.get("delete"):
        access = "write"
    else:
        access = "read"
    # 只回传文件核心认识的三个字段：多带一个键就会被 DisallowUnknownFields 拒收
    return {"source": str(scope.get("source") or ""), "path": str(scope.get("path") or ""), "access": access}


async def write_identity_grants(
    key: str, grants: list[dict[str, Any]]
) -> tuple[bool, str]:
    """整体替换某账号的目录授权（文件核心的写接口是全量替换语义）。

    写入前统一转换成文件核心的 ``access`` 形状。
    """
    payload = [to_access_grant(g) for g in grants]
    ok, detail = await labgo_admin(
        "PUT", f"/v1/admin/file-access/{quote(key, safe='')}", {"grants": payload}
    )
    if not ok:
        return False, str(detail)
    return True, ""


# ------------------------------------------------------------------ Casdoor 账号

def _casdoor_users() -> list[dict[str, Any]]:
    """Casdoor 账号列表（含进组时间）。

    复用 accounts 模块的 Casdoor 连接池；accounts.py 不在本次改动范围内，
    所以这里只调用不修改。
    """
    rows = accounts._query(
        """
        SELECT id, name, display_name, email, groups, created_time
          FROM public."user"
         WHERE owner = %s AND is_deleted = false AND is_forbidden = false
         ORDER BY name
         LIMIT 1000
        """,
        (accounts.OWNER,),
    )
    return [dict(r) for r in rows]


def _casdoor_user_by_name(name: str) -> dict[str, Any] | None:
    rows = accounts._query(
        """
        SELECT id, name, display_name, email, groups, created_time
          FROM public."user"
         WHERE owner = %s AND name = %s AND is_deleted = false
        """,
        (accounts.OWNER, str(name or "").strip().lower()),
    )
    return dict(rows[0]) if rows else None


def _casdoor_user_by_id(uid: str) -> dict[str, Any] | None:
    rows = accounts._query(
        """
        SELECT id, name, display_name, email, groups, created_time
          FROM public."user"
         WHERE owner = %s AND id = %s AND is_deleted = false
        """,
        (accounts.OWNER, str(uid or "").strip()),
    )
    return dict(rows[0]) if rows else None


def casdoor_user_by_name(name: str) -> dict[str, Any] | None:
    """按登录名取账号（供 meetings 等模块复用）。"""
    return _casdoor_user_by_name(name)


def casdoor_user_by_id(uid: str) -> dict[str, Any] | None:
    """按 Casdoor 用户 id 取账号（会话里的 ``sub``）。"""
    return _casdoor_user_by_id(uid)


def file_key(account: dict[str, Any]) -> str:
    """文件核心的身份键（与 Go 侧一致：邮箱优先）。"""
    return accounts._file_key(account)


def _require_teacher(user: dict[str, Any]) -> dict[str, Any]:
    """只有**教师**能管理课题资料目录。

    刻意不含管理员：管理员的职责是平台运维（账号、服务、备份），
    教师视图（学生的课题资料目录）是另一类职责，两者不应互相穿透。
    需要兼具的话，给账号同时加上 lab-teacher 组。
    """
    if has_role(user, settings.teacher_roles):
        return user
    raise HTTPException(status_code=403, detail="需要教师权限（lab-teacher 用户组）")


def _actor(user: dict[str, Any]) -> str:
    return str(user.get("name") or user.get("email") or user.get("sub") or "")


# ------------------------------------------------------------------ 接口

class FolderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)


def _folder_view(
    folder: str, account: dict[str, Any] | None, used_bytes: int, granted: bool
) -> dict[str, Any]:
    created = str((account or {}).get("created_time") or "")
    return {
        "name": folder,
        "source": SOURCE,
        "path": folder,
        "displayName": str((account or {}).get("display_name") or (account or {}).get("name") or ""),
        "account": str((account or {}).get("name") or ""),
        "userId": str((account or {}).get("id") or ""),
        "joinedAt": created[:10],
        "usedBytes": int(used_bytes),
        "granted": bool(granted),
        "owned": bool(account),
    }


@router.get("/folders")
async def list_folders(
    request: Request, user: dict[str, Any] = Depends(require_user)
) -> dict[str, Any]:
    """列出所有学生的课题资料目录（Casdoor 账号 + 文件存储实际目录两边合并）。"""
    _require_teacher(user)
    users = await asyncio.to_thread(_casdoor_users)
    state = await _acl_state()
    entries = await source_entries(request, SOURCE)
    dirs, sizes = source_dirs(entries)

    folders: list[dict[str, Any]] = []
    seen: set[str] = set()
    for account in users:
        try:
            folder = research_folder_name(
                str(account.get("created_time") or ""),
                str(account.get("display_name") or ""),
                str(account.get("name") or ""),
            )
        except ValueError:
            continue
        key = file_key(account)
        granted = any(
            str(g.get("source") or "") == SOURCE and str(g.get("path") or "") == folder
            for g in identity_grants_of(state, key)
        )
        if folder not in dirs and not granted:
            continue
        seen.add(folder)
        folders.append(_folder_view(folder, account, sizes.get(folder, 0), granted))

    # 存储里有、但账号对不上的目录（历史遗留或改了姓名）也要看得见，
    # 否则管理员会以为目录凭空消失了。
    for folder in sorted(dirs - seen):
        folders.append(_folder_view(folder, None, sizes.get(folder, 0), False))

    folders.sort(key=lambda f: (f["displayName"] or f["name"], f["name"]))
    return {
        "folders": folders,
        "total": len(folders),
        "storageAvailable": entries is not None,
    }


@router.post("/folders")
async def create_folder(
    body: FolderCreate,
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    """为某个学生开一份课题资料：建目录 + 写 ACL（老师与学生共用）。"""
    _require_teacher(user)
    account = await asyncio.to_thread(_casdoor_user_by_name, body.name)
    if not account:
        raise HTTPException(status_code=404, detail="账号不存在")
    try:
        folder = research_folder_name(
            str(account.get("created_time") or ""),
            str(account.get("display_name") or ""),
            str(account.get("name") or ""),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    ok, detail = await ensure_source_dir(request, SOURCE, folder)
    if not ok:
        raise HTTPException(status_code=502, detail=f"课题资料目录创建失败：{go_detail_zh(detail)}")

    state = await _acl_state()
    if state is None:
        raise HTTPException(status_code=502, detail="无法读取文件核心的授权状态，未改动授权")
    key = file_key(account)
    managed = [
        {
            "source": SOURCE,
            "path": folder,
            "view": True,
            "download": True,
            "create": True,
            "modify": True,
        }
    ]
    merged = merge_grants(identity_grants_of(state, key), managed)
    ok, detail = await write_identity_grants(key, merged)
    if not ok:
        raise HTTPException(status_code=502, detail=f"课题资料授权写入失败：{go_detail_zh(detail)}")

    return {
        "ok": True,
        "folder": _folder_view(folder, account, 0, True),
        "grants": managed,
    }


@router.delete("/folders/{name}")
async def revoke_folder(
    name: str,
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    """收回某个学生的课题资料目录授权（**不删数据**，只收回访问权）。"""
    _require_teacher(user)
    account = await asyncio.to_thread(_casdoor_user_by_name, name)
    if not account:
        raise HTTPException(status_code=404, detail="账号不存在")
    state = await _acl_state()
    if state is None:
        raise HTTPException(status_code=502, detail="无法读取文件核心的授权状态，未改动授权")
    key = file_key(account)
    grants = identity_grants_of(state, key)
    research = [g for g in grants if str(g.get("source") or "") == SOURCE]
    if not research:
        return {"ok": True, "removed": 0, "folders": [], "dataKept": True}
    remaining = [
        normalize_grant(g) for g in grants if str(g.get("source") or "") != SOURCE
    ]
    ok, detail = await write_identity_grants(key, remaining)
    if not ok:
        raise HTTPException(status_code=502, detail=f"课题资料授权收回失败：{go_detail_zh(detail)}")
    return {
        "ok": True,
        "removed": len(research),
        "folders": [str(g.get("path") or "") for g in research],
        "dataKept": True,
    }


@student_router.get("/mine")
async def my_research(
    request: Request, user: dict[str, Any] = Depends(require_user)
) -> dict[str, Any]:
    """学生侧：只返回自己的课题资料目录（能不能看见由 ACL 决定）。"""
    account = await asyncio.to_thread(_casdoor_user_by_id, str(user.get("sub") or ""))
    if account is None:
        # 会话里的 sub 通常就是 Casdoor 的 user id；万一不是（例如服务令牌签的会话），
        # 退回按邮箱前缀（= 账号名）查 —— Casdoor 的 name 列才是账号名，
        # 显示名（display_name）查不到。
        email = str(user.get("email") or "")
        account = await asyncio.to_thread(
            _casdoor_user_by_name, email.split("@", 1)[0] if "@" in email else str(user.get("name") or "")
        )
    if account is None:
        return {"ok": True, "folder": None, "message": "未找到账号信息"}
    try:
        folder = research_folder_name(
            str(account.get("created_time") or ""),
            str(account.get("display_name") or ""),
            str(account.get("name") or ""),
        )
    except ValueError as exc:
        return {"ok": True, "folder": None, "message": str(exc)}

    key = file_key(account)
    grants = await identity_grants(key)
    own = [
        g
        for g in (grants or [])
        if str(g.get("source") or "") == SOURCE and str(g.get("path") or "") == folder
    ]
    dirs, _ = source_dirs(await source_entries(request, SOURCE))
    return {
        "ok": True,
        "folder": {
            "name": folder,
            "path": folder,
            "source": SOURCE,
            "exists": folder in dirs,
            "granted": bool(own),
        },
        "message": "",
    }
