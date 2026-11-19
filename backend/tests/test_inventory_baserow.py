"""库存发布到多维表格（Baserow）的契约：幂等、复用、字段映射与失败保护。

Baserow 用 httpx.MockTransport 打桩：内存里模拟工作区 / 数据库 / 表 / 字段 / 记录，
既能断言请求序列（有没有重复创建），也能断言本地数据不被改动。
"""
from __future__ import annotations

import json
import time
from typing import Any

import httpx
import jwt
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import baserow, db, inventory_baserow, main
from app.config import settings

CSRF = "csrf-token-for-test"

ITEM_ROWS: list[dict[str, Any]] = [
    {
        "id": "i1",
        "owner": "木林森",
        "kind": "sample",
        "name": "PBS 缓冲液",
        "code": "S-2601-AAA111",
        "location": "冷藏 A2",
        "quantity": 3.0,
        "unit": "瓶",
        "low_threshold": 1.0,
        "metadata": {},
        "notes": "常用试剂",
    },
    {
        "id": "i2",
        "owner": "木林森",
        "kind": "consumable",
        "name": "移液器吸头",
        "code": "C-2601-BBB222",
        "location": "柜 3",
        "quantity": 20.0,
        "unit": "盒",
        "low_threshold": 5.0,
        "metadata": {},
        "notes": "",
    },
]

TX_ROWS: list[dict[str, Any]] = [
    {
        "id": 1,
        "item_id": "i1",
        "item_name": "PBS 缓冲液",
        "delta": 3.0,
        "kind": "in",
        "reason": "初始入库",
        "operator": "木林森",
        "created_at": "2026-01-02 10:00:00",
    },
    {
        "id": 2,
        "item_id": "i1",
        "item_name": "PBS 缓冲液",
        "delta": -1.0,
        "kind": "out",
        "reason": "取用",
        "operator": "林森",
        "created_at": "2026-01-03 09:00:00",
    },
]


def _payload(body: Any) -> dict[str, Any]:
    """请求体统一按字典处理（GET 没有体）。"""
    return body if isinstance(body, dict) else {}


class FakeBaserow:
    """内存版 Baserow：只实现库存发布用到的接口。"""

    def __init__(self) -> None:
        self.workspaces: list[dict[str, Any]] = []
        self.applications: dict[int, list[dict[str, Any]]] = {}
        self.tables: dict[int, list[dict[str, Any]]] = {}
        self.fields: dict[int, list[dict[str, Any]]] = {}
        self.rows: dict[int, list[dict[str, Any]]] = {}
        self.calls: list[tuple[str, str, Any]] = []
        self.fail_on: str = ""
        self._seq = 100

    def _id(self) -> int:
        self._seq += 1
        return self._seq

    # -- 断言辅助 ---------------------------------------------------
    def paths(self, method: str) -> list[str]:
        return [path for m, path, _ in self.calls if m == method]

    def bodies(self, method: str, path_contains: str) -> list[Any]:
        return [body for m, path, body in self.calls if m == method and path_contains in path]

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, path, body))
        if self.fail_on and self.fail_on in path:
            return httpx.Response(500, json={"error": "baserow upstream exploded"})

        parts = [p for p in path.split("/") if p]

        # /api/workspaces/
        if path.rstrip("/") == "/api/workspaces":
            if request.method == "GET":
                return httpx.Response(200, json=self.workspaces)
            wid = self._id()
            self.workspaces.append({"id": wid, "name": _payload(body).get("name")})
            return httpx.Response(200, json={"id": wid, "name": _payload(body).get("name")})

        # /api/applications/workspace/{id}/
        if len(parts) == 4 and parts[:2] == ["api", "applications"] and parts[2] == "workspace":
            wid = int(parts[3])
            if request.method == "GET":
                return httpx.Response(200, json=self.applications.get(wid, []))
            did = self._id()
            self.applications.setdefault(wid, []).append(
                {"id": did, "name": _payload(body).get("name"), "type": _payload(body).get("type")}
            )
            return httpx.Response(200, json={"id": did, "name": _payload(body).get("name"), "type": _payload(body).get("type")})

        # /api/database/tables/database/{id}/
        if len(parts) == 5 and parts[:3] == ["api", "database", "tables"] and parts[3] == "database":
            did = int(parts[4])
            if request.method == "GET":
                return httpx.Response(200, json=self.tables.get(did, []))
            tid = self._id()
            self.tables.setdefault(did, []).append({"id": tid, "name": _payload(body).get("name")})
            # Baserow 2.4 建表模板：主字段 Name + Notes/Active 两列 + 两行空行
            self.fields[tid] = [
                {"id": self._id(), "name": "Name", "type": "text", "primary": True},
                {"id": self._id(), "name": "Notes", "type": "long_text", "primary": False},
                {"id": self._id(), "name": "Active", "type": "boolean", "primary": False},
            ]
            self.rows[tid] = [{"id": self._id(), "Name": ""}, {"id": self._id(), "Name": ""}]
            return httpx.Response(200, json={"id": tid, "name": _payload(body).get("name")})

        # /api/database/fields/table/{id}/  与  /api/database/fields/{id}/
        if len(parts) == 5 and parts[:3] == ["api", "database", "fields"] and parts[3] == "table":
            tid = int(parts[4])
            if request.method == "GET":
                return httpx.Response(200, json=self.fields.get(tid, []))
            fid = self._id()
            payload = _payload(body)
            self.fields.setdefault(tid, []).append(
                {
                    "id": fid,
                    "name": payload.get("name"),
                    "type": payload.get("type"),
                    "primary": False,
                    "number_decimal_places": payload.get("number_decimal_places", 0),
                    "number_negative": payload.get("number_negative", False),
                }
            )
            return httpx.Response(200, json={"id": fid, "name": payload.get("name"), "type": payload.get("type")})
        if len(parts) == 4 and parts[:3] == ["api", "database", "fields"]:
            fid = int(parts[3])
            payload = _payload(body)
            for fields in self.fields.values():
                for field in fields:
                    if field["id"] == fid:
                        if request.method == "DELETE":
                            fields.remove(field)
                            return httpx.Response(204)
                        field.update({k: v for k, v in payload.items() if k in ("name", "number_decimal_places", "number_negative")})
                        return httpx.Response(200, json=field)
            return httpx.Response(404, json={"error": "field not found"})

        # /api/database/rows/table/{id}/  与  .../batch/
        if len(parts) >= 5 and parts[:3] == ["api", "database", "rows"] and parts[3] == "table":
            tid = int(parts[4])
            if request.method == "GET":
                rows = self.rows.get(tid, [])
                return httpx.Response(200, json={"count": len(rows), "results": rows, "next": None})
            if request.method == "DELETE":
                row_id = int(parts[5])
                self.rows[tid] = [r for r in self.rows.get(tid, []) if r.get("id") != row_id]
                return httpx.Response(204)
            if parts[5:6] == ["batch"]:
                items = _payload(body).get("items") or []
                for item in items:
                    self.rows.setdefault(tid, []).append({"id": self._id(), **item})
                return httpx.Response(200, json=self.rows.get(tid, []))
            self.rows.setdefault(tid, []).append({"id": self._id(), **_payload(body)})
            return httpx.Response(200, json=self.rows[tid][-1])

        return httpx.Response(404, json={"error": f"unhandled path {path}"})


@pytest.fixture()
def fake_baserow(monkeypatch: pytest.MonkeyPatch) -> FakeBaserow:
    fake = FakeBaserow()
    real_client = httpx.AsyncClient

    def factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs.pop("transport", None)
        return real_client(*args, transport=httpx.MockTransport(fake.handler), **kwargs)

    if hasattr(baserow, "_client"):
        # baserow 预留的测试打桩点
        monkeypatch.setattr(baserow, "_client", lambda: factory())
    else:
        monkeypatch.setattr(httpx, "AsyncClient", factory)

    async def fake_admin_token(force: bool = False) -> str:
        return "admin-token"

    monkeypatch.setattr(baserow, "_admin_token", fake_admin_token)

    async def read_items() -> list[dict[str, Any]]:
        return [dict(r) for r in ITEM_ROWS]

    async def read_txs() -> list[dict[str, Any]]:
        return [dict(r) for r in TX_ROWS]

    monkeypatch.setattr(inventory_baserow, "_read_items", read_items)
    monkeypatch.setattr(inventory_baserow, "_read_txs", read_txs)

    # 本地库存只读：任何写操作都视为破坏迁移契约
    def boom(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("库存发布不得写本地库存表")

    monkeypatch.setattr(db, "execute", boom)
    return fake


ADMIN = {"sub": "u1", "email": "a@b.c", "name": "管理员", "roles": ["lab-admin"]}


def _session(roles: list[str]) -> str:
    return jwt.encode(
        {"sub": "u1", "email": "a@b.c", "name": "管理员", "roles": roles, "exp": int(time.time()) + 3600},
        settings.session_secret,
        algorithm="HS256",
    )


async def _publish() -> dict[str, Any]:
    return await inventory_baserow.publish({"sub": "u1", "roles": ["lab-admin"], "email": "a@b.c"})


def test_publish_is_idempotent(fake_baserow: FakeBaserow) -> None:
    """第一次建好结构并全量写入；第二次只补数据，不重复建工作区/库/表，也不重复插行。"""
    first = asyncio_run(_publish())
    assert first["created"] is True
    assert first["workspaceName"] == "实验室物资"
    assert [t["name"] for t in first["tables"]] == ["物品台账", "出入库流水"]

    item_table_id = first["tables"][0]["id"]
    tx_table_id = first["tables"][1]["id"]
    assert len(fake_baserow.rows[item_table_id]) == len(ITEM_ROWS)
    assert len(fake_baserow.rows[tx_table_id]) == len(TX_ROWS)

    second = asyncio_run(_publish())
    assert second["created"] is False
    assert second["workspaceId"] == first["workspaceId"]
    assert second["databaseId"] == first["databaseId"]
    assert [t["id"] for t in second["tables"]] == [item_table_id, tx_table_id]
    assert second["tables"][0]["inserted"] == 0
    assert second["tables"][1]["inserted"] == 0

    # 第二次没有再创建工作区 / 数据库 / 表
    assert fake_baserow.paths("POST").count("/api/workspaces/") == 1
    assert len(fake_baserow.bodies("POST", "/api/applications/workspace/")) == 1
    assert len(fake_baserow.bodies("POST", "/api/database/tables/database/")) == 2
    # 行数不翻倍
    assert len(fake_baserow.rows[item_table_id]) == len(ITEM_ROWS)
    assert len(fake_baserow.rows[tx_table_id]) == len(TX_ROWS)


def test_publish_reuses_existing_workspace(fake_baserow: FakeBaserow) -> None:
    """已存在同名工作区时直接复用，不再新建。"""
    fake_baserow.workspaces.extend(
        [{"id": 7, "name": "别人的空间"}, {"id": 42, "name": "实验室物资"}]
    )
    result = asyncio_run(_publish())
    assert result["workspaceId"] == 42
    # 工作区复用，但数据库/表是新建的
    assert result["created"] is True
    assert fake_baserow.paths("POST").count("/api/workspaces/") == 0
    assert len(fake_baserow.bodies("POST", "/api/applications/workspace/42/")) == 1


def test_field_mapping(fake_baserow: FakeBaserow) -> None:
    """字段类型按约定下发：数量/预警阈值是 number，备注是 long_text。"""
    result = asyncio_run(_publish())
    item_table_id = result["tables"][0]["id"]
    tx_table_id = result["tables"][1]["id"]

    item_fields = {f["name"]: f["type"] for f in fake_baserow.fields[item_table_id]}
    assert item_fields["数量"] == "number"
    assert item_fields["预警阈值"] == "number"
    assert item_fields["备注"] == "long_text"
    assert item_fields["名称"] == "text"
    assert item_fields["类别"] == "text"
    assert item_fields["规格"] == "text"
    assert item_fields["单位"] == "text"
    assert item_fields["存放位置"] == "text"
    assert item_fields["负责人"] == "text"
    # Baserow 建表模板自带的 Notes/Active 不应残留
    assert "Notes" not in item_fields and "Active" not in item_fields

    # number 字段必须允许小数位；流水数量要允许负数（出库）
    item_defs = {f["name"]: f for f in fake_baserow.fields[item_table_id]}
    assert item_defs["数量"]["number_decimal_places"] == 2
    assert item_defs["数量"]["number_negative"] is False
    assert item_defs["预警阈值"]["number_decimal_places"] == 2

    tx_fields = {f["name"]: f["type"] for f in fake_baserow.fields[tx_table_id]}
    assert tx_fields["数量"] == "number"
    assert tx_fields["备注"] == "long_text"
    assert set(tx_fields) == {"物品", "类型", "数量", "经办人", "时间", "备注"}
    tx_defs = {f["name"]: f for f in fake_baserow.fields[tx_table_id]}
    assert tx_defs["数量"]["number_negative"] is True

    # 行数据按字段名写入（user_field_names）
    written = fake_baserow.rows[item_table_id][0]
    assert written["名称"] == "PBS 缓冲液"
    assert written["数量"] == 3.0
    assert written["预警阈值"] == 1.0
    assert written["类别"] == "样品"
    assert written["负责人"] == "木林森"
    assert written["存放位置"] == "冷藏 A2"
    assert written["备注"] == "常用试剂"

    tx_written = fake_baserow.rows[tx_table_id][0]
    assert tx_written["物品"] == "PBS 缓冲液"
    assert tx_written["类型"] == "入库"
    assert tx_written["数量"] == 3.0
    assert tx_written["经办人"] == "木林森"


def test_upstream_failure_keeps_local_data(fake_baserow: FakeBaserow) -> None:
    """上游失败时明确报错，且不删本地库存数据。"""
    fake_baserow.fail_on = "/api/workspaces/"
    with pytest.raises(HTTPException) as excinfo:
        asyncio_run(_publish())
    assert "同步库存到多维表格失败" in str(excinfo.value.detail)

    # 没有对 Baserow 发出任何删除请求
    assert fake_baserow.paths("DELETE") == []
    # 本地数据原样保留
    assert [r["name"] for r in ITEM_ROWS] == ["PBS 缓冲液", "移液器吸头"]
    assert len(TX_ROWS) == 2


def test_endpoint_requires_admin(fake_baserow: FakeBaserow) -> None:
    """接口本身也校验管理员角色。"""
    with pytest.raises(HTTPException) as excinfo:
        asyncio_run(inventory_baserow.publish({"sub": "u2", "roles": [], "email": "b@b.c"}))
    assert excinfo.value.status_code == 403


def test_endpoint_publishes(fake_baserow: FakeBaserow, monkeypatch: pytest.MonkeyPatch) -> None:
    """走 HTTP 接口：管理员可发布，普通用户被拒。"""
    monkeypatch.setattr(db, "revoked_before", lambda subject: None)
    client = TestClient(main.app)

    admin_cookies = {"labspace_session": _session(["lab-admin"]), settings.csrf_cookie: CSRF}
    resp = client.post(
        "/api/labops/inventory/publish",
        cookies=admin_cookies,
        headers={"X-CSRF-Token": CSRF, "Origin": settings.allowed_origins[0]},
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["workspaceName"] == "实验室物资"
    assert payload["databaseName"] == "库存"
    assert [t["name"] for t in payload["tables"]] == ["物品台账", "出入库流水"]

    user_cookies = {"labspace_session": _session([]), settings.csrf_cookie: CSRF}
    resp = client.post(
        "/api/labops/inventory/publish",
        cookies=user_cookies,
        headers={"X-CSRF-Token": CSRF, "Origin": settings.allowed_origins[0]},
    )
    assert resp.status_code == 403


def asyncio_run(coro: Any) -> Any:
    """同步测试里跑协程（避免额外引入 pytest-asyncio 标记）。"""
    import asyncio

    return asyncio.run(coro)
