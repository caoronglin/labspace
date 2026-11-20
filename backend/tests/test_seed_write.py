"""种子台账的写权限边界。

业务约定（2026-11）：台账是全实验室同一份，
- 读：任何登录用户；
- **新增 / 编辑记录：任何登录用户**（学生也要能入库、改错别字）；
- 删除、批量操作、Excel 导入导出、表与字段结构：仅管理员。

台账建在**管理员**的 Baserow 工作区里，普通账号的令牌写不进去，
所以写操作由后端用管理员令牌完成（`baserow.admin_row_create/update`），
这里断言的是门户自己这一层的权限与转发，不打真实 Baserow。
"""
from __future__ import annotations

import time
from typing import Any

import jwt
import pytest
from fastapi.testclient import TestClient

from app import baserow as baserow_mod
from app import main, seed_tables
from app.config import settings


def _session(roles: list[str], email: str) -> dict[str, str]:
    token = jwt.encode(
        {"sub": "u1", "email": email, "name": email.split("@")[0], "roles": roles, "exp": int(time.time()) + 3600},
        settings.session_secret,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def client() -> TestClient:
    return TestClient(main.app)


@pytest.fixture()
def no_baserow(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """把「共享台账解析」与「管理员写」都换成桩，避免真的访问 Baserow。"""
    calls: dict[str, Any] = {"created": [], "updated": []}

    async def fake_table() -> tuple[int, str]:
        return 417, "种子管理"

    async def fake_create(table_id: int, values: dict[str, Any]) -> dict[str, Any]:
        calls["created"].append((table_id, values))
        return {"id": 1001, **values}

    async def fake_update(table_id: int, row_id: int, values: dict[str, Any]) -> dict[str, Any]:
        calls["updated"].append((table_id, row_id, values))
        return {"id": row_id, **values}

    monkeypatch.setattr(seed_tables, "_shared_seed_table", fake_table)
    monkeypatch.setattr(baserow_mod, "admin_row_create", fake_create)
    monkeypatch.setattr(baserow_mod, "admin_row_update", fake_update)
    return calls


def test_student_can_create_seed_row(client: TestClient, no_baserow: dict[str, Any]) -> None:
    resp = client.post(
        "/api/baserow/seed/rows",
        headers={**_session(["lab-student"], "stu01@local"), "X-CSRF-Token": "t"},
        cookies={"labspace_csrf": "t"},
        json={"名称": "粳稻 09", "编号": "R09-2026"},
    )
    assert resp.status_code == 200, resp.text
    # 表 id 由服务端解析，前端不传表 id
    assert no_baserow["created"][0][0] == 417
    assert resp.json()["id"] == 1001


def test_student_can_update_seed_row(client: TestClient, no_baserow: dict[str, Any]) -> None:
    resp = client.patch(
        "/api/baserow/seed/rows/1001",
        headers={**_session(["lab-student"], "stu01@local"), "X-CSRF-Token": "t"},
        cookies={"labspace_csrf": "t"},
        json={"存放位置": "A-12"},
    )
    assert resp.status_code == 200, resp.text
    assert no_baserow["updated"][0] == (417, 1001, {"存放位置": "A-12"})


def test_student_cannot_delete_seed_row(client: TestClient, no_baserow: dict[str, Any]) -> None:
    """删除是破坏性动作：学生只能改，不能删（否则台账会被越权清空）。"""
    resp = client.delete(
        "/api/baserow/tables/417/rows/1001",
        headers={**_session(["lab-student"], "stu01@local"), "X-CSRF-Token": "t"},
        cookies={"labspace_csrf": "t"},
    )
    assert resp.status_code == 403, resp.text
    assert no_baserow["updated"] == []


def test_anonymous_cannot_create_seed_row(client: TestClient, no_baserow: dict[str, Any]) -> None:
    resp = client.post("/api/baserow/seed/rows", json={"名称": "x"})
    assert resp.status_code in (401, 403), resp.text
    assert no_baserow["created"] == []
