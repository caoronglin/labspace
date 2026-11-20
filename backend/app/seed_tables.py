"""种子管理表模板（Baserow 多维表格）。

目标形态：工作区「实验室数据」→ 数据库「种子」→ 表「种子管理」。

幂等策略（与库存台账同一套做法）：

* 工作区 / 数据库 / 表都按名称查找复用，同名已存在就复用，不重复创建；
* 字段按名称补齐，已存在的只校正类型相关的选项，不删不改数据。

所有 Baserow 调用都走 ``baserow._call``（管理员身份，令牌不出后端）。
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from fastapi import APIRouter, Body, Depends, File, HTTPException, Query, UploadFile

from . import baserow, db, seed_ocr
from .config import settings
from .security import has_role, require_admin, require_csrf, require_user

log = logging.getLogger("labspace.seed_tables")

router = APIRouter(prefix="/api/baserow", tags=["baserow-templates"])

WORKSPACE_NAME = "实验室数据"
DATABASE_NAME = "种子"
TABLE_NAME = "种子管理"

#: 管理员配置里的默认工作区（存 integration_settings，键 baserow.defaultWorkspace）。
DEFAULT_WORKSPACE_SETTING = "baserow.defaultWorkspace"

#: 表「种子管理」的字段定义。
#: number 字段必须显式给出小数位与是否允许负数，否则 Baserow 默认 0 位小数。
SEED_FIELDS: tuple[dict[str, Any], ...] = (
    {"name": "名称", "type": "text"},
    {"name": "编号", "type": "text"},
    {"name": "物种", "type": "text"},
    {"name": "来源", "type": "text"},
    {"name": "入库日期", "type": "date", "date_format": "ISO", "date_include_time": False},
    {"name": "数量", "type": "number", "number_decimal_places": 2, "number_negative": False},
    {"name": "单位", "type": "text"},
    {"name": "存放位置", "type": "text"},
    {"name": "存放柜", "type": "text"},
    {"name": "发芽率", "type": "number", "number_decimal_places": 2, "number_negative": False},
    {
        "name": "活力等级",
        "type": "single_select",
        "select_options": [
            {"value": "高", "color": "green"},
            {"value": "中", "color": "blue"},
            {"value": "低", "color": "red"},
        ],
    },
    {"name": "处理方式", "type": "long_text"},
    {"name": "备份位置", "type": "text"},
    {"name": "是否已备份", "type": "boolean"},
    {"name": "备份日期", "type": "date", "date_format": "ISO", "date_include_time": False},
    {"name": "负责人", "type": "text"},
    # —— 育种/诱变场景的标记字段（2026-11 新增）——
    # 突变类型用 single_select：值域固定，且每个选项带颜色，
    # 前端的「突变类型视图」直接按这个字段分色，一眼看出材料是哪一类。
    {
        "name": "突变类型",
        "type": "single_select",
        "select_options": [
            {"value": "点突变", "color": "blue"},
            {"value": "大片段缺失", "color": "orange"},
            {"value": "插入/缺失", "color": "gold"},
            {"value": "基因敲除", "color": "red"},
            {"value": "CRISPR 编辑", "color": "purple"},
            {"value": "过表达", "color": "magenta"},
            {"value": "回补", "color": "cyan"},
            {"value": "自然变异", "color": "green"},
            {"value": "诱变处理", "color": "lime"},
            {"value": "未知", "color": "gray"},
        ],
    },
    # 突变基因：可以是基因座（如 sd1、OsMADS14），也可以写多基因（逗号分隔）。
    {"name": "突变基因", "type": "text"},
    # 自由标签：用于"高产""抗病""待测交"这类实验状态词，逗号分隔。
    {"name": "标签", "type": "text"},
    {"name": "备注", "type": "long_text"},
    {"name": "附件", "type": "file"},
)

#: Baserow 建表模板自带的列，与我们的字段重复。
DEFAULT_TEMPLATE_FIELDS = ("Notes", "Active")


# Baserow 在**新建表尚未同步完成**时会拒绝一切字段改动，并返回
# ERROR_FAILED_TO_LOCK_TABLE_DUE_TO_CONFLICT（409）。这是暂态错误，重试即可，
# 不该直接当成"创建失败"抛给用户。
_LOCK_RETRY_MARKERS = ("LOCK_TABLE", "DUE_TO_CONFLICT", "sync")


async def _call(method: str, path: str, user: dict[str, Any], **kwargs: Any) -> Any:
    """统一走 baserow._call，并把上游报错翻译成可读的提示。

    表刚建好时 Baserow 还在同步，此时改字段会 409；这里自动退避重试若干次。
    """
    attempts = 4
    last: HTTPException | None = None
    for attempt in range(attempts):
        try:
            return await baserow._call(method, path, user, **kwargs)
        except HTTPException as exc:
            last = exc
            detail = str(exc.detail or "")
            if exc.status_code != 409 or not any(m in detail for m in _LOCK_RETRY_MARKERS):
                break
            await asyncio.sleep(1.5 * (attempt + 1))
    assert last is not None
    raise HTTPException(
        status_code=last.status_code,
        detail=f"创建种子管理表失败：{last.detail}",
    ) from last


def _text(value: Any) -> str:
    return "" if value is None else str(value)


def _configured_workspace_id() -> int:
    """管理员配置里的默认工作区 id；没有配置或配置不可读时返回 0。"""
    try:
        rows = db.query(
            "SELECT value FROM labspace.integration_settings WHERE key = %s",
            (DEFAULT_WORKSPACE_SETTING,),
        )
    except Exception as exc:  # noqa: BLE001 - 配置读不到不应阻塞建表
        log.warning("读取默认工作区配置失败: %s", exc)
        return 0
    if not rows:
        return 0
    value = rows[0].get("value")
    if not isinstance(value, dict):
        return 0
    try:
        return int(value.get("workspaceId") or 0)
    except (TypeError, ValueError):
        return 0


async def _resolve_workspace(user: dict[str, Any], *, create: bool) -> tuple[int, str]:
    """返回 (工作区 id, 工作区名)。

    优先用管理员配置里的默认工作区，其次复用同名工作区「实验室数据」，
    都没有才在 ``create=True`` 时新建。
    """
    workspaces = baserow._list(await _call("GET", "/api/workspaces/", user))
    configured = _configured_workspace_id()
    if configured:
        for workspace in workspaces:
            if int(workspace.get("id") or 0) == configured:
                return configured, _text(workspace.get("name")) or WORKSPACE_NAME
    for workspace in workspaces:
        if _text(workspace.get("name")).strip() == WORKSPACE_NAME:
            wid = int(workspace.get("id") or 0)
            if wid:
                return wid, WORKSPACE_NAME
    if not create:
        return 0, ""
    created = await _call("POST", "/api/workspaces/", user, json_body={"name": WORKSPACE_NAME})
    wid = int((created or {}).get("id") or 0)
    if not wid:
        raise HTTPException(status_code=502, detail="创建种子管理表失败：创建工作区失败")
    return wid, WORKSPACE_NAME


async def _resolve_database(
    workspace_id: int, user: dict[str, Any], *, create: bool
) -> tuple[int, str]:
    """返回 (数据库 id, 数据库名)。"""
    apps = baserow._list(
        await _call("GET", f"/api/applications/workspace/{workspace_id}/", user)
    )
    for app in apps:
        if _text(app.get("type")) == "database" and _text(app.get("name")).strip() == DATABASE_NAME:
            did = int(app.get("id") or 0)
            if did:
                return did, DATABASE_NAME
    if not create:
        return 0, ""
    created = await _call(
        "POST",
        f"/api/applications/workspace/{workspace_id}/",
        user,
        json_body={"name": DATABASE_NAME, "type": "database"},
    )
    did = int((created or {}).get("id") or 0)
    if not did:
        raise HTTPException(status_code=502, detail="创建种子管理表失败：创建数据库失败")
    return did, DATABASE_NAME


async def _resolve_table(
    database_id: int, user: dict[str, Any], *, create: bool
) -> tuple[int, str]:
    """返回 (表 id, 表名)。"""
    tables = baserow._list(
        await _call("GET", f"/api/database/tables/database/{database_id}/", user)
    )
    for table in tables:
        if _text(table.get("name")).strip() == TABLE_NAME:
            tid = int(table.get("id") or 0)
            if tid:
                return tid, TABLE_NAME
    if not create:
        return 0, ""
    created = await _call(
        "POST", f"/api/database/tables/database/{database_id}/", user, json_body={"name": TABLE_NAME}
    )
    tid = int((created or {}).get("id") or 0)
    if not tid:
        raise HTTPException(status_code=502, detail="创建种子管理表失败：创建表失败")
    return tid, TABLE_NAME


def _is_blank(value: Any) -> bool:
    """空值判定。

    Baserow 里“没填”的表示方式有好几种：null、空字符串、false、空列表
    （附件字段）、空字典，全都要认，否则新建行的模板行永远清不掉。
    """
    if value is None or value is False:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, tuple, set, dict)):
        return len(value) == 0
    return False


# 单选项里这些值算「等同于空」：它们是 Baserow 新建行时的默认选中项，
# 不代表用户真的填过东西。若不认它们，Baserow 自带的模板行就永远清不掉。
_EMPTY_OPTION_WORDS = {
    "否",
    "无",
    "未备份",
    "待备份",
    "未入库",
    "未出库",
    "未设置",
    "未填写",
    "不适用",
    "待定",
}


async def _empty_option_ids(table_id: int, user: dict[str, Any]) -> dict[str, set[Any]]:
    """返回「等同于空」的单选项 id，按字段名索引。"""
    fields = baserow._list(await _call("GET", f"/api/database/fields/table/{table_id}/", user))
    out: dict[str, set[Any]] = {}
    for field in fields:
        if not isinstance(field, dict):
            continue
        options = field.get("select_options") or []
        if not isinstance(options, list):
            continue
        ids = {
            option.get("id")
            for option in options
            if isinstance(option, dict)
            and _text(option.get("value")).strip() in _EMPTY_OPTION_WORDS
        }
        if ids:
            out[_text(field.get("name")).strip()] = {i for i in ids if i is not None}
    return out


async def _remove_template_rows(table_id: int, user: dict[str, Any]) -> int:
    """删掉**整行全空**的记录。

    Baserow 新建表会自带两行空模板行；台账里留着它们只会让页面显示成一排
    “—”，看起来像坏了。全空行不含任何信息（台账没有草稿概念），所以每次
    确保模板时都清理一次，返回删掉的行数。
    """
    payload = await _call(
        "GET",
        f"/api/database/rows/table/{table_id}/",
        user,
        params={"page": 1, "size": 200, "user_field_names": "true"},
    )
    data = payload if isinstance(payload, dict) else {}
    empty_ids = await _empty_option_ids(table_id, user)
    removed = 0
    for row in data.get("results") or []:
        if not isinstance(row, dict):
            continue
        values = [
            (k, v) for k, v in row.items() if k not in ("id", "order")
        ]
        if not values:
            continue
        blank = True
        for key, value in values:
            if _is_blank(value):
                continue
            # 单选项的默认值（如「否」）也当作空。
            option = empty_ids.get(_text(key).strip())
            if option and value in option:
                continue
            blank = False
            break
        if blank:
            await _call(
                "DELETE", f"/api/database/rows/table/{table_id}/{int(row.get('id') or 0)}/", user
            )
            removed += 1
    return removed


async def _ensure_number_options(
    field: dict[str, Any], spec: dict[str, Any], user: dict[str, Any]
) -> None:
    """number 字段的小数位/负数开关与约定不一致时改过来（否则写入会被 Baserow 拒绝）。"""
    if _text(field.get("type")) != "number":
        return
    want_places = int(spec.get("number_decimal_places", 2))
    want_negative = bool(spec.get("number_negative", False))
    if int(field.get("number_decimal_places") or 0) == want_places and bool(
        field.get("number_negative")
    ) == want_negative:
        return
    await _call(
        "PATCH",
        f"/api/database/fields/{int(field.get('id') or 0)}/",
        user,
        json_body={"number_decimal_places": want_places, "number_negative": want_negative},
    )


async def _ensure_select_options(
    field: dict[str, Any], spec: dict[str, Any], user: dict[str, Any]
) -> None:
    """single_select 字段补齐缺少的选项（已有的不动，避免改掉用户已填的值）。"""
    if _text(field.get("type")) != "single_select":
        return
    wanted = [str(o.get("value")) for o in (spec.get("select_options") or [])]
    if not wanted:
        return
    have = {
        _text(o.get("value")).strip()
        for o in (field.get("select_options") or [])
        if isinstance(o, dict)
    }
    missing = [value for value in wanted if value not in have]
    if not missing:
        return
    options = list(field.get("select_options") or [])
    colors = ["green", "blue", "red", "orange", "purple", "yellow", "cyan", "brown"]
    for value in missing:
        options.append({"value": value, "color": colors[len(options) % len(colors)]})
    await _call(
        "PATCH",
        f"/api/database/fields/{int(field.get('id') or 0)}/",
        user,
        json_body={"select_options": options},
    )


async def _ensure_fields(
    table_id: int, user: dict[str, Any], *, fresh: bool
) -> None:
    """按名称补齐字段；Baserow 建表模板自带的主字段直接改名为首个业务字段。"""
    fields = baserow._list(await _call("GET", f"/api/database/fields/table/{table_id}/", user))
    if fresh:
        for field in fields:
            if field.get("primary"):
                continue
            if _text(field.get("name")).strip() in DEFAULT_TEMPLATE_FIELDS:
                await _call(
                    "DELETE", f"/api/database/fields/{int(field.get('id') or 0)}/", user
                )
        fields = [
            f for f in fields if _text(f.get("name")).strip() not in DEFAULT_TEMPLATE_FIELDS
        ]
    by_name = {_text(f.get("name")).strip(): f for f in fields}
    primary = next((f for f in fields if f.get("primary")), None)
    for spec in SEED_FIELDS:
        name = str(spec["name"])
        field_type = str(spec["type"])
        existing = by_name.get(name)
        if existing:
            await _ensure_number_options(existing, spec, user)
            await _ensure_select_options(existing, spec, user)
            continue
        if primary is not None and field_type == "text" and _text(primary.get("name")).strip() in ("", "Name"):
            await _call(
                "PATCH",
                f"/api/database/fields/{int(primary.get('id') or 0)}/",
                user,
                json_body={"name": name},
            )
            by_name.pop(_text(primary.get("name")).strip(), None)
            by_name[name] = primary
            primary = None
            continue
        body: dict[str, Any] = {"name": name, "type": field_type}
        if field_type == "number":
            body["number_decimal_places"] = int(spec.get("number_decimal_places", 2))
            body["number_negative"] = bool(spec.get("number_negative", False))
        if field_type == "date":
            body["date_format"] = str(spec.get("date_format", "ISO"))
            body["date_include_time"] = bool(spec.get("date_include_time", False))
        if field_type == "single_select":
            body["select_options"] = list(spec.get("select_options") or [])
        created = await _call(
            "POST", f"/api/database/fields/table/{table_id}/", user, json_body=body
        )
        if not int((created or {}).get("id") or 0):
            raise HTTPException(
                status_code=502, detail=f"创建种子管理表失败：创建字段「{name}」失败"
            )
        by_name[name] = created


async def _field_list(table_id: int, user: dict[str, Any]) -> list[dict[str, Any]]:
    fields = baserow._list(await _call("GET", f"/api/database/fields/table/{table_id}/", user))
    return [
        {
            "id": int(f.get("id") or 0),
            "name": _text(f.get("name")),
            "type": _text(f.get("type")),
            "primary": bool(f.get("primary")),
            "select_options": [
                {"value": _text(o.get("value")), "color": _text(o.get("color"))}
                for o in (f.get("select_options") or [])
                if isinstance(o, dict)
            ],
        }
        for f in fields
    ]


# -------------------------------------------------- 全实验室共享的只读视图

#: 共享台账解析结果的缓存：工作区 / 数据库 / 表三段的 (id, 名字)，5 分钟过期。
_shared_cache: dict[str, Any] = {"at": 0.0, "ws": (0, ""), "db": (0, ""), "table": (0, "")}
_SHARED_TTL = 300.0


async def _shared_seed_ids() -> dict[str, tuple[int, str]]:
    """用数据表管理员身份解析「实验室数据 / 种子 / 种子管理」。

    台账是**全实验室同一份**，它建在管理员账号的工作区里；普通账号用自己的
    令牌看过去只有一个空工作区，于是种子页对所有人 404。这里集中做一次
    带缓存的解析，读接口共用。
    """
    if time.time() - float(_shared_cache["at"]) < _SHARED_TTL and _shared_cache["table"][0]:
        return _shared_cache
    not_found = HTTPException(status_code=404, detail="管理员还没有创建种子管理表")
    workspaces = baserow._list(await baserow.call_as_admin("GET", "/api/workspaces/"))
    configured = _configured_workspace_id()
    ws = (0, "")
    for workspace in workspaces:
        wid = int(workspace.get("id") or 0)
        name = _text(workspace.get("name"))
        if configured and wid == configured:
            ws = (wid, name or WORKSPACE_NAME)
            break
        if name.strip() == WORKSPACE_NAME:
            ws = (wid, WORKSPACE_NAME)
    if not ws[0]:
        raise not_found
    apps = baserow._list(
        await baserow.call_as_admin("GET", f"/api/applications/workspace/{ws[0]}/")
    )
    db_id = 0
    for app in apps:
        if _text(app.get("type")) == "database" and _text(app.get("name")).strip() == DATABASE_NAME:
            db_id = int(app.get("id") or 0)
            break
    if not db_id:
        raise not_found
    tables = baserow._list(
        await baserow.call_as_admin("GET", f"/api/database/tables/database/{db_id}/")
    )
    table_id = 0
    for table in tables:
        if _text(table.get("name")).strip() == TABLE_NAME:
            table_id = int(table.get("id") or 0)
            break
    if not table_id:
        raise not_found
    _shared_cache.update(
        at=time.time(), ws=ws, db=(db_id, DATABASE_NAME), table=(table_id, TABLE_NAME)
    )
    return _shared_cache


async def _shared_seed_table() -> tuple[int, str]:
    return (await _shared_seed_ids())["table"]


def _shared_seed_workspace() -> tuple[int, str]:
    """共享台账的工作区（在同一次请求里 `_shared_seed_table()` 之后调用）。"""
    return _shared_cache["ws"]


def _shared_seed_database() -> tuple[int, str]:
    return _shared_cache["db"]


async def _shared_fields(table_id: int) -> list[dict[str, Any]]:
    fields = baserow._list(
        await baserow.call_as_admin("GET", f"/api/database/fields/table/{table_id}/")
    )
    return [
        {
            "id": int(f.get("id") or 0),
            "name": _text(f.get("name")),
            "type": _text(f.get("type")),
            "primary": bool(f.get("primary")),
            "select_options": [
                {"value": _text(o.get("value")), "color": _text(o.get("color"))}
                for o in (f.get("select_options") or [])
                if isinstance(o, dict)
            ],
        }
        for f in fields
    ]


@router.post("/seed/rows", dependencies=[Depends(require_csrf)])
async def create_seed_row(
    values: dict[str, Any] = Body(...),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """新增一条种子记录（登录即可，用于学生/老师日常入库）。

    台账只有一份、在管理员工作区，所以写入走管理员令牌；实际操作人记到日志里，
    便于事后追溯（Baserow 侧作者固定显示为管理员账号）。
    """
    table_id, _ = await _shared_seed_table()
    created = await baserow.admin_row_create(table_id, values)
    log.info(
        "seed row created: table=%s row=%s by=%s",
        table_id,
        created.get("id"),
        str(user.get("email") or user.get("name") or user.get("sub") or ""),
    )
    return created


@router.patch("/seed/rows/{row_id}", dependencies=[Depends(require_csrf)])
async def update_seed_row(
    row_id: int,
    values: dict[str, Any] = Body(...),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """修改一条种子记录（登录即可）。删除与结构变更仍然只有管理员能做。"""
    table_id, _ = await _shared_seed_table()
    updated = await baserow.admin_row_update(table_id, row_id, values)
    log.info(
        "seed row updated: table=%s row=%s by=%s",
        table_id,
        row_id,
        str(user.get("email") or user.get("name") or user.get("sub") or ""),
    )
    return updated


async def ensure_seed_template(user: dict[str, Any]) -> dict[str, Any]:
    """建好「实验室数据 / 种子 / 种子管理」结构；重复调用只复用，不重复建。"""
    workspace_id, workspace_name = await _resolve_workspace(user, create=True)
    database_id, database_name = await _resolve_database(workspace_id, user, create=True)
    table_id, _ = await _resolve_table(database_id, user, create=True)

    fields = baserow._list(await _call("GET", f"/api/database/fields/table/{table_id}/", user))
    fresh = not any(_text(f.get("name")).strip() == SEED_FIELDS[0]["name"] for f in fields)
    await _ensure_fields(table_id, user, fresh=fresh)
    # 空行清理每次都做：Baserow 建表自带的模板行会让台账看起来像坏了。
    await _remove_template_rows(table_id, user)

    return {
        "ok": True,
        "workspaceId": workspace_id,
        "workspaceName": workspace_name,
        "databaseId": database_id,
        "databaseName": database_name,
        "tableId": table_id,
        "tableName": TABLE_NAME,
        "fields": await _field_list(table_id, user),
    }


@router.post("/templates/seed")
async def create_seed_template(
    user: dict[str, Any] = Depends(require_admin), _csrf: None = Depends(require_csrf)
) -> dict[str, Any]:
    """创建（或复用）「种子管理」表模板。"""
    return await ensure_seed_template(user)


@router.get("/templates/seed")
async def get_seed_template(
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """返回「种子管理」表的 workspace / database / table id 与字段清单。

    **读接口**：只要登录就能看台账（学生也要查种子），写操作才要管理员。
    之前这里挂的是 require_admin，于是非管理员打开种子页直接 403，
    而页面又把它当作唯一入口（GET 失败就 POST 建表，也是管理员接口），
    结果整个种子模块对所有人白屏。

    台账是在**管理员账号**的工作区里建的，所以非管理员一律用数据表管理员
    身份解析与读取（只读），写入仍然走 require_admin + 调用者自己的令牌。

    顺带清一次全空行：Baserow 建表自带的模板行会让台账看起来像坏了。
    清理是幂等的，只删整行全空的记录；但它是**写副作用**，所以只对管理员做。
    """
    if has_role(user, settings.admin_roles):
        workspace_id, workspace_name = await _resolve_workspace(user, create=False)
        if not workspace_id:
            raise HTTPException(status_code=404, detail="尚未创建种子管理表，请先调用创建接口")
        database_id, database_name = await _resolve_database(workspace_id, user, create=False)
        if not database_id:
            raise HTTPException(status_code=404, detail="尚未创建种子管理表，请先调用创建接口")
        table_id, table_name = await _resolve_table(database_id, user, create=False)
        if not table_id:
            raise HTTPException(status_code=404, detail="尚未创建种子管理表，请先调用创建接口")
        await _remove_template_rows(table_id, user)
        fields = await _field_list(table_id, user)
    else:
        table_id, table_name = await _shared_seed_table()
        workspace_id, workspace_name = _shared_seed_workspace()
        database_id, database_name = _shared_seed_database()
        fields = await _shared_fields(table_id)
    return {
        "ok": True,
        "workspaceId": workspace_id,
        "workspaceName": workspace_name,
        "databaseId": database_id,
        "databaseName": database_name,
        "tableId": table_id,
        "tableName": table_name,
        "fields": fields,
    }


@router.get("/seed/rows")
async def get_seed_rows(
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=200),
    search: str = Query("", max_length=200),
    order_by: str = Query("", max_length=120),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """读种子台账的行（只读）。

    台账是全实验室同一份数据：用数据表管理员身份读，**不接受**前端传 table id，
    省得让人拿任意表 id 来试读别人的表。
    """
    table_id, _ = await _shared_seed_table()
    params: dict[str, Any] = {"page": page, "size": size, "user_field_names": "true"}
    if search.strip():
        params["search"] = search.strip()
    if order_by.strip():
        params["order_by"] = order_by.strip()
    payload = await baserow.call_as_admin(
        "GET", f"/api/database/rows/table/{table_id}/", params=params
    )
    data = payload if isinstance(payload, dict) else {}
    return {
        "count": int(data.get("count") or 0),
        "next": data.get("next"),
        "previous": data.get("previous"),
        "results": [r for r in (data.get("results") or []) if isinstance(r, dict)],
    }

# ---------------------------------------------------------------- 标签 OCR

# 手机直拍的标签照片通常 2~5MB；给到 12MB 容忍高像素原图。
# 超过这个量级不是"标签照片"而是别的东西，直接拒，省得 tesseract 跑到超时。
_OCR_MAX_BYTES = 12 * 1024 * 1024


@router.post("/seed/ocr")
async def seed_label_ocr(
    image: UploadFile = File(..., description="种子标签照片（jpg/png/webp）"),
    user: dict[str, Any] = Depends(require_admin),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    """识别种子标签照片，返回**预填字段**。

    只做预填：前端把 ``fields`` 填进新建表单，由人确认后再提交。
    识别不出内容时返回 ``ok=false`` 与空字段，不抛错——
    拍照环境（反光、曲面、手写）本来就常常认不出来，那不是故障。
    """
    if image.content_type and not image.content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="只接受图片文件")
    data = await image.read()
    if len(data) > _OCR_MAX_BYTES:
        raise HTTPException(status_code=413, detail="图片过大（上限 12MB），请压缩后重试")
    return await seed_ocr.recognize(data)

