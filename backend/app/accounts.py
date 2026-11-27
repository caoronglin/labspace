"""统一账号管理：门户自有认证，提供管理员侧的账号读写。

Casdoor 的写 API（add-user / update-user）在本部署中返回
"Unauthorized operation"，且 built-in 组织默认禁止通过 API 新增用户，
因此本模块在**管理员会话 + CSRF** 的双重保护下直接读写原 Casdoor
PostgreSQL 账号库（容器已下线、数据保留），并写入 labspace.account_audit 审计表。

约束：
* 只操作 ``owner = 'built-in'`` 的用户；
* 用户名校验后可以修改（改名会清理旧登录名的 Casdoor 令牌），但文件身份跟随
  邮箱前缀，改名不影响个人目录与目录授权；
* 组必须来自 Casdoor 的 group 表；
* 不能禁用自己，也不能移除最后一个可用管理员；
* 禁用/改组/改密/删除都会吊销该账号已签发的会话（JWT 本身无法撤回）；
* 删除是**硬删除**：先吊销会话，再清除文件授权与个人目录，最后删数据库行，
  任何一步失败都保留账号并可重试；全站公告只匿名作者，不删内容；
* 口令只接受写入，不提供读取；哈希使用 bcrypt（与 Casdoor 兼容）。
"""
from __future__ import annotations

import json
import logging
import os
import re
import secrets
import threading
import uuid
import warnings
from datetime import datetime
from typing import Any

import psycopg2
import psycopg2.extras
from psycopg2 import pool as pgpool
from psycopg2 import sql

from . import account_security, audit
from . import baserow as baserow_mod

with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    import bcrypt

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from . import db
from .config import settings
from .golink import (
    access_preview,
    delete_file_group,
    deprovision_user,
    file_access,
    file_groups,
    provision_user,
    set_file_grants,
    set_group_grants,
    set_project_access,
)
from .security import require_admin, require_csrf

log = logging.getLogger("labspace.accounts")
router = APIRouter(prefix="/api/admin/accounts", tags=["accounts"])

OWNER = "built-in"
NAME_RE = re.compile(r"^[a-z][a-z0-9._-]{2,31}$")
# 与文件核心的组名校验保持一致（组名就是身份源里的 group 名称）。
GROUP_RE = re.compile(r"^[a-z][a-z0-9_-]{1,31}$")
GROUP_NAME_HINT = "用户组名称需以小写字母开头，仅含小写字母/数字/_-，长度 2–32"
ADMIN_GROUP = "lab-admin"

SqlStatement = str | sql.Composed

_pool: pgpool.ThreadedConnectionPool | None = None
_lock = threading.Lock()


def _get_pool() -> pgpool.ThreadedConnectionPool:
    global _pool
    if _pool is None:
        with _lock:
            if _pool is None:
                _pool = pgpool.ThreadedConnectionPool(
                    1,
                    settings.account_db_pool_max,
                    host=settings.casdoor_db_host,
                    port=settings.casdoor_db_port,
                    dbname=settings.casdoor_db_name,
                    user=settings.casdoor_db_user,
                    password=settings.casdoor_db_password,
                    connect_timeout=3,
                )
    return _pool


# 说明：门户库与 Casdoor 库是两个库，因此这里各有一套执行器。
# 两者都只接受**常量 SQL + 占位符参数**；表名/列名这类标识符不能参数化，
# 一律用 psycopg2.sql.Identifier 组合（见下方 set_group_grants / purge_user）。
def _query(statement: SqlStatement, params: tuple = ()) -> list[dict[str, Any]]:
    """在 Casdoor 库执行一条参数化查询，返回字典列表。

    SAFETY: 本函数是模块级统一入口，``statement`` 只来自本文件内的**字面量**
    查询（带 ``%s`` 占位符）或 ``psycopg2.sql.Composed``；所有外部输入一律
    走 ``params``。不要把用户可控的字符串拼进 ``statement``。
    """
    pool = _get_pool()
    conn = pool.getconn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # SAFETY: 同 _execute —— statement 只来自本文件字面量或
            # sql.Composed；值全走 params。命名参数让 SQL 与绑定值的边界清晰可见。
            cur.execute(query=statement, vars=params)
            rows = cur.fetchall()
            conn.commit()
            return [dict(r) for r in rows]
    finally:
        pool.putconn(conn)


def _execute(statement: SqlStatement, params: tuple = ()) -> int:
    """在 Casdoor 库执行一条参数化写语句，返回影响行数。

    SAFETY: 同 :func:`_query` —— ``statement`` 只来自本文件内的字面量或
    ``psycopg2.sql.Composed``，值一律走 ``params``。
    """
    pool = _get_pool()
    conn = pool.getconn()
    try:
        with conn.cursor() as cur:
            cur.execute(query=statement, vars=params)
            n = cur.rowcount
        conn.commit()
        return n
    except Exception:
        conn.rollback()
        raise
    finally:
        pool.putconn(conn)


# 新账号的一次性口令由服务端随机生成，不再提供全站通用默认口令。


def _hash_password(password: str, *, allow_weak: bool = False) -> str:
    """生成 bcrypt 哈希。

    ``allow_weak`` 仅保留给确知口令来源的旧数据迁移。
    """
    if not password:
        raise HTTPException(status_code=400, detail="口令不能为空")
    if len(password) < 10 and not allow_weak:
        raise HTTPException(status_code=400, detail="口令至少 10 个字符")
    raw = password.encode("utf-8")
    if len(raw) > 72:
        raise HTTPException(status_code=400, detail="口令超过 72 字节（bcrypt 上限）")
    # 用 bcrypt 而不是标准库 crypt：crypt 自 Python 3.13 起被移除（PEP 594），
    # 而镜像以后必然要升 3.13，届时 crypt 会让"新建账号"整个功能直接崩。
    # bcrypt 产出的 $2b$ 哈希与既有数据同格式，已存口令仍可继续校验。
    return bcrypt.hashpw(raw, bcrypt.gensalt(rounds=12)).decode("ascii")


def generate_one_time_password(length: int = 16) -> str:
    """生成不含歧义字符的一次性强口令，供管理员安全交付。"""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*"
    required = "Aa2!"
    while True:
        chars = [secrets.choice(alphabet) for _ in range(length - len(required))]
        chars.extend(required)
        secrets.SystemRandom().shuffle(chars)
        candidate = "".join(chars)
        if (
            any(c.islower() for c in candidate)
            and any(c.isupper() for c in candidate)
            and any(c.isdigit() for c in candidate)
            and any(not c.isalnum() for c in candidate)
        ):
            return candidate


def verify_password(name: str, password: str) -> bool:
    """校验账号口令（bcrypt）。读不到账号或哈希异常一律 False。"""
    rows = _query(
        'SELECT password, password_type FROM public."user" WHERE owner = %s AND name = %s',
        (OWNER, name.lower()),
    )
    if not rows:
        return False
    stored = str(rows[0].get("password") or "")
    kind = str(rows[0].get("password_type") or "bcrypt")
    if not stored:
        return False
    if kind != "bcrypt":
        # 历史明文账号（极少）：按明文比较后由调用方负责迁移，避免直接报错。
        return secrets.compare_digest(stored, password)
    try:
        return bcrypt.checkpw(password.encode("utf-8"), stored.encode("utf-8"))
    except ValueError:
        return False


def set_user_password(name: str, password: str) -> None:
    """直接改写 Casdoor 用户口令（bcrypt），并清掉必须改密标记。

    调用方负责先校验旧口令与新口令强度；这里只做落库，避免校验逻辑出现两份。
    """
    pwd = _hash_password(password)
    _execute(
        """
        UPDATE public."user"
           SET password = %s, password_salt = %s, password_type = 'bcrypt',
               updated_time = %s
         WHERE owner = %s AND name = %s
        """,
        (pwd, secrets.token_hex(11), _now(), OWNER, name.lower()),
    )
    # 标记表在门户库（见 app/account_security.py），不能用这里的 Casdoor 连接池。
    account_security.clear_must_change(name)


def record_login(name: str) -> None:
    """本地登录成功后更新最近登录时间（Casdoor 下线后的权威入口）。"""
    _execute(
        'UPDATE public."user" SET last_signin_time = %s WHERE owner = %s AND name = %s',
        (_now(), OWNER, (name or "").strip().lower()),
    )


def _now() -> str:
    """Casdoor 使用 RFC3339（+08:00 带冒号），保持与既有行一致。"""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _audit_actor(admin: dict[str, Any]) -> str:
    return str(admin.get("name") or admin.get("email") or admin.get("sub") or "admin")


def _groups_of(raw: Any) -> list[str]:
    if not raw:
        return []
    if isinstance(raw, list):
        return [str(x) for x in raw]
    try:
        val = json.loads(str(raw))
        if isinstance(val, list):
            return [str(x) for x in val]
    except (TypeError, ValueError):
        pass
    return [x.strip() for x in str(raw).split(",") if x.strip()]


def _account(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": row.get("name") or "",
        "displayName": row.get("display_name") or "",
        "email": row.get("email") or "",
        "groups": _groups_of(row.get("groups")),
        "isAdmin": any(g == ADMIN_GROUP for g in _groups_of(row.get("groups"))),
        "isForbidden": bool(row.get("is_forbidden")),
        "hasPassword": bool(row.get("has_password")),
        "createdAt": row.get("created_time") or "",
        "updatedAt": row.get("updated_time") or "",
        "lastSigninAt": row.get("last_signin_time") or "",
    }


def get_account(name: str) -> dict[str, Any] | None:
    """按账号名取账号信息（不含口令哈希）。

    直连登录要用它判断账号是否存在/被禁用；查不到返回 None 而不是抛 404，
    让调用方自己决定如何提示（避免区分「账号不存在」与「口令错误」）。
    """
    try:
        return _get_user((name or "").strip().lower())
    except HTTPException:
        return None


def groups_of(account: dict[str, Any]) -> list[str]:
    """账号所属用户组（用于会话里的 roles claim）。"""
    return _groups_of(account.get("groups"))


def directory() -> list[dict[str, Any]]:
    """可供指派 / 共享选择的人员目录（仅返回启用账号，不含敏感字段）。

    身份键使用 Casdoor 用户 id（即 OIDC `sub`），与工作台各表的 user_id 一致。
    """
    rows = _query(
        """
        SELECT id, name, display_name, email, groups
        FROM public."user"
        WHERE owner = %s AND is_deleted = false AND is_forbidden = false
        ORDER BY name
        LIMIT 1000
        """,
        (OWNER,),
    )
    out: list[dict[str, Any]] = []
    for row in rows:
        name = str(row.get("name") or "")
        uid = str(row.get("id") or "")
        if not name or not uid:
            continue
        out.append(
            {
                "id": uid,
                "name": name,
                "displayName": row.get("display_name") or name,
                "email": str(row.get("email") or "").lower(),
                "groups": _groups_of(row.get("groups")),
            }
        )
    return out


def _file_key(row: dict[str, Any]) -> str:
    """文件核心的身份键，与 Go 侧 userScopes 的解析顺序一致：邮箱优先。

    登录名可以随账号管理修改，但邮箱前缀才是个人目录与 ACL 的稳定身份；
    两者不一致时必须用后者去读写文件授权。
    """
    email = str(row.get("email") or "").strip().lower()
    if email:
        return email.split("@", 1)[0] if "@" in email else email
    return str(row.get("name") or "").strip().lower()


def _get_user(name: str) -> dict[str, Any]:
    rows = _query(
        """
        SELECT owner, id, name, display_name, email, groups, is_admin, is_forbidden,
               is_deleted, created_time, updated_time, last_signin_time,
               (password IS NOT NULL AND length(password) > 0) AS has_password
        FROM public."user"
        WHERE owner = %s AND name = %s
        """,
        (OWNER, name),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="账号不存在")
    return rows[0]


def _known_groups() -> dict[str, dict[str, Any]]:
    rows = _query(
        """
        SELECT name, display_name, is_enabled
        FROM public."group"
        WHERE owner = %s
        ORDER BY name
        """,
        (OWNER,),
    )
    return {str(r["name"]): r for r in rows}


def _validate_groups(groups: list[str]) -> list[str]:
    known = _known_groups()
    out: list[str] = []
    for g in groups:
        g = str(g).strip()
        if not g:
            continue
        if g not in known:
            raise HTTPException(status_code=400, detail=f"未知角色组：{g}")
        if g not in out:
            out.append(g)
    return out


def _enabled_admins() -> list[str]:
    rows = _query(
        """
        SELECT name, groups FROM public."user"
        WHERE owner = %s AND is_deleted = false AND is_forbidden = false
        """,
        (OWNER,),
    )
    return [str(r["name"]) for r in rows if ADMIN_GROUP in _groups_of(r.get("groups"))]


def _group_members() -> dict[str, list[str]]:
    """按 Casdoor 的成员关系汇总每个用户组的成员，文件权限不重复维护成员。"""
    rows = _query(
        'SELECT name, groups FROM public."user" WHERE owner = %s AND is_deleted = false',
        (OWNER,),
    )
    members: dict[str, list[str]] = {}
    for row in rows:
        for group in _groups_of(row.get("groups")):
            members.setdefault(group, []).append(str(row["name"]))
    for names in members.values():
        names.sort()
    return members


# 文件核心用英文说明拒绝原因；直接透传会让中文界面出现半句英文，
# 但也不能把不同的拒绝合并成一句"操作失败"——那正是 403 排查不下去的原因。
_GO_DETAIL_ZH = {
    "builtin group cannot be deleted": "内置用户组不可删除，可以在身份源中调整成员",
    "unknown group": "用户组不存在",
    "invalid group name": "用户组名称不合法",
    "unknown directory": "所选目录不存在，请先在文件管理中创建",
    "unknown shared source": "未知的共享文件源",
    "access must be read, write or deny": "权限档位只能是只读、读写或收回",
    "invalid user name": "账号名称不合法",
}


def _go_detail_zh(detail: Any) -> str:
    text = str(detail or "").strip()
    if not text:
        return "未知原因"
    for needle, chinese in _GO_DETAIL_ZH.items():
        if needle in text:
            return chinese
    return text


def _normalize_grants(grants: Any) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for item in grants if isinstance(grants, list) else []:
        if not isinstance(item, dict):
            continue
        source = str(item.get("source") or "")
        if not source:
            continue
        access = str(item.get("access") or "read")
        if access not in {"read", "write", "deny"}:
            access = "read"
        out.append({"source": source, "path": str(item.get("path") or ""), "access": access})
    return out


def _audit(actor: str, action: str, target: str, detail: dict[str, Any]) -> None:
    try:
        db.execute(
            "INSERT INTO labspace.account_audit (actor, action, target, detail, ip) VALUES (%s,%s,%s,%s::jsonb,%s)",
            (actor, action, target, json.dumps(detail, ensure_ascii=False), audit.current_ip()),
        )
    except Exception as exc:  # audit failure must not block the operation
        log.warning("account audit failed: %s", exc)


class AccountCreate(BaseModel):
    name: str = Field(min_length=3, max_length=32)
    displayName: str = Field(default="", max_length=100)
    email: str = Field(default="", max_length=100)
    groups: list[str] = Field(default_factory=list)


class AccountUpdate(BaseModel):
    newName: str | None = Field(default=None, max_length=32)
    displayName: str | None = Field(default=None, max_length=100)
    email: str | None = Field(default=None, max_length=100)
    groups: list[str] | None = None
    isForbidden: bool | None = None


class PasswordReset(BaseModel):
    password: str = Field(min_length=10, max_length=72)


class FileGrant(BaseModel):
    source: str = Field(min_length=1, max_length=40)
    path: str = Field(default="", max_length=200)
    # deny 是"单独收回"：优先于组授权与管理员绕过，所以必须是可表达的一档。
    access: str = Field(default="read", pattern="^(read|write|deny)$")


class GroupAccess(BaseModel):
    grants: list[FileGrant] = Field(default_factory=list, max_length=200)


class GroupCreate(BaseModel):
    name: str = Field(min_length=2, max_length=32)
    displayName: str = Field(default="", max_length=100)
    enabled: bool = True
    grants: list[FileGrant] | None = None


class GroupPatch(BaseModel):
    # 改名会同步迁移成员归属与组文件授权；只改显示名/启停则不动成员。
    newName: str | None = Field(default=None, max_length=32)
    displayName: str | None = Field(default=None, max_length=100)
    enabled: bool | None = None


class ProjectAccess(BaseModel):
    # grants 是新的目录级授权（读写分离）；projects 仅为兼容旧客户端的
    # 项目目录快捷授权，两者互斥，同时出现时以 grants 为准。
    projects: list[str] | None = None
    grants: list[FileGrant] | None = None


def _grants_for(account_name: str, scopes: dict[str, Any], legacy: dict[str, Any]) -> list[dict[str, str]]:
    raw = scopes.get(account_name)
    if isinstance(raw, list) and raw:
        out: list[dict[str, str]] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            source = str(item.get("source") or "")
            if not source:
                continue
            # deny 必须原样透传：折叠成 read 会让界面上"被单独收回"的条目
            # 看起来仍然可读，而服务端其实已经拒绝。
            access = str(item.get("access") or "read")
            if access not in {"read", "write", "deny"}:
                access = "read"
            out.append(
                {
                    "source": source,
                    "path": str(item.get("path") or ""),
                    "access": access,
                }
            )
        return out
    # 旧版 Go 核心没有 scopes 字段时，从项目授权反推读写权限。
    projects = legacy.get(account_name) or []
    return [
        {"source": "projects", "path": str(p), "access": "write"}
        for p in projects
        if p
    ]


@router.get("")
@router.get("/")
async def list_accounts(
    q: str = Query("", max_length=100),
    _admin: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    like = f"%{q.strip()}%"
    rows = _query(
        """
        SELECT name, display_name, email, groups, is_admin, is_forbidden,
               is_deleted, created_time, updated_time, last_signin_time,
               (password IS NOT NULL AND length(password) > 0) AS has_password
        FROM public."user"
        WHERE owner = %s AND is_deleted = false
          AND (%s = '%%' OR name ILIKE %s OR display_name ILIKE %s OR email ILIKE %s)
        ORDER BY name
        LIMIT 500
        """,
        (OWNER, like, like, like, like),
    )
    groups = [
        {
            "name": str(g["name"]),
            "displayName": g.get("display_name") or "",
            "enabled": bool(g.get("is_enabled")),
        }
        for g in _known_groups().values()
    ]
    access = await file_access()
    projects = [str(p) for p in ((access or {}).get("projects") or []) if p]
    grants = (access or {}).get("grants") or {}
    if not isinstance(grants, dict):
        grants = {}
    scopes = (access or {}).get("scopes") or {}
    if not isinstance(scopes, dict):
        scopes = {}
    directories = (access or {}).get("directories") or {}
    if not isinstance(directories, dict):
        directories = {}
    file_groups_list = (access or {}).get("groups") or []
    if not isinstance(file_groups_list, list):
        file_groups_list = []
    accounts = [_account(r) for r in rows]
    for account in accounts:
        # 文件权限永远按邮箱前缀查找，登录名改了也不影响个人目录与授权。
        key = _file_key(account)
        granted = grants.get(key) or []
        account["projects"] = [str(p) for p in granted if p]
        account["fileGrants"] = _grants_for(key, scopes, grants)
        account["homeReady"] = os.path.isdir(
            os.path.join(settings.users_root, key)
        )
    return {
        "accounts": accounts,
        "total": len(accounts),
        "groups": groups,
        "fileGroups": [
            {
                "name": str(g.get("name") or ""),
                "builtin": bool(g.get("builtin")),
                "grants": _normalize_grants(g.get("grants")),
            }
            for g in file_groups_list
            if isinstance(g, dict) and g.get("name")
        ],
        "projects": projects,
        "directories": {
            str(source): [str(p) for p in paths]
            for source, paths in directories.items()
            if isinstance(paths, list)
        },
        "fileAccessAvailable": access is not None,
    }


@router.post("")
@router.post("/")
async def create_account(
    body: AccountCreate,
    admin: dict[str, Any] = Depends(require_admin),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    name = body.name.strip().lower()
    if not NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="用户名需以字母开头，仅含小写字母/数字/._-，长度 3–32")
    existing = _query(
        'SELECT name FROM public."user" WHERE owner = %s AND name = %s', (OWNER, name)
    )
    if existing:
        raise HTTPException(status_code=409, detail="用户名已存在")
    email = body.email.strip()
    if email:
        dup = _query(
            'SELECT name FROM public."user" WHERE owner = %s AND lower(email) = lower(%s) AND is_deleted = false',
            (OWNER, email),
        )
        if dup:
            raise HTTPException(status_code=409, detail="邮箱已被其他账号使用")
    groups = _validate_groups(body.groups)
    # 新账号使用服务端随机一次性口令，不再有全站通用默认口令。
    initial_password = generate_one_time_password()
    pwd = _hash_password(initial_password)
    now = _now()
    _execute(
        """
        INSERT INTO public."user"
          (owner, name, created_time, updated_time, id, type, password, password_salt,
           password_type, display_name, email, email_verified, is_admin, is_forbidden,
           is_deleted, signup_application, language, groups)
        VALUES (%s,%s,%s,%s,%s,'normal',%s,%s,'bcrypt',%s,%s,true,%s,false,false,
                'app-built-in','zh',%s)
        """,
        (
            OWNER,
            name,
            now,
            now,
            str(uuid.uuid4()),
            pwd,
            secrets.token_hex(11),
            body.displayName.strip() or name,
            email,
            ADMIN_GROUP in groups,
            json.dumps(groups, ensure_ascii=False),
        ),
    )
    # 一次性口令必须标记为"待修改"，避免管理员掌握的凭据长期有效。
    account_security.mark_must_change(name)
    ok, detail = await provision_user(_file_key({"name": name, "email": email}))
    if not ok:
        # 补偿删除，避免出现能登录但没有任何个人文件空间的半成品账号。
        _execute('DELETE FROM public."user" WHERE owner = %s AND name = %s', (OWNER, name))
        _audit(_audit_actor(admin), "create-failed", name, {"reason": detail})
        raise HTTPException(
            status_code=502, detail=f"个人文件空间初始化失败，账号未创建：{_go_detail_zh(detail)}"
        )
    _audit(_audit_actor(admin), "create", name, {"groups": groups})
    account = _account(_get_user(name))
    account["projects"] = []
    account["fileGrants"] = [
        {"source": "public", "path": "", "access": "read"},
        {"source": "course-materials", "path": "", "access": "read"},
        {"source": "plasmids", "path": "", "access": "read"},
    ]
    account["homeReady"] = True
    # 明确回传**实际使用**的初始口令：口令由服务端统一生成（不接受管理员自选），
    # 不回传的话前端只能显示管理员在表单里填的那个值 —— 那个值是无效的，
    # 用户拿着它登不进去（这是"新建账号后用户登录失败"的常见根因）。
    return {"ok": True, "account": account, "initialPassword": initial_password}


@router.patch("/{name}")
async def update_account(
    name: str,
    body: AccountUpdate,
    admin: dict[str, Any] = Depends(require_admin),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    current = _get_user(name)
    if current.get("is_deleted"):
        raise HTTPException(status_code=404, detail="账号已删除")

    new_name = name
    if body.newName is not None:
        candidate = body.newName.strip().lower()
        if candidate and candidate != name:
            if not NAME_RE.match(candidate):
                raise HTTPException(
                    status_code=400, detail="用户名需以字母开头，仅含小写字母/数字/._-，长度 3–32"
                )
            dup = _query(
                'SELECT name FROM public."user" WHERE owner = %s AND name = %s', (OWNER, candidate)
            )
            if dup:
                raise HTTPException(status_code=409, detail="用户名已存在")
            new_name = candidate

    groups = _groups_of(current.get("groups"))
    new_groups = _validate_groups(body.groups) if body.groups is not None else groups
    forbidden = bool(body.isForbidden) if body.isForbidden is not None else bool(current.get("is_forbidden"))
    if body.displayName is None:
        display_name = current.get("display_name") or ""
    else:
        display_name = body.displayName.strip()
    if body.email is None:
        email = current.get("email") or ""
    else:
        email = body.email.strip()

    actor_email = str(admin.get("email") or "").lower()
    current_email = str(current.get("email") or "").lower()
    is_self = bool(actor_email) and current_email == actor_email
    if is_self and forbidden:
        raise HTTPException(status_code=400, detail="不能禁用当前登录账号")

    losing_admin = ADMIN_GROUP in groups and (ADMIN_GROUP not in new_groups or forbidden)
    if losing_admin:
        remaining = [n for n in _enabled_admins() if n != name]
        if not remaining:
            raise HTTPException(status_code=400, detail="必须保留至少一个可用管理员")

    if email:
        dup = _query(
            """
            SELECT name FROM public."user"
            WHERE owner = %s AND lower(email) = lower(%s) AND name <> %s AND is_deleted = false
            """,
            (OWNER, email, name),
        )
        if dup:
            raise HTTPException(status_code=409, detail="邮箱已被其他账号使用")

    _execute(
        """
        UPDATE public."user"
        SET name = %s, display_name = %s, email = %s, groups = %s, is_forbidden = %s, updated_time = %s
        WHERE owner = %s AND name = %s
        """,
        (
            new_name,
            display_name,
            email,
            json.dumps(new_groups, ensure_ascii=False),
            forbidden,
            _now(),
            OWNER,
            name,
        ),
    )
    if new_name != name:
        # Casdoor 的会话/令牌行按旧登录名存放；改名后清掉，旧名令牌不再可用。
        for table, column in _CASDOOR_USER_TABLES:
            try:
                # 表名/列名来自本文件顶部的常量元组，不是用户输入；但仍用
                # Identifier 交给驱动做标识符转义，避免以后有人把常量改成动态值。
                _execute(
                    sql.SQL("DELETE FROM public.{} WHERE owner = %s AND {} = %s").format(
                        sql.Identifier(table), sql.Identifier(column)
                    ),
                    (OWNER, name),
                )
            except Exception as exc:  # noqa: BLE001 - 令牌清理失败不应回滚改名
                log.warning("casdoor token cleanup after rename failed (%s): %s", table, exc)
    _audit(
        _audit_actor(admin),
        "rename" if new_name != name else "update",
        new_name,
        {
            "oldName": name,
            "newName": new_name,
            "groups": new_groups,
            "email": email,
            "displayName": display_name,
            "isForbidden": forbidden,
        },
    )
    if forbidden or new_groups != groups:
        # 会话是 JWT，is_forbidden 与 roles 都写死在已签发的令牌里；不吊销的话
        # 禁用与改组要等到过期（默认 8 小时）才真正生效。
        db.revoke_sessions(str(current.get("id") or ""), "account-disabled" if forbidden else "groups-changed")
    return {"ok": True, "account": _account(_get_user(new_name))}


@router.post("/{name}/provision")
async def provision_account(
    name: str,
    admin: dict[str, Any] = Depends(require_admin),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    current = _get_user(name)
    if current.get("is_deleted"):
        raise HTTPException(status_code=404, detail="账号已删除")
    ok, detail = await provision_user(_file_key(current))
    if not ok:
        raise HTTPException(status_code=502, detail=f"文件空间初始化失败：{_go_detail_zh(detail)}")
    _audit(_audit_actor(admin), "provision", name, {})
    return {"ok": True}


@router.put("/{name}/file-access")
async def update_file_access(
    name: str,
    body: ProjectAccess,
    admin: dict[str, Any] = Depends(require_admin),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    current = _get_user(name)
    if current.get("is_deleted"):
        raise HTTPException(status_code=404, detail="账号已删除")
    if body.grants is not None:
        if len(body.grants) > 200:
            raise HTTPException(status_code=400, detail="授权目录数量超出限制")
        grants = [g.model_dump() for g in body.grants]
        ok, detail = await set_file_grants(_file_key(current), grants)
        if not ok:
            raise HTTPException(status_code=502, detail=f"文件权限更新失败：{_go_detail_zh(detail)}")
        _audit(_audit_actor(admin), "file-access", name, {"grants": grants})
        projects = [g["path"] for g in grants if g["source"] == "projects" and g["access"] == "write"]
        return {"ok": True, "grants": grants, "projects": projects}
    if body.projects is None:
        raise HTTPException(status_code=400, detail="请提供 grants 或 projects")
    if len(body.projects) > 100:
        raise HTTPException(status_code=400, detail="项目目录数量超出限制")
    ok, detail = await set_project_access(_file_key(current), body.projects)
    if not ok:
        raise HTTPException(status_code=502, detail=f"文件权限更新失败：{_go_detail_zh(detail)}")
    _audit(_audit_actor(admin), "file-access", name, {"projects": body.projects})
    return {"ok": True, "projects": body.projects}


def _group_member_names(name: str) -> list[str]:
    rows = _query(
        'SELECT name, groups FROM public."user" WHERE owner = %s AND is_deleted = false',
        (OWNER,),
    )
    return [str(r["name"]) for r in rows if name in _groups_of(r.get("groups"))]


def _replace_member_group(old: str, new: str | None) -> int:
    """把成员的旧组替换为新组（new=None 表示移除）。返回受影响账号数。"""
    rows = _query(
        'SELECT name, groups FROM public."user" WHERE owner = %s AND is_deleted = false',
        (OWNER,),
    )
    changed = 0
    for row in rows:
        groups = _groups_of(row.get("groups"))
        if old not in groups:
            continue
        updated: list[str] = []
        for g in groups:
            if g == old:
                if new and new not in updated:
                    updated.append(new)
            elif g not in updated:
                updated.append(g)
        _execute(
            'UPDATE public."user" SET groups = %s, updated_time = %s WHERE owner = %s AND name = %s',
            (json.dumps(updated, ensure_ascii=False), _now(), OWNER, row["name"]),
        )
        changed += 1
    return changed


@router.post("/groups")
async def create_group(
    body: GroupCreate,
    admin: dict[str, Any] = Depends(require_admin),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    name = body.name.strip().lower()
    if not GROUP_RE.match(name):
        raise HTTPException(status_code=400, detail=GROUP_NAME_HINT)
    if name in _known_groups():
        raise HTTPException(status_code=409, detail=f"用户组 {name} 已存在")
    now = _now()
    _execute(
        """
        INSERT INTO public."group"
            (owner, name, created_time, updated_time, display_name, is_enabled)
        VALUES (%s, %s, %s, %s, %s, %s)
        """,
        (OWNER, name, now, now, body.displayName.strip() or name, body.enabled),
    )
    grants: list[dict[str, Any]] = []
    if body.grants is not None:
        normalized, detail = await set_group_grants(name, [g.model_dump() for g in body.grants])
        if normalized is None:
            _execute('DELETE FROM public."group" WHERE owner = %s AND name = %s', (OWNER, name))
            raise HTTPException(status_code=502, detail=f"用户组权限写入失败：{_go_detail_zh(detail)}")
        grants = normalized
    _audit(_audit_actor(admin), "group-create", name, {"displayName": body.displayName, "grants": grants})
    return {
        "ok": True,
        "name": name,
        "displayName": body.displayName.strip() or name,
        "enabled": body.enabled,
        "grants": grants,
    }


@router.patch("/groups/{group}")
async def patch_group(
    group: str,
    body: GroupPatch,
    admin: dict[str, Any] = Depends(require_admin),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    name = group.strip().lower()
    known = _known_groups()
    if name not in known:
        raise HTTPException(status_code=404, detail=f"用户组 {name} 不存在于统一身份源")
    new_name = (body.newName or "").strip().lower() or None
    if new_name and new_name != name:
        if not GROUP_RE.match(new_name):
            raise HTTPException(status_code=400, detail=GROUP_NAME_HINT)
        if new_name in known:
            raise HTTPException(status_code=409, detail=f"用户组 {new_name} 已存在")
        # 迁移成员归属，再把组文件授权复制到新组名，最后删除旧授权。
        moved = _replace_member_group(name, new_name)
        existing = await file_groups() or []
        old_grants = next(
            (g.get("grants") for g in existing if isinstance(g, dict) and str(g.get("name")) == name),
            [],
        )
        if old_grants:
            copied, detail = await set_group_grants(new_name, list(old_grants))
            if copied is None:
                _replace_member_group(new_name, name)
                raise HTTPException(status_code=502, detail=f"用户组权限迁移失败：{_go_detail_zh(detail)}")
        await delete_file_group(name)
        _execute(
            'UPDATE public."group" SET name = %s, updated_time = %s WHERE owner = %s AND name = %s',
            (new_name, _now(), OWNER, name),
        )
        if moved:
            # 会话里缓存的是登录时的组，改名后吊销让其重新签发。
            for member in _group_member_names(new_name):
                row = _get_user(member)
                db.revoke_sessions(str(row.get("id") or ""), "groups-changed")
        _audit(_audit_actor(admin), "group-rename", name, {"newName": new_name, "members": moved})
        name = new_name
    display = body.displayName.strip() if body.displayName is not None else None
    enabled = body.enabled
    if display is not None or enabled is not None:
        sets: list[str] = ["updated_time = %s"]
        params: list[Any] = [_now()]
        if display is not None:
            sets.append("display_name = %s")
            params.append(display or name)
        if enabled is not None:
            sets.append("is_enabled = %s")
            params.append(enabled)
        params.extend([OWNER, name])
        # sets 里每一项都是本文件写死的 "列名 = %s"（白名单），值走占位符；
        # 用 sql.SQL 组合标识符，避免将来有人把列名改成动态值。
        assignments = [sql.SQL(part) for part in sets]
        _execute(
            sql.SQL('UPDATE public."group" SET {} WHERE owner = %s AND name = %s').format(
                sql.SQL(", ").join(assignments)
            ),
            tuple(params),
        )
        if enabled is False:
            for member in _group_member_names(name):
                row = _get_user(member)
                db.revoke_sessions(str(row.get("id") or ""), "groups-changed")
        _audit(_audit_actor(admin), "group-update", name, {"displayName": display, "enabled": enabled})
    return {"ok": True, "name": name}


@router.get("/groups")
async def list_file_groups(
    _admin: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    """用户组视图：成员关系来自统一身份源，文件权限来自 LabGo。"""
    known = _known_groups()
    members = _group_members()
    # file_access 一次性带回组模板与可选目录，避免为同一个界面打两次文件核心。
    access = await file_access()
    acl_groups = (access or {}).get("groups")
    if not isinstance(acl_groups, list):
        acl_groups = None
    directories = (access or {}).get("directories") or {}
    if not isinstance(directories, dict):
        directories = {}
    grants_by_group = {
        str(g.get("name")): _normalize_grants(g.get("grants"))
        for g in (acl_groups or [])
        if isinstance(g, dict) and g.get("name")
    }
    builtin = {
        str(g.get("name")) for g in (acl_groups or []) if isinstance(g, dict) and g.get("builtin")
    }
    out: list[dict[str, Any]] = []
    for name in sorted(set(known) | set(grants_by_group) | set(members)):
        info = known.get(name) or {}
        out.append(
            {
                "name": name,
                "displayName": str(info.get("display_name") or "") or name,
                "enabled": bool(info.get("is_enabled", False)),
                "members": members.get(name, []),
                "grants": grants_by_group.get(name, []),
                "builtin": name in builtin,
                # 两个方向的不一致都要看得见：身份源里有组但没配文件权限，
                # 或文件权限里有组但身份源已不存在（成员永远配不上）。
                "hasFileGrants": name in grants_by_group,
                "inIdentitySource": name in known,
            }
        )
    return {
        "groups": out,
        "total": len(out),
        "directories": {
            str(source): [str(p) for p in paths]
            for source, paths in directories.items()
            if isinstance(paths, list)
        },
        "fileAccessAvailable": access is not None,
    }


@router.put("/groups/{group}")
async def update_file_group(
    group: str,
    body: GroupAccess,
    admin: dict[str, Any] = Depends(require_admin),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    name = group.strip().lower()
    if not GROUP_RE.match(name):
        raise HTTPException(status_code=400, detail=GROUP_NAME_HINT)
    # 组名必须对应身份源里真实存在的组，否则成员关系永远配不上；
    # 已配置过文件权限的组允许继续编辑，避免改名后无法收拾。
    if name not in _known_groups():
        existing = await file_groups()
        if not any(isinstance(g, dict) and str(g.get("name")) == name for g in (existing or [])):
            raise HTTPException(status_code=400, detail=f"用户组 {name} 不在统一身份源中，请先在身份源创建")
    grants, detail = await set_group_grants(name, [g.model_dump() for g in body.grants])
    if grants is None:
        raise HTTPException(status_code=502, detail=f"用户组权限更新失败：{_go_detail_zh(detail)}")
    _audit(_audit_actor(admin), "group-access", name, {"grants": grants})
    return {"ok": True, "name": name, "grants": grants}


@router.delete("/groups/{group}")
async def remove_file_group(
    group: str,
    force: bool = Query(False),
    admin: dict[str, Any] = Depends(require_admin),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    name = group.strip().lower()
    if not GROUP_RE.match(name):
        raise HTTPException(status_code=400, detail=GROUP_NAME_HINT)
    known = _known_groups()
    members = _group_member_names(name)
    if members and not force:
        raise HTTPException(
            status_code=409,
            detail=f"用户组 {name} 仍有 {len(members)} 名成员，请先移出或使用强制删除",
        )
    # 内置文件模板（lab-student / lab-teacher / lab-admin）由文件核心保护，
    # 但身份源里的同名组仍可删除；模板保留本身无害，只是不再有人继承。
    ok, detail = await delete_file_group(name)
    if not ok and "builtin" not in str(detail).lower() and "unknown" not in str(detail).lower():
        raise HTTPException(status_code=400, detail=_go_detail_zh(detail))
    removed_members = 0
    if name in known:
        removed_members = _replace_member_group(name, None)
        _execute('DELETE FROM public."group" WHERE owner = %s AND name = %s', (OWNER, name))
        for member in members:
            row = _get_user(member)
            db.revoke_sessions(str(row.get("id") or ""), "groups-changed")
    _audit(_audit_actor(admin), "group-delete", name, {"members": members, "force": force})
    return {"ok": True, "name": name, "removedMembers": removed_members}


@router.post("/{name}/access-preview")
async def preview_account_access(
    name: str,
    _admin: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    """按真实的判定顺序预演某账号的文件权限，避免"配置看起来对"与"实际能访问"各说一套。"""
    current = _get_user(name)
    if current.get("is_deleted"):
        raise HTTPException(status_code=404, detail="账号已删除")
    roles = _groups_of(current.get("groups"))
    email = str(current.get("email") or "")
    is_admin = ADMIN_GROUP in [r.lower() for r in roles] or bool(current.get("is_admin"))
    probes, detail = await access_preview(name.strip().lower(), email, roles, is_admin)
    if probes is None:
        raise HTTPException(status_code=502, detail=f"文件权限预演失败：{_go_detail_zh(detail)}")
    return {
        "name": name.strip().lower(),
        "roles": roles,
        "admin": is_admin,
        "probes": probes,
    }


@router.post("/{name}/password")
async def reset_password(
    name: str,
    body: PasswordReset,
    admin: dict[str, Any] = Depends(require_admin),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    current = _get_user(name)
    if current.get("is_deleted"):
        raise HTTPException(status_code=404, detail="账号已删除")
    pwd = _hash_password(body.password)
    _execute(
        """
        UPDATE public."user"
        SET password = %s, password_salt = %s, password_type = 'bcrypt', updated_time = %s
        WHERE owner = %s AND name = %s
        """,
        (pwd, secrets.token_hex(11), _now(), OWNER, name),
    )
    _audit(_audit_actor(admin), "reset-password", name, {})
    # 管理员设的口令等同于新的「初始口令」：必须要求本人改掉，
    # 否则管理员知道的那个口令会一直是有效凭据。
    account_security.mark_must_change(name)
    if _audit_actor(admin) != name:
        # 改密后旧令牌仍然有效直到过期，必须吊销；管理员给自己改密则保持在线。
        db.revoke_sessions(str(current.get("id") or ""), "password-reset")
    return {"ok": True}


# 硬删除要一并清除的业务数据：这些表都按会话 sub（即 Casdoor 的用户 id）隔离。
_LABSPACE_USER_TABLES = (
    ("workbench_items", "user_id"),
    ("workbench_projects", "user_id"),
    ("workbench_plans", "user_id"),
    ("workbench_briefs", "user_id"),
    ("agent_sessions", "user_id"),
    ("agent_messages", "user_id"),
    ("favorites", "user_id"),
    ("recent", "user_id"),
    ("drawings", "user_id"),
    ("knowledge_docs", "owner"),
    ("knowledge_spaces", "owner"),
)

# Casdoor 侧按用户名引用账号的表。public.record（Casdoor 自己的审计）保留，
# 它是这次删除的凭据之一。
#: 账号删除/改名时要一并清理的 Casdoor 附属表：(表名, 关联列名)。
#
# 列名写**裸名**（"user" 而不是 '"user"'）：这些值会交给 sql.Identifier 转义，
# 自带双引号会让它把引号当普通字符再转义一次，生成 """user"""，
# 于是 PostgreSQL 报 `column ""user"" does not exist`，账号删不掉。
_CASDOOR_USER_TABLES = (
    ("session", "name"),
    ("token", "user"),
    ("resource", "user"),
    ("third_party_link", "user_name"),
    ("password_history", "name"),
    ("verification_record", "user"),
)


class AccountDeleteConfirm(BaseModel):
    confirm: str = Field(min_length=1, max_length=64)


@router.delete("/{name}")
async def delete_account(
    name: str,
    body: AccountDeleteConfirm,
    admin: dict[str, Any] = Depends(require_admin),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    """硬删除账号：身份、个人文件空间与各服务业务数据一并清除，不可恢复。

    顺序是刻意的：先吊销会话（无状态 JWT 不会因删除而失效），再切断文件授权并
    删除个人目录，最后才动数据库行。任何一步失败都保留账号，可用同一请求重试。
    个人目录仍出现在当晚的 /srv/lab 全量备份里，但那是备份而不是可依赖的回滚。
    """
    current = _get_user(name)
    if current.get("is_deleted"):
        raise HTTPException(status_code=404, detail="账号已删除")
    if body.confirm.strip() != name:
        raise HTTPException(status_code=400, detail="请输入准确的账号标识以确认删除")
    actor = _audit_actor(admin)
    if actor == name:
        raise HTTPException(status_code=400, detail="不能删除当前登录账号")
    groups = _groups_of(current.get("groups"))
    if ADMIN_GROUP in groups and not [n for n in _enabled_admins() if n != name]:
        raise HTTPException(status_code=400, detail="必须保留至少一个可用管理员")

    subject = str(current.get("id") or "")
    email = str(current.get("email") or "").lower()
    snapshot = {
        "id": subject,
        "email": email,
        "displayName": current.get("display_name") or "",
        "groups": groups,
        "createdAt": current.get("created_time") or "",
    }

    if not subject:
        raise HTTPException(status_code=400, detail="账号缺少用户标识，无法安全吊销会话")
    db.revoke_sessions(subject, "account-deleted")

    ok, files = await deprovision_user(_file_key(current))
    if not ok:
        _audit(actor, "delete-failed", name, {"reason": str(files)})
        raise HTTPException(
            status_code=502,
            detail=f"个人文件空间清理失败，账号与业务数据已保留：{_go_detail_zh(str(files))}",
        )

    purged: dict[str, int] = {}
    for table, column in _LABSPACE_USER_TABLES:
        # SAFETY: table/column 只来自常量元组 _LABSPACE_USER_TABLES（编译期固定），
        # 这里再断言一次，保证将来有人把它改成动态值时立刻在这里失败，
        # 而不是悄悄变成一个可注入的 DELETE。
        if (table, column) not in _LABSPACE_USER_TABLES:
            raise AssertionError("非法的用户表清理目标")
        purged[table] = len(
            db.query(
                statement=sql.SQL("DELETE FROM labspace.{} WHERE {} = %s RETURNING 1").format(
                    sql.Identifier(table), sql.Identifier(column)
                ),
                params=(subject,),
            )
        )
    # 公告是全站内容，删掉会连带影响其他用户；只隐去作者并把原名留在审计里。
    announcements = 0
    if email:
        announcements = len(
            db.query(
                "UPDATE labspace.announcements SET author = %s WHERE lower(author) = lower(%s) RETURNING 1",
                (f"已删除账号（{name}）", email),
            )
        )
    purged["announcements"] = announcements
    for table, column in _CASDOOR_USER_TABLES:
        purged[f"casdoor.{table}"] = _execute(
            sql.SQL('DELETE FROM public.{} WHERE owner = %s AND {} = %s').format(
                sql.Identifier(table), sql.Identifier(column)
            ),
            (OWNER, name),
        )
    purged["casdoor.user"] = _execute(
        'DELETE FROM public."user" WHERE owner = %s AND name = %s', (OWNER, name)
    )
    if email:
        try:
            purged["baserow"] = await baserow_mod.purge_user(email)
        except Exception:  # noqa: BLE001 - Baserow 不可用时不应阻塞账号硬删除
            purged["baserow"] = -1
            log.warning("baserow purge failed for %s", name, exc_info=True)

    _audit(
        actor,
        "delete",
        name,
        {"account": snapshot, "purged": purged, "files": files, "announcements": announcements},
    )
    return {"ok": True, "name": name, "purged": purged, "files": files}
