"""Baserow 数据表：门户内原生接入。

每个门户用户对应一个 Baserow 账号（首次访问自动注册，密码随机生成后
使用会话密钥派生的 Fernet 密钥加密存放于 labspace.baserow_accounts）。
管理员（settings.admin_roles）使用 /etc/labspace/baserow-admin.txt 中的
Baserow 管理员身份，便于管理全部工作区。

所有读写都以调用者自身的 Baserow JWT 执行，Baserow 的 ACL 始终是权威；
门户后端只做身份映射与请求转发，不做额外的越权放行。
"""
from __future__ import annotations

import asyncio
import base64
import csv
import hashlib
import io
import logging
import secrets
import time
from typing import Any

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Body, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from . import db
from .config import settings
from .security import has_role, require_csrf, require_user

log = logging.getLogger("labspace.baserow")
router = APIRouter(prefix="/api/baserow", tags=["baserow"])

_TIMEOUT = httpx.Timeout(30.0)
_TOKEN_TTL = 25 * 60
_admin_lock = asyncio.Lock()
_admin_cache: dict[str, Any] = {"token": "", "at": 0.0}
_user_cache: dict[str, tuple[str, float]] = {}

# 人员字段：每个数据库内维护一张由系统账号目录自动同步的镜像表，
# 业务表通过 Baserow 原生 link_row 关联到该表，记录中保存的是可点击的人员标签。
PEOPLE_TABLE_NAME = "系统人员（自动同步）"
PEOPLE_COLUMNS = ("系统ID", "账号", "邮箱", "分组")
_PEOPLE_MARK = "labspace:people:"
_PEOPLE_TTL = 60.0
_people_lock = asyncio.Lock()
_people_setup_lock = asyncio.Lock()
_people_cache: dict[int, tuple[float, list[dict[str, Any]], dict[str, dict[str, Any]]]] = {}


# ------------------------------------------------------------------ 基础

def _base() -> str:
    return settings.baserow_url.rstrip("/")


def _fernet() -> Fernet:
    seed = settings.session_secret or settings.service_token or "labspace-baserow"
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(seed.encode()).digest()))


def _read_admin_file() -> dict[str, str]:
    data: dict[str, str] = {}
    try:
        with open(settings.baserow_admin_file, encoding="utf-8") as fh:
            for line in fh:
                key, sep, value = line.strip().partition("=")
                if sep and key.strip() and value.strip():
                    data[key.strip().lower()] = value.strip()
    except OSError:
        return {}
    return data


def _email(user: dict[str, Any]) -> str:
    email = str(user.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="当前账号缺少邮箱，无法开通数据表")
    return email


def _is_admin(user: dict[str, Any]) -> bool:
    return has_role(user, settings.admin_roles)


def _error_text(resp: httpx.Response) -> str:
    try:
        payload = resp.json()
    except ValueError:
        return resp.text[:300] or f"Baserow HTTP {resp.status_code}"
    if isinstance(payload, dict):
        for key in ("error", "detail", "non_field_errors", "message"):
            value = payload.get(key)
            if value:
                return value if isinstance(value, str) else str(value)
        return str(payload)[:300]
    return str(payload)[:300]


async def _http(method: str, path: str, token: str, *, json_body: Any = None, params: dict[str, Any] | None = None) -> Any:
    headers = {"Host": settings.baserow_host}
    if token:
        headers["Authorization"] = f"JWT {token}"
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.request(method, f"{_base()}{path}", json=json_body, params=params, headers=headers)
    if resp.status_code >= 400:
        exc = HTTPException(status_code=resp.status_code if resp.status_code < 500 else 502, detail=_error_text(resp))
        exc.baserow_status = resp.status_code  # type: ignore[attr-defined]
        raise exc
    if resp.status_code == 204 or not resp.content:
        return None
    try:
        return resp.json()
    except ValueError:
        return resp.text


def _list(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    if isinstance(payload, dict):
        for key in ("results", "data", "items"):
            value = payload.get(key)
            if isinstance(value, list):
                return [x for x in value if isinstance(x, dict)]
    return []


# ------------------------------------------------------------------ 身份

async def _admin_token(force: bool = False) -> str:
    async with _admin_lock:
        if not force and _admin_cache["token"] and time.time() - _admin_cache["at"] < _TOKEN_TTL:
            return _admin_cache["token"]
        creds = _read_admin_file()
        email, password = creds.get("email", ""), creds.get("password", "")
        if not email or not password:
            raise HTTPException(status_code=503, detail="数据表管理员凭据未配置")
        data = await _http("POST", "/api/user/token-auth/", "", json_body={"email": email, "password": password})
        token = str((data or {}).get("token") or "")
        if not token:
            raise HTTPException(status_code=502, detail="数据表管理员登录失败")
        _admin_cache.update(token=token, at=time.time())
        return token


async def _login(email: str, password: str) -> str:
    data = await _http("POST", "/api/user/token-auth/", "", json_body={"email": email, "password": password})
    token = str((data or {}).get("token") or "")
    if not token:
        raise HTTPException(status_code=502, detail="数据表登录失败")
    return token


async def _provision(email: str, name: str) -> str:
    password = secrets.token_urlsafe(24)
    try:
        await _http(
            "POST",
            "/api/user/",
            "",
            json_body={"name": name or email.split("@")[0], "email": email, "password": password, "language": "en", "authenticate": False},
        )
    except HTTPException as exc:
        if getattr(exc, "baserow_status", 0) in (400, 409):
            raise HTTPException(status_code=409, detail="该邮箱已在数据表服务中注册，请联系管理员重置数据表账号") from exc
        raise
    db.execute(
        "INSERT INTO labspace.baserow_accounts (email, secret) VALUES (%s,%s) "
        "ON CONFLICT (email) DO UPDATE SET secret=EXCLUDED.secret",
        (email, _fernet().encrypt(password.encode()).decode()),
    )
    token = await _login(email, password)
    await _auto_setup(token)
    return token


async def _auto_setup(token: str) -> None:
    try:
        workspace = await _http("POST", "/api/workspaces/", token, json_body={"name": "个人空间"})
        wid = int((workspace or {}).get("id") or 0)
        if not wid:
            return
        database = await _http("POST", f"/api/applications/workspace/{wid}/", token, json_body={"name": "数据表", "type": "database"})
        did = int((database or {}).get("id") or 0)
        if did:
            await _http("POST", f"/api/database/tables/database/{did}/", token, json_body={"name": "工作表 1"})
    except Exception:  # noqa: BLE001 - 初始化失败不阻止用户进入页面
        log.warning("baserow auto setup failed", exc_info=True)


async def _user_token(user: dict[str, Any]) -> str:
    email = _email(user)
    cached = _user_cache.get(email)
    if cached and time.time() - cached[1] < _TOKEN_TTL:
        return cached[0]
    rows = db.query("SELECT secret FROM labspace.baserow_accounts WHERE email=%s", (email,))
    if not rows:
        token = await _provision(email, str(user.get("name") or ""))
    else:
        try:
            password = _fernet().decrypt(rows[0]["secret"].encode()).decode()
        except (InvalidToken, ValueError):
            raise HTTPException(status_code=409, detail="数据表凭据无法解密，请联系管理员重置") from None
        token = await _login(email, password)
    _user_cache[email] = (token, time.time())
    return token


async def _token(user: dict[str, Any], force: bool = False) -> str:
    if _is_admin(user):
        return await _admin_token(force=force)
    email = _email(user)
    if force:
        _user_cache.pop(email, None)
    return await _user_token(user)


async def _call(method: str, path: str, user: dict[str, Any], *, json_body: Any = None, params: dict[str, Any] | None = None) -> Any:
    token = await _token(user)
    try:
        return await _http(method, path, token, json_body=json_body, params=params)
    except HTTPException as exc:
        if getattr(exc, "baserow_status", 0) == 401:
            token = await _token(user, force=True)
            return await _http(method, path, token, json_body=json_body, params=params)
        raise


async def _call_lock_retry(method: str, path: str, user: dict[str, Any], *, json_body: Any = None, attempts: int = 6) -> Any:
    """新建表/导入后 Baserow 会对字段短暂加锁并返回 409，稍后重试即可。

    仅用于字段建/改这类幂等操作；记录写入不能盲目重试，否则会产生重复行。
    """
    for attempt in range(attempts):
        try:
            return await _call(method, path, user, json_body=json_body)
        except HTTPException as exc:
            if getattr(exc, "baserow_status", 0) != 409 or attempt == attempts - 1:
                raise
            await asyncio.sleep(0.4 * (attempt + 1))


# ------------------------------------------------------------------ 人员目录

def _people_target(field: dict[str, Any]) -> int:
    """从字段 description 中解析人员字段指向的人员表 id。"""
    if str(field.get("type") or "") != "link_row":
        return 0
    desc = str(field.get("description") or "")
    if not desc.startswith(_PEOPLE_MARK):
        return 0
    try:
        return int(desc[len(_PEOPLE_MARK) :].strip())
    except ValueError:
        return 0


async def _table_meta(table_id: int, user: dict[str, Any]) -> dict[str, Any]:
    data = await _call("GET", f"/api/database/tables/{table_id}/", user)
    return data if isinstance(data, dict) else {}


async def _assert_people_table_mutable(table_id: int, user: dict[str, Any]) -> None:
    if str((await _table_meta(table_id, user)).get("name") or "") == PEOPLE_TABLE_NAME:
        raise HTTPException(status_code=400, detail="系统人员同步表由门户自动维护，不能手动修改结构")


async def _ensure_people_table(database_id: int, user: dict[str, Any]) -> int:
    """确保当前数据库拥有系统人员镜像表，返回人员表 id。"""
    async with _people_setup_lock:
        tables = _list(await _call("GET", f"/api/database/tables/database/{database_id}/", user))
        hit = next((t for t in tables if str(t.get("name") or "") == PEOPLE_TABLE_NAME), None)
        if hit:
            pid = int(hit.get("id") or 0)
        else:
            created = await _call_lock_retry(
                "POST", f"/api/database/tables/database/{database_id}/", user, json_body={"name": PEOPLE_TABLE_NAME}
            )
            pid = int((created or {}).get("id") or 0)
        if not pid:
            raise HTTPException(status_code=502, detail="系统人员同步表创建失败，请稍后重试")

        fields: list[dict[str, Any]] = []
        for _ in range(8):
            fields = _list(await _call("GET", f"/api/database/fields/table/{pid}/", user))
            if fields:
                break
            await asyncio.sleep(0.4)
        if not fields:
            raise HTTPException(status_code=502, detail="系统人员同步表尚未就绪，请稍后重试")

        primary = next((f for f in fields if f.get("primary")), fields[0])
        if str(primary.get("name") or "") != "姓名":
            try:
                await _call_lock_retry(
                    "PATCH", f"/api/database/fields/{int(primary.get('id') or 0)}/", user, json_body={"name": "姓名"}
                )
            except HTTPException:
                log.warning("baserow people table primary field rename failed", exc_info=True)

        existing = {str(f.get("name") or "") for f in fields}
        for name in PEOPLE_COLUMNS:
            if name in existing:
                continue
            try:
                await _call_lock_retry(
                    "POST", f"/api/database/fields/table/{pid}/", user, json_body={"name": name, "type": "text"}
                )
            except HTTPException as exc:
                if getattr(exc, "baserow_status", 0) == 400:
                    continue
                raise
        return pid


async def _people_rows(pid: int, user: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    page = 1
    while page <= 50:
        payload = await _call(
            "GET",
            f"/api/database/rows/table/{pid}/",
            user,
            params={"page": page, "size": 200, "user_field_names": "true"},
        )
        data = payload if isinstance(payload, dict) else {}
        chunk = [r for r in (data.get("results") or []) if isinstance(r, dict)]
        rows.extend(chunk)
        if not data.get("next") or len(chunk) < 200:
            break
        page += 1
    return rows


def _people_row_map(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        uid = str(row.get("系统ID") or "").strip()
        if uid and uid not in out:
            out[uid] = row
    return out


async def _sync_people(pid: int, user: dict[str, Any], force: bool = False) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    """把 Casdoor 启用的系统账号同步到人员镜像表。

    只增改不删除，避免历史记录中的人员指派被清空；读取失败时退回镜像表现有数据。
    """
    cached = _people_cache.get(pid)
    if not force and cached and time.time() - cached[0] < _PEOPLE_TTL:
        return cached[1], cached[2]

    async with _people_lock:
        cached = _people_cache.get(pid)
        if not force and cached and time.time() - cached[0] < _PEOPLE_TTL:
            return cached[1], cached[2]

        fields = _list(await _call("GET", f"/api/database/fields/table/{pid}/", user))
        primary = next((f for f in fields if f.get("primary")), None)
        primary_name = str((primary or {}).get("name") or "姓名")

        directory: list[dict[str, Any]] = []
        try:
            from . import accounts as accounts_mod

            directory = await asyncio.to_thread(accounts_mod.directory)
        except Exception:  # noqa: BLE001 - 目录暂时不可用时仍允许查看已有指派
            log.warning("baserow people directory unavailable", exc_info=True)

        existing = _people_row_map(await _people_rows(pid, user))
        if not directory:
            people = [
                {
                    "id": uid,
                    "row_id": int(row.get("id") or 0),
                    "name": str(row.get("账号") or ""),
                    "displayName": str(row.get(primary_name) or row.get("账号") or uid),
                    "email": str(row.get("邮箱") or ""),
                    "groups": [g for g in str(row.get("分组") or "").split(" / ") if g],
                }
                for uid, row in existing.items()
            ]
            people.sort(key=lambda p: (p["displayName"], p["name"]))
            _people_cache[pid] = (time.time(), people, existing)
            return people, existing

        creates: list[dict[str, Any]] = []
        updates: list[dict[str, Any]] = []
        for person in directory:
            uid = str(person.get("id") or "").strip()
            if not uid:
                continue
            values = {
                primary_name: str(person.get("displayName") or person.get("name") or uid),
                "系统ID": uid,
                "账号": str(person.get("name") or ""),
                "邮箱": str(person.get("email") or ""),
                "分组": " / ".join(str(g) for g in (person.get("groups") or []) if str(g).strip()),
            }
            row = existing.get(uid)
            if not row:
                creates.append(values)
                continue
            if any(str(row.get(key) or "") != str(value) for key, value in values.items()):
                updates.append({"id": int(row.get("id") or 0), **values})

        try:
            for start in range(0, len(creates), 200):
                await _call(
                    "POST",
                    f"/api/database/rows/table/{pid}/batch/",
                    user,
                    json_body={"items": creates[start : start + 200]},
                    params={"user_field_names": "true"},
                )
            for start in range(0, len(updates), 200):
                await _call(
                    "PATCH",
                    f"/api/database/rows/table/{pid}/batch/",
                    user,
                    json_body={"items": updates[start : start + 200]},
                    params={"user_field_names": "true"},
                )
        except HTTPException:
            log.warning("baserow people sync write failed; fallback to existing rows", exc_info=True)

        if creates:
            existing = _people_row_map(await _people_rows(pid, user))

        people: list[dict[str, Any]] = []
        for person in directory:
            uid = str(person.get("id") or "").strip()
            row = existing.get(uid)
            if not uid or not row:
                continue
            people.append(
                {
                    "id": uid,
                    "row_id": int(row.get("id") or 0),
                    "name": str(person.get("name") or ""),
                    "displayName": str(person.get("displayName") or person.get("name") or uid),
                    "email": str(person.get("email") or ""),
                    "groups": [str(g) for g in (person.get("groups") or []) if str(g).strip()],
                }
            )
        people.sort(key=lambda p: (p["displayName"], p["name"]))
        _people_cache[pid] = (time.time(), people, existing)
        return people, existing


# ------------------------------------------------------------------ 模型

class NamedCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)


class FieldCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    type: str = Field(default="text", max_length=40)


class FieldRename(BaseModel):
    name: str = Field(min_length=1, max_length=160)


class WorkspaceInvite(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    permissions: str = Field(default="MEMBER", max_length=32)


class MemberPermissions(BaseModel):
    permissions: str = Field(min_length=1, max_length=32)


# ------------------------------------------------------------------ 读取

@router.get("/overview")
async def overview(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    workspaces = _list(await _call("GET", "/api/workspaces/", user))
    dbs = await asyncio.gather(
        *[_call("GET", f"/api/applications/workspace/{int(w.get('id') or 0)}/", user) for w in workspaces]
    )
    result = []
    for workspace, apps in zip(workspaces, dbs):
        result.append(
            {
                "id": int(workspace.get("id") or 0),
                "name": workspace.get("name") or "未命名工作区",
                "databases": [
                    {"id": int(app.get("id") or 0), "name": app.get("name") or "未命名数据表"}
                    for app in _list(apps)
                    if app.get("type") == "database"
                ],
            }
        )
    return {"admin": _is_admin(user), "workspaces": result}


@router.get("/databases/{database_id}/tables")
async def list_tables(database_id: int, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    tables = _list(await _call("GET", f"/api/database/tables/database/{database_id}/", user))
    return {
        "tables": [
            {"id": int(t.get("id") or 0), "name": t.get("name") or "未命名表"}
            for t in tables
            if str(t.get("name") or "") != PEOPLE_TABLE_NAME
        ]
    }


@router.get("/tables/{table_id}/fields")
async def list_fields(table_id: int, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    fields = _list(await _call("GET", f"/api/database/fields/table/{table_id}/", user))
    keep = []
    for f in fields:
        people_table_id = _people_target(f)
        keep.append(
            {
                "id": int(f.get("id") or 0),
                "name": f.get("name") or "",
                "type": "people" if people_table_id else (f.get("type") or "text"),
                "primary": bool(f.get("primary")),
                "read_only": bool(f.get("read_only")),
                "description": str(f.get("description") or ""),
                "link_row_table_id": int(f.get("link_row_table_id") or 0) or None,
                "people": bool(people_table_id),
                "select_options": [
                    {"id": int(o.get("id") or 0), "value": o.get("value") or "", "color": o.get("color") or ""}
                    for o in (f.get("select_options") or [])
                    if isinstance(o, dict)
                ],
            }
        )
    return {"fields": keep}


@router.get("/tables/{table_id}/people")
async def list_people(table_id: int, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    """返回当前工作表中人员字段可指派/展示的系统账号（含对应镜像行 id）。"""
    fields = _list(await _call("GET", f"/api/database/fields/table/{table_id}/", user))
    field = next((f for f in fields if _people_target(f)), None)
    pid = _people_target(field or {})
    if not pid:
        raise HTTPException(status_code=404, detail="当前工作表还没有人员字段")
    people, _ = await _sync_people(pid, user)
    return {"table_id": pid, "people": people}


@router.get("/tables/{table_id}/rows")
async def list_rows(
    table_id: int,
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=200),
    search: str = Query("", max_length=200),
    order_by: str = Query("", max_length=120),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    params: dict[str, Any] = {"page": page, "size": size, "user_field_names": "true"}
    if search.strip():
        params["search"] = search.strip()
    if order_by.strip():
        params["order_by"] = order_by.strip()
    payload = await _call("GET", f"/api/database/rows/table/{table_id}/", user, params=params)
    data = payload if isinstance(payload, dict) else {}
    return {
        "count": int(data.get("count") or 0),
        "next": data.get("next"),
        "previous": data.get("previous"),
        "results": [r for r in (data.get("results") or []) if isinstance(r, dict)],
    }


# ------------------------------------------------------------------ 成员共享

@router.get("/workspaces/{workspace_id}/members")
async def list_members(workspace_id: int, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    payload = await _call("GET", f"/api/workspaces/users/workspace/{workspace_id}/", user)
    return {
        "members": [
            {
                "id": int(m.get("id") or 0),
                "user_id": int(m.get("user_id") or 0),
                "name": m.get("name") or "",
                "email": m.get("email") or "",
                "permissions": m.get("permissions") or "",
            }
            for m in _list(payload)
        ]
    }


@router.post("/workspaces/{workspace_id}/invite", dependencies=[Depends(require_csrf)])
async def invite_member(workspace_id: int, payload: WorkspaceInvite, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    data = await _call(
        "POST",
        f"/api/workspaces/invitations/workspace/{workspace_id}/",
        user,
        json_body={
            "email": payload.email.strip().lower(),
            "permissions": payload.permissions,
            "base_url": f"{settings.public_url}/baserow",
        },
    )
    return data if isinstance(data, dict) else {"ok": True}


@router.patch("/workspaces/{workspace_id}/members/{member_id}", dependencies=[Depends(require_csrf)])
async def update_member(
    workspace_id: int,
    member_id: int,
    payload: MemberPermissions,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    data = await _call(
        "PATCH", f"/api/workspaces/users/{member_id}/", user, json_body={"permissions": payload.permissions}
    )
    return data if isinstance(data, dict) else {"ok": True}


@router.delete("/workspaces/{workspace_id}/members/{member_id}", dependencies=[Depends(require_csrf)])
async def remove_member(workspace_id: int, member_id: int, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    await _call("DELETE", f"/api/workspaces/users/{member_id}/", user)
    return {"ok": True}


# ------------------------------------------------------------------ 结构管理

@router.patch("/tables/{table_id}/fields/{field_id}", dependencies=[Depends(require_csrf)])
async def rename_field(
    table_id: int,
    field_id: int,
    payload: FieldRename,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    await _assert_people_table_mutable(table_id, user)
    data = await _call_lock_retry("PATCH", f"/api/database/fields/{field_id}/", user, json_body={"name": payload.name})
    return data if isinstance(data, dict) else {"ok": True}


@router.delete("/tables/{table_id}/fields/{field_id}", dependencies=[Depends(require_csrf)])
async def delete_field(table_id: int, field_id: int, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    await _assert_people_table_mutable(table_id, user)
    await _call("DELETE", f"/api/database/fields/{field_id}/", user)
    return {"ok": True}


@router.delete("/tables/{table_id}", dependencies=[Depends(require_csrf)])
async def delete_table(table_id: int, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    await _assert_people_table_mutable(table_id, user)
    await _call("DELETE", f"/api/database/tables/{table_id}/", user)
    return {"ok": True}


@router.delete("/databases/{database_id}", dependencies=[Depends(require_csrf)])
async def delete_database(database_id: int, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    await _call("DELETE", f"/api/applications/{database_id}/", user)
    return {"ok": True}


@router.post("/tables/{table_id}/import", dependencies=[Depends(require_csrf)])
async def import_table(
    table_id: int,
    file: UploadFile = File(...),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """把本地 CSV/TSV 导入工作表：缺失列自动建文本字段，分批写入记录。"""
    raw = await file.read(5 * 1024 * 1024 + 1)
    if len(raw) > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="文件超过 5 MB，请拆分后再导入")
    name = (file.filename or "").lower()
    text = raw.decode("utf-8-sig", errors="replace")
    lines = text.splitlines()
    if not lines:
        raise HTTPException(status_code=400, detail="文件为空，未读取到表头")
    first_line = lines[0]
    try:
        delimiter = "\t" if name.endswith((".tsv", ".tab")) else "\t" if "\t" in first_line and "," not in first_line else ","
        # newline="" 让 csv 自行处理 \r / \r\n / \n 三种换行（Excel 导出的老式 CSV 常见 \r）。
        reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter)
        rows = [r for r in reader if any(str(c).strip() for c in r)]
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400,
            detail=f"无法解析表格：{exc}。请确认文件是 UTF-8 编码的 CSV/TSV（Excel 可另存为「CSV UTF-8」）",
        ) from exc
    if len(rows) < 2:
        raise HTTPException(status_code=400, detail="表格至少需要表头和一行数据")
    header = [str(c).strip() or f"列 {i + 1}" for i, c in enumerate(rows[0])]
    body_rows = rows[1:]
    if len(header) > 60:
        raise HTTPException(status_code=400, detail="列数超过 60，请精简后再导入")

    existing = _list(await _call("GET", f"/api/database/fields/table/{table_id}/", user))
    by_name = {str(f.get("name") or "").strip().lower(): str(f.get("name") or "") for f in existing}
    fields_added: list[str] = []
    for col in header:
        if col.strip().lower() in by_name:
            continue
        created = await _call_lock_retry(
            "POST", f"/api/database/fields/table/{table_id}/", user, json_body={"name": col, "type": "text"}
        )
        actual = str((created or {}).get("name") or col)
        by_name[col.strip().lower()] = actual
        fields_added.append(actual)

    items = []
    for r in body_rows:
        item = {}
        for i, col in enumerate(header):
            value = str(r[i]).strip() if i < len(r) else ""
            if value:
                item[by_name[col.strip().lower()]] = value
        if item:
            items.append(item)

    created = 0
    for start in range(0, len(items), 200):
        chunk = items[start : start + 200]
        await _call(
            "POST",
            f"/api/database/rows/table/{table_id}/batch/",
            user,
            json_body={"items": chunk},
            params={"user_field_names": "true"},
        )
        created += len(chunk)
    return {"created": created, "fields_added": fields_added, "skipped": len(body_rows) - len(items)}


# ------------------------------------------------------------------ 写入

@router.post("/workspaces", dependencies=[Depends(require_csrf)])
async def create_workspace(payload: NamedCreate, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    data = await _call("POST", "/api/workspaces/", user, json_body={"name": payload.name})
    return {"id": int((data or {}).get("id") or 0), "name": (data or {}).get("name") or payload.name}


@router.post("/workspaces/{workspace_id}/databases", dependencies=[Depends(require_csrf)])
async def create_database(workspace_id: int, payload: NamedCreate, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    data = await _call(
        "POST", f"/api/applications/workspace/{workspace_id}/", user, json_body={"name": payload.name, "type": "database"}
    )
    return {"id": int((data or {}).get("id") or 0), "name": (data or {}).get("name") or payload.name}


@router.post("/databases/{database_id}/tables", dependencies=[Depends(require_csrf)])
async def create_table(database_id: int, payload: NamedCreate, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    data = await _call("POST", f"/api/database/tables/database/{database_id}/", user, json_body={"name": payload.name})
    return {"id": int((data or {}).get("id") or 0), "name": (data or {}).get("name") or payload.name}


@router.post("/tables/{table_id}/fields", dependencies=[Depends(require_csrf)])
async def create_field(table_id: int, payload: FieldCreate, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    if payload.type == "people":
        meta = await _table_meta(table_id, user)
        database_id = int(meta.get("database_id") or 0)
        if not database_id:
            raise HTTPException(status_code=502, detail="无法定位当前数据表所属数据库")
        pid = await _ensure_people_table(database_id, user)
        await _sync_people(pid, user, force=True)
        data = await _call_lock_retry(
            "POST",
            f"/api/database/fields/table/{table_id}/",
            user,
            json_body={
                "name": payload.name,
                "type": "link_row",
                "link_row_table_id": pid,
                "has_related_field": False,
                "description": f"{_PEOPLE_MARK}{pid}",
            },
        )
        return {
            "id": int((data or {}).get("id") or 0),
            "name": (data or {}).get("name") or payload.name,
            "type": "people",
            "people": True,
            "link_row_table_id": pid,
        }
    data = await _call_lock_retry(
        "POST", f"/api/database/fields/table/{table_id}/", user, json_body={"name": payload.name, "type": payload.type}
    )
    return {"id": int((data or {}).get("id") or 0), "name": (data or {}).get("name") or payload.name, "type": (data or {}).get("type") or payload.type}


@router.post("/tables/{table_id}/rows", dependencies=[Depends(require_csrf)])
async def create_row(
    table_id: int, values: dict[str, Any] = Body(...), user: dict[str, Any] = Depends(require_user)
) -> dict[str, Any]:
    data = await _call(
        "POST", f"/api/database/rows/table/{table_id}/", user, json_body=values, params={"user_field_names": "true"}
    )
    return data if isinstance(data, dict) else {}


@router.patch("/tables/{table_id}/rows/{row_id}", dependencies=[Depends(require_csrf)])
async def update_row(
    table_id: int,
    row_id: int,
    values: dict[str, Any] = Body(...),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    data = await _call(
        "PATCH", f"/api/database/rows/table/{table_id}/{row_id}/", user, json_body=values, params={"user_field_names": "true"}
    )
    return data if isinstance(data, dict) else {}


@router.delete("/tables/{table_id}/rows/{row_id}", dependencies=[Depends(require_csrf)])
async def delete_row(table_id: int, row_id: int, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    await _call("DELETE", f"/api/database/rows/table/{table_id}/{row_id}/", user)
    return {"ok": True}


# ------------------------------------------------------------------ 账号清理

async def purge_user(email: str) -> int:
    """硬删除账号时同步清理 Baserow 账号（尽力而为）。"""
    email = email.strip().lower()
    if not email:
        return 0
    token = await _admin_token()
    found = _list(await _http("GET", "/api/admin/users/", token, params={"search": email, "size": 50}))
    removed = 0
    for item in found:
        identity = str(item.get("username") or item.get("email") or "").strip().lower()
        if identity and identity != email:
            continue
        uid = int(item.get("id") or 0)
        if not uid:
            continue
        await _http("DELETE", f"/api/admin/users/{uid}/", token)
        removed += 1
    db.execute("DELETE FROM labspace.baserow_accounts WHERE email=%s", (email,))
    _user_cache.pop(email, None)
    return removed