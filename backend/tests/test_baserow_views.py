"""多维表格视图管理代理：视图 CRUD、筛选/排序、批量操作、字段类型透传。

不打真实 Baserow：上游用 httpx.MockTransport 打桩，断言的是
门户自己拼出的上游路径、请求体与对外响应形状。
"""
from __future__ import annotations

import json
import time
from typing import Any

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient

from app import baserow as baserow_mod
from app import db, main
from app.config import settings

CALLER_JWT = "caller-jwt-not-a-real-token"
TABLE_ID = 42
VIEW_ID = 7

# Baserow 真实字段类型全集（2.4.1 registry 里存在的那些）
FIELD_TYPES = [
    "text",
    "long_text",
    "number",
    "rating",
    "boolean",
    "date",
    "url",
    "email",
    "phone_number",
    "single_select",
    "multiple_select",
    "link_row",
    "file",
    "formula",
    "lookup",
    "rollup",
    "created_on",
    "last_modified_on",
    "autonumber",
    "duration",
    "uuid",
    "password",
    "count",
]

VIEW_JSON = {
    "id": VIEW_ID,
    "table_id": TABLE_ID,
    "name": "Grid",
    "order": 1,
    "type": "grid",
    "filter_type": "AND",
    "filters_disabled": False,
    "filters": [
        {"id": 91, "view": VIEW_ID, "field": 1, "type": "contains", "value": "x", "group": None}
    ],
    "sortings": [
        {"id": 81, "view": VIEW_ID, "field": 2, "order": "DESC", "type": "default", "priority": 1}
    ],
    "filter_groups": [
        {"id": 71, "view": VIEW_ID, "filter_type": "OR", "parent_group": None}
    ],
}


def _field_payload(field_id: int, name: str, ftype: str, **extra: Any) -> dict[str, Any]:
    return {"id": field_id, "name": name, "type": ftype, "primary": False, **extra}


@pytest.fixture()
def upstream(monkeypatch: pytest.MonkeyPatch) -> list[httpx.Request]:
    """把上游 Baserow 换成 MockTransport，并记录收到的请求。"""
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        path = request.url.path
        method = request.method
        if path == f"/api/database/views/table/{TABLE_ID}/":
            if method == "GET":
                return httpx.Response(200, json=[VIEW_JSON])
            if method == "POST":
                return httpx.Response(200, json={**VIEW_JSON, "id": 8, "name": "新视图", "type": "gallery"})
            return httpx.Response(404, json={"error": "not found"})
        if path == f"/api/database/views/{VIEW_ID}/":
            if method == "GET":
                return httpx.Response(200, json=VIEW_JSON)
            if method == "PATCH":
                return httpx.Response(200, json={**VIEW_JSON, "name": "改名"})
            if method == "DELETE":
                return httpx.Response(204)
            return httpx.Response(404, json={"error": "not found"})
        if path == f"/api/database/views/{VIEW_ID}/filters/":
            return httpx.Response(200, json={"id": 92, "view": VIEW_ID, "field": 1, "type": "contains", "value": "y"})
        if path == f"/api/database/views/{VIEW_ID}/sortings/":
            return httpx.Response(200, json={"id": 82, "view": VIEW_ID, "field": 2, "order": "ASC"})
        if path == f"/api/database/views/{VIEW_ID}/filter-groups/":
            return httpx.Response(200, json={"id": 72, "view": VIEW_ID, "filter_type": "AND"})
        if path.startswith("/api/database/views/filter/"):
            if method == "PATCH":
                return httpx.Response(200, json={"id": 91, "view": VIEW_ID, "field": 1, "type": "contains", "value": "z"})
            return httpx.Response(204)
        if path.startswith("/api/database/views/sort/"):
            if method == "PATCH":
                return httpx.Response(200, json={"id": 81, "view": VIEW_ID, "field": 2, "order": "ASC"})
            return httpx.Response(204)
        if path.startswith("/api/database/views/filter-group/"):
            return httpx.Response(204)
        if path == f"/api/database/views/{VIEW_ID}/field-options/":
            if method == "GET":
                return httpx.Response(
                    200,
                    json={"field_options": {"1": {"width": 200, "hidden": False, "order": 1}}},
                )
            return httpx.Response(
                200,
                json={"field_options": {"1": {"width": 200, "hidden": True, "order": 1}}},
            )
        if path == f"/api/database/fields/table/{TABLE_ID}/":
            return httpx.Response(
                200,
                json=[
                    _field_payload(1, "标题", "text", primary=True),
                    _field_payload(2, "状态", "single_select", select_options=[{"id": 3, "value": "完成", "color": "green"}]),
                    _field_payload(3, "关联", "link_row", link_row_table_id=99),
                    _field_payload(4, "公式", "formula", read_only=True),
                ],
            )
        if path == f"/api/database/rows/table/{TABLE_ID}/":
            return httpx.Response(200, json={"count": 1, "next": None, "previous": None, "results": [{"id": 5}]})
        if path == f"/api/database/rows/table/{TABLE_ID}/batch-delete/":
            return httpx.Response(204)
        if path == f"/api/database/rows/table/{TABLE_ID}/batch/":
            return httpx.Response(200, json={"items": [{"id": 5, "标题": "改"}]})
        if path == f"/api/row_comments/{TABLE_ID}/5/":
            if method == "GET":
                return httpx.Response(
                    200,
                    json=[
                        {
                            "id": 3,
                            "message": "收到",
                            "first_name": "木林森",
                            "created_on": "2026-01-01T00:00:00Z",
                            "updated_on": "2026-01-01T00:00:00Z",
                            "edited": False,
                        }
                    ],
                )
            return httpx.Response(200, json={"id": 4, "message": "新的"})
        if path == "/api/trash/workspace/3/":
            return httpx.Response(
                200,
                json={
                    "count": 1,
                    "results": [
                        {
                            "id": 55,
                            "user_who_trashed": "labadmin",
                            "trash_item_type": "row",
                            "trash_item_id": 13,
                            "parent_trash_item_id": TABLE_ID,
                            "trashed_at": "2026-01-01T00:00:00Z",
                            "name": "13",
                            "names": ["未命名行 13"],
                            "parent_name": "工作表",
                        }
                    ],
                },
            )
        if path == "/api/trash/restore/":
            return httpx.Response(200, json={"id": 55})
        return httpx.Response(404, json={"error": "URL_NOT_FOUND", "detail": path})

    monkeypatch.setattr(
        baserow_mod,
        "_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )

    async def fake_token(user: dict[str, Any], force: bool = False) -> str:
        return CALLER_JWT

    monkeypatch.setattr(baserow_mod, "_token", fake_token)
    monkeypatch.setattr(db, "revoked_before", lambda subject: None)
    return calls


@pytest.fixture()
def client() -> TestClient:
    return TestClient(main.app)


@pytest.fixture()
def auth() -> dict[str, str]:
    """Bearer 会话：内部服务同款，CSRF 双提交对 Bearer 豁免。"""
    token = jwt.encode(
        # 写操作（建视图、改筛选、删行…）现在只对 lab-admin 开放：
        # 任何登录用户都能改 Baserow 表结构、删行，等于没有权限区分。
        {"sub": "u1", "email": "a@b.c", "name": "木林森", "roles": ["lab-admin"], "exp": int(time.time()) + 3600},
        settings.session_secret,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def cookie_auth() -> dict[str, str]:
    """Cookie 会话：浏览器路径，双提交 CSRF 生效。"""
    token = jwt.encode(
        # 写操作（建视图、改筛选、删行…）现在只对 lab-admin 开放：
        # 任何登录用户都能改 Baserow 表结构、删行，等于没有权限区分。
        {"sub": "u1", "email": "a@b.c", "name": "木林森", "roles": ["lab-admin"], "exp": int(time.time()) + 3600},
        settings.session_secret,
        algorithm="HS256",
    )
    return {"labspace_session": token, settings.csrf_cookie: "csrf-token-for-test"}


# ------------------------------------------------------------------ 视图 CRUD


def test_list_views_calls_upstream_view_list(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.get(f"/api/baserow/tables/{TABLE_ID}/views", headers=auth)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["views"]) == 1
    view = body["views"][0]
    assert view["id"] == VIEW_ID
    assert view["type"] == "grid"
    assert view["filters"][0]["field"] == 1
    assert view["sortings"][0]["order"] == "DESC"
    assert view["filter_groups"][0]["filter_type"] == "OR"

    call = upstream[0]
    assert call.url.path == f"/api/database/views/table/{TABLE_ID}/"
    # 视图的筛选/排序要一并取回
    assert "filters" in call.url.params.get("include")


def test_create_view_posts_to_upstream(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.post(
        f"/api/baserow/tables/{TABLE_ID}/views",
        headers=auth,
        json={"name": "画廊", "type": "gallery"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["type"] == "gallery"
    create = [r for r in upstream if r.method == "POST"][0]
    assert create.url.path == f"/api/database/views/table/{TABLE_ID}/"
    assert json.loads(create.read()) == {"name": "画廊", "type": "gallery"}


def test_create_view_rejects_unknown_type(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.post(
        f"/api/baserow/tables/{TABLE_ID}/views",
        headers=auth,
        json={"name": "奇怪", "type": "pivot"},
    )
    assert resp.status_code == 400, resp.text
    assert not [r for r in upstream if r.method == "POST"]


def test_rename_view_patches_upstream(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.patch(
        f"/api/baserow/tables/{TABLE_ID}/views/{VIEW_ID}",
        headers=auth,
        json={"name": "改名"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "改名"
    patch = [r for r in upstream if r.method == "PATCH" and r.url.path.endswith(f"/{VIEW_ID}/")][0]
    assert patch.url.path == f"/api/database/views/{VIEW_ID}/"
    assert json.loads(patch.read()) == {"name": "改名"}


def test_delete_view_calls_upstream_delete(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.delete(f"/api/baserow/tables/{TABLE_ID}/views/{VIEW_ID}", headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True}
    assert any(
        r.method == "DELETE" and r.url.path == f"/api/database/views/{VIEW_ID}/" for r in upstream
    )


# ------------------------------------------------------------------ 筛选 / 排序


def test_create_view_filter(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.post(
        f"/api/baserow/tables/{TABLE_ID}/views/{VIEW_ID}/filters",
        headers=auth,
        json={"field": 1, "type": "contains", "value": "abc"},
    )
    assert resp.status_code == 200, resp.text
    create = [r for r in upstream if r.url.path.endswith("/filters/")][0]
    assert create.url.path == f"/api/database/views/{VIEW_ID}/filters/"
    body = create.read()
    assert b'"field":1' in body and b'"type":"contains"' in body and b'"value":"abc"' in body


def test_create_view_sort(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.post(
        f"/api/baserow/tables/{TABLE_ID}/views/{VIEW_ID}/sortings",
        headers=auth,
        json={"field": 2, "order": "desc"},
    )
    assert resp.status_code == 200, resp.text
    create = [r for r in upstream if r.url.path.endswith("/sortings/")][0]
    assert create.url.path == f"/api/database/views/{VIEW_ID}/sortings/"
    assert b'"order":"DESC"' in create.read()


def test_delete_view_filter_and_sort(client: TestClient, auth: dict[str, str], upstream) -> None:
    assert (
        client.delete(
            f"/api/baserow/tables/{TABLE_ID}/views/{VIEW_ID}/filters/91", headers=auth
        ).status_code
        == 200
    )
    assert (
        client.delete(
            f"/api/baserow/tables/{TABLE_ID}/views/{VIEW_ID}/sortings/81", headers=auth
        ).status_code
        == 200
    )
    paths = {r.url.path for r in upstream if r.method == "DELETE"}
    assert "/api/database/views/filter/91/" in paths
    assert "/api/database/views/sort/81/" in paths


def test_filter_with_foreign_field_is_rejected(client: TestClient, auth: dict[str, str], upstream) -> None:
    """伪造字段 id（属于别的表）不能越权写入视图筛选。"""
    resp = client.post(
        f"/api/baserow/tables/{TABLE_ID}/views/{VIEW_ID}/filters",
        headers=auth,
        json={"field": 9999, "type": "contains", "value": "x"},
    )
    assert resp.status_code == 400, resp.text
    assert "9999" in resp.json()["detail"]
    assert not [r for r in upstream if r.url.path.endswith("/filters/")]


def test_sort_with_foreign_field_is_rejected(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.post(
        f"/api/baserow/tables/{TABLE_ID}/views/{VIEW_ID}/sortings",
        headers=auth,
        json={"field": 9999, "order": "ASC"},
    )
    assert resp.status_code == 400, resp.text
    assert not [r for r in upstream if r.url.path.endswith("/sortings/")]


def test_view_of_another_table_is_not_writable(client: TestClient, auth: dict[str, str], upstream) -> None:
    """视图 id 不属于当前工作表时，改名/删除都要被挡住。"""
    resp = client.delete(f"/api/baserow/tables/43/views/{VIEW_ID}", headers=auth)
    assert resp.status_code == 404, resp.text
    assert not [r for r in upstream if r.method == "DELETE"]


def test_update_view_filter_patches_upstream(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.patch(
        f"/api/baserow/tables/{TABLE_ID}/views/{VIEW_ID}/filters/91",
        headers=auth,
        json={"field": 1, "type": "contains", "value": "z"},
    )
    assert resp.status_code == 200, resp.text
    call = [r for r in upstream if r.method == "PATCH"][0]
    assert call.url.path == "/api/database/views/filter/91/"
    assert json.loads(call.read()) == {"type": "contains", "value": "z"}


def test_update_view_sort_patches_upstream(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.patch(
        f"/api/baserow/tables/{TABLE_ID}/views/{VIEW_ID}/sortings/81",
        headers=auth,
        json={"field": 2, "order": "asc"},
    )
    assert resp.status_code == 200, resp.text
    call = [r for r in upstream if r.method == "PATCH"][0]
    assert call.url.path == "/api/database/views/sort/81/"
    assert json.loads(call.read()) == {"field": 2, "order": "ASC"}


# ------------------------------------------------------------------ 字段类型


def test_field_types_are_passed_through(
    client: TestClient, auth: dict[str, str], upstream, monkeypatch: pytest.MonkeyPatch
) -> None:
    """字段类型要原样透出，前端才能按类型渲染控件。"""
    payload = [_field_payload(i, f"字段{i}", t) for i, t in enumerate(FIELD_TYPES, start=1)]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == f"/api/database/fields/table/{TABLE_ID}/":
            return httpx.Response(200, json=payload)
        return httpx.Response(404, json={"error": "URL_NOT_FOUND"})

    monkeypatch.setattr(
        baserow_mod,
        "_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    resp = client.get(f"/api/baserow/tables/{TABLE_ID}/fields", headers=auth)
    assert resp.status_code == 200, resp.text
    types = [f["type"] for f in resp.json()["fields"]]
    assert types == FIELD_TYPES


def test_link_row_field_keeps_linked_table_id(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.get(f"/api/baserow/tables/{TABLE_ID}/fields", headers=auth)
    assert resp.status_code == 200, resp.text
    fields = {f["name"]: f for f in resp.json()["fields"]}
    assert fields["关联"]["link_row_table_id"] == 99
    assert fields["公式"]["read_only"] is True


# ------------------------------------------------------------------ 批量操作


def test_batch_delete_uses_upstream_batch_delete_path(
    client: TestClient, auth: dict[str, str], upstream
) -> None:
    resp = client.post(
        f"/api/baserow/tables/{TABLE_ID}/rows/batch-delete",
        headers=auth,
        json={"items": [5, 6, 7]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"deleted": 3}
    call = [r for r in upstream if r.method == "POST"][0]
    assert call.url.path == f"/api/database/rows/table/{TABLE_ID}/batch-delete/"
    assert b'"items":[5,6,7]' in call.read()


def test_batch_delete_rejects_empty_selection(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.post(
        f"/api/baserow/tables/{TABLE_ID}/rows/batch-delete",
        headers=auth,
        json={"items": []},
    )
    assert resp.status_code == 422, resp.text
    assert not [r for r in upstream if r.method == "POST"]


def test_batch_update_uses_upstream_batch_patch(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.patch(
        f"/api/baserow/tables/{TABLE_ID}/rows/batch",
        headers=auth,
        json={"items": [{"id": 5, "标题": "改"}]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["updated"] == 1
    call = [r for r in upstream if r.method == "PATCH"][0]
    assert call.url.path == f"/api/database/rows/table/{TABLE_ID}/batch/"
    body = call.read()
    assert b'"id":5' in body and b'"title"' not in body


def test_rows_accept_view_id(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.get(f"/api/baserow/tables/{TABLE_ID}/rows?view_id={VIEW_ID}&size=10", headers=auth)
    assert resp.status_code == 200, resp.text
    call = [r for r in upstream if r.url.path.endswith(f"/api/database/rows/table/{TABLE_ID}/")][0]
    assert call.url.params.get("view_id") == str(VIEW_ID)


# ------------------------------------------------------------------ 评论 / 回收站


def test_row_comments_are_listed(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.get(f"/api/baserow/tables/{TABLE_ID}/rows/5/comments", headers=auth)
    assert resp.status_code == 200, resp.text
    comments = resp.json()["comments"]
    assert comments[0]["message"] == "收到"
    assert upstream[0].url.path == f"/api/row_comments/{TABLE_ID}/5/"


def test_row_comment_is_created(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.post(
        f"/api/baserow/tables/{TABLE_ID}/rows/5/comments",
        headers=auth,
        json={"message": "新的"},
    )
    assert resp.status_code == 200, resp.text
    call = [r for r in upstream if r.method == "POST"][0]
    assert call.url.path == f"/api/row_comments/{TABLE_ID}/5/"
    assert b'"message"' in call.read()


def test_trash_lists_deleted_items(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.get("/api/baserow/trash?workspace_id=3", headers=auth)
    assert resp.status_code == 200, resp.text
    items = resp.json()["items"]
    assert items[0]["trash_item_type"] == "row"
    assert items[0]["trash_item_id"] == 13
    assert upstream[0].url.path == "/api/trash/workspace/3/"


def test_trash_restore(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.post(
        "/api/baserow/trash/restore",
        headers=auth,
        json={"trash_item_id": 13, "trash_item_type": "row", "parent_trash_item_id": TABLE_ID},
    )
    assert resp.status_code == 200, resp.text
    call = [r for r in upstream if r.url.path == "/api/trash/restore/"][0]
    assert call.method == "PATCH"
    body = call.read()
    assert b'"trash_item_id":13' in body and b'"trash_item_type":"row"' in body


def test_never_leaks_token(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.get(f"/api/baserow/tables/{TABLE_ID}/views", headers=auth)
    assert resp.status_code == 200, resp.text
    assert CALLER_JWT not in resp.text
    assert upstream[0].headers["authorization"] == f"JWT {CALLER_JWT}"


# ------------------------------------------------------------------ CSRF

def test_view_writes_require_csrf(client: TestClient, cookie_auth: dict[str, str], upstream) -> None:
    """浏览器 Cookie 会话下，写操作必须带 CSRF 头。"""
    resp = client.post(
        f"/api/baserow/tables/{TABLE_ID}/views",
        cookies=cookie_auth,
        json={"name": "无 CSRF", "type": "grid"},
    )
    assert resp.status_code == 403, resp.text
    assert not [r for r in upstream if r.method == "POST"]


def test_batch_delete_requires_csrf(client: TestClient, cookie_auth: dict[str, str], upstream) -> None:
    resp = client.post(
        f"/api/baserow/tables/{TABLE_ID}/rows/batch-delete",
        cookies=cookie_auth,
        json={"items": [5]},
    )
    assert resp.status_code == 403, resp.text
    assert not [r for r in upstream if r.method == "POST"]


def test_view_write_succeeds_with_csrf(
    client: TestClient, cookie_auth: dict[str, str], upstream
) -> None:
    resp = client.post(
        f"/api/baserow/tables/{TABLE_ID}/views",
        cookies=cookie_auth,
        headers={"X-CSRF-Token": "csrf-token-for-test", "Origin": settings.allowed_origins[0]},
        json={"name": "带 CSRF", "type": "grid"},
    )
    assert resp.status_code == 200, resp.text
    assert any(r.method == "POST" for r in upstream)


def test_view_field_options_are_read(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.get(f"/api/baserow/tables/{TABLE_ID}/views/{VIEW_ID}/field-options", headers=auth)
    assert resp.status_code == 200, resp.text
    options = resp.json()["field_options"]
    assert options["1"]["hidden"] is False
    # 先校验视图归属，再取字段选项
    assert upstream[0].url.path == f"/api/database/views/table/{TABLE_ID}/"
    assert upstream[-1].url.path == f"/api/database/views/{VIEW_ID}/field-options/"


def test_view_field_options_are_updated(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.patch(
        f"/api/baserow/tables/{TABLE_ID}/views/{VIEW_ID}/field-options",
        headers=auth,
        json={"field_options": {"1": {"hidden": True}}},
    )
    assert resp.status_code == 200, resp.text
    call = [r for r in upstream if r.method == "PATCH"][0]
    assert call.url.path == f"/api/database/views/{VIEW_ID}/field-options/"
    assert json.loads(call.read()) == {"field_options": {"1": {"hidden": True}}}


def test_view_field_options_rejects_empty(client: TestClient, auth: dict[str, str], upstream) -> None:
    resp = client.patch(
        f"/api/baserow/tables/{TABLE_ID}/views/{VIEW_ID}/field-options",
        headers=auth,
        json={"field_options": {}},
    )
    assert resp.status_code == 400, resp.text
    assert not [r for r in upstream if r.method == "PATCH"]


def test_write_endpoints_reject_non_admin(client: TestClient, upstream) -> None:
    """回归：Baserow 的**写**操作只对 lab-admin 开放。

    以前所有代理接口都是 require_user —— 任何登录用户都能建视图、改字段、
    批量删行、删表。多维表格等于没有权限区分，普通成员误操作就能毁掉台账。
    读保持 require_user（业务上大家都要看台账），写收紧到管理员。
    """
    token = jwt.encode(
        {"sub": "u2", "email": "student@b.c", "name": "学生", "roles": ["lab-student"],
         "exp": int(time.time()) + 3600},
        settings.session_secret,
        algorithm="HS256",
    )
    headers = {"Authorization": f"Bearer {token}"}

    # 建视图
    resp = client.post(f"/api/baserow/tables/{TABLE_ID}/views", json={"name": "x", "type": "grid"}, headers=headers)
    assert resp.status_code == 403, resp.text
    assert "lab-admin" in resp.text

    # 删行
    resp = client.delete(f"/api/baserow/tables/{TABLE_ID}/rows/1", headers=headers)
    assert resp.status_code == 403, resp.text

    # 改字段
    resp = client.post(f"/api/baserow/tables/{TABLE_ID}/fields", json={"name": "x"}, headers=headers)
    assert resp.status_code == 403, resp.text

    # 但**读**仍然开放：台账是大家都要看的
    resp = client.get(f"/api/baserow/tables/{TABLE_ID}/views", headers=headers)
    assert resp.status_code == 200, resp.text
