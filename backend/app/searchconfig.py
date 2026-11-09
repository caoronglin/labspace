"""门户检索分类与别名（单一数据源）。

门户对外暴露的检索分类（与 SearXNG settings.yml 的 categories_as_tabs 对齐）。
「论文」在 SearXNG 里的真实分类名是 "scientific publications"，前端历史上
一直用 scholarly，这里做双向别名映射，避免分类传过去搜不到结果。

该文件被 backend/app/main.py、backend/app/corpus.py 与
ops/export-corpus-data.py 共用，保证 Python 端与 Go 核心（LabGo）拿到
完全一致的分类清单。
"""
from __future__ import annotations

SEARCH_CATEGORIES: list[dict[str, str]] = [
    {"value": "general", "label": "网页", "hint": "中文通用网页检索"},
    {"value": "science", "label": "学术", "hint": "PubMed / EuropePMC / arXiv / OpenAlex"},
    {"value": "scientific publications", "label": "论文", "hint": "Crossref / OpenAlex / arXiv 元数据"},
    {"value": "videos", "label": "视频", "hint": "哔哩哔哩 / AcFun / 腾讯视频"},
    {"value": "images", "label": "图片", "hint": "百度图片 / 夸克 / Naver / Pixabay"},
    {"value": "it", "label": "IT / 代码", "hint": "GitHub / npm / crates.io / 技术问答"},
    {"value": "news", "label": "新闻", "hint": "Hacker News / 微信搜一搜"},
    {"value": "books", "label": "图书", "hint": "中文通用引擎检索图书条目"},
]

CATEGORY_ALIASES: dict[str, str] = {
    "scholarly": "scientific publications",
    "scientific publications": "scientific publications",
    "paper": "scientific publications",
    "papers": "scientific publications",
    "publication": "scientific publications",
    "publications": "scientific publications",
    "web": "general",
    "general": "general",
    "science": "science",
    "video": "videos",
    "videos": "videos",
    "image": "images",
    "images": "images",
    "it": "it",
    "code": "it",
    "news": "news",
    "book": "books",
    "books": "books",
}


def normalize_category(value: str | None) -> str:
    """把前端传入的分类名映射到 SearXNG 真实分类名，非法值回落 general。"""
    raw = (value or "general").strip().lower()
    return CATEGORY_ALIASES.get(raw, "general")
