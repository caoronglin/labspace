"""文献数据源统一层：OpenAlex → Semantic Scholar → Crossref 三级降级 + arXiv。

为什么要这一层
--------------
「每日论文」和科研检索都需要同一组字段，但三个上游的返回结构完全不同：
OpenAlex 用 ``authorships``/``primary_location``，Semantic Scholar 用
``authors``/``venue``，Crossref 用 ``author``/``container-title``。如果每个
调用点各自解析，字段迟早会漂移成三套。

这里的约定
----------
* 只做**取数与归一**，不做排序策略、不落库（那是 dailypapers.py 的事）。
* 降级链是显式的：某一源失败或零结果，才试下一个；每次命中都记录来源，
  便于观测"今天的数据其实来自 Crossref"。
* 不做静默兜底：三个源全失败时返回空列表 + 失败原因，由调用方决定怎么提示。
  宁可页面写"今天没抓到文献"，也不拿上周的结果冒充今天的。
* 不伪造字段：拿不到 DOI 就留空，不在客户端拼一个。

HTTP 依赖只用 httpx（项目已有），不引入新包。
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

import httpx

OPENALEX_URL = "https://api.openalex.org/works"
S2_URL = "https://api.semanticscholar.org/graph/v1/paper/search"
CROSSREF_URL = "https://api.crossref.org/works"
ARXIV_URL = "https://export.arxiv.org/api/query"

DEFAULT_TIMEOUT = 20.0
MAX_ABSTRACT = 4000

# 上游普遍接受 mailto 参数以进入"礼貌池"（更少限流）。没有配置就不带。
USER_AGENT = "labspace-portal/1.0 (+https://labspace.local)"


@dataclass(slots=True)
class Paper:
    """归一后的文献条目。字段缺省一律留空，不用占位符冒充。"""

    title: str
    source: str
    authors: list[str] = field(default_factory=list)
    doi: str = ""
    year: int | None = None
    venue: str = ""
    abstract: str = ""
    citations: int | None = None
    landing_url: str = ""
    pdf_url: str = ""
    open_access: bool = False
    # 上游给出的相关度（OpenAlex relevance_score / Crossref score）；没有就留空。
    score: float | None = None
    external_ids: dict[str, str] = field(default_factory=dict)

    def key(self) -> str:
        """去重键：DOI 优先（归一化），否则标题+年份。"""
        if self.doi:
            return f"doi:{normalize_doi(self.doi)}"
        return f"title:{_title_key(self.title)}:{self.year or ''}"

    def as_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "source": self.source,
            "authors": self.authors,
            "doi": self.doi,
            "year": self.year,
            "venue": self.venue,
            "abstract": self.abstract,
            "citations": self.citations,
            "landingUrl": self.landing_url,
            "pdfUrl": self.pdf_url,
            "openAccess": self.open_access,
            "score": self.score,
            "externalIds": self.external_ids,
        }


@dataclass(slots=True)
class SearchResult:
    papers: list[Paper]
    source: str
    attempts: list[dict[str, str]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "papers": [p.as_dict() for p in self.papers],
            "attempts": self.attempts,
        }


# --------------------------------------------------------------- 归一化工具


_DOI_PREFIX = re.compile(r"^(?:https?://(?:dx\.)?doi\.org/|doi:)", re.I)


def normalize_doi(raw: str) -> str:
    """去掉 URL / doi: 前缀并小写；不做任何"猜测式"补全。"""
    value = (raw or "").strip()
    value = _DOI_PREFIX.sub("", value)
    return value.strip().lower()


def _title_key(title: str) -> str:
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", (title or "").lower())


def _clean(text: str, limit: int = MAX_ABSTRACT) -> str:
    """把 HTML 标签与多余空白压平：上游摘要里常带 <jats:p> 之类的标记。"""
    flat = re.sub(r"<[^>]+>", " ", text or "")
    flat = re.sub(r"\s+", " ", flat).strip()
    return flat[:limit]


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _float_or_none(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def dedupe(papers: Iterable[Paper]) -> list[Paper]:
    """按 key 去重，保留先出现的（即优先级更高的源）。"""
    seen: dict[str, Paper] = {}
    for paper in papers:
        if not paper.title:
            continue
        key = paper.key()
        if key in seen:
            # 用后到的条目补齐先到条目缺的字段（例如 S2 有 pdf、OpenAlex 没有）
            kept = seen[key]
            if not kept.abstract and paper.abstract:
                kept.abstract = paper.abstract
            if not kept.pdf_url and paper.pdf_url:
                kept.pdf_url = paper.pdf_url
            if kept.citations is None and paper.citations is not None:
                kept.citations = paper.citations
            if kept.score is None and paper.score is not None:
                kept.score = paper.score
            continue
        seen[key] = paper
    return list(seen.values())


# --------------------------------------------------------------- 各源解析


def _parse_openalex(payload: dict[str, Any], limit: int) -> list[Paper]:
    out: list[Paper] = []
    for work in (payload.get("results") or [])[:limit]:
        if work.get("type") in {"paratext", "peer-review"}:
            continue
        authors = [
            str((a.get("author") or {}).get("display_name") or "").strip()
            for a in (work.get("authorships") or [])
        ]
        primary = (work.get("primary_location") or {})
        source_info = primary.get("source") or {}
        open_access = work.get("open_access") or {}
        pdf_url = str(open_access.get("oa_url") or "")
        out.append(
            Paper(
                title=_clean(work.get("title") or work.get("display_name") or ""),
                source="openalex",
                authors=[a for a in authors if a],
                doi=normalize_doi(work.get("doi") or ""),
                year=_int_or_none(work.get("publication_year")),
                venue=_clean(source_info.get("display_name") or "", 200),
                abstract=_abstract_from_inverted(work.get("abstract_inverted_index")),
                citations=_int_or_none(work.get("cited_by_count")),
                landing_url=str(primary.get("landing_page_url") or work.get("id") or ""),
                pdf_url=pdf_url,
                open_access=bool(open_access.get("is_oa")),
                score=_float_or_none(work.get("relevance_score")),
                external_ids={"openalex": str(work.get("id") or "").rsplit("/", 1)[-1]},
            )
        )
    return out


def _abstract_from_inverted(index: Any) -> str:
    """OpenAlex 把摘要存成 {词: [位置...]}，按位置还原成句子。"""
    if not isinstance(index, dict) or not index:
        return ""
    positions: list[tuple[int, str]] = []
    for word, spots in index.items():
        for pos in spots or []:
            if isinstance(pos, int):
                positions.append((pos, str(word)))
    positions.sort(key=lambda item: item[0])
    return _clean(" ".join(word for _, word in positions))


def _parse_semantic_scholar(payload: dict[str, Any], limit: int) -> list[Paper]:
    out: list[Paper] = []
    for row in (payload.get("data") or [])[:limit]:
        ext = row.get("externalIds") or {}
        pdf = (row.get("openAccessPdf") or {}).get("url") or ""
        out.append(
            Paper(
                title=_clean(row.get("title") or ""),
                source="semanticscholar",
                authors=[str(a.get("name") or "").strip() for a in (row.get("authors") or []) if a.get("name")],
                doi=normalize_doi(ext.get("DOI") or ""),
                year=_int_or_none(row.get("year")),
                venue=_clean(row.get("venue") or "", 200),
                abstract=_clean(row.get("abstract") or ""),
                citations=_int_or_none(row.get("citationCount")),
                landing_url=f"https://www.semanticscholar.org/paper/{row.get('paperId')}" if row.get("paperId") else "",
                pdf_url=pdf,
                open_access=bool(pdf),
                external_ids={k: str(v) for k, v in ext.items() if v},
            )
        )
    return out


def _parse_crossref(payload: dict[str, Any], limit: int) -> list[Paper]:
    out: list[Paper] = []
    for row in ((payload.get("message") or {}).get("items") or [])[:limit]:
        title = _clean(" ".join(row.get("title") or []))
        if not title:
            continue
        authors: list[str] = []
        for a in row.get("author") or []:
            name = " ".join(part for part in [a.get("given"), a.get("family")] if part)
            if name.strip():
                authors.append(name.strip())
        issued = (row.get("issued") or {}).get("date-parts") or [[]]
        year = _int_or_none((issued[0] or [None])[0])
        year = year or _int_or_none((row.get("published-print") or {}).get("date-parts", [[None]])[0][0])
        venues = row.get("container-title") or []
        out.append(
            Paper(
                title=title,
                source="crossref",
                authors=authors,
                doi=normalize_doi(row.get("DOI") or ""),
                year=year,
                venue=_clean(" ".join(venues), 200),
                abstract=_clean(row.get("abstract") or ""),
                citations=_int_or_none(row.get("is-referenced-by-count")),
                landing_url=str(row.get("URL") or ""),
                pdf_url="",
                open_access=bool(row.get("license")),
                score=_float_or_none(row.get("score")),
                external_ids={"crossref": str(row.get("DOI") or "")},
            )
        )
    return out


_ATOM_ENTRY = re.compile(r"<entry>(.*?)</entry>", re.S)
_ATOM_TAG = {
    "title": re.compile(r"<title>(.*?)</title>", re.S),
    "summary": re.compile(r"<summary>(.*?)</summary>", re.S),
    "id": re.compile(r"<id>(.*?)</id>", re.S),
    "published": re.compile(r"<published>(.*?)</published>", re.S),
    "author": re.compile(r"<name>(.*?)</name>", re.S),
    "pdf": re.compile(r'<link[^>]*title="pdf"[^>]*href="([^"]+)"', re.S),
    "doi": re.compile(r'<arxiv:doi[^>]*>(.*?)</arxiv:doi>', re.S),
}


def _atom_field(chunk: str, name: str) -> str:
    """取一个 Atom 字段；把 chunk 作为参数而不是闭包变量，避免绑定循环变量。"""
    match = _ATOM_TAG[name].search(chunk)
    return _clean(match.group(1)) if match else ""


def _parse_arxiv(xml: str, limit: int) -> list[Paper]:
    """arXiv 只提供 Atom；用正则会比引入 feedparser 更省依赖，字段也够用。"""
    out: list[Paper] = []
    for chunk in _ATOM_ENTRY.findall(xml)[:limit]:
        # 直接传参而不是闭包捕获 chunk：闭包会绑定循环变量
        # （此处虽按顺序立即调用、等价，但改代码时极易踩坑）。
        def grab(name: str, src: str = chunk) -> str:
            return _atom_field(src, name)

        title = grab("title")
        if not title:
            continue
        published = grab("published")
        authors = [_clean(n) for n in _ATOM_TAG["author"].findall(chunk) if _clean(n)]
        out.append(
            Paper(
                title=title,
                source="arxiv",
                authors=authors,
                doi=normalize_doi(grab("doi")),
                year=_int_or_none(published[:4]) if published else None,
                venue="arXiv",
                abstract=grab("summary"),
                landing_url=grab("id"),
                pdf_url=grab("pdf"),
                open_access=True,
                external_ids={"arxiv": grab("id").rsplit("/", 1)[-1]},
            )
        )
    return out


# --------------------------------------------------------------- 取数


async def _get(client: httpx.AsyncClient, url: str, params: dict[str, Any]) -> dict[str, Any]:
    resp = await client.get(url, params=params, headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()
    return resp.json()


async def search_openalex(client: httpx.AsyncClient, query: str, limit: int) -> list[Paper]:
    data = await _get(
        client,
        OPENALEX_URL,
        {
            "search": query,
            "per-page": max(1, min(limit, 50)),
            "sort": "relevance_score:desc",
            "mailto": "labspace@local",
        },
    )
    return _parse_openalex(data, limit)


async def search_semantic_scholar(client: httpx.AsyncClient, query: str, limit: int) -> list[Paper]:
    data = await _get(
        client,
        S2_URL,
        {
            "query": query,
            "limit": max(1, min(limit, 50)),
            "fields": "title,abstract,year,venue,authors,externalIds,citationCount,openAccessPdf",
        },
    )
    return _parse_semantic_scholar(data, limit)


async def search_crossref(client: httpx.AsyncClient, query: str, limit: int) -> list[Paper]:
    data = await _get(
        client,
        CROSSREF_URL,
        {"query": query, "rows": max(1, min(limit, 50)), "select": "DOI,title,author,issued,container-title,abstract,is-referenced-by-count,URL,license"},
    )
    return _parse_crossref(data, limit)


async def search_arxiv(client: httpx.AsyncClient, query: str, limit: int) -> list[Paper]:
    resp = await client.get(
        ARXIV_URL,
        params={"search_query": f"all:{query}", "start": 0, "max_results": max(1, min(limit, 50))},
        headers={"User-Agent": USER_AGENT},
    )
    resp.raise_for_status()
    return _parse_arxiv(resp.text, limit)


async def search(
    query: str,
    limit: int = 20,
    *,
    client: httpx.AsyncClient | None = None,
    timeout: float = DEFAULT_TIMEOUT,
    include_arxiv: bool = True,
) -> SearchResult:
    """按 OpenAlex → S2 → Crossref 顺序降级；每个源的成败都记进 attempts。

    调用方拿到 ``result.source`` 就知道这批数据到底出自哪个源；若为 ``"none"``，
    说明三个源都失败或都是零结果，此时不该在任何地方展示成"今日论文"。
    """
    query = (query or "").strip()
    if not query:
        return SearchResult(papers=[], source="none", attempts=[{"source": "-", "status": "empty query"}])

    owned = client is None
    client = client or httpx.AsyncClient(timeout=timeout, follow_redirects=True)
    attempts: list[dict[str, str]] = []
    papers: list[Paper] = []
    hit = "none"
    try:
        for name, fn in (
            ("openalex", search_openalex),
            ("semanticscholar", search_semantic_scholar),
            ("crossref", search_crossref),
        ):
            try:
                found = await fn(client, query, limit)
            except Exception as exc:  # noqa: BLE001 - 降级链要吞掉单源异常
                attempts.append({"source": name, "status": f"error: {type(exc).__name__}"})
                continue
            if found:
                papers = found
                hit = name
                attempts.append({"source": name, "status": f"ok: {len(found)}"})
                break
            attempts.append({"source": name, "status": "empty"})

        if include_arxiv:
            try:
                extra = await search_arxiv(client, query, max(5, limit // 2))
                if extra:
                    attempts.append({"source": "arxiv", "status": f"ok: {len(extra)}"})
                    if not papers:
                        # 三个主源都没命中，只有 arXiv 有结果：实际命中源就是 arxiv，
                        # 否则 source 会谎报 "none"（"none" 应当只表示全败）。
                        hit = "arxiv"
                    papers = papers + extra
                else:
                    attempts.append({"source": "arxiv", "status": "empty"})
            except Exception as exc:  # noqa: BLE001
                attempts.append({"source": "arxiv", "status": f"error: {type(exc).__name__}"})
    finally:
        if owned:
            await client.aclose()

    return SearchResult(papers=dedupe(papers)[:limit], source=hit, attempts=attempts)


def search_sync(query: str, limit: int = 20) -> SearchResult:
    """给同步调用点（CLI / 定时任务）用的薄包装。"""
    return asyncio.run(search(query, limit))
