"""导师-组员共享目录（v26.11）。

每位组员固定三个目录：``01_组会汇报`` / ``02_论文`` / ``03_其他``；
导师可以在此基础上**自设**更多目录，学生**不可**。

物理结构（只有一份，挂在导师家目录下）::

    users/<导师账号>/共享文件-组员/<学号>_<姓名>/{01_组会汇报,02_论文,03_其他}

权限口径（导师定，学生只在自己那棵目录里活动）：

* 导师：上传 / 下载 / 编辑 / 删除（整棵树，含自设目录）
* 学生：查看 + 上传；**不能**下载、不能改名移动、不能新建子目录；
  删除只对 **48 小时内**上传的材料开放。

名册存在门户库（``labspace.lab_roster``），目录与授权由文件核心落地：
本模块负责"名册 → 目录 + ACL"的同步，文件核心负责真正执行权限。
"""
from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import accounts, db
from .admin_research import labgo_admin, labgo_user_request
from .config import settings
from .security import has_role, require_csrf, require_user
from . import audit

log = logging.getLogger("labspace.labshared")

router = APIRouter(prefix="/api/lab/shared", tags=["lab-shared"])

#: 共享树在文件核心里的固定名字（用户要求的口径，导师和学生看到的是同一个）。
TREE_NAME = "共享文件-组员"

#: 每位组员固定的三���目录。
DEFAULT_FOLDERS = ("01_组会汇报", "02_论文", "03_其他")

#: 学生删除自己上传材料的时间窗（小时）。
DELETE_WINDOW_HOURS = 48

#: 组员文件夹名：``{学号}_{姓名}``。
FOLDER_RE = re.compile(r"^\d{4}_[^/\\]+$")

#: 账号键形态（小写字母/数字/下划线/连字符）；显示名不在此列。
_ACCOUNT_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")

#: 名册初始名单（2026-11 在研组员）。学号 + 姓名，账号在门户里另建。
ROSTER_SEED: tuple[tuple[str, str], ...] = (
    ("2506", "赵同学"),
    ("2509", "李同学"),
    ("2510", "陈同学"),
    ("2510", "周同学"),
    ("2510", "吴同学"),
    ("2601", "孙同学"),
    ("2605", "郑同学"),
    ("2605", "钱同学"),
    ("2606", "王同学"),
    ("2607", "蒋同学"),
    ("2606", "冯同学"),
    ("2607", "沈同学"),
    ("2609", "韩同学"),
)

# 表结构在 app/db.py 的 SCHEMA 里建（启动时统一执行），这里不再跑 DDL。


def _ensure_member_columns() -> None:
    """给老库补 identity 列（幂等）。

    `lab_roster` 最早只有 code/name/status/account；身份（博士/硕士/本科…）
    是后加的需求。用 ALTER ... IF NOT EXISTS 让已存在的库无需手工迁移。
    """
    db.execute("ALTER TABLE labspace.lab_roster ADD COLUMN IF NOT EXISTS identity text NOT NULL DEFAULT '硕士生'")


def _as_int(value: Any) -> int:
    """安全取整数：脏数据（NULL / 文本）一律按 0 处理，不让整个接口 500。"""
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


# ------------------------------------------------------------------ 名册存取


def seed_roster(advisor: str) -> int:
    """把初始名册写进去（已存在的跳过）。返回新增条数。"""
    added = 0
    for code, name in ROSTER_SEED:
        # 按**学号**判重，而不是 (学号, 姓名)：
        # 名单里的姓名可能与账号实际姓名不一致（改名、或名单本身记错），
        # 按姓名判重会让同一学号长出第二行，同步时反复建出重复目录。
        rows = db.query(
            "SELECT id, name FROM labspace.lab_roster WHERE advisor=%s AND code=%s",
            (advisor, code),
        )
        if rows:
            continue
        db.execute(
            "INSERT INTO labspace.lab_roster (advisor, code, name, status) VALUES (%s, %s, %s, %s)",
            (advisor, code, name, "在研"),
        )
        added += 1
    return added


def list_members(advisor: str) -> list[dict[str, Any]]:
    _fix_legacy_advisor(advisor)
    rows = db.query(
        "SELECT id, code, name, status, account, identity, created_at "
        "FROM labspace.lab_roster WHERE advisor=%s ORDER BY code, name",
        (advisor,),
    )
    display = _display_names()
    out: list[dict[str, Any]] = []
    for r in rows:
        code = str(r.get("code") or "")
        name = str(r.get("name") or "")
        account = str(r.get("account") or "")
        # 文件夹名用**当前显示名**（{学号}_{姓名}）：
        # 名单里的旧姓名（例如改名前的"李同学"）与账号现在的姓名不一致时，
        # 目录必须跟着账号走，否则会凭空多出一棵重复的目录。
        shown = display.get(account) or name
        out.append(
            {
                "id": _as_int(r.get("id")),
                "code": code,
                "name": name,
                "displayName": shown,
                "status": str(r.get("status") or "在研"),
                "identity": str(r.get("identity") or "硕士生"),
                "account": account,
                "folder": f"{code}_{shown}",
            }
        )
    return out


def _display_names() -> dict[str, str]:
    """账号键 → 当前显示名（中文姓名）。"""
    try:
        rows = accounts._query(
            """
            SELECT name, display_name, email FROM public."user"
             WHERE owner = %s AND is_deleted = false AND is_forbidden = false
             LIMIT 1000
            """,
            (accounts.OWNER,),
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("读取账号显示名失败：%s", exc)
        return {}
    out: dict[str, str] = {}
    for row in rows:
        email = str(row.get("email") or "").strip().lower()
        key = email.split("@", 1)[0] if "@" in email else email
        display = str(row.get("display_name") or "").strip()
        if key and display:
            out[key] = display
    return out


def find_member(advisor: str, member_id: int) -> dict[str, Any] | None:
    for m in list_members(advisor):
        if m["id"] == member_id:
            return m
    return None


def remove_member(advisor: str, member_id: int) -> bool:
    rows = db.query(
        "SELECT id FROM labspace.lab_roster WHERE advisor=%s AND id=%s", (advisor, member_id)
    )
    if not rows:
        return False
    db.execute("DELETE FROM labspace.lab_roster WHERE advisor=%s AND id=%s", (advisor, member_id))
    return True


def link_account(advisor: str, member_id: int, account: str) -> None:
    db.execute(
        "UPDATE labspace.lab_roster SET account=%s WHERE advisor=%s AND id=%s",
        (account, advisor, member_id),
    )


# ------------------------------------------------------------------ 目录与授权


def account_key(user: dict[str, Any]) -> str:
    """会话用户的**文件账号键**（邮箱前缀），与文件核心一致。

    登录名可能改，邮箱前缀才是个人目录与 ACL 的稳定身份；
    显示名（中文姓名）不能用来拼路径。
    """
    email = str(user.get("email") or "").strip().lower()
    if email and "@" in email:
        return email.split("@", 1)[0]
    if email:
        return email
    return str(user.get("name") or "").strip().lower()


def _advisor_of(user: dict[str, Any]) -> str:
    """当前会话对应的导师账号键。

    导师本人登录时就是他自己的账号键；组员登录时用名册里已有的那位导师。
    """
    if has_role(user, settings.teacher_roles):
        return account_key(user)
    # 组员登录时只能“猜”导师：名册里按 advisor 取一个（加 ORDER BY 是为了
    # 结果稳定 —— 之前没有排序，两个导师并存时同一个学生可能看到两棵不同的树）。
    rows = db.query("SELECT DISTINCT advisor FROM labspace.lab_roster ORDER BY advisor LIMIT 5")
    if rows:
        advisor = str(rows[0].get("advisor") or "")
        if advisor:
            return advisor
    return account_key(user)


def _fix_legacy_advisor(advisor: str) -> None:
    """把早期用显示名写入的导师列改成账号键。

    名册早期版本用中文姓名当 advisor，路径拼出来的是「陈同学/共享文件-组员」，
    文件核心只认账号目录（adminlegacy/...），这类行必须修正，否则建目录必然 403。
    """
    rows = db.query(
        "SELECT DISTINCT advisor FROM labspace.lab_roster WHERE advisor <> %s", (advisor,)
    )
    for row in rows:
        old = str(row.get("advisor") or "")
        # 只修正明显是显示名的（不是纯账号形态）；真正的另一个导师不动。
        if not old or _ACCOUNT_KEY_RE.match(old):
            continue
        legacy = db.query(
            "SELECT id, code, name FROM labspace.lab_roster WHERE advisor=%s", (old,)
        )
        for item in legacy:
            dup = db.query(
                "SELECT id FROM labspace.lab_roster WHERE advisor=%s AND code=%s AND name=%s",
                (advisor, item.get("code"), item.get("name")),
            )
            if dup:
                # 同一名在新 advisor 下已经有了：删掉旧行，避免唯一键冲突。
                db.execute(
                    "DELETE FROM labspace.lab_roster WHERE advisor=%s AND id=%s",
                    (old, item.get("id")),
                )
                continue
            db.execute(
                "UPDATE labspace.lab_roster SET advisor=%s WHERE advisor=%s AND id=%s",
                (advisor, old, item.get("id")),
            )


def _auto_link_accounts(advisor: str, members: list[dict[str, Any]]) -> None:
    """按姓名把名册行关联到门户账号（学号_姓名 → 账号键）。

    名册里的姓名是中文姓名，账号键是邮箱前缀；两者对不上时以**姓名**为准匹配
    Casdoor 的 display_name，匹配到就顺手写回名册（省得导师手工填）。
    """
    pending = [m for m in members if not m.get("account")]
    if not pending:
        return
    try:
        users = accounts._query(
            """
            SELECT name, display_name, email FROM public."user"
             WHERE owner = %s AND is_deleted = false AND is_forbidden = false
             LIMIT 1000
            """,
            (accounts.OWNER,),
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("读取账号列表失败：%s", exc)
        return
    by_display: dict[str, str] = {}
    for row in users:
        display = str(row.get("display_name") or "").strip()
        email = str(row.get("email") or "").strip().lower()
        key = email.split("@", 1)[0] if "@" in email else email
        if display and key:
            by_display.setdefault(display, key)
    for member in pending:
        key = by_display.get(str(member.get("name") or "").strip())
        if not key:
            continue
        link_account(advisor, _as_int(member["id"]), key)
        member["account"] = key


def tree_root(advisor: str) -> str:
    """共享树在文件核心里的相对路径。"""
    return f"{advisor}/{TREE_NAME}"


def member_root(advisor: str, member: dict[str, Any]) -> str:
    return f"{tree_root(advisor)}/{member['folder']}"


async def _ensure_dir(request: Request, path: str) -> tuple[bool, str]:
    """确保目录存在（已存在算成功）。"""
    status, payload = await labgo_user_request(
        "POST", "/v1/files/mkdir", request, json_body={"source": "users", "path": path}
    )
    if status in (200, 409):
        return True, ""
    detail = ""
    if isinstance(payload, dict):
        detail = str(payload.get("error") or "")
    return False, detail or f"文件核心返回 {status}"


async def _ensure_tree(request: Request, advisor: str, member: dict[str, Any]) -> tuple[bool, str]:
    """按名册把某个组员的目录补齐（三个固定目录，缺一个建一个）。"""
    root = member_root(advisor, member)
    ok, detail = await _ensure_dir(request, root)
    if not ok:
        return False, f"{member['folder']}：{detail}"
    for folder in DEFAULT_FOLDERS:
        ok, detail = await _ensure_dir(request, f"{root}/{folder}")
        if not ok:
            return False, f"{member['folder']}/{folder}：{detail}"
    return True, ""


async def _grant_member(advisor: str, member: dict[str, Any]) -> tuple[bool, str]:
    """把「查看 + 上传 + 48 小时内可删」的授权写给该组员。

    共享树物理上在**导师家目录**里（users 源），而共享源授权接口
    （/v1/admin/file-access）明确不写 users 源，所以这里走个人空间专用入口
    /v1/admin/personal-access。
    """
    account = str(member.get("account") or "").strip()
    if not account:
        return True, ""  # 还没建账号的组员先不发授权
    if account == advisor:
        # 导师自己的那棵目录就在他家目录里，权限天然齐全，
        # 再发一条授权会被文件核心判为「给自己家目录授权」而拒绝。
        return True, ""
    path = member_root(advisor, member)
    ok, detail = await labgo_admin(
        "PUT",
        f"/v1/admin/personal-access/{quote(account, safe='')}",
        {
            "grants": [
                {
                    "source": "users",
                    "path": path,
                    "access": "upload",
                    "delete_within": f"{DELETE_WINDOW_HOURS}h",
                }
            ]
        },
    )
    if not ok:
        return False, str(detail)
    # 跨目录共享 = 把导师家目录里的一棵子树开给组员，属于权限变更，必须留痕
    audit.record(
        advisor,
        "share.grant",
        f"users:{path}",
        {"member": account, "access": "upload", "delete_within_hours": DELETE_WINDOW_HOURS},
    )
    return True, ""


def _grant_of(scope: dict[str, Any]) -> dict[str, Any]:
    """把文件核心返回的 scope 转回授权条目（保留 no_dirs / delete_within）。"""
    if scope.get("deny"):
        access = "deny"
    elif scope.get("no_dirs"):
        access = "upload"
    elif scope.get("create") or scope.get("modify") or scope.get("delete"):
        access = "write"
    else:
        access = "read"
    grant: dict[str, Any] = {
        "source": "users",
        "path": str(scope.get("path") or ""),
        "access": access,
    }
    window = str(scope.get("delete_within") or "").strip()
    if window:
        grant["delete_within"] = window
    return grant


async def _revoke_member(advisor: str, member: dict[str, Any]) -> tuple[bool, str]:
    """收回某组员在自己目录上的授权（目录与数据保留）。"""
    account = str(member.get("account") or "").strip()
    if not account:
        return True, ""
    if account == advisor:
        # 导师本人的那一行就在他家目录里，本来就不该有"别人给"的授权。
        # 之前这里照样发了一次 PUT，把整份授权列表（去掉共享树条目后）写回去，
        # 而剩下条目里包含导师自己的家目录 → 文件核心判为
        # "cannot grant access to one's own home" 直接拒绝，
        # 于是界面报「移除失败：授权收回失败」。与 _grant_member 是同一个坑。
        return True, ""
    ok, scopes = await labgo_admin(
        "GET", f"/v1/admin/personal-access/{quote(account, safe='')}", None
    )
    if not ok:
        return False, str(scopes)
    current = scopes.get("scopes") if isinstance(scopes, dict) else None
    grants = [
        _grant_of(s)
        for s in (current or [])
        if isinstance(s, dict)
        and not str(s.get("path") or "").startswith(f"{tree_root(advisor)}/")
    ]
    ok, detail = await labgo_admin(
        "PUT",
        f"/v1/admin/personal-access/{quote(account, safe='')}",
        {"grants": grants},
    )
    if not ok:
        return False, str(detail)
    return True, ""


# ------------------------------------------------------------------ 接口


class MemberIn(BaseModel):
    code: str = Field(min_length=2, max_length=16)
    name: str = Field(min_length=1, max_length=32)
    account: str = Field(default="", max_length=64)
    #: 在研 / 已出组 / 暂休 —— 出组不删数据，只把状态改掉并收回授权。
    status: str = Field(default="在研", max_length=16)
    #: 身份：博士生 / 硕士生 / 本科生 / 博士后 / 实习生 / 科研助理
    identity: str = Field(default="硕士生", max_length=16)


#: 名册允许的状态与身份（前端下拉与后端校验共用同一份口径）。
MEMBER_STATUSES = ("在研", "已出组", "暂休")
MEMBER_IDENTITIES = ("博士后", "博士生", "硕士生", "本科生", "实习生", "科研助理")


def _require_advisor(user: dict[str, Any]) -> str:
    """只有**教师**（lab-teacher）能改组员结构；其他角色只能读自己那部分。

    管理员不含在内：组员名册与共享目录是教师职责，
    与平台运维（账号、服务、备份）分开。
    """
    if has_role(user, settings.teacher_roles):
        return _advisor_of(user)
    raise HTTPException(status_code=403, detail="只有教师可以维护组员目录（lab-teacher 用户组）")


@router.get("/members")
async def get_members(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    """组员名册 + 目录状态。导师看全部；学生只看到自己那一行。"""
    advisor = _advisor_of(user)
    seed_roster(advisor)
    members = list_members(advisor)
    account = account_key(user)
    is_advisor = has_role(user, settings.teacher_roles)
    _auto_link_accounts(advisor, members)
    if not is_advisor:
        members = [m for m in members if m.get("account") == account]
    return {
        "ok": True,
        "advisor": advisor,
        "tree": tree_root(advisor),
        "treeName": TREE_NAME,
        "defaultFolders": list(DEFAULT_FOLDERS),
        "deleteWithinHours": DELETE_WINDOW_HOURS,
        "canManage": is_advisor,
        "members": members,
    }


@router.post("/members")
async def add_member(
    body: MemberIn,
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    """新增组员并按名册建目录、下发授权。"""
    advisor = _require_advisor(user)
    code = body.code.strip()
    name = body.name.strip()
    if not code.isdigit():
        raise HTTPException(status_code=400, detail="学号必须是数字")
    status = body.status.strip() or "在研"
    identity = body.identity.strip() or "硕士生"
    if status not in MEMBER_STATUSES:
        raise HTTPException(status_code=400, detail=f"状态必须是 {'/'.join(MEMBER_STATUSES)} 之一")
    if identity not in MEMBER_IDENTITIES:
        raise HTTPException(status_code=400, detail=f"身份必须是 {'/'.join(MEMBER_IDENTITIES)} 之一")
    rows = db.query(
        "SELECT id FROM labspace.lab_roster WHERE advisor=%s AND code=%s AND name=%s",
        (advisor, code, name),
    )
    if rows:
        raise HTTPException(status_code=409, detail="该组员已在名册里")
    _ensure_member_columns()
    db.execute(
        "INSERT INTO labspace.lab_roster (advisor, code, name, status, account, identity) "
        "VALUES (%s, %s, %s, %s, %s, %s)",
        (advisor, code, name, status, body.account.strip(), identity),
    )
    members = list_members(advisor)
    member = next((m for m in members if m["code"] == code and m["name"] == name), None)
    if member is None:
        raise HTTPException(status_code=500, detail="组员写入后读不到")
    ok, detail = await _ensure_tree(request, advisor, member)
    if not ok:
        raise HTTPException(status_code=502, detail=f"目录创建失败：{detail}")
    ok, detail = await _grant_member(advisor, member)
    if not ok:
        raise HTTPException(status_code=502, detail=f"授权写入失败：{detail}")
    return {"ok": True, "member": member}


@router.patch("/members/{member_id}")
async def update_member(
    member_id: int,
    body: MemberIn,
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    """修改组员资料：姓名、身份、状态（进组/出组）、账号。

    两条值得说明的规则：
      * **改名要跟着改目录**：目录名是 `{学号}_{姓名}`，只改数据库不改磁盘会让
        名册和文件树对不上（学生看不到自己的目录）。这里改名后重建目录并重新授权。
      * **出组不删数据**：状态改成"已出组"时只收回授权，目录与文件全部保留，
        需要时改回"在研"就能恢复访问。
    """
    advisor = _require_advisor(user)
    current = find_member(advisor, member_id)
    if current is None:
        raise HTTPException(status_code=404, detail="组员不存在")

    code = body.code.strip() or current["code"]
    name = body.name.strip() or current["name"]
    status = body.status.strip() or current["status"]
    identity = body.identity.strip() or current.get("identity", "硕士生")
    account = body.account.strip() or current.get("account", "")
    if not code.isdigit():
        raise HTTPException(status_code=400, detail="学号必须是数字")
    if status not in MEMBER_STATUSES:
        raise HTTPException(status_code=400, detail=f"状态必须是 {'/'.join(MEMBER_STATUSES)} 之一")
    if identity not in MEMBER_IDENTITIES:
        raise HTTPException(status_code=400, detail=f"身份必须是 {'/'.join(MEMBER_IDENTITIES)} 之一")

    # 学号 + 姓名 唯一约束：改完不能与同组另一个成员撞车
    dup = db.query(
        "SELECT id FROM labspace.lab_roster WHERE advisor=%s AND code=%s AND name=%s AND id<>%s",
        (advisor, code, name, member_id),
    )
    if dup:
        raise HTTPException(status_code=409, detail="该学号+姓名已存在")

    old_folder = current["folder"]
    _ensure_member_columns()
    db.execute(
        "UPDATE labspace.lab_roster SET code=%s, name=%s, status=%s, identity=%s, account=%s "
        "WHERE advisor=%s AND id=%s",
        (code, name, status, identity, account, advisor, member_id),
    )
    member = find_member(advisor, member_id)
    if member is None:
        raise HTTPException(status_code=500, detail="更新后读不到组员")

    problems: list[str] = []
    if status == "已出组":
        # 出组：收授权，留数据
        ok, detail = await _revoke_member(advisor, member)
        if not ok:
            problems.append(f"授权收回失败：{detail}")
    else:
        # 在研/暂休：确保目录存在（改名会建出新目录）并下发授权
        ok, detail = await _ensure_tree(request, advisor, member)
        if not ok:
            problems.append(f"目录创建失败：{detail}")
        if status == "在研":
            ok, detail = await _grant_member(advisor, member)
            if not ok:
                problems.append(f"授权写入失败：{detail}")
        else:
            ok, detail = await _revoke_member(advisor, member)
            if not ok:
                problems.append(f"授权收回失败：{detail}")

    return {
        "ok": not problems,
        "member": member,
        "renamed": old_folder != member["folder"],
        "oldFolder": old_folder if old_folder != member["folder"] else "",
        "problems": problems,
    }


@router.delete("/members/{member_id}")
async def delete_member(
    member_id: int,
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    """移出名册并收回授权（目录与数据保留在磁盘上）。"""
    advisor = _require_advisor(user)
    member = find_member(advisor, member_id)
    if member is None:
        raise HTTPException(status_code=404, detail="组员不存在")
    ok, detail = await _revoke_member(advisor, member)
    if not ok:
        raise HTTPException(status_code=502, detail=f"授权收回失败：{detail}")
    remove_member(advisor, member_id)
    return {"ok": True, "removed": member["folder"], "dataKept": True}


@router.post("/members/{member_id}/link")
async def link_member_account(
    member_id: int,
    body: MemberIn,
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    """把组员行关联到门户账号（账号建好后来这里挂一下）。"""
    advisor = _require_advisor(user)
    member = find_member(advisor, member_id)
    if member is None:
        raise HTTPException(status_code=404, detail="组员不存在")
    account = body.account.strip() or account_key({"email": body.name})
    link_account(advisor, member_id, account)
    return {"ok": True, "member": {**member, "account": account}}


@router.post("/sync")
async def sync_tree(
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    """按名册补齐目录并重新下发授权（导师点一次即可修复缺目录/缺授权）。"""
    advisor = _require_advisor(user)
    seed_roster(advisor)
    members = list_members(advisor)
    problems: list[str] = []
    created = 0
    for member in members:
        ok, detail = await _ensure_tree(request, advisor, member)
        if not ok:
            problems.append(detail)
            continue
        created += 1
        ok, detail = await _grant_member(advisor, member)
        if not ok:
            problems.append(f"{member['folder']}：{detail}")
    return {
        "ok": not problems,
        "synced": created,
        "total": len(members),
        "problems": problems[:10],
    }


@router.get("/mine")
async def my_shared_folder(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    """学生侧：我在共享树里的那棵目录（工作台入口就指向它）。"""
    advisor = _advisor_of(user)
    account = account_key(user)
    members = list_members(advisor)
    _auto_link_accounts(advisor, members)
    mine = next((m for m in members if m.get("account") == account), None)
    if mine is None:
        return {
            "ok": True,
            "granted": False,
            "message": "导师还没有开通你的共享目录",
            "tree": tree_root(advisor),
        }
    return {
        "ok": True,
        "granted": True,
        "folder": mine["folder"],
        "path": member_root(advisor, mine),
        "tree": tree_root(advisor),
        "folders": list(DEFAULT_FOLDERS),
        "deleteWithinHours": DELETE_WINDOW_HOURS,
    }

# ------------------------------------------------------------------ 个人空间的组会目录

#: 个人空间里组会目录的固定名字。
PERSONAL_MEETING_DIR = "组会汇报"


def _week_labels(count: int) -> list[str]:
    """最近 count 个 ISO 周的目录名（从本周往前数）。"""
    from datetime import date, timedelta

    out: list[str] = []
    today = date.today()
    for back in range(max(1, count)):
        iso = (today - timedelta(weeks=back)).isocalendar()
        out.append(f"{iso.year}-W{iso.week:02d}")
    return out


@router.post("/personal-folders")
async def ensure_personal_folders(
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    """在调用者的**个人空间**里按自然年-自然周建组会目录。

    口径：
      * **学生**：看到 ``组会汇报/2026-W48/`` —— 一周一个目录，自己往里放材料；
      * **教师**：看到 ``组会汇报/2026-W48-孙同学/`` —— 一周按成员再分一层，
        谁的材料在谁的目录里，不用靠文件名猜。

    目录建在各自的家目录里（物理只有一份），互不可见；
    教师那一层是"按成员汇总"的视图，实际文件仍在学生自己的家目录中。
    """
    advisor = _advisor_of(user)
    is_teacher = has_role(user, settings.teacher_roles)
    weeks = _week_labels(2)

    home = account_key(user)
    created: list[str] = []
    problems: list[str] = []

    if not is_teacher:
        # 学生：自己的家目录 → 组会汇报/{年}-W{周}
        for week in weeks:
            path = f"{home}/{PERSONAL_MEETING_DIR}/{week}"
            ok, detail = await _ensure_dir(request, path)
            if ok:
                created.append(path)
            else:
                problems.append(f"{path}：{detail}")
    else:
        # 教师：自己的家目录 → 组会汇报/{年}-W{周}-{成员姓名}
        members = list_members(advisor)
        for week in weeks:
            for member in members:
                label = member.get("displayName") or member.get("name") or member.get("account")
                if not label:
                    continue
                path = f"{home}/{PERSONAL_MEETING_DIR}/{week}-{label}"
                ok, detail = await _ensure_dir(request, path)
                if ok:
                    created.append(path)
                else:
                    problems.append(f"{path}：{detail}")

    return {
        "ok": not problems,
        "role": "teacher" if is_teacher else "member",
        "created": created,
        "problems": problems[:10],
    }

