"""工作台 SQL 契约：过滤条件、参数顺序、聚合。

不连数据库：拦截 db.query / db.query_many，断言真正下发的 SQL 与参数。
这几个点曾经真实出错过（q 为空时条件恒真、updated_at 排序方向反了）。
"""
from __future__ import annotations

import time
from typing import Any

import jwt
import pytest
from fastapi.testclient import TestClient

from app import db, main, workbench
from app.config import settings


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    calls: list[tuple[str, tuple[Any, ...]]] = []

    def answer(sql: str) -> list[dict[str, Any]]:
        """按语句内容返回假数据——同一个 fake 供 query / query_many 两条路径复用。"""
        if "AS active_tasks" in sql:
            return [{"active_tasks": 2, "inbox": 1, "completed_week": 4}]
        if "count(*) FILTER" in sql:
            return [{"n": 7}]
        if "count(*) AS n" in sql:
            return [{"n": 3}]
        return []

    def fake_query(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        calls.append((sql, params))
        return answer(sql)

    def fake_query_many(statements: list[tuple[str, tuple]]) -> list[list[dict[str, Any]]]:
        out: list[list[dict[str, Any]]] = []
        for sql, params in statements:
            calls.append((sql, params))
            out.append(answer(sql))
        return out

    # summary 走 _q_batch → db.query_many（单连接批量），其余端点走 db.query。
    # 两个都要拦住，否则漏掉的那个会真的去连 PostgreSQL。
    monkeypatch.setattr(db, "query", fake_query)
    monkeypatch.setattr(db, "query_many", fake_query_many)
    client = TestClient(main.app)
    client.calls = calls  # type: ignore[attr-defined]
    return client


CSRF = "csrf-token-for-test"


@pytest.fixture()
def cookies() -> dict[str, str]:
    token = jwt.encode(
        {"sub": "u1", "email": "a@b.c", "name": "木林森", "roles": [], "exp": int(time.time()) + 3600},
        settings.session_secret,
        algorithm="HS256",
    )
    # 双提交 CSRF：Cookie 与请求头必须一致
    return {"labspace_session": token, settings.csrf_cookie: CSRF}


def write(origin: str = "") -> dict[str, str]:
    return {"X-CSRF-Token": CSRF, "Origin": origin or settings.allowed_origins[0]}


def test_items_search_binds_keyword(client: TestClient, cookies: dict[str, str]) -> None:
    resp = client.get("/api/workbench/items?q=abc&kind=task", cookies=cookies)
    assert resp.status_code == 200
    assert resp.json()["total"] == 3
    count_sql, count_params = client.calls[-2]  # type: ignore[attr-defined]
    assert "%abc%" in count_params
    # kind 出现两处（判空 + 比较），q 只占一个位置参数
    assert count_params.count("task") == 2
    select_sql, select_params = client.calls[-1]  # type: ignore[attr-defined]
    assert "updated_at DESC" in select_sql
    assert select_params[-1] == 50


def test_items_without_keyword_keeps_other_filters(client: TestClient, cookies: dict[str, str]) -> None:
    """q 为空时不能把 kind/status 过滤一起短路掉。"""
    client.get("/api/workbench/items?kind=task", cookies=cookies)
    _, params = client.calls[-1]  # type: ignore[attr-defined]
    assert params[1] == "task" and params[2] == "task"
    assert params[-3] is None and params[-2] is None  # like 仍为 NULL


def test_summary_stats_are_aggregated(client: TestClient, cookies: dict[str, str]) -> None:
    resp = client.get("/api/workbench/summary", cookies=cookies)
    assert resp.status_code == 200
    assert resp.json()["stats"] == {
        "activeTasks": 2,
        "activeProjects": 7,
        "activeDirections": 7,
        "inbox": 1,
        "completedThisWeek": 4,
    }
    # 列表查询必须带 LIMIT，避免整表取回
    for sql, params in client.calls:  # type: ignore[attr-defined]
        if sql.startswith("SELECT * FROM labspace.workbench_items") and "brief_date" not in sql:
            assert "LIMIT %s" in sql
            assert isinstance(params[-1], int)


def test_capture_rejects_empty(client: TestClient, cookies: dict[str, str]) -> None:
    resp = client.post(
        "/api/workbench/capture",
        json={"text": "   "},
        cookies=cookies,
        headers=write(),
    )
    assert resp.status_code == 400


def test_write_endpoints_require_csrf(client: TestClient, cookies: dict[str, str]) -> None:
    resp = client.post("/api/workbench/items", json={"title": "x"}, cookies=cookies)
    assert resp.status_code == 403


def test_item_kind_is_validated(client: TestClient, cookies: dict[str, str]) -> None:
    resp = client.post(
        "/api/workbench/items",
        json={"kind": "not-a-kind", "title": "x"},
        cookies=cookies,
        headers=write(),
    )
    assert resp.status_code == 400
    assert resp.json()["detail"] == "条目类型无效"


def test_workbench_routes_are_mounted() -> None:
    """FastAPI ≥0.116 把 include_router 的路由放进 _IncludedRouter，
    这里用 OpenAPI 校验 16 个接口确实挂上了。"""
    paths = main.app.openapi()["paths"]
    expected = {
        "/api/workbench/items",
        "/api/workbench/items/{item_id}",
        "/api/workbench/projects",
        "/api/workbench/projects/{project_id}",
        "/api/workbench/plans",
        "/api/workbench/plans/{plan_id}",
        "/api/workbench/briefs",
        "/api/workbench/capture",
        "/api/workbench/summary",
    }
    assert expected <= set(paths)
    # 这里原本写死 ==16：路由一增加测试就红，但它想守的是"这些接口都挂上了"，
    # 不是"路由数量永不变化"。改成下界 + 上面的集合断言，才是它真正要保证的东西。
    assert len(workbench.router.routes) >= 16


def test_summary_goes_through_one_batched_connection(
    client: TestClient, cookies: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """首页 12 条查询必须走 db.query_many 的批量路径，而不是逐条 db.query。

    连接池上限 8，逐条发会打成 12 条独占连接 → PoolError。这条断言同时守住
    一个曾经的真实事故：summary 改走 _q_batch 后，测试只 patch 了 db.query，
    于是用例直接去连 PostgreSQL，在 CI 上以「connection refused」崩掉——
    测试通过与否跟被测代码走的路径脱钩了。
    """
    single: list[str] = []
    original = client.calls  # type: ignore[attr-defined]
    monkeypatch.setattr(db, "query", lambda sql, params=(): single.append(sql) or [])

    assert client.get("/api/workbench/summary", cookies=cookies).status_code == 200
    assert single == [], "summary 不应该逐条 db.query"
    assert len(original) == 12  # 一次批量，12 条语句
