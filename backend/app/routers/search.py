"""search 路由（由 ops/split_main_module.py 从 main.py 搬出）。"""
from __future__ import annotations

import logging
from typing import Any

import httpx
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
)

from .. import (
    corpus as corpus_mod,
)
from .. import (
    knowledge as knowledge_mod,
)
from .. import (
    literature_sources as literature_mod,
)
from .. import (
    semantic as semantic_mod,
)
from ..catalog import adapt_host
from ..databases import search_databases
from ..golink import corpus_query as go_corpus_query
from ..golink import corpus_suggest as go_corpus_suggest
from ..golink import portal_search as go_portal_search
from ..golink import search_categories as go_search_categories
from ..routers.deps import (
    client_host as _client_host,
)
from ..searchconfig import SEARCH_CATEGORIES as _SEARCH_CATEGORIES
from ..searchconfig import normalize_category
from ..security import (
    require_user,
    require_user_or_service,
)

log = logging.getLogger("labspace.routers.search")

router = APIRouter()


# ------------------------------------------------------------------ 检索 / 文献代理

# 门户对外暴露的检索分类与别名统一放在 app/searchconfig.py，
# 与 Go 核心（LabGo）共用同一份数据，避免两端分类名漂移。
SEARCH_CATEGORIES: list[dict[str, str]] = _SEARCH_CATEGORIES

# 「论文」类别：与 SearXNG 的 "scientific publications" 并列，走文献源
# （OpenAlex → Semantic Scholar → Crossref 降级 + arXiv）。
# 分类名必须在 normalize_category 之前判断，因为 "papers" 会被别名表映射成
# "scientific publications"，映射后就分不出是不是用户要了文献源。
# 前端分类切换器用的是 searchconfig.py 里的「论文」键（scientific publications），
# 与 Go 侧共用；这里把它一并视为文献类别，避免"界面有论文、后端不认"的漂移。
LITERATURE_CATEGORY_TOKENS = {"papers", "literature", "scientific publications"}
LITERATURE_RESULT_LIMIT = 20

async def _search_literature(q: str, limit: int = LITERATURE_RESULT_LIMIT) -> tuple[list[dict[str, Any]], list[str]]:
    """统一搜索的「论文」类别。

    文献源失败只降级该类别（返回空条目 + degraded 标记），绝不让整个搜索 500。
    返回 (条目列表, 降级类别列表)。
    """
    try:
        result = await literature_mod.search(q, limit)
    except Exception as exc:  # noqa: BLE001 - 文献源挂掉不能拖垮整个搜索
        log.warning("文献源检索失败：%s", exc)
        return [], ["papers"]
    if not result.papers or result.source == "none":
        log.info("文献源未命中：%s", result.attempts)
        return [], ["papers"]
    items: list[dict[str, Any]] = []
    for paper in result.papers:
        snippet = (paper.abstract or "")[:500]
        items.append(
            {
                "title": paper.title,
                "url": paper.landing_url,
                "content": snippet,
                "snippet": snippet,
                "engine": "literature",
                "category": "papers",
                "kind": "paper",
                # 来源标记：前端据此区分 OpenAlex / Semantic Scholar / Crossref / arXiv
                "source": paper.source,
                "hitSource": paper.source,
                "doi": paper.doi,
                "authors": list(paper.authors),
                "year": paper.year,
                "venue": paper.venue,
                "citations": paper.citations,
                "pdfUrl": paper.pdf_url,
            }
        )
    return items, []

async def _rerank_local(query: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """本地命中统一交给 bge-reranker 定序；联网结果保持原序并排在后面。

    重排只影响顺序，不增删条目；模型不可用时 semantic.reorder 原样返回，
    条目上带 fusion=keyword，前端可据此展示匹配方式。
    """
    local = [item for item in items if item.get("kind") == "local"]
    if len(local) < 2:
        return items
    try:
        ordered = await semantic_mod.reorder(
            query,
            local,
            lambda item: f"{item.get('title') or ''}\n{item.get('content') or ''}",
            timeout=5.0,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("本地检索重排不可用：%s", exc)
        return items
    others = [item for item in items if item.get("kind") != "local"]
    return ordered + others

@router.get("/api/search/categories")
@router.get("/v1/portal/search/categories")
async def api_search_categories(_: dict = Depends(require_user_or_service)) -> dict[str, Any]:
    """检索分类清单，前端据此渲染分类切换，避免前后端分类名漂移。"""
    data = await go_search_categories()
    if data:
        return data
    return {"categories": SEARCH_CATEGORIES, "default": "general"}

@router.get("/api/search")
@router.get("/v1/portal/search")
async def api_search(
    request: Request,
    q: str = Query(..., min_length=1, max_length=200),
    categories: str = Query("general"),
    scope: str = Query("web"),
    user: dict = Depends(require_user_or_service),
) -> dict[str, Any]:
    """统一搜索。

    scope=web      仅联网结果（SearXNG 聚合）
    scope=local    仅本地语料（服务 / 数据库 / 命令 / 工具 / 页面）
    scope=all      两者合并（本地命中置顶）

    categories 透传给 SearXNG：general / science / scientific publications / images / videos / it / news / books
    papers / literature 额外走文献源（OpenAlex / S2 / Crossref / arXiv）
    """
    # 先记下原始分类名：normalize_category 会把 "papers" 映射成
    # "scientific publications"，映射后就没法判断用户是否点名了文献源。
    raw_categories = [c.strip().lower() for c in (categories or "").split(",") if c.strip()]
    wants_papers = any(c in LITERATURE_CATEGORY_TOKENS for c in raw_categories)
    categories = normalize_category(categories)
    scope = (scope or "web").lower()

    # 文献源是联网类别：scope=local（只看本地语料）时不混入。
    paper_items: list[dict[str, Any]] = []
    degraded: list[str] = []
    if wants_papers and scope in ("web", "all"):
        paper_items, degraded = await _search_literature(q)

    # 知识条目是按人可见的，只能在 Python 侧用调用者会话现查，不能进 Go 核心的全局语料索引。
    knowledge_hits: list[dict[str, Any]] = []
    if scope in ("local", "all") and not user.get("is_service"):
        try:
            knowledge_hits = await knowledge_mod.search_hits(q, user, limit=8)
        except Exception as exc:  # noqa: BLE001 - 联动失败不能拖垮搜索
            log.warning("知识库检索联动失败：%s", exc)

    # Go 核心（LabGo）已经接管统一搜索：本地语料 + SearXNG 联网结果。
    # 只有在 Go 核心不可达时才回退到本模块的实现。
    go_result = await go_portal_search(q, categories, scope)
    if go_result is not None:
        if knowledge_hits:
            merged = knowledge_hits + list(go_result.get("results") or [])
            go_result["results"] = merged
            try:
                local_total = int(go_result.get("localTotal") or 0)
            except (TypeError, ValueError):
                # Go 核心返回了非数字：当作 0，不能让整个搜索因它 500。
                local_total = 0
            go_result["localTotal"] = local_total + len(knowledge_hits)
            go_result["count"] = len(merged)
        go_result["results"] = await _rerank_local(q, list(go_result.get("results") or []))
        if paper_items:
            go_result["results"] = list(go_result["results"]) + paper_items
            go_result["count"] = len(go_result["results"])
        go_result["degraded"] = degraded
        return go_result

    web_results: list[dict[str, Any]] = []
    engines: list[str] | None = None
    web_error: str | None = None

    if scope in ("web", "all"):
        try:
            async with httpx.AsyncClient(timeout=45) as client:
                resp = await client.get(
                    # 容器内用服务名访问 SearXNG（127.0.0.1 指向容器自身）
                    "http://lab-searxng:8080/search",
                    params={"q": q, "format": "json", "categories": categories},
                )
                resp.raise_for_status()
                data = resp.json()
            engines = data.get("engines")
            web_results = [
                {
                    "title": r.get("title"),
                    "url": r.get("url"),
                    "content": (r.get("content") or "")[:500],
                    "engine": r.get("engine"),
                    "category": r.get("category"),
                    "kind": "web",
                }
                for r in (data.get("results") or [])[:20]
            ]
        except Exception as exc:
            web_error = f"检索服务暂时不可用（{type(exc).__name__}）"
            if scope == "web":
                raise HTTPException(status_code=502, detail=web_error) from exc

    # 本地统一语料命中（engine=d509），覆盖服务/数据库/命令/工具/页面
    # 统一搜索使用更多条目：本地命中上限从 12 提升到 30
    local_hits = corpus_mod.search_corpus(q, limit=30) if scope in ("local", "all") else []
    local_results = [
        {
            "title": hit["title"] if hit["type"] != "database" else f"{hit['title']} · {hit['subtitle']}".strip(" ·"),
            "url": adapt_host(hit["url"], _client_host(request)),
            "content": hit["description"] or hit["subtitle"],
            "engine": "d509",
            "category": hit["type"],
            "kind": "local",
            "path": hit["path"],
        }
        for hit in local_hits
    ]
    local_results = await _rerank_local(q, knowledge_hits + local_results)

    results = local_results + web_results if scope == "all" else (local_results if scope == "local" else web_results)
    if paper_items:
        results = results + paper_items

    # 兼容旧字段：local 仍返回植物数据库命中
    local_dbs = search_databases(q)
    return {
        "query": q,
        "categories": categories,
        "scope": scope,
        "count": len(results),
        "results": results,
        "engines": engines,
        "error": web_error,
        # 降级的检索类别（如文献源挂掉时的 "papers"），前端可提示“该分类暂不可用”
        "degraded": degraded,
        "local": [
            {"id": d["id"], "name": d["name"], "cn": d.get("cn", ""), "url": d["url"], "category": d["category"]}
            for d in local_dbs[:16]
        ],
        "hot": corpus_mod.hot_keywords(),
    }

@router.get("/api/search/suggest")
@router.get("/v1/corpus/suggest")
async def api_search_suggest(
    request: Request,
    q: str = Query("", max_length=100),
    limit: int = Query(10, ge=1, le=20),
    _: dict = Depends(require_user),
) -> dict[str, Any]:
    """搜索建议（输入框联想）。"""
    data = await go_corpus_suggest(q, limit=limit)
    if data:
        return {
            "suggestions": adapt_host(data.get("suggestions") or [], _client_host(request)),
            "hot": data.get("hot") or [],
        }
    return {
        "suggestions": adapt_host(corpus_mod.suggest(q, limit=limit), _client_host(request)),
        "hot": corpus_mod.hot_keywords(),
    }

@router.get("/api/corpus")
@router.get("/v1/corpus")
async def api_corpus(
    request: Request,
    q: str = Query("", max_length=100),
    limit: int = Query(30, ge=1, le=100),
    _: dict = Depends(require_user),
) -> dict[str, Any]:
    """统一语料查询（命令面板 / 全局直达）。"""
    kw = q.strip()
    data = await go_corpus_query(kw, limit)
    if data is not None:
        items = adapt_host(data.get("items") or [], _client_host(request))
        return {"query": data.get("query", kw), "count": len(items), "items": items}
    if not kw:
        # 空查询：按类型配额均衡展示，避免某一类把面板洗掉
        buckets: dict[str, list[dict[str, Any]]] = {}
        for e in corpus_mod.corpus():
            cap = corpus_mod.TYPE_CAPS.get(e.type, 4)
            arr = buckets.setdefault(e.type, [])
            if len(arr) < cap:
                arr.append(
                    {
                        "type": e.type,
                        "id": e.id,
                        "title": e.title,
                        "subtitle": e.subtitle,
                        "path": e.path,
                        "url": e.url,
                    }
                )
        order = ["page", "service", "tool", "snapotter", "database", "command"]
        items: list[dict[str, Any]] = []
        for t in order:
            items.extend(buckets.get(t, []))
        items = adapt_host(items[:limit], _client_host(request))
        return {"query": "", "count": len(items), "items": items}
    items = adapt_host(corpus_mod.search_corpus(kw, limit=limit), _client_host(request))
    return {"query": kw, "count": len(items), "items": items}

@router.get("/api/literature")
async def api_literature(
    q: str = Query(..., min_length=1, max_length=200),
    source: str = Query("pubmed"),
    _: dict = Depends(require_user),
) -> dict[str, Any]:
    """代理科研检索 API（PubMed / Europe PMC / Crossref / UniProt / NCBI Gene）。"""
    # q 必须做 URL 编码：直接 f-string 拼接会让 & / # / 空格等字符篡改上游
    # 查询串（例如 q="x&rows=999" 或注入额外参数）。改用 params 由 httpx 编码。
    sources = {
        "pubmed": ("/tools/pubmed/search", {"query": q, "retmax": 8}),
        "europepmc": ("/tools/europepmc/search", {"query": q, "page_size": 8}),
        "crossref": ("/tools/crossref/search", {"query": q, "rows": 8}),
        "uniprot": ("/tools/uniprot/search", {"query": q, "size": 8}),
        "gene": ("/tools/ncbi/gene", {"query": q, "retmax": 8}),
    }
    if source not in sources:
        raise HTTPException(status_code=400, detail="不支持的检索源")
    path, params = sources[source]
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get("http://lab-research-api:8000" + path, params=params)
            resp.raise_for_status()
            return resp.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"文献服务不可用: {type(exc).__name__}") from exc
