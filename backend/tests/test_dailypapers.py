"""每日论文：首次抓取落库 / 第二次读库不重复抓取 / 全源失败不伪造数据 / 跨用户不可见。

不连数据库：用内存假库接管 ``db.query`` / ``db.execute``。假库**按列名**解析
WHERE 里的占位符（而不是按位置），所以 SQL 里参数顺序写错、漏掉 owner 条件
都会被测出来；INSERT 也按列名对齐，列数与占位符对不上会直接报错。
"""
from __future__ import annotations

import importlib
import json
import re
import time
from datetime import UTC, date, datetime
from typing import Any

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient

from app.routers import search as search_router_mod  # 路由已迁出 main
from app import dailypapers, db
from app.config import settings
from app.literature_sources import Paper, SearchResult

DAY = date(2026, 11, 10)

OPENALEX_OK = {
    "results": [
        {
            "title": "Maize drought response",
            "doi": "https://doi.org/10.1000/ABC",
            "publication_year": 2024,
            "cited_by_count": 12,
            "authorships": [{"author": {"display_name": "Li Wei"}}],
            "primary_location": {
                "source": {"display_name": "Plant Cell"},
                "landing_page_url": "https://example.org/paper",
            },
            "open_access": {"is_oa": True, "oa_url": "https://example.org/paper.pdf"},
            "abstract_inverted_index": {"Drought": [0], "reduces": [1], "yield": [2]},
            "id": "https://openalex.org/W123",
        }
    ]
}

_COL_BIND = re.compile(r"(\w+)\s*=\s*%s")
_INSERT_COLS = re.compile(r"INSERT INTO labspace\.daily_papers \((.*?)\)", re.S)


def _where_bind(sql: str, params: tuple) -> dict[str, Any]:
    """按列名解析 WHERE 里的占位符，返回 {列名: 参数值}。"""
    if " WHERE " not in sql:
        return {}
    where = sql.split(" WHERE ", 1)[1]
    for stop in (" ORDER BY ", " LIMIT ", " GROUP BY "):
        where = where.split(stop, 1)[0]
    names = _COL_BIND.findall(where)
    assert len(names) == len(params[: len(names)]), f"WHERE 条件与参数个数不匹配：{sql}"
    return dict(zip(names, params, strict=False))


class FakeDb:
    """内存假库：只认识 daily_papers 这一张表的读写。"""

    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []
        self.calls: list[tuple[str, tuple]] = []

    # -- db.query / db.execute 的替身 ------------------------------------------------
    def query(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        flat = " ".join(sql.split())
        self.calls.append((flat, tuple(params)))
        bind = _where_bind(flat, params)
        matched = self._match(bind)
        if "count(*)" in flat:
            return [{"n": len(matched)}]
        matched.sort(key=lambda r: (0 if r.get("score") is not None else 1, -(r.get("score") or 0.0), r.get("title") or ""))
        if "LIMIT %s OFFSET %s" in flat:
            limit, offset = int(params[-2]), int(params[-1])
            return matched[offset : offset + limit]
        return matched

    def execute(self, sql: str, params: tuple = ()) -> None:
        flat = " ".join(sql.split())
        self.calls.append((flat, tuple(params)))
        match = _INSERT_COLS.search(flat)
        assert match, f"只应执行 daily_papers 的 INSERT：{flat}"
        cols = [c.strip() for c in match.group(1).split(",")]
        assert len(cols) == len(params), f"列数 {len(cols)} 与占位符 {len(params)} 不匹配"
        row = dict(zip(cols, params, strict=True))
        key = (row["day"], row["owner"], row["topic"], row["doi"], row["title"])
        for existing in self.rows:
            if (existing["day"], existing["owner"], existing["topic"], existing["doi"], existing["title"]) == key:
                existing.update(row)
                return
        row["created_at"] = datetime(2026, 11, 10, tzinfo=UTC)
        self.rows.append(row)

    # -- 内部 ------------------------------------------------------------------------
    def _match(self, bind: dict[str, Any]) -> list[dict[str, Any]]:
        out = []
        for row in self.rows:
            if row.get("day") != bind.get("day"):
                continue
            if row.get("owner") != bind.get("owner"):
                continue
            if "topic" in bind and row.get("topic") != bind.get("topic"):
                continue
            out.append(row)
        return out


@pytest.fixture()
def fake_db(monkeypatch: pytest.MonkeyPatch) -> FakeDb:
    fake = FakeDb()
    monkeypatch.setattr(db, "query", fake.query)
    monkeypatch.setattr(db, "execute", fake.execute)
    return fake


def _openalex_client(calls: list[str]) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.host)
        if request.url.host == "api.openalex.org":
            return httpx.Response(200, json=OPENALEX_OK)
        return httpx.Response(503, text="unavailable")

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_first_build_fetches_and_stores_rows(fake_db: FakeDb) -> None:
    """第一次调用：抓文献源并落库。"""
    calls: list[str] = []
    async with _openalex_client(calls) as client:
        result = await dailypapers.build_daily("u1", "植物抗旱", DAY, 5, client=client)

    assert result["source"] == "openalex"
    assert result["count"] == 1
    assert result["cached"] is False
    paper = result["papers"][0]
    assert paper["title"] == "Maize drought response"
    assert paper["doi"] == "10.1000/abc"
    assert paper["authors"] == ["Li Wei"]
    assert paper["venue"] == "Plant Cell"
    assert paper["year"] == 2024
    assert paper["source"] == "openalex"
    assert paper["snippet"] == "Drought reduces yield"

    assert "api.openalex.org" in calls
    assert len(fake_db.rows) == 1
    row = fake_db.rows[0]
    assert (row["day"], row["owner"], row["topic"]) == (DAY, "u1", "植物抗旱")
    assert row["title"] == "Maize drought response"
    assert row["doi"] == "10.1000/abc"
    assert row["url"] == "https://example.org/paper"
    assert row["pdf_url"] == "https://example.org/paper.pdf"
    assert row["citations"] == 12


@pytest.mark.asyncio
async def test_second_build_reads_db_without_refetching(fake_db: FakeDb) -> None:
    """第二次调用：直接读库，不再打上游。"""
    calls: list[str] = []
    async with _openalex_client(calls) as client:
        first = await dailypapers.build_daily("u1", "植物抗旱", DAY, 5, client=client)

    def boom(request: httpx.Request) -> httpx.Response:  # pragma: no cover - 不应被调用
        raise AssertionError("已有数据时不应重复抓取")

    async with httpx.AsyncClient(transport=httpx.MockTransport(boom)) as client:
        second = await dailypapers.build_daily("u1", "植物抗旱", DAY, 5, client=client)

    assert first["cached"] is False
    assert second["cached"] is True
    assert second["count"] == first["count"]
    assert second["papers"][0]["title"] == "Maize drought response"
    assert second["source"] == "openalex"
    assert len(fake_db.rows) == 1, "第二次不应再写一行"


@pytest.mark.asyncio
async def test_all_sources_fail_does_not_fabricate_data(fake_db: FakeDb) -> None:
    """全源失败：source=none、count=0、失败原因留痕，且一条都不写库。"""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="unavailable")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await dailypapers.build_daily("u1", "植物抗旱", DAY, 5, client=client)

    assert result["source"] == "none"
    assert result["count"] == 0
    assert result["papers"] == []
    assert result["attempts"], "失败原因必须写进 attempts"
    assert all(a["status"].startswith("error") for a in result["attempts"])
    assert {a["source"] for a in result["attempts"]} >= {"openalex", "semanticscholar", "crossref"}
    assert fake_db.rows == [], "失败时不得留下任何条目"


@pytest.mark.asyncio
async def test_papers_are_isolated_between_owners(fake_db: FakeDb) -> None:
    """跨用户不可见：u2 读不到 u1 的数据，u2 的缓存也不共享。"""
    calls: list[str] = []
    async with _openalex_client(calls) as client:
        await dailypapers.build_daily("u1", "植物抗旱", DAY, 5, client=client)

    other = await dailypapers.list_daily("u2", DAY)
    assert other["count"] == 0
    assert other["total"] == 0
    assert other["papers"] == []

    mine = await dailypapers.list_daily("u1", DAY)
    assert mine["total"] == 1
    assert mine["papers"][0]["title"] == "Maize drought response"

    # u2 自己构建时会重新抓（缓存按 (day, owner, topic) 分开）
    calls.clear()
    async with _openalex_client(calls) as client:
        for_user_two = await dailypapers.build_daily("u2", "植物抗旱", DAY, 5, client=client)
    assert for_user_two["cached"] is False
    assert "api.openalex.org" in calls

    # 所有落到 daily_papers 的 SQL 都必须按 owner 隔离
    daily_sql = [(sql, params) for sql, params in fake_db.calls if "daily_papers" in sql]
    assert daily_sql, "应当有读写 daily_papers 的 SQL"
    for sql, params in daily_sql:
        if sql.startswith("INSERT"):
            assert "(day, owner, topic," in sql, f"INSERT 缺少 owner 列：{sql}"
        else:
            assert "owner=%s" in sql, f"SQL 缺少 owner 条件：{sql}"
        assert "u1" in params or "u2" in params, f"SQL 参数里没有 owner：{params}"


@pytest.mark.asyncio
async def test_list_daily_paginates(fake_db: FakeDb) -> None:
    """分页：page/page_size 生效，total 是当天全部条数。"""
    for idx, title in enumerate(["A paper", "B paper", "C paper"]):
        fake_db.execute(
            "INSERT INTO labspace.daily_papers (day, owner, topic, doi, title, authors, venue, year,"
            " abstract, url, pdf_url, citations, source, score)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (DAY, "u1", "植物抗旱", f"10.1/{idx}", title, "Li Wei", "Plant Cell", 2024,
             "abstract", "https://example.org/x", "", 3, "openalex", 10.0 - idx),
        )

    page1 = await dailypapers.list_daily("u1", DAY, page=1, page_size=2)
    assert page1["total"] == 3
    assert page1["count"] == 2
    assert page1["page"] == 1 and page1["pageSize"] == 2
    assert [p["title"] for p in page1["papers"]] == ["A paper", "B paper"]

    page2 = await dailypapers.list_daily("u1", DAY, page=2, page_size=2)
    assert [p["title"] for p in page2["papers"]] == ["C paper"]

    filtered = await dailypapers.list_daily("u1", DAY, topic="别的主题")
    assert filtered["total"] == 0
    assert filtered["papers"] == []


@pytest.mark.asyncio
async def test_build_daily_rejects_empty_topic(fake_db: FakeDb) -> None:
    """主题为空：直接返回空结果，不去打上游。"""
    result = await dailypapers.build_daily("u1", "   ", DAY, 5)
    assert result["source"] == "none"
    assert result["count"] == 0
    assert result["papers"] == []
    assert result["attempts"][0]["status"] == "empty topic"


def test_cli_prints_json_summary(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    """CLI：参数齐全时打印 JSON 摘要，全源失败时退出码为 1。"""
    calls: list[str] = []

    async def fake_search(query: str, limit: int = 20, **kwargs: Any) -> SearchResult:
        calls.append(query)
        return SearchResult(
            papers=[
                Paper(
                    title="Maize drought response",
                    source="openalex",
                    authors=["Li Wei"],
                    doi="10.1000/abc",
                    year=2024,
                    venue="Plant Cell",
                    abstract="Drought reduces yield",
                    landing_url="https://example.org/paper",
                )
            ],
            source="openalex",
            attempts=[{"source": "openalex", "status": "ok: 1"}],
        )

    monkeypatch.setattr(dailypapers, "search", fake_search)
    monkeypatch.setattr(db, "query", lambda sql, params=(): [])
    monkeypatch.setattr(db, "execute", lambda sql, params=(): None)

    code = dailypapers.main(["--day", "2026-11-10", "--topic", "植物抗旱", "--owner", "u1"])
    assert code == 0
    assert calls == ["植物抗旱"]
    payload = json.loads(capsys.readouterr().out)
    assert payload["source"] == "openalex"
    assert payload["count"] == 1
    assert payload["day"] == "2026-11-10"
    assert payload["papers"][0]["title"] == "Maize drought response"

    async def failing_search(query: str, limit: int = 20, **kwargs: Any) -> SearchResult:
        return SearchResult(papers=[], source="none", attempts=[{"source": "openalex", "status": "error: Timeout"}])

    monkeypatch.setattr(dailypapers, "search", failing_search)
    code = dailypapers.main(["--day", "2026-11-10", "--topic", "植物抗旱", "--owner", "u1"])
    assert code == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["source"] == "none"
    assert payload["count"] == 0


# ------------------------------------------------------------------ HTTP 层


@pytest.fixture()
def api(fake_db: FakeDb) -> TestClient:
    main = importlib.import_module("app.main")
    return TestClient(main.app)


def _session_cookies(subject: str) -> dict[str, str]:
    token = jwt.encode(
        {"sub": subject, "email": f"{subject}@b.c", "name": subject, "roles": [], "exp": int(time.time()) + 3600},
        settings.session_secret,
        algorithm="HS256",
    )
    return {"labspace_session": token, settings.csrf_cookie: "csrf-token-for-test"}


def _csrf_headers() -> dict[str, str]:
    return {"X-CSRF-Token": "csrf-token-for-test", "Origin": settings.allowed_origins[0]}


def test_daily_papers_route_is_isolated_between_users(api: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """HTTP 层：u1 抓到的论文，u2 读不到。"""
    async def fake_search(query: str, limit: int = 20, **kwargs: Any) -> SearchResult:
        return SearchResult(
            papers=[
                Paper(
                    title="Maize drought response",
                    source="openalex",
                    authors=["Li Wei"],
                    doi="10.1000/abc",
                    year=2024,
                    venue="Plant Cell",
                    abstract="Drought reduces yield",
                    landing_url="https://example.org/paper",
                )
            ],
            source="openalex",
            attempts=[{"source": "openalex", "status": "ok: 1"}],
        )

    monkeypatch.setattr(dailypapers, "search", fake_search)

    refreshed = api.post(
        "/api/daily-papers/refresh",
        json={"day": "2026-11-10", "topic": "植物抗旱"},
        cookies=_session_cookies("u1"),
        headers=_csrf_headers(),
    )
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["count"] == 1

    mine = api.get("/api/daily-papers?day=2026-11-10", cookies=_session_cookies("u1"))
    assert mine.status_code == 200, mine.text
    assert mine.json()["total"] == 1
    assert mine.json()["papers"][0]["title"] == "Maize drought response"

    other = api.get("/api/daily-papers?day=2026-11-10", cookies=_session_cookies("u2"))
    assert other.status_code == 200, other.text
    assert other.json()["total"] == 0
    assert other.json()["papers"] == []


def test_daily_papers_refresh_requires_csrf(api: TestClient) -> None:
    """写操作必须带 CSRF 头，否则 403。"""
    resp = api.post(
        "/api/daily-papers/refresh",
        json={"topic": "植物抗旱"},
        cookies=_session_cookies("u1"),
    )
    assert resp.status_code == 403


def test_daily_papers_refresh_rejects_empty_topic(api: TestClient) -> None:
    resp = api.post(
        "/api/daily-papers/refresh",
        json={"topic": "  "},
        cookies=_session_cookies("u1"),
        headers=_csrf_headers(),
    )
    assert resp.status_code == 400


def test_daily_papers_route_requires_login(api: TestClient) -> None:
    assert api.get("/api/daily-papers?day=2026-11-10").status_code == 401


def test_search_papers_category_maps_papers_into_results(api: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """统一搜索的 papers 类别：条目与既有结果同构，并带来源标记。"""
    main = importlib.import_module("app.main")
    literature_sources = importlib.import_module("app.literature_sources")

    async def fake_go_search(q: str, categories: str, scope: str) -> dict[str, Any]:
        return {"query": q, "results": [{"title": "网页命中", "url": "https://x", "content": "c", "kind": "web"}], "count": 1}

    async def fake_lit_search(query: str, limit: int = 20, **kwargs: Any) -> SearchResult:
        return SearchResult(
            papers=[
                Paper(
                    title="Maize drought response",
                    source="openalex",
                    authors=["Li Wei"],
                    doi="10.1000/abc",
                    year=2024,
                    venue="Plant Cell",
                    abstract="Drought reduces yield",
                    landing_url="https://example.org/paper",
                )
            ],
            source="openalex",
            attempts=[{"source": "openalex", "status": "ok: 1"}],
        )

    monkeypatch.setattr(search_router_mod, "go_portal_search", fake_go_search)
    monkeypatch.setattr(literature_sources, "search", fake_lit_search)

    resp = api.get("/api/search?q=maize&categories=papers", cookies=_session_cookies("u1"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    papers = [item for item in body["results"] if item.get("kind") == "paper"]
    assert len(papers) == 1
    item = papers[0]
    assert item["title"] == "Maize drought response"
    assert item["url"] == "https://example.org/paper"
    assert item["snippet"] == "Drought reduces yield"
    assert item["content"] == "Drought reduces yield"
    assert item["category"] == "papers"
    assert item["source"] == "openalex"
    assert item["hitSource"] == "openalex"
    assert item["doi"] == "10.1000/abc"
    assert item["authors"] == ["Li Wei"]
    assert item["year"] == 2024
    assert item["venue"] == "Plant Cell"
    assert body["degraded"] == []


def test_search_papers_category_degrades_without_breaking_search(api: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """文献源全败：搜索不 500，该类别降级为空并给出 degraded。"""
    main = importlib.import_module("app.main")
    literature_sources = importlib.import_module("app.literature_sources")

    async def fake_go_search(q: str, categories: str, scope: str) -> dict[str, Any]:
        return {"query": q, "results": [{"title": "网页命中", "url": "https://x", "content": "c", "kind": "web"}], "count": 1}

    async def failing_lit_search(query: str, limit: int = 20, **kwargs: Any) -> SearchResult:
        return SearchResult(papers=[], source="none", attempts=[{"source": "openalex", "status": "error: Timeout"}])

    monkeypatch.setattr(search_router_mod, "go_portal_search", fake_go_search)
    monkeypatch.setattr(literature_sources, "search", failing_lit_search)

    resp = api.get("/api/search?q=maize&categories=papers", cookies=_session_cookies("u1"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["degraded"] == ["papers"]
    assert [item for item in body["results"] if item.get("kind") == "paper"] == []
    assert any(item.get("title") == "网页命中" for item in body["results"]), "其他类别的结果不应受影响"


def test_search_without_papers_category_is_unchanged(api: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """不点 papers 分类时，搜索结果里不应混进文献条目，degraded 为空。"""
    main = importlib.import_module("app.main")

    async def fake_go_search(q: str, categories: str, scope: str) -> dict[str, Any]:
        return {"query": q, "results": [{"title": "网页命中", "url": "https://x", "content": "c", "kind": "web"}], "count": 1}

    monkeypatch.setattr(search_router_mod, "go_portal_search", fake_go_search)

    resp = api.get("/api/search?q=maize&categories=general", cookies=_session_cookies("u1"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["degraded"] == []
    assert [item for item in body["results"] if item.get("kind") == "paper"] == []
