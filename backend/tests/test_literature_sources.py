"""文献源统一层：降级顺序、字段归一、arXiv 解析、去重。

全部走 httpx.MockTransport，不连外网 —— 但断言的是**真实的解析函数**，
不是"给什么返回什么"的空壳：每个 mock 响应都是对应上游的真实字段结构裁剪版。
"""
from __future__ import annotations

import httpx
import pytest

from app import literature_sources as ls


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


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

S2_OK = {
    "data": [
        {
            "title": "Rice salt tolerance",
            "year": 2023,
            "venue": "Nature Plants",
            "paperId": "abc123",
            "externalIds": {"DOI": "10.2000/XYZ"},
            "citationCount": 7,
            "openAccessPdf": {"url": "https://example.org/rice.pdf"},
            "authors": [{"name": "Zhang San"}],
        }
    ]
}

CROSSREF_OK = {
    "message": {
        "items": [
            {
                "title": ["Wheat heat shock"],
                "DOI": "10.3000/QWE",
                "author": [{"given": "Wang", "family": "Wu"}],
                "issued": {"date-parts": [[2022, 5]]},
                "container-title": ["Plant Journal"],
                "is-referenced-by-count": 3,
                "URL": "https://doi.org/10.3000/qwe",
                "license": [{"URL": "https://creativecommons.org/licenses/by/4.0/"}],
            }
        ]
    }
}

ARXIV_XML = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <title>Deep learning for plant phenotyping</title>
    <summary>A survey of  methods.</summary>
    <published>2024-01-02T00:00:00Z</published>
    <author><name>Ada Lovelace</name></author>
    <link title="pdf" href="http://arxiv.org/pdf/2401.00001v1"/>
  </entry>
</feed>
"""


def test_normalize_doi_strips_prefix_and_lowercases():
    assert ls.normalize_doi("https://doi.org/10.1000/ABC") == "10.1000/abc"
    assert ls.normalize_doi("doi:10.1/X") == "10.1/x"
    assert ls.normalize_doi("  10.5/Y  ") == "10.5/y"
    assert ls.normalize_doi("") == ""


def test_openalex_inverted_abstract_is_reconstructed_in_order():
    papers = ls._parse_openalex(OPENALEX_OK, 5)
    assert len(papers) == 1
    paper = papers[0]
    assert paper.abstract == "Drought reduces yield"
    assert paper.doi == "10.1000/abc"
    assert paper.open_access is True
    assert paper.pdf_url.endswith("paper.pdf")
    assert paper.authors == ["Li Wei"]


def test_crossref_skips_items_without_title():
    payload = {"message": {"items": [{"DOI": "10.9/x"}, CROSSREF_OK["message"]["items"][0]]}}
    papers = ls._parse_crossref(payload, 5)
    assert [p.title for p in papers] == ["Wheat heat shock"]
    assert papers[0].year == 2022
    assert papers[0].authors == ["Wang Wu"]


def test_arxiv_atom_parsing():
    papers = ls._parse_arxiv(ARXIV_XML, 5)
    assert len(papers) == 1
    paper = papers[0]
    assert paper.title == "Deep learning for plant phenotyping"
    assert paper.year == 2024
    assert paper.authors == ["Ada Lovelace"]
    assert paper.pdf_url.endswith("2401.00001v1")


@pytest.mark.asyncio
async def test_search_falls_through_to_semantic_scholar():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.host)
        if request.url.host == "api.openalex.org":
            return httpx.Response(500, json={"error": "boom"})
        if request.url.host == "api.semanticscholar.org":
            return httpx.Response(200, json=S2_OK)
        return httpx.Response(200, json=CROSSREF_OK)

    async with _client(handler) as client:
        result = await ls.search("rice", 5, client=client, include_arxiv=False)

    assert result.source == "semanticscholar"
    assert result.papers[0].title == "Rice salt tolerance"
    # 失败与命中都要留痕，便于回答"这批数据到底从哪来的"
    assert [a["source"] for a in result.attempts] == ["openalex", "semanticscholar"]
    assert result.attempts[0]["status"].startswith("error")
    assert "api.crossref.org" not in calls, "命中的源之后不应继续请求更低的源"


@pytest.mark.asyncio
async def test_search_reports_no_source_when_all_fail():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="unavailable")

    async with _client(handler) as client:
        result = await ls.search("wheat", 5, client=client, include_arxiv=False)

    assert result.source == "none"
    assert result.papers == []
    assert all(a["status"].startswith("error") for a in result.attempts)


@pytest.mark.asyncio
async def test_arxiv_results_are_merged_and_deduped_by_doi():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.openalex.org":
            return httpx.Response(200, json=OPENALEX_OK)
        return httpx.Response(200, text=ARXIV_XML)

    async with _client(handler) as client:
        result = await ls.search("maize", 10, client=client)

    assert result.source == "openalex"
    titles = [p.title for p in result.papers]
    assert "Maize drought response" in titles
    assert "Deep learning for plant phenotyping" in titles


def test_dedupe_prefers_first_and_fills_gaps():
    first = ls.Paper(title="Same paper", source="openalex", doi="10.1/ABC")
    second = ls.Paper(
        title="Same paper (dup)",
        source="semanticscholar",
        doi="https://doi.org/10.1/abc",
        abstract="filled later",
        pdf_url="https://example.org/x.pdf",
        citations=9,
    )
    merged = ls.dedupe([first, second])
    assert len(merged) == 1
    assert merged[0].source == "openalex"
    assert merged[0].abstract == "filled later"
    assert merged[0].pdf_url.endswith("x.pdf")
    assert merged[0].citations == 9


def test_dedupe_without_doi_falls_back_to_title_and_year():
    a = ls.Paper(title="Genome assembly of maize", source="openalex", year=2021)
    b = ls.Paper(title="Genome  assembly of maize!", source="crossref", year=2021)
    c = ls.Paper(title="Genome assembly of maize", source="crossref", year=2019)
    assert len(ls.dedupe([a, b])) == 1
    assert len(ls.dedupe([a, c])) == 2


@pytest.mark.asyncio
async def test_empty_query_short_circuits_without_network():
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover - 不应被调用
        raise AssertionError("empty query must not hit the network")

    async with _client(handler) as client:
        result = await ls.search("   ", 5, client=client)

    assert result.source == "none"
    assert result.papers == []
