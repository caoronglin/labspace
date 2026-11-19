"""把库存台账发布成多维表格（Baserow）里的一个工作区。

目标形态：工作区「实验室物资」→ 数据库「库存」→ 表「物品台账」「出入库流水」。

迁移是**只读镜像**：本地 ``labspace.labops_inventory_items`` 与
``labspace.labops_inventory_tx`` 原样保留（库存功能继续可用，避免数据丢失），
本模块只负责把数据推给 Baserow。

幂等策略：

* 工作区 / 数据库 / 表 / 字段都按名称查找复用，不重复创建；
* 行按去重键跳过已存在的记录，重复调用不会产生第二份数据。

所有 Baserow 调用都走 ``baserow._call``（管理员身份，token 不出后端）。
"""
from __future__ import annotations

import asyncio
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from fastapi import HTTPException

from . import baserow, db

WORKSPACE_NAME = "实验室物资"
DATABASE_NAME = "库存"
ITEMS_TABLE_NAME = "物品台账"
TX_TABLE_NAME = "出入库流水"

#: 表「物品台账」的字段定义；number 字段必须显式给出小数位与是否允许负数，
#: 否则 Baserow 默认 0 位小数（写 1.5 会 400），流水里的负数也会被拒。
ITEM_FIELDS: tuple[dict[str, Any], ...] = (
    {"name": "名称", "type": "text"},
    {"name": "类别", "type": "text"},
    {"name": "规格", "type": "text"},
    {"name": "单位", "type": "text"},
    {"name": "数量", "type": "number", "number_decimal_places": 2, "number_negative": False},
    {"name": "预警阈值", "type": "number", "number_decimal_places": 2, "number_negative": False},
    {"name": "存放位置", "type": "text"},
    {"name": "负责人", "type": "text"},
    {"name": "备注", "type": "long_text"},
)

#: 表「出入库流水」的字段定义
TX_FIELDS: tuple[dict[str, Any], ...] = (
    {"name": "物品", "type": "text"},
    {"name": "类型", "type": "text"},
    {"name": "数量", "type": "number", "number_decimal_places": 2, "number_negative": True},
    {"name": "经办人", "type": "text"},
    {"name": "时间", "type": "text"},
    {"name": "备注", "type": "long_text"},
)

#: Baserow 建表模板自带的列，与我们的字段重复
DEFAULT_TEMPLATE_FIELDS = ("Notes", "Active")

KIND_LABELS = {"sample": "样品", "plasmid": "质粒", "strain": "菌株", "consumable": "耗材"}
TX_KIND_LABELS = {"in": "入库", "out": "出库", "loss": "损耗"}

_FIELD_SEP = "\x1f"


# ------------------------------------------------------------------ 工具

async def _call(method: str, path: str, user: dict[str, Any], **kwargs: Any) -> Any:
    """统一走 baserow._call，并把上游报错翻译成可读的提示。"""
    try:
        return await baserow._call(method, path, user, **kwargs)
    except HTTPException as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail=f"同步库存到多维表格失败：{exc.detail}",
        ) from exc


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.isoformat(" ")
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def _num(value: Any) -> float:
    if isinstance(value, Decimal):
        return float(value)
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


# ------------------------------------------------------------------ 本地数据

async def _read_items() -> list[dict[str, Any]]:
    """读取本地库存条目（只读）。"""
    rows = await asyncio.to_thread(
        db.query,
        "SELECT id, owner, kind, name, code, location, quantity::float8 AS quantity, unit, "
        "low_threshold::float8 AS low_threshold, metadata, notes "
        "FROM labspace.labops_inventory_items ORDER BY created_at",
    )
    return [dict(r) for r in rows]


async def _read_txs() -> list[dict[str, Any]]:
    """读取本地出入库流水（只读）。"""
    rows = await asyncio.to_thread(
        db.query,
        "SELECT t.id, t.item_id, i.name AS item_name, t.delta::float8 AS delta, t.kind, "
        "t.reason, t.operator, t.created_at "
        "FROM labspace.labops_inventory_tx t "
        "LEFT JOIN labspace.labops_inventory_items i ON i.id = t.item_id ORDER BY t.id",
    )
    return [dict(r) for r in rows]


def _item_values(row: dict[str, Any]) -> dict[str, Any]:
    raw_meta = row.get("metadata")
    metadata: dict[str, Any] = raw_meta if isinstance(raw_meta, dict) else {}
    code = _text(row.get("code")).strip()
    spec = _text(metadata.get("spec")).strip() or code
    return {
        "名称": _text(row.get("name")).strip(),
        "类别": KIND_LABELS.get(_text(row.get("kind")).strip(), _text(row.get("kind")).strip()),
        "规格": spec,
        "单位": _text(row.get("unit")).strip(),
        "数量": _num(row.get("quantity")),
        "预警阈值": _num(row.get("low_threshold")),
        "存放位置": _text(row.get("location")).strip(),
        "负责人": _text(row.get("owner")).strip(),
        "备注": _text(row.get("notes")).strip(),
    }


def _tx_values(row: dict[str, Any]) -> dict[str, Any]:
    item_name = _text(row.get("item_name")).strip() or _text(row.get("item_id")).strip()
    return {
        "物品": item_name,
        "类型": TX_KIND_LABELS.get(_text(row.get("kind")).strip(), _text(row.get("kind")).strip()),
        "数量": _num(row.get("delta")),
        "经办人": _text(row.get("operator")).strip(),
        "时间": _text(row.get("created_at")),
        "备注": _text(row.get("reason")).strip(),
    }


def _item_key(values: dict[str, Any]) -> str:
    """物品台账去重键：名称 + 规格（规格存的是编号，避免同名条目互相覆盖）。"""
    return f"{_text(values.get('名称')).strip()}{_FIELD_SEP}{_text(values.get('规格')).strip()}"


def _tx_key(values: dict[str, Any]) -> str:
    """出入库流水去重键：物品 + 时间 + 类型 + 数量（同一物品的多笔流水都要保留）。"""
    return _FIELD_SEP.join(
        [
            _text(values.get("物品")).strip(),
            _text(values.get("时间")).strip(),
            _text(values.get("类型")).strip(),
            f"{_num(values.get('数量'))}",
        ]
    )


# ------------------------------------------------------------------ 结构同步

async def _ensure_workspace(user: dict[str, Any]) -> tuple[int, bool]:
    workspaces = baserow._list(await _call("GET", "/api/workspaces/", user))
    for workspace in workspaces:
        if _text(workspace.get("name")).strip() == WORKSPACE_NAME:
            wid = int(workspace.get("id") or 0)
            if wid:
                return wid, False
    created = await _call("POST", "/api/workspaces/", user, json_body={"name": WORKSPACE_NAME})
    wid = int((created or {}).get("id") or 0)
    if not wid:
        raise HTTPException(status_code=502, detail="同步库存到多维表格失败：创建工作区失败")
    return wid, True


async def _ensure_database(workspace_id: int, user: dict[str, Any]) -> tuple[int, bool]:
    apps = baserow._list(await _call("GET", f"/api/applications/workspace/{workspace_id}/", user))
    for app in apps:
        if _text(app.get("type")) == "database" and _text(app.get("name")).strip() == DATABASE_NAME:
            did = int(app.get("id") or 0)
            if did:
                return did, False
    created = await _call(
        "POST",
        f"/api/applications/workspace/{workspace_id}/",
        user,
        json_body={"name": DATABASE_NAME, "type": "database"},
    )
    did = int((created or {}).get("id") or 0)
    if not did:
        raise HTTPException(status_code=502, detail="同步库存到多维表格失败：创建数据库失败")
    return did, True


async def _ensure_table(database_id: int, name: str, user: dict[str, Any]) -> tuple[int, bool]:
    tables = baserow._list(await _call("GET", f"/api/database/tables/database/{database_id}/", user))
    for table in tables:
        if _text(table.get("name")).strip() == name:
            tid = int(table.get("id") or 0)
            if tid:
                return tid, False
    created = await _call(
        "POST", f"/api/database/tables/database/{database_id}/", user, json_body={"name": name}
    )
    tid = int((created or {}).get("id") or 0)
    if not tid:
        raise HTTPException(status_code=502, detail=f"同步库存到多维表格失败：创建表「{name}」失败")
    return tid, True


async def _ensure_number_options(field: dict[str, Any], spec: dict[str, Any], user: dict[str, Any]) -> None:
    """number 字段的小数位/负数开关与约定不一致时改过来（否则写入会被 Baserow 拒绝）。"""
    if _text(field.get("type")) != "number":
        return
    want_places = int(spec.get("number_decimal_places", 2))
    want_negative = bool(spec.get("number_negative", False))
    if int(field.get("number_decimal_places") or 0) == want_places and bool(field.get("number_negative")) == want_negative:
        return
    await _call(
        "PATCH",
        f"/api/database/fields/{int(field.get('id') or 0)}/",
        user,
        json_body={"number_decimal_places": want_places, "number_negative": want_negative},
    )


def _is_blank(value: Any) -> bool:
    return value is None or value is False or (isinstance(value, str) and not value.strip())


async def _remove_template_rows(table_id: int, user: dict[str, Any]) -> None:
    """Baserow 新建表会带两行空模板行，删掉它们，避免台账里出现空行。"""
    for row in await _existing_rows(table_id, user):
        values = [v for k, v in row.items() if k not in ("id", "order")]
        if values and all(_is_blank(v) for v in values):
            await _call("DELETE", f"/api/database/rows/table/{table_id}/{int(row.get('id') or 0)}/", user)


async def _ensure_fields(
    table_id: int, spec: tuple[dict[str, Any], ...], user: dict[str, Any], fresh: bool = False
) -> None:
    """按名称补齐字段；Baserow 新建表自带的主字段直接改名为首个业务字段。"""
    fields = baserow._list(await _call("GET", f"/api/database/fields/table/{table_id}/", user))
    if fresh:
        # Baserow 建表模板自带 Notes / Active 两列，与我们的字段重复，直接删掉
        for field in fields:
            if field.get("primary"):
                continue
            if _text(field.get("name")).strip() in DEFAULT_TEMPLATE_FIELDS:
                await _call("DELETE", f"/api/database/fields/{int(field.get('id') or 0)}/", user)
        fields = [f for f in fields if _text(f.get("name")).strip() not in DEFAULT_TEMPLATE_FIELDS]
    by_name = {_text(f.get("name")).strip(): f for f in fields}
    primary = next((f for f in fields if f.get("primary")), None)
    for field_spec in spec:
        name = str(field_spec["name"])
        field_type = str(field_spec["type"])
        existing = by_name.get(name)
        if existing:
            await _ensure_number_options(existing, field_spec, user)
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
            body["number_decimal_places"] = int(field_spec.get("number_decimal_places", 2))
            body["number_negative"] = bool(field_spec.get("number_negative", False))
        created = await _call(
            "POST",
            f"/api/database/fields/table/{table_id}/",
            user,
            json_body=body,
        )
        if not int((created or {}).get("id") or 0):
            raise HTTPException(
                status_code=502, detail=f"同步库存到多维表格失败：创建字段「{name}」失败"
            )
        by_name[name] = created


# ------------------------------------------------------------------ 数据同步

async def _existing_rows(table_id: int, user: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    page = 1
    while page <= 50:
        payload = await _call(
            "GET",
            f"/api/database/rows/table/{table_id}/",
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


async def _insert_rows(table_id: int, items: list[dict[str, Any]], user: dict[str, Any]) -> int:
    inserted = 0
    for start in range(0, len(items), 200):
        chunk = items[start : start + 200]
        await _call(
            "POST",
            f"/api/database/rows/table/{table_id}/batch/",
            user,
            json_body={"items": chunk},
            params={"user_field_names": "true"},
        )
        inserted += len(chunk)
    return inserted


async def _sync_table(
    table_id: int,
    source_rows: list[dict[str, Any]],
    value_fn: Any,
    key_fn: Any,
    user: dict[str, Any],
) -> dict[str, Any]:
    existing = await _existing_rows(table_id, user)
    seen = {key_fn(row) for row in existing}
    pending: list[dict[str, Any]] = []
    for source in source_rows:
        values = value_fn(source)
        key = key_fn(values)
        if key in seen:
            continue
        seen.add(key)
        pending.append(values)
    inserted = await _insert_rows(table_id, pending, user) if pending else 0
    return {"total": len(existing) + inserted, "inserted": inserted}


# ------------------------------------------------------------------ 对外入口

async def publish(user: dict[str, Any]) -> dict[str, Any]:
    """把本地库存发布成多维表格工作区；重复调用只补齐缺失的数据。"""
    if not baserow._is_admin(user):
        raise HTTPException(status_code=403, detail="只有管理员可以同步库存到多维表格")
    items = await _read_items()
    txs = await _read_txs()

    workspace_id, workspace_created = await _ensure_workspace(user)
    database_id, database_created = await _ensure_database(workspace_id, user)

    tables: list[dict[str, Any]] = []
    created = workspace_created or database_created

    item_table_id, item_created = await _ensure_table(database_id, ITEMS_TABLE_NAME, user)
    created = created or item_created
    await _ensure_fields(item_table_id, ITEM_FIELDS, user, fresh=item_created)
    if item_created:
        await _remove_template_rows(item_table_id, user)
    item_stats = await _sync_table(item_table_id, items, _item_values, _item_key, user)
    tables.append({"id": item_table_id, "name": ITEMS_TABLE_NAME, **item_stats})

    tx_table_id, tx_created = await _ensure_table(database_id, TX_TABLE_NAME, user)
    created = created or tx_created
    await _ensure_fields(tx_table_id, TX_FIELDS, user, fresh=tx_created)
    if tx_created:
        await _remove_template_rows(tx_table_id, user)
    tx_stats = await _sync_table(tx_table_id, txs, _tx_values, _tx_key, user)
    tables.append({"id": tx_table_id, "name": TX_TABLE_NAME, **tx_stats})

    return {
        "workspaceId": workspace_id,
        "workspaceName": WORKSPACE_NAME,
        "databaseId": database_id,
        "databaseName": DATABASE_NAME,
        "tables": tables,
        "created": created,
    }
