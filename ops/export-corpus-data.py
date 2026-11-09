#!/usr/bin/env python3
"""导出统一语料的静态数据（单一数据源）。

输出：labspace/shared/corpus-data.json
内容：
  * databases   —— 植物 / 生物医学数据库目录（id, name, cn, desc, url, category, tags, featured, biomed）
  * pages       —— 门户页面（命令面板可跳转）
  * section_cn  —— SnapOtter 分区中文名
  * tool_aliases—— SnapOtter 工具中文别名
  * hot_keywords—— 热搜词
  * search_categories —— 门户检索分类（与 app/searchconfig.py 同源）

用法（在 backend 目录下执行）：
    python3 ../ops/export-corpus-data.py

该脚本只读现网模块，生成物写入 shared/corpus-data.json（门户与 Go 核心共用的唯一数据源）；
需与 /srv/labdata/labgo/corpus-data.json 保持一致（由 lab-go 同步）。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))

from app.corpus import HOT_KEYWORDS, PAGES, _SECTION_CN, _TOOL_ALIASES  # noqa: E402
from app.databases import PLANT_DATABASES  # noqa: E402
from app.searchconfig import SEARCH_CATEGORIES  # noqa: E402

TARGET = Path(__file__).resolve().parent.parent / "shared" / "corpus-data.json"


def main() -> int:
    payload = {
        "version": 1,
        "databases": PLANT_DATABASES,
        "pages": PAGES,
        "section_cn": _SECTION_CN,
        "tool_aliases": _TOOL_ALIASES,
        "hot_keywords": HOT_KEYWORDS,
        "search_categories": SEARCH_CATEGORIES,
    }
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    tmp = TARGET.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=False) + "\n", encoding="utf-8")
    os.replace(tmp, TARGET)
    print(
        f"已导出 {TARGET}："
        f"databases={len(PLANT_DATABASES)} pages={len(PAGES)} "
        f"aliases={len(_TOOL_ALIASES)} hot={len(HOT_KEYWORDS)} categories={len(SEARCH_CATEGORIES)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
