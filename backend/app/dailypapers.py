"""每日论文聚合：抓取 → 落库 → 按人按天读取。

边界
----
* 本模块只管「数据」，不注册路由；路由在 ``app/main.py`` 里挂载。
* 文献抓取复用 ``literature_sources.search``（OpenAlex → S2 → Crossref 降级 + arXiv），
  这里不重复实现降级链。

三条硬规矩
----------
1. **不伪造数据**：所有源都失败时返回 ``source="none"``、``count=0``，
   并在 ``attempts`` 里写明每个源的失败原因；库里也不会留下半截条目。
2. **不重复抓取**：同一 ``(day, owner, topic)`` 已有数据时直接读库返回，
   不再打上游（``cached=True``）。
3. **按人隔离**：所有读写都带 ``owner`` 条件，跨用户互不可见。

CLI
---
    python -m app.dailypapers --day 2026-11-10 --topic "植物抗旱" --owner alice

退出码：0 表示抓到数据，1 表示全源失败（便于以后挂 systemd timer 判成败）。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
from datetime import date
from typing import Any

import httpx

from . import db
from .literature_sources import Paper, search

log = logging.getLogger("labspace.dailypapers")

DEFAULT_LIMIT = 20
MAX_LIMIT = 100
MAX_PAGE_SIZE = 100
SNIPPET_LEN = 300

_SELECT_SQL = (
    "SELECT doi, title, authors, venue, year, abstract, url, pdf_url, citations, source, score"
    " FROM labspace.daily_papers"
)
_INSERT_SQL = (
    "INSERT INTO labspace.daily_papers"
    " (day, owner, topic, doi, title, authors, venue, year, abstract, url, pdf_url,"
    " citations, source, score)"
    " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)"
    " ON CONFLICT (day, owner, topic, doi, title) DO UPDATE SET"
    "   authors=EXCLUDED.authors, venue=EXCLUDED.venue, year=EXCLUDED.year,"
    "   abstract=EXCLUDED.abstract, url=EXCLUDED.url, pdf_url=EXCLUDED.pdf_url,"
    "   citations=EXCLUDED.citations, source=EXCLUDED.source, score=EXCLUDED.score"
)


# --------------------------------------------------------------- 数据库访问



def _as_int(value: object, default: int = 0, lo: int | None = None, hi: int | None = None) -> int:
    """安全取整数：脏数据（None/文本/负数）一律回落到默认值并夹在区间内。

    这个文件里的 limit / 计数既可能来自请求参数，也可能来自数据库里被手工改过的行；
    裸 int() 会让一个手改的 URL 或一行脏数据把整个接口打成 500。
    """
    try:
        out = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        out = default
    if lo is not None and out < lo:
        out = lo
    if hi is not None and out > hi:
        out = hi
    return out


async def _aq(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    """异步读库（线程池里跑同步 psycopg2）。"""
    return await asyncio.to_thread(db.query, sql, params)


async def _ax(sql: str, params: tuple = ()) -> None:
    """异步写库。"""
    await asyncio.to_thread(db.execute, sql, params)


# --------------------------------------------------------------- 数据转换


def _authors_out(raw: Any) -> list[str]:
    return [a for a in str(raw or "").split(", ") if a]


def _row_out(row: dict[str, Any]) -> dict[str, Any]:
    """库里的一行 → 对外条目（字段名与接口文档一致）。"""
    abstract = str(row.get("abstract") or "")
    return {
        "title": str(row.get("title") or ""),
        "doi": str(row.get("doi") or ""),
        "authors": _authors_out(row.get("authors")),
        "venue": str(row.get("venue") or ""),
        "year": row.get("year"),
        "abstract": abstract,
        "snippet": abstract[:SNIPPET_LEN],
        "url": str(row.get("url") or ""),
        "pdfUrl": str(row.get("pdf_url") or ""),
        "citations": row.get("citations"),
        "source": str(row.get("source") or ""),
        "score": row.get("score"),
    }


def _paper_out(paper: Paper) -> dict[str, Any]:
    """刚抓到的 Paper → 对外条目（与 _row_out 同构）。"""
    return {
        "title": paper.title,
        "doi": paper.doi,
        "authors": list(paper.authors),
        "venue": paper.venue,
        "year": paper.year,
        "abstract": paper.abstract,
        "snippet": paper.abstract[:SNIPPET_LEN],
        "url": paper.landing_url,
        "pdfUrl": paper.pdf_url,
        "citations": paper.citations,
        "source": paper.source,
        "score": paper.score,
    }


def _paper_row(owner: str, topic: str, day: date, paper: Paper) -> tuple:
    return (
        day,
        owner,
        topic,
        paper.doi or "",
        paper.title,
        ", ".join(paper.authors),
        paper.venue or "",
        paper.year,
        paper.abstract or "",
        paper.landing_url or "",
        paper.pdf_url or "",
        paper.citations,
        paper.source or "",
        paper.score,
    )


def _sources_label(papers: list[dict[str, Any]]) -> str:
    """一批条目的来源标签：单一来源直接给名字，混合来源给 "mixed"。"""
    found = sorted({p.get("source") or "" for p in papers if p.get("source")})
    if not found:
        return "none"
    if len(found) == 1:
        return found[0]
    return "mixed"


# --------------------------------------------------------------- 读写


async def _load_day(owner: str, day: date, topic: str) -> list[dict[str, Any]]:
    """读取某个 (day, owner, topic) 已落库的条目。"""
    return await _aq(
        _SELECT_SQL
        + " WHERE day=%s AND owner=%s AND topic=%s"
        + " ORDER BY score DESC NULLS LAST, created_at, title",
        (day, owner, topic),
    )


async def _count_day(owner: str, day: date, topic: str) -> int:
    sql = "SELECT count(*) AS n FROM labspace.daily_papers WHERE day=%s AND owner=%s"
    params: tuple = (day, owner)
    if topic:
        sql += " AND topic=%s"
        params = (day, owner, topic)
    rows = await _aq(sql, params)
    return _as_int(rows[0].get("n")) if rows and rows[0].get("n") is not None else 0


async def _store_day(owner: str, day: date, topic: str, papers: list[Paper]) -> int:
    """把抓到的条目 upsert 进库（同一 (day, owner, topic, doi, title) 覆盖更新）。"""
    written = 0
    for paper in papers:
        if not paper.title:
            continue
        await _ax(_INSERT_SQL, _paper_row(owner, topic, day, paper))
        written += 1
    return written


# --------------------------------------------------------------- 服务函数


async def build_daily(
    owner: str,
    topic: str,
    day: date,
    limit: int = DEFAULT_LIMIT,
    *,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """抓取某天某主题的论文并落库。

    已有数据时直接读库返回（``cached=True``），不重复抓取。
    全源失败时返回 ``source="none"``、``count=0``，失败原因写在 ``attempts`` 里。

    ``client`` 只为测试（注入 MockTransport）保留；线上留空走默认客户端。
    """
    owner = (owner or "").strip()
    topic = (topic or "").strip()
    limit = _as_int(limit, DEFAULT_LIMIT, lo=1, hi=MAX_LIMIT)
    if not owner:
        raise ValueError("owner 不能为空")
    if not topic:
        return {
            "day": day.isoformat(),
            "topic": topic,
            "source": "none",
            "count": 0,
            "papers": [],
            "attempts": [{"source": "-", "status": "empty topic"}],
            "cached": False,
        }

    cached_rows = await _load_day(owner, day, topic)
    if cached_rows:
        papers = [_row_out(row) for row in cached_rows]
        return {
            "day": day.isoformat(),
            "topic": topic,
            "source": _sources_label(papers),
            "count": len(papers),
            "papers": papers,
            "attempts": [{"source": "cache", "status": f"ok: {len(papers)}"}],
            "cached": True,
        }

    result = await search(topic, limit, client=client)
    if not result.papers:
        # 全源失败：如实回报失败原因，一条都不写进库。
        attempts = result.attempts or [{"source": "-", "status": "no results"}]
        return {
            "day": day.isoformat(),
            "topic": topic,
            "source": "none",
            "count": 0,
            "papers": [],
            "attempts": attempts,
            "cached": False,
        }

    stored = await _store_day(owner, day, topic, result.papers)
    if stored != len(result.papers):
        log.warning("写入条数与抓取条数不一致：%s != %s", stored, len(result.papers))
    papers = [_paper_out(paper) for paper in result.papers]
    return {
        "day": day.isoformat(),
        "topic": topic,
        "source": result.source,
        "count": len(papers),
        "papers": papers,
        "attempts": result.attempts,
        "cached": False,
    }


async def list_daily(
    owner: str,
    day: date,
    topic: str = "",
    page: int = 1,
    page_size: int = DEFAULT_LIMIT,
) -> dict[str, Any]:
    """按人读取某天的论文；``topic`` 为空时返回当天全部主题。"""
    owner = (owner or "").strip()
    if not owner:
        raise ValueError("owner 不能为空")
    topic = (topic or "").strip()
    page = _as_int(page, 1, lo=1)
    page_size = _as_int(page_size, DEFAULT_LIMIT, lo=1, hi=MAX_PAGE_SIZE)
    offset = (page - 1) * page_size

    total = await _count_day(owner, day, topic)
    sql = _SELECT_SQL + " WHERE day=%s AND owner=%s"
    params: tuple = (day, owner)
    if topic:
        sql += " AND topic=%s"
        params = (day, owner, topic)
    sql += " ORDER BY score DESC NULLS LAST, created_at, title LIMIT %s OFFSET %s"
    rows = await _aq(sql, (*params, page_size, offset))

    papers = [_row_out(row) for row in rows]
    return {
        "day": day.isoformat(),
        "topic": topic,
        "source": _sources_label(papers),
        "sources": sorted({p["source"] for p in papers if p["source"]}),
        "count": len(papers),
        "total": total,
        "page": page,
        "pageSize": page_size,
        "papers": papers,
    }


# --------------------------------------------------------------- CLI


def _day_arg(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"--day 需要 YYYY-MM-DD 格式：{value}") from exc


def main(argv: list[str] | None = None) -> int:
    """CLI 入口：抓取并落库某一天的论文，打印 JSON 摘要。"""
    parser = argparse.ArgumentParser(
        prog="python -m app.dailypapers",
        description="抓取并落库某一天的论文（按人 + 主题）",
    )
    parser.add_argument("--day", type=_day_arg, default=date.today(), help="YYYY-MM-DD，默认今天")
    parser.add_argument("--topic", required=True, help="检索主题，例如 植物抗旱")
    parser.add_argument("--owner", required=True, help="账号（决定数据归属与可见范围）")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help=f"抓取条数，默认 {DEFAULT_LIMIT}")
    args = parser.parse_args(argv)

    result = asyncio.run(build_daily(args.owner, args.topic, args.day, args.limit))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("source") != "none" else 1


if __name__ == "__main__":
    raise SystemExit(main())


# ------------------------------------------------------------------ 自主订阅

async def list_subs(owner: str) -> list[dict[str, Any]]:
    """某人的每日论文订阅。"""
    rows = await _aq(
        "SELECT topic, limit_n, enabled, created_at, updated_at, last_run, "
        "last_count, last_error FROM labspace.daily_paper_subs "
        "WHERE owner=%s ORDER BY created_at",
        (owner,),
    )
    return [
        {
            "topic": str(r.get("topic") or ""),
            "limit": _as_int(r.get("limit_n"), 10, lo=1, hi=50),
            "enabled": bool(r.get("enabled")),
            "createdAt": str(r.get("created_at") or ""),
            "updatedAt": str(r.get("updated_at") or ""),
            "lastRun": str(r.get("last_run") or ""),
            "lastCount": _as_int(r.get("last_count")),
            "lastError": str(r.get("last_error") or ""),
        }
        for r in rows
    ]


async def upsert_sub(owner: str, topic: str, limit: int, enabled: bool) -> dict[str, Any]:
    """新增/修改一条订阅（同一 owner+topic 只有一条）。"""
    await _ax(
        "INSERT INTO labspace.daily_paper_subs (owner, topic, limit_n, enabled) "
        "VALUES (%s,%s,%s,%s) "
        "ON CONFLICT (owner, topic) DO UPDATE SET limit_n=EXCLUDED.limit_n, "
        "enabled=EXCLUDED.enabled, updated_at=now()",
        (owner, topic, limit, enabled),
    )
    return {"topic": topic, "limit": limit, "enabled": enabled}


async def delete_sub(owner: str, topic: str) -> None:
    await _ax(
        "DELETE FROM labspace.daily_paper_subs WHERE owner=%s AND topic=%s",
        (owner, topic),
    )


async def run_subs(owner: str | None = None) -> dict[str, Any]:
    """跑一遍订阅（每日维护调用；也可由用户点「立即抓取」触发）。

    owner 为空表示所有订阅者。逐条独立处理：一条失败不影响其它条，
    失败原因记在 last_error，界面上能直接看到是哪条出的问题。
    """
    where = "WHERE enabled" if owner is None else "WHERE enabled AND owner=%s"
    params: tuple = () if owner is None else (owner,)
    subs = await _aq(
        f"SELECT owner, topic, limit_n FROM labspace.daily_paper_subs {where}",  # noqa: S608
        params,
    )
    done = 0
    failed = 0
    today = date.today()
    for sub in subs:
        sub_owner = str(sub.get("owner") or "")
        topic = str(sub.get("topic") or "")
        limit = _as_int(sub.get("limit_n"), 10, lo=1, hi=50)
        try:
            result = await build_daily(sub_owner, topic, today, limit)
            count = _as_int(result.get("count"))
            await _ax(
                "UPDATE labspace.daily_paper_subs SET last_run=now(), last_count=%s, "
                "last_error='' WHERE owner=%s AND topic=%s",
                (count, sub_owner, topic),
            )
            done += 1
        except Exception as exc:  # noqa: BLE001 - 单条失败不能中断整批
            failed += 1
            await _ax(
                "UPDATE labspace.daily_paper_subs SET last_run=now(), "
                "last_error=%s WHERE owner=%s AND topic=%s",
                (f"{type(exc).__name__}: {exc}"[:300], sub_owner, topic),
            )
    return {"ok": failed == 0, "total": len(subs), "done": done, "failed": failed}
