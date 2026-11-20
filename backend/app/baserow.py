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
import mimetypes
import os
import re
import secrets
import time
from typing import Any

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import (
    APIRouter,
    Body,
    Depends,
    File,
    HTTPException,
    Query,
    Response,
    UploadFile,
)
from pydantic import BaseModel, Field

from . import db
from .config import settings
from .security import has_role, require_admin, require_csrf, require_user

log = logging.getLogger("labspace.baserow")
router = APIRouter(prefix="/api/baserow", tags=["baserow"])

_TIMEOUT = httpx.Timeout(30.0)
# Baserow 签发的 JWT 约 20 分钟过期；缓存比它短一点，
# 避免“拿一个已经失效的令牌去请求→401→刷新→还是同一个令牌”的死循环。
_TOKEN_TTL = 18 * 60

# 附件上传：大小上限与扩展名白名单（上传到 Baserow 的 user-files）
FILE_MAX_BYTES = 20 * 1024 * 1024
FILE_EXT_ALLOW = frozenset(
    {
        "pdf", "png", "jpg", "jpeg", "gif", "webp", "svg",
        "docx", "xlsx", "pptx", "csv", "txt", "md", "zip",
        "tif", "tiff", "fasta", "fa", "gtf", "gff", "bed", "bam", "vcf", "gz",
    }
)
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


#: 内网账号用的伪域名。门户账号的邮箱是 ``<账号>@local``（没有点，Django 的
#: EmailValidator 直接判非法），而 Baserow 注册必须用合法地址，
#: 所以给数据表单独发一个 ``<账号>@labspace.local`` 身份。
BASEROW_DOMAIN = "labspace.local"

#: 数据表能接受的最小邮箱判定：@ 前非空、域名里至少一个点。
_REAL_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$")


def _email(user: dict[str, Any]) -> str:
    """门户账号的邮箱（用于显示与人员映射）。"""
    email = str(user.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="当前账号缺少邮箱，无法开通数据表")
    return email


def _account_email(user: dict[str, Any]) -> str:
    """数据表服务里的账号地址。

    门户大量使用 ``xxx@local``：它是**合法**的门户标识，但 Baserow 的注册接口会
    回 ``Enter a valid email address``（400）。之前把这个 400 当成「邮箱已注册」，
    于是所有 ``@local`` 账号打开多维表格 / 种子页都是 409，提示词还完全指错方向
    （让用户去找管理员重置一个根本不存在的账号）。
    这里把不合法的域名换成 ``<账号>@labspace.local``，一人一个数据表账号。
    """
    email = _email(user)
    if _REAL_EMAIL_RE.match(email):
        return email
    local = email.split("@", 1)[0] or "user"
    return f"{local}@{BASEROW_DOMAIN}"


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


def _client() -> httpx.AsyncClient:
    """构造上游 HTTP 客户端；测试用 httpx.MockTransport 打桩时替换这里。"""
    return httpx.AsyncClient(timeout=_TIMEOUT)


async def _http(
    method: str,
    path: str,
    token: str,
    *,
    json_body: Any = None,
    params: dict[str, Any] | None = None,
    files: dict[str, Any] | None = None,
) -> Any:
    if files is not None and json_body is not None:
        raise ValueError("multipart 与 json body 不能同时发送")
    headers = {"Host": settings.baserow_host}
    if token:
        headers["Authorization"] = f"JWT {token}"
    async with _client() as client:
        resp = await client.request(method, f"{_base()}{path}", json=json_body, params=params, files=files, headers=headers)
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
        status = getattr(exc, "baserow_status", 0)
        if status == 409:
            raise HTTPException(
                status_code=409,
                detail=f"数据表账号 {email} 已存在但门户没有它的密码（历史遗留），"
                "请联系管理员在「后台 → 用户和权限」重置数据表账号",
            ) from exc
        if status == 400:
            # 之前把 400 也当成「已注册」，拼写错误的提示把排查引到错误方向。
            reason = str(getattr(exc, "detail", "") or "注册被拒")
            raise HTTPException(
                status_code=502,
                detail=f"数据表服务拒绝了账号 {email}：{reason}",
            ) from exc
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
    # 用**数据表身份**（合法邮箱）做主键：`@local` 这种门户邮箱 Baserow 不接受。
    email = _account_email(user)
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
    if force:
        # 缓存键必须与 `_user_token` 写入时**完全一致**（数据表身份，不是门户邮箱）。
        # 取错了键就会“刷新”成同一个过期令牌，然后 401 一路抛给前端：
        # 所有 @local 账号在多维表格/种子页停留 20 分钟后开始 401，刷新页面也好不了。
        _user_cache.pop(_account_email(user), None)
    return await _user_token(user)


async def _call(
    method: str,
    path: str,
    user: dict[str, Any],
    *,
    json_body: Any = None,
    params: dict[str, Any] | None = None,
    files: dict[str, Any] | None = None,
) -> Any:
    token = await _token(user)
    try:
        return await _http(method, path, token, json_body=json_body, params=params, files=files)
    except HTTPException as exc:
        if getattr(exc, "baserow_status", 0) == 401:
            token = await _token(user, force=True)
            return await _http(method, path, token, json_body=json_body, params=params, files=files)
        raise


async def call_as_admin(
    method: str,
    path: str,
    *,
    json_body: Any = None,
    params: dict[str, Any] | None = None,
) -> Any:
    """以**数据表管理员**身份调用。

    只给「全实验室同一份」的只读台账用（种子台账）：它建在管理员账号的
    工作区里，普通账号用自己的令牌看不到——之前就因此把种子模块对学生
    变成了白屏。调用方负责保证这是**只读**操作，写入口仍然走
    ``require_admin`` + 调用者自己的令牌。
    """
    if method.upper() not in ("GET", "HEAD"):
        raise ValueError("call_as_admin 只允许只读请求")
    return await _http(method, path, await _admin_token(), json_body=json_body, params=params)


async def admin_row_create(table_id: int, values: dict[str, Any]) -> dict[str, Any]:
    """以数据表管理员身份新增一行（**仅**给全实验室共享的种子台账用）。

    为什么需要这条：种子台账建在管理员账号的工作区里，普通账号的 Baserow 令牌
    连表都看不到，更写不进去；而「谁都可以录入种子」是业务要求。
    为了不把它变成"任何人都能写任何表"的通用后门，这里**不接受路径参数**：
    路径由同样是管理员身份解析出来的 table_id 拼成（seed_tables._shared_seed_table），
    调用方拿不到写别的表的入口。

    代价：Baserow 侧的作者是管理员账号，不是实际操作人；调用方负责记录审计日志。
    """
    if table_id <= 0:
        raise HTTPException(status_code=400, detail="表 id 无效")
    payload = await _http(
        "POST",
        f"/api/database/rows/table/{int(table_id)}/",
        await _admin_token(),
        json_body=values,
        params={"user_field_names": "true"},
    )
    return payload if isinstance(payload, dict) else {}


async def admin_row_update(table_id: int, row_id: int, values: dict[str, Any]) -> dict[str, Any]:
    """以数据表管理员身份更新一行。限制同 `admin_row_create`。"""
    if table_id <= 0 or row_id <= 0:
        raise HTTPException(status_code=400, detail="表 id 或行 id 无效")
    payload = await _http(
        "PATCH",
        f"/api/database/rows/table/{int(table_id)}/{int(row_id)}/",
        await _admin_token(),
        json_body=values,
        params={"user_field_names": "true"},
    )
    return payload if isinstance(payload, dict) else {}


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


# 视图（view）：Baserow 的 GET/PATCH /api/database/views/{id}/ 只认 name /
# filter_type / filters_disabled 等视图属性，筛选与排序各有独立子资源。

VIEW_TYPES = ("grid", "gallery", "kanban", "calendar", "form", "timeline")
VIEW_SORT_ORDERS = ("ASC", "DESC")
VIEW_CONDITION_TYPES = ("AND", "OR")


class ViewCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    type: str = Field(default="grid", max_length=32)


class ViewUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=255)
    filter_type: str | None = Field(default=None, max_length=8)
    filters_disabled: bool | None = None


class ViewFilterCreate(BaseModel):
    field: int = Field(ge=1)
    type: str = Field(min_length=1, max_length=64)
    value: Any = ""
    group: int | None = None


class ViewSortCreate(BaseModel):
    field: int = Field(ge=1)
    order: str = Field(default="ASC", max_length=8)
    type: str | None = Field(default=None, max_length=32)


class ViewFilterGroupCreate(BaseModel):
    filter_type: str = Field(default="AND", max_length=8)
    parent_group: int | None = None


class RowBatchDelete(BaseModel):
    items: list[int] = Field(min_length=1, max_length=200)


class RowBatchUpdate(BaseModel):
    items: list[dict[str, Any]] = Field(min_length=1, max_length=200)


class RowCommentCreate(BaseModel):
    message: str = Field(min_length=1, max_length=10000)


class TrashRestore(BaseModel):
    trash_item_id: int = Field(ge=0)
    trash_item_type: str = Field(min_length=1, max_length=40)
    parent_trash_item_id: int | None = None


# ------------------------------------------------------------------ 读取

@router.get("/overview")
async def overview(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    workspaces = _list(await _call("GET", "/api/workspaces/", user))
    dbs = await asyncio.gather(
        *[_call("GET", f"/api/applications/workspace/{int(w.get('id') or 0)}/", user) for w in workspaces]
    )
    result = []
    for workspace, apps in zip(workspaces, dbs, strict=False):
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
    view_id: int | None = Query(None, ge=1),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    params: dict[str, Any] = {"page": page, "size": size, "user_field_names": "true"}
    if search.strip():
        params["search"] = search.strip()
    if order_by.strip():
        params["order_by"] = order_by.strip()
    if view_id:
        # view_id 让 Baserow 按视图的筛选/排序返回记录（GET rows 支持该查询参数）
        params["view_id"] = view_id
    payload = await _call("GET", f"/api/database/rows/table/{table_id}/", user, params=params)
    data = payload if isinstance(payload, dict) else {}
    return {
        "count": int(data.get("count") or 0),
        "next": data.get("next"),
        "previous": data.get("previous"),
        "results": [r for r in (data.get("results") or []) if isinstance(r, dict)],
    }


# ------------------------------------------------------------------ 视图

async def _table_field_ids(table_id: int, user: dict[str, Any]) -> set[int]:
    fields = _list(await _call("GET", f"/api/database/fields/table/{table_id}/", user))
    return {int(f.get("id") or 0) for f in fields}


async def _assert_fields_in_table(table_id: int, field_ids: list[int], user: dict[str, Any]) -> None:
    """字段必须属于该工作表，避免用别表的字段 id 越权筛选/排序。"""
    known = await _table_field_ids(table_id, user)
    outside = [fid for fid in field_ids if fid not in known]
    if outside:
        raise HTTPException(status_code=400, detail=f"字段不属于当前工作表：{outside}")


async def _assert_view_in_table(table_id: int, view_id: int, user: dict[str, Any]) -> None:
    """视图必须属于该工作表，避免用别表的视图 id 改写别人的配置。"""
    views = _list(await _call("GET", f"/api/database/views/table/{table_id}/", user))
    if view_id not in {int(v.get("id") or 0) for v in views}:
        raise HTTPException(status_code=404, detail="视图不存在或不属于当前工作表")


def _view_payload(raw: dict[str, Any]) -> dict[str, Any]:
    """把 Baserow 的视图对象整形成前端要的形状（保留 filters/sortings/filter_groups）。"""
    return {
        "id": int(raw.get("id") or 0),
        "name": str(raw.get("name") or ""),
        "type": str(raw.get("type") or "grid"),
        "order": int(raw.get("order") or 0),
        "filter_type": str(raw.get("filter_type") or "AND"),
        "filters_disabled": bool(raw.get("filters_disabled")),
        "filters": [
            {
                "id": int(f.get("id") or 0),
                "field": int(f.get("field") or 0),
                "type": str(f.get("type") or ""),
                "value": f.get("value") if f.get("value") is not None else "",
                "group": int(f["group"]) if f.get("group") is not None else None,
            }
            for f in (raw.get("filters") or [])
            if isinstance(f, dict)
        ],
        "sortings": [
            {
                "id": int(s.get("id") or 0),
                "field": int(s.get("field") or 0),
                "order": str(s.get("order") or "ASC"),
                "type": str(s.get("type") or "default"),
            }
            for s in (raw.get("sortings") or [])
            if isinstance(s, dict)
        ],
        "filter_groups": [
            {
                "id": int(g.get("id") or 0),
                "filter_type": str(g.get("filter_type") or "AND"),
                "parent_group": int(g["parent_group"]) if g.get("parent_group") is not None else None,
            }
            for g in (raw.get("filter_groups") or [])
            if isinstance(g, dict)
        ],
    }


@router.get("/tables/{table_id}/views")
async def list_views(table_id: int, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    payload = await _call(
        "GET",
        f"/api/database/views/table/{table_id}/",
        user,
        params={"include": "filters,sortings,filter_groups,decorations"},
    )
    return {"views": [_view_payload(v) for v in _list(payload)]}


@router.post("/tables/{table_id}/views", dependencies=[Depends(require_csrf)])
async def create_view(
    table_id: int, payload: ViewCreate, user: dict[str, Any] = Depends(require_admin)
) -> dict[str, Any]:
    if payload.type not in VIEW_TYPES:
        raise HTTPException(status_code=400, detail=f"不支持的视图类型：{payload.type}")
    data = await _call(
        "POST",
        f"/api/database/views/table/{table_id}/",
        user,
        json_body={"name": payload.name.strip(), "type": payload.type},
    )
    return _view_payload(data if isinstance(data, dict) else {})


@router.patch("/tables/{table_id}/views/{view_id}", dependencies=[Depends(require_csrf)])
async def update_view(
    table_id: int,
    view_id: int,
    payload: ViewUpdate,
    user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    await _assert_view_in_table(table_id, view_id, user)
    body: dict[str, Any] = {}
    if payload.name is not None:
        body["name"] = payload.name.strip()
    if payload.filter_type is not None:
        if payload.filter_type not in VIEW_CONDITION_TYPES:
            raise HTTPException(status_code=400, detail="filter_type 只能是 AND 或 OR")
        body["filter_type"] = payload.filter_type
    if payload.filters_disabled is not None:
        body["filters_disabled"] = payload.filters_disabled
    if not body:
        raise HTTPException(status_code=400, detail="没有需要更新的视图属性")
    data = await _call("PATCH", f"/api/database/views/{view_id}/", user, json_body=body)
    return _view_payload(data if isinstance(data, dict) else {})


@router.delete("/tables/{table_id}/views/{view_id}", dependencies=[Depends(require_csrf)])
async def delete_view(
    table_id: int, view_id: int, user: dict[str, Any] = Depends(require_admin)
) -> dict[str, Any]:
    await _assert_view_in_table(table_id, view_id, user)
    await _call("DELETE", f"/api/database/views/{view_id}/", user)
    return {"ok": True}


@router.post("/tables/{table_id}/views/{view_id}/filters", dependencies=[Depends(require_csrf)])
async def create_view_filter(
    table_id: int,
    view_id: int,
    payload: ViewFilterCreate,
    user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    await _assert_view_in_table(table_id, view_id, user)
    await _assert_fields_in_table(table_id, [payload.field], user)
    body: dict[str, Any] = {
        "field": payload.field,
        "type": payload.type,
        "value": payload.value if payload.value is not None else "",
    }
    if payload.group is not None:
        body["group"] = payload.group
    data = await _call("POST", f"/api/database/views/{view_id}/filters/", user, json_body=body)
    return data if isinstance(data, dict) else {"ok": True}


@router.delete(
    "/tables/{table_id}/views/{view_id}/filters/{filter_id}", dependencies=[Depends(require_csrf)]
)
async def delete_view_filter(
    table_id: int, view_id: int, filter_id: int, user: dict[str, Any] = Depends(require_admin)
) -> dict[str, Any]:
    await _assert_view_in_table(table_id, view_id, user)
    await _call("DELETE", f"/api/database/views/filter/{filter_id}/", user)
    return {"ok": True}


@router.patch(
    "/tables/{table_id}/views/{view_id}/filters/{filter_id}", dependencies=[Depends(require_csrf)]
)
async def update_view_filter(
    table_id: int,
    view_id: int,
    filter_id: int,
    payload: ViewFilterCreate,
    user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    await _assert_view_in_table(table_id, view_id, user)
    await _assert_fields_in_table(table_id, [payload.field], user)
    body: dict[str, Any] = {"type": payload.type, "value": payload.value if payload.value is not None else ""}
    data = await _call("PATCH", f"/api/database/views/filter/{filter_id}/", user, json_body=body)
    return data if isinstance(data, dict) else {"ok": True}


@router.post("/tables/{table_id}/views/{view_id}/sortings", dependencies=[Depends(require_csrf)])
async def create_view_sort(
    table_id: int, view_id: int, payload: ViewSortCreate, user: dict[str, Any] = Depends(require_admin)
) -> dict[str, Any]:
    await _assert_view_in_table(table_id, view_id, user)
    await _assert_fields_in_table(table_id, [payload.field], user)
    order = payload.order.upper()
    if order not in VIEW_SORT_ORDERS:
        raise HTTPException(status_code=400, detail="order 只能是 ASC 或 DESC")
    body: dict[str, Any] = {"field": payload.field, "order": order}
    if payload.type:
        body["type"] = payload.type
    data = await _call("POST", f"/api/database/views/{view_id}/sortings/", user, json_body=body)
    return data if isinstance(data, dict) else {"ok": True}


@router.delete(
    "/tables/{table_id}/views/{view_id}/sortings/{sort_id}", dependencies=[Depends(require_csrf)]
)
async def delete_view_sort(
    table_id: int, view_id: int, sort_id: int, user: dict[str, Any] = Depends(require_admin)
) -> dict[str, Any]:
    await _assert_view_in_table(table_id, view_id, user)
    await _call("DELETE", f"/api/database/views/sort/{sort_id}/", user)
    return {"ok": True}


@router.patch(
    "/tables/{table_id}/views/{view_id}/sortings/{sort_id}", dependencies=[Depends(require_csrf)]
)
async def update_view_sort(
    table_id: int,
    view_id: int,
    sort_id: int,
    payload: ViewSortCreate,
    user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    await _assert_view_in_table(table_id, view_id, user)
    await _assert_fields_in_table(table_id, [payload.field], user)
    order = payload.order.upper()
    if order not in VIEW_SORT_ORDERS:
        raise HTTPException(status_code=400, detail="order 只能是 ASC 或 DESC")
    data = await _call(
        "PATCH", f"/api/database/views/sort/{sort_id}/", user, json_body={"field": payload.field, "order": order}
    )
    return data if isinstance(data, dict) else {"ok": True}


@router.post("/tables/{table_id}/views/{view_id}/filter-groups", dependencies=[Depends(require_csrf)])
async def create_view_filter_group(
    table_id: int,
    view_id: int,
    payload: ViewFilterGroupCreate,
    user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    await _assert_view_in_table(table_id, view_id, user)
    filter_type = payload.filter_type.upper()
    if filter_type not in VIEW_CONDITION_TYPES:
        raise HTTPException(status_code=400, detail="filter_type 只能是 AND 或 OR")
    body: dict[str, Any] = {"filter_type": filter_type}
    if payload.parent_group is not None:
        body["parent_group"] = payload.parent_group
    data = await _call("POST", f"/api/database/views/{view_id}/filter-groups/", user, json_body=body)
    return data if isinstance(data, dict) else {"ok": True}


@router.delete(
    "/tables/{table_id}/views/{view_id}/filter-groups/{group_id}", dependencies=[Depends(require_csrf)]
)
async def delete_view_filter_group(
    table_id: int, view_id: int, group_id: int, user: dict[str, Any] = Depends(require_admin)
) -> dict[str, Any]:
    await _assert_view_in_table(table_id, view_id, user)
    await _call("DELETE", f"/api/database/views/filter-group/{group_id}/", user)
    return {"ok": True}


@router.get("/tables/{table_id}/views/{view_id}/field-options")
async def get_view_field_options(
    table_id: int, view_id: int, user: dict[str, Any] = Depends(require_user)
) -> dict[str, Any]:
    """视图的字段选项（列宽、隐藏、顺序），对应 Baserow 的 grid_view_field_options。"""
    await _assert_view_in_table(table_id, view_id, user)
    data = await _call("GET", f"/api/database/views/{view_id}/field-options/", user)
    payload = data if isinstance(data, dict) else {}
    options = payload.get("field_options")
    return {"field_options": options if isinstance(options, dict) else {}}


@router.patch("/tables/{table_id}/views/{view_id}/field-options", dependencies=[Depends(require_csrf)])
async def update_view_field_options(
    table_id: int,
    view_id: int,
    payload: dict[str, Any] = Body(...),
    user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    """更新视图的字段选项（隐藏列、列宽、列顺序）。"""
    await _assert_view_in_table(table_id, view_id, user)
    options = payload.get("field_options")
    if not isinstance(options, dict) or not options:
        raise HTTPException(status_code=400, detail="field_options 必须是非空对象")
    data = await _call(
        "PATCH", f"/api/database/views/{view_id}/field-options/", user, json_body={"field_options": options}
    )
    payload_out = data if isinstance(data, dict) else {}
    result = payload_out.get("field_options")
    return {"field_options": result if isinstance(result, dict) else {}}


@router.get("/tables/{table_id}/link-rows/{linked_table_id}")
async def list_link_rows(
    table_id: int,
    linked_table_id: int,
    search: str = Query("", max_length=200),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """关联行（link_row）候选：取被关联表的前若干行，供选择器搜索。"""
    params: dict[str, Any] = {"page": 1, "size": 100, "user_field_names": "true"}
    if search.strip():
        params["search"] = search.strip()
    payload = await _call("GET", f"/api/database/rows/table/{linked_table_id}/", user, params=params)
    data = payload if isinstance(payload, dict) else {}
    rows = [r for r in (data.get("results") or []) if isinstance(r, dict)]
    fields = _list(await _call("GET", f"/api/database/fields/table/{linked_table_id}/", user))
    primary = next((f for f in fields if f.get("primary")), fields[0] if fields else None)
    primary_name = str((primary or {}).get("name") or "")
    return {
        "primary_field": primary_name,
        "rows": [
            {
                "id": int(r.get("id") or 0),
                "label": str(r.get(primary_name) or "").strip() or f"#{r.get('id')}",
                "values": {str(f.get("name") or ""): r.get(str(f.get("name") or "")) for f in fields},
            }
            for r in rows
        ],
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
async def invite_member(workspace_id: int, payload: WorkspaceInvite, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
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
    user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    data = await _call(
        "PATCH", f"/api/workspaces/users/{member_id}/", user, json_body={"permissions": payload.permissions}
    )
    return data if isinstance(data, dict) else {"ok": True}


@router.delete("/workspaces/{workspace_id}/members/{member_id}", dependencies=[Depends(require_csrf)])
async def remove_member(workspace_id: int, member_id: int, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    await _call("DELETE", f"/api/workspaces/users/{member_id}/", user)
    return {"ok": True}


# ------------------------------------------------------------------ 结构管理

@router.patch("/tables/{table_id}/fields/{field_id}", dependencies=[Depends(require_csrf)])
async def rename_field(
    table_id: int,
    field_id: int,
    payload: FieldRename,
    user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    await _assert_people_table_mutable(table_id, user)
    data = await _call_lock_retry("PATCH", f"/api/database/fields/{field_id}/", user, json_body={"name": payload.name})
    return data if isinstance(data, dict) else {"ok": True}


@router.delete("/tables/{table_id}/fields/{field_id}", dependencies=[Depends(require_csrf)])
async def delete_field(table_id: int, field_id: int, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    await _assert_people_table_mutable(table_id, user)
    await _call("DELETE", f"/api/database/fields/{field_id}/", user)
    return {"ok": True}


@router.delete("/tables/{table_id}", dependencies=[Depends(require_csrf)])
async def delete_table(table_id: int, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    await _assert_people_table_mutable(table_id, user)
    await _call("DELETE", f"/api/database/tables/{table_id}/", user)
    return {"ok": True}


@router.patch("/databases/{database_id}", dependencies=[Depends(require_csrf)])
async def rename_database(
    database_id: int, payload: NamedCreate, user: dict[str, Any] = Depends(require_admin)
) -> dict[str, Any]:
    """重命名数据表（Baserow 的 application 名称）。"""
    data = await _call("PATCH", f"/api/applications/{database_id}/", user, json_body={"name": payload.name})
    return {"id": database_id, "name": str((data or {}).get("name") or payload.name)}


@router.delete("/databases/{database_id}", dependencies=[Depends(require_csrf)])
async def delete_database(database_id: int, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    await _call("DELETE", f"/api/applications/{database_id}/", user)
    return {"ok": True}


@router.patch("/workspaces/{workspace_id}", dependencies=[Depends(require_csrf)])
async def rename_workspace(
    workspace_id: int, payload: NamedCreate, user: dict[str, Any] = Depends(require_admin)
) -> dict[str, Any]:
    """重命名工作区。"""
    data = await _call("PATCH", f"/api/workspaces/{workspace_id}/", user, json_body={"name": payload.name})
    return {"id": workspace_id, "name": str((data or {}).get("name") or payload.name)}


@router.delete("/workspaces/{workspace_id}", dependencies=[Depends(require_csrf)])
async def delete_workspace(workspace_id: int, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    """删除工作区（Baserow 会一并删除其中的数据表与记录）。"""
    await _call("DELETE", f"/api/workspaces/{workspace_id}/", user)
    return {"ok": True}


@router.post("/tables/{table_id}/files", dependencies=[Depends(require_csrf)])
async def upload_table_file(
    table_id: int,
    file: UploadFile = File(...),
    user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    """把附件上传到 Baserow 的 user-files，返回可直接写回文件字段的对象。

    上游返回的 ``name`` 是 user-files 的校验名（哈希串），写回行时必须原样带上；
    原始文件名放在 ``visible_name``，只用于界面展示。门户令牌不出现在响应里。
    """
    filename = os.path.basename(str(file.filename or "")).strip()
    if not filename:
        raise HTTPException(status_code=400, detail="缺少文件名")
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in FILE_EXT_ALLOW:
        allowed = "、".join(sorted(FILE_EXT_ALLOW))
        raise HTTPException(status_code=400, detail=f"不支持的文件类型 .{ext}；允许的扩展名：{allowed}")
    size = getattr(file, "size", None)
    if isinstance(size, int) and size > FILE_MAX_BYTES:
        raise HTTPException(status_code=413, detail="附件超过 20 MB 上限")
    raw = await file.read(FILE_MAX_BYTES + 1)
    if len(raw) > FILE_MAX_BYTES:
        raise HTTPException(status_code=413, detail="附件超过 20 MB 上限")
    if not raw:
        raise HTTPException(status_code=400, detail="文件内容为空")
    meta = await _table_meta(table_id, user)
    if not meta.get("id"):
        raise HTTPException(status_code=404, detail="工作表不存在或无权访问")
    mime = str(file.content_type or "").strip() or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    data = await _call(
        "POST",
        "/api/user-files/upload-file/",
        user,
        files={"file": (filename, raw, mime)},
    )
    payload = data if isinstance(data, dict) else {}
    url = str(payload.get("url") or "")
    name = str(payload.get("name") or "")
    if not url or not name:
        raise HTTPException(status_code=502, detail="数据表未返回文件地址")
    return {
        "url": url,
        "name": name,
        "visible_name": str(payload.get("original_name") or filename),
        "size": int(payload.get("size") or len(raw)),
        "mime": str(payload.get("mime_type") or mime),
    }


@router.post("/tables/{table_id}/import", dependencies=[Depends(require_csrf)])
async def import_table(
    table_id: int,
    file: UploadFile = File(...),
    user: dict[str, Any] = Depends(require_admin),
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

@router.post("/tables/{table_id}/rows/batch-delete", dependencies=[Depends(require_csrf)])
async def batch_delete_rows(
    table_id: int, payload: RowBatchDelete, user: dict[str, Any] = Depends(require_admin)
) -> dict[str, Any]:
    """批量删除记录（Baserow: POST /api/database/rows/table/{id}/batch-delete/）。"""
    await _call(
        "POST",
        f"/api/database/rows/table/{table_id}/batch-delete/",
        user,
        json_body={"items": [int(i) for i in payload.items]},
    )
    return {"deleted": len(payload.items)}


@router.patch("/tables/{table_id}/rows/batch", dependencies=[Depends(require_csrf)])
async def batch_update_rows(
    table_id: int, payload: RowBatchUpdate, user: dict[str, Any] = Depends(require_admin)
) -> dict[str, Any]:
    """批量更新记录（Baserow: PATCH /api/database/rows/table/{id}/batch/）。"""
    items = []
    for item in payload.items:
        row_id = int(item.get("id") or 0)
        if not row_id:
            raise HTTPException(status_code=400, detail="批量更新的每条记录都必须带 id")
        values = {k: v for k, v in item.items() if k != "id"}
        items.append({"id": row_id, **values})
    data = await _call(
        "PATCH",
        f"/api/database/rows/table/{table_id}/batch/",
        user,
        json_body={"items": items},
        params={"user_field_names": "true"},
    )
    return {"updated": len(items), "rows": _list(data if isinstance(data, dict) else data)}


@router.post("/workspaces", dependencies=[Depends(require_csrf)])
async def create_workspace(payload: NamedCreate, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    data = await _call("POST", "/api/workspaces/", user, json_body={"name": payload.name})
    return {"id": int((data or {}).get("id") or 0), "name": (data or {}).get("name") or payload.name}


@router.post("/workspaces/{workspace_id}/databases", dependencies=[Depends(require_csrf)])
async def create_database(workspace_id: int, payload: NamedCreate, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    data = await _call(
        "POST", f"/api/applications/workspace/{workspace_id}/", user, json_body={"name": payload.name, "type": "database"}
    )
    return {"id": int((data or {}).get("id") or 0), "name": (data or {}).get("name") or payload.name}


@router.post("/databases/{database_id}/tables", dependencies=[Depends(require_csrf)])
async def create_table(database_id: int, payload: NamedCreate, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    data = await _call("POST", f"/api/database/tables/database/{database_id}/", user, json_body={"name": payload.name})
    return {"id": int((data or {}).get("id") or 0), "name": (data or {}).get("name") or payload.name}


@router.post("/tables/{table_id}/fields", dependencies=[Depends(require_csrf)])
async def create_field(table_id: int, payload: FieldCreate, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
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
    table_id: int, values: dict[str, Any] = Body(...), user: dict[str, Any] = Depends(require_admin)
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
    user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    data = await _call(
        "PATCH", f"/api/database/rows/table/{table_id}/{row_id}/", user, json_body=values, params={"user_field_names": "true"}
    )
    return data if isinstance(data, dict) else {}


@router.delete("/tables/{table_id}/rows/{row_id}", dependencies=[Depends(require_csrf)])
async def delete_row(table_id: int, row_id: int, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    await _call("DELETE", f"/api/database/rows/table/{table_id}/{row_id}/", user)
    return {"ok": True}


# ------------------------------------------------------------------ 行评论

@router.get("/tables/{table_id}/rows/{row_id}/comments")
async def list_row_comments(
    table_id: int, row_id: int, user: dict[str, Any] = Depends(require_user)
) -> dict[str, Any]:
    """行评论时间线（Baserow: GET /api/row_comments/{table_id}/{row_id}/）。

    该能力在商业版部署里才开启，未开启时上游返回 402，此处原样透出提示。
    """
    data = await _call("GET", f"/api/row_comments/{table_id}/{row_id}/", user)
    return {
        "comments": [
            {
                "id": int(c.get("id") or 0),
                "message": str(c.get("message") or ""),
                "first_name": str(c.get("first_name") or ""),
                "created_on": str(c.get("created_on") or ""),
                "updated_on": str(c.get("updated_on") or ""),
                "edited": bool(c.get("edited")),
            }
            for c in _list(data)
        ]
    }


@router.post("/tables/{table_id}/rows/{row_id}/comments", dependencies=[Depends(require_csrf)])
async def create_row_comment(
    table_id: int, row_id: int, payload: RowCommentCreate, user: dict[str, Any] = Depends(require_admin)
) -> dict[str, Any]:
    data = await _call(
        "POST",
        f"/api/row_comments/{table_id}/{row_id}/",
        user,
        json_body={"message": payload.message},
    )
    return data if isinstance(data, dict) else {"ok": True}


# ------------------------------------------------------------------ 回收站

@router.get("/trash")
async def list_trash(
    workspace_id: int | None = Query(None, ge=1), user: dict[str, Any] = Depends(require_user)
) -> dict[str, Any]:
    """最近删除的内容（Baserow: GET /api/trash/workspace/{id}/）。"""
    if workspace_id is None:
        data = await _call("GET", "/api/trash/", user)
        return {"structure": data if isinstance(data, dict) else {}}
    payload = await _call(
        "GET", f"/api/trash/workspace/{workspace_id}/", user, params={"page": 1, "size": 100}
    )
    data = payload if isinstance(payload, dict) else {}
    return {
        "count": int(data.get("count") or 0),
        "items": [
            {
                "id": int(t.get("id") or 0),
                "trash_item_id": int(t.get("trash_item_id") or 0),
                "trash_item_type": str(t.get("trash_item_type") or ""),
                "parent_trash_item_id": (
                    int(t["parent_trash_item_id"]) if t.get("parent_trash_item_id") is not None else None
                ),
                "trashed_at": str(t.get("trashed_at") or ""),
                "name": str(t.get("name") or ""),
                "names": [str(n) for n in (t.get("names") or [])],
                "parent_name": str(t.get("parent_name") or ""),
                "user_who_trashed": str(t.get("user_who_trashed") or ""),
            }
            for t in (data.get("results") or [])
            if isinstance(t, dict)
        ],
    }


@router.post("/trash/restore", dependencies=[Depends(require_csrf)])
async def restore_trash(payload: TrashRestore, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    """从回收站恢复（Baserow: PATCH /api/trash/restore/）。"""
    body: dict[str, Any] = {
        "trash_item_id": payload.trash_item_id,
        "trash_item_type": payload.trash_item_type,
    }
    if payload.parent_trash_item_id is not None:
        body["parent_trash_item_id"] = payload.parent_trash_item_id
    data = await _call("PATCH", "/api/trash/restore/", user, json_body=body)
    return data if isinstance(data, dict) else {"ok": True}


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

# ------------------------------------------------------------------ Excel 导入导出


def _xlsx_rows(raw: bytes) -> list[list[str]]:
    """解析 xlsx 为二维字符串表；不是合法 xlsx 时抛 ValueError。

    用 openpyxl 而不是前端解析：省掉一个大依赖，且服务端能统一做
    「列名 → 字段」的映射与校验，错误提示能说清是哪一列对不上。
    """
    from openpyxl import load_workbook

    try:
        wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    except Exception as exc:  # noqa: BLE001 - 统一转成可读提示
        raise ValueError(f"无法读取 Excel 文件：{exc}") from exc
    try:
        # wb.active 在极端情况下可能是 None（没有可见工作表），
        # 取第一个可见工作表，拿不到就明确报错，不要让 None 往下传。
        ws = wb.active or next(iter(wb.worksheets), None)
        if ws is None:
            raise ValueError("这个 Excel 文件里没有可读的工作表")
        rows: list[list[str]] = []
        for row in ws.iter_rows(values_only=True):
            cells = ["" if v is None else str(v).strip() for v in row]
            if any(c for c in cells):
                rows.append(cells)
        return rows
    finally:
        wb.close()


@router.post("/tables/{table_id}/import/excel")
async def import_table_excel(
    table_id: int,
    file: UploadFile = File(...),
    user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    """导入 .xlsx 台账：按表头匹配已有字段，缺失列自动建成文本字段。

    与 CSV 导入的差别只有解析方式；后面的映射、批量写入完全复用，
    避免两条导入路径的行为不一致。
    """
    raw = await file.read(20 * 1024 * 1024 + 1)
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="文件超过 20 MB，请拆分后再导入")
    try:
        rows = _xlsx_rows(raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not rows:
        raise HTTPException(status_code=400, detail="工作表是空的，未读取到表头")
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
        item: dict[str, Any] = {}
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
    return {
        "created": created,
        "fields_added": fields_added,
        "skipped": len(body_rows) - len(items),
    }


@router.get("/tables/{table_id}/export/excel")
async def export_table_excel(
    table_id: int,
    user: dict[str, Any] = Depends(require_admin),
) -> Response:
    """导出整张表为 .xlsx。

    读不需要管理员（台账是共享的业务数据），但导出**整表**会绕过页面上
    的筛选与分页，所以仍然只给管理员 —— 否则普通成员可以一次性把
    全部种质信息（含负责人、存放位置）拉走。
    """
    from openpyxl import Workbook

    fields = _list(await _call("GET", f"/api/database/fields/table/{table_id}/", user))
    names = [str(f.get("name") or "") for f in fields if f.get("name")]
    if not names:
        raise HTTPException(status_code=404, detail="这张表还没有字段")

    rows: list[dict[str, Any]] = []
    offset = 0
    page = 200
    while True:
        batch = await _call(
            "GET",
            f"/api/database/rows/table/{table_id}/",
            user,
            params={"user_field_names": "true", "offset": offset, "limit": page},
        )
        items = batch.get("items") if isinstance(batch, dict) else None
        if not isinstance(items, list) or not items:
            break
        rows.extend(items)
        offset += page
        if offset >= int(batch.get("count") or 0):
            break

    wb = Workbook()
    ws = wb.active or wb.create_sheet()
    ws.title = "台账"
    ws.append(names)
    for row in rows:
        ws.append([_cell_text(row.get(n)) for n in names])
    # 冻结首行 + 首行加粗：Excel 里最常用的两个操作，不用每次手动调
    for cell in ws[1]:
        cell.font = cell.font.copy(bold=True)
    ws.freeze_panes = "A2"
    from openpyxl.utils import get_column_letter

    for i, n in enumerate(names, start=1):
        ws.column_dimensions[get_column_letter(i)].width = max(10, min(28, len(n) * 2 + 6))

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": 'attachment; filename="table-export.xlsx"',
        },
    )


def _cell_text(value: Any) -> Any:
    """把单元格值转成 Excel 能直接写的值（None → 空）。

    数字保持数字类型：变成字符串后 Excel 里的求和/排序就失效了，
    这是导出表格最常见的抱怨。
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, list):
        # Baserow 的多选字段是 [{id, value}, ...]
        parts = []
        for item in value:
            if isinstance(item, dict) and item.get("value") is not None:
                parts.append(str(item["value"]))
            elif item is not None:
                parts.append(str(item))
        return "、".join(parts)
    if isinstance(value, dict):
        for key in ("value", "name", "text"):
            if key in value and value[key] is not None:
                return str(value[key])
        return ""
    return str(value)

