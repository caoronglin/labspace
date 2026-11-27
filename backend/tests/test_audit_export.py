"""审计埋点与导出（Phase 2 · acl-audit）。

目标不是测 SQL，而是锁住三条容易退化的约定：
1. 过滤条件真的进 WHERE（否则导出等于把整表吐给前端）；
2. CSV 导出带表头且不乱码；
3. audit.record() 写失败绝不能把业务操作带崩 —— 审计是旁路。
"""
from __future__ import annotations

import csv
import io
import json

import pytest
from starlette.requests import Request

from app import audit, db
from app.routers import reports


def _request() -> Request:
    """最小可用 Request：导出接口只为签名接受它，函数体不读它。"""
    return Request({
        "type": "http",
        "method": "GET",
        "path": "/api/admin/audit",
        "headers": [],
        "query_string": b"",
        "scheme": "http",
        "server": ("127.0.0.1", 80),
        "client": ("127.0.0.1", 1234),
    })


@pytest.fixture()
def fake_rows(monkeypatch):
    seen: dict[str, object] = {}

    def _query(sql, params=()):
        seen["sql"] = sql
        seen["params"] = params
        return [
            {
                "id": 1,
                "actor": "student01",
                "action": "seed.update",
                "target": "table:1/row:7",
                "detail": {"values": {"编号": "A-1"}},
                "ip": "127.0.0.1",
                "created_at": "2026-11-21T10:00:00+08:00",
            }
        ]

    monkeypatch.setattr(db, "query", _query)
    return seen


@pytest.mark.asyncio
async def test_export_filters_are_parameterised(fake_rows):
    out = await reports.api_admin_audit(
        request=_request(),
        actor="Student01",
        action="seed.",
        since="2026-11-01",
        until="2026-12-01",
        limit=100,
        format="json",
        _admin={"sub": "admin01"},
    )
    sql = str(fake_rows["sql"])
    assert "actor = %s" in sql and "action LIKE %s" in sql
    assert "created_at >= %s" in sql and "created_at < %s" in sql
    # 账号统一小写再查：台账里写的是小写账号名
    assert fake_rows["params"][0] == "student01"
    assert fake_rows["params"][1] == "seed.%"
    assert out["count"] == 1 and out["items"][0]["action"] == "seed.update"


@pytest.mark.asyncio
async def test_export_csv_has_header_and_utf8(fake_rows):
    resp = await reports.api_admin_audit(
        request=_request(),
        actor="",
        action="",
        since="",
        until="",
        limit=10,
        format="csv",
        _admin={"sub": "admin01"},
    )
    assert resp.media_type.startswith("text/csv")
    text = resp.body.decode("utf-8")
    rows = list(csv.reader(io.StringIO(text)))
    assert rows[0][:4] == ["id", "actor", "action", "target"]
    assert rows[1][2] == "seed.update"
    # detail 是 jsonb，导出成 JSON 字符串而不是 Python repr
    assert json.loads(rows[1][4])["values"]["编号"] == "A-1"


@pytest.mark.asyncio
async def test_export_csv_neutralizes_spreadsheet_formulas(monkeypatch):
    monkeypatch.setattr(
        db,
        "query",
        lambda *_args, **_kwargs: [
            {
                "id": 2,
                "actor": "=1+1",
                "action": "@SUM(A1)",
                "target": " \t=cmd",
                "detail": {},
                "ip": "-1",
                "created_at": "2026-11-21T10:00:00+08:00",
            }
        ],
    )
    response = await reports.api_admin_audit(
        request=_request(), actor="", action="", since="", until="", limit=10,
        format="csv", _admin={"sub": "admin01"},
    )
    rows = list(csv.reader(io.StringIO(response.body.decode("utf-8"))))
    assert rows[1][1] == "'=1+1"
    assert rows[1][2] == "'@SUM(A1)"
    assert rows[1][3] == "' \t=cmd"
    assert rows[1][5] == "'-1"


def test_record_failure_never_breaks_business(monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("database is on fire")

    monkeypatch.setattr(db, "execute", boom)
    # 不抛异常 = 业务不会被审计带崩
    audit.record("student01", "seed.create", "table:1/row:1", {"values": {}})


def test_request_ip_context_roundtrip():
    audit.set_request_ip("10.1.2.3")
    try:
        assert audit.current_ip() == "10.1.2.3"
    finally:
        audit.set_request_ip("")
