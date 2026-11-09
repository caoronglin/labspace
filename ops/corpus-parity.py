#!/usr/bin/env python3
"""语料 / 搜索一致性对照：Go 核心（LabGo） vs Python 旧实现。

在宿主机执行（需 backend 虚拟环境）：

    /opt/labspace/backend/.venv/bin/python /opt/labspace/ops/corpus-parity.py

比较维度：
  * 统一语料检索（多组关键词）
  * 空查询分桶（命令面板）
  * 搜索建议 / 热搜词
  * 数据库目录检索

两侧都返回同一份「共享数据」导出的条目，差异必须是 0。
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parent.parent
APP_DIR = Path("/srv/app") if Path("/srv/app").exists() else ROOT / "backend"
sys.path.insert(0, str(APP_DIR))

from app import corpus as corpus_mod  # noqa: E402
from app.config import settings  # noqa: E402
from app.databases import search_databases  # noqa: E402


def _service_token() -> str:
    token = (settings.service_token or "").strip()
    if token:
        return token
    env_path = ROOT / "deploy" / ".env"
    if not env_path.exists():
        env_path = Path("/srv/app/../deploy/.env")
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("LABSPACE_SERVICE_TOKEN="):
                return line.split("=", 1)[1].strip()
    return ""


GO_BASE = os.environ.get("LABGO_BASE_URL", "").rstrip("/") or (
    settings.labgo_base.rstrip("/") if Path("/srv/app").exists() else "http://127.0.0.1:8122"
)
HEADERS = {"X-Lab-Service-Token": _service_token()}

QUERIES = ["ncbi", "NCBI", "拟南芥", "单细胞", "fastp", "BLAST", "表达组", "截图", "nonexistent-term-xyz"]


def key_of(entry: dict[str, Any]) -> tuple[str, str, str]:
    return (entry.get("type", ""), entry.get("id", ""), entry.get("title", ""))


async def go_get(client: httpx.AsyncClient, path: str, params: dict[str, Any]) -> Any:
    resp = await client.get(f"{GO_BASE}{path}", params=params, headers=HEADERS)
    resp.raise_for_status()
    return resp.json()


async def main() -> int:
    problems: list[str] = []
    # 预览服务端启动时的预热行为：拉取 SnapOtter 工具目录（243 个），
    # 否则独立进程里的语料缺少文件处理工具，与服务端不一致。
    try:
        from app import snapotter as snapotter_mod

        await snapotter_mod.get_tool_catalog()
        corpus_mod.corpus(refresh=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] SnapOtter 工具目录拉取失败：{type(exc).__name__}")
    async with httpx.AsyncClient(timeout=30) as client:
        # 1) 统一语料检索
        for q in QUERIES:
            py_items = corpus_mod.search_corpus(q, limit=30)
            go = await go_get(client, "/v1/corpus", {"q": q, "limit": 30})
            go_items = go.get("items") or []
            py_keys = [key_of(i) for i in py_items]
            go_keys = [key_of(i) for i in go_items]
            if py_keys != go_keys:
                problems.append(
                    f"语料检索不一致 q={q!r}: python={len(py_keys)} go={len(go_keys)} "
                    f"python_only={sorted(set(py_keys) - set(go_keys))[:3]} "
                    f"go_only={sorted(set(go_keys) - set(py_keys))[:3]} "
                    f"order_equal={py_keys == go_keys}"
                )
            else:
                print(f"[OK] 语料检索 {q!r}: {len(py_keys)} 条，两侧顺序一致")

        # 2) 空查询分桶
        py_buckets: list[dict[str, Any]] = []
        for entry in corpus_mod.corpus():
            cap = corpus_mod.TYPE_CAPS.get(entry.type, 4)
            arr = py_buckets
            bucket = [e for e in arr if e["type"] == entry.type]
            if len(bucket) < cap:
                arr.append(
                    {
                        "type": entry.type,
                        "id": entry.id,
                        "title": entry.title,
                        "subtitle": entry.subtitle,
                        "path": entry.path,
                        "url": entry.url,
                    }
                )
        order = ["page", "service", "tool", "snapotter", "database", "command"]
        py_items = []
        for t in order:
            py_items.extend([e for e in py_buckets if e["type"] == t])
        go = await go_get(client, "/v1/corpus", {"limit": 30})
        go_items = go.get("items") or []
        py_items = py_items[:30]
        if [key_of(i) for i in py_items] != [key_of(i) for i in go_items[:30]]:
            problems.append(
                f"空查询分桶不一致: python={len(py_items)} go={len(go_items)} "
                f"python_first={[i['title'] for i in py_items[:3]]} go_first={[i['title'] for i in go_items[:3]]}"
            )
        else:
            print(f"[OK] 空查询分桶: {len(go_items)} 条，两侧顺序一致")

        # 3) 搜索建议 / 热搜
        for q in ["", "ncbi", "单细胞"]:
            py_sug = corpus_mod.suggest(q, limit=10)
            py_hot = corpus_mod.hot_keywords()
            go = await go_get(client, "/v1/corpus/suggest", {"q": q, "limit": 10})
            if py_sug != (go.get("suggestions") or []):
                problems.append(f"搜索建议不一致 q={q!r}: python={py_sug[:3]} go={(go.get('suggestions') or [])[:3]}")
            if py_hot != (go.get("hot") or []):
                problems.append(f"热搜词不一致: python={py_hot[:3]} go={(go.get('hot') or [])[:3]}")
            else:
                print(f"[OK] 搜索建议/热搜 q={q!r}: suggestions={len(py_sug)} hot={len(py_hot)}")

        # 4) 数据库目录
        for kw in ["ncbi", "拟南芥", "单细胞", ""]:
            py_db = search_databases(kw, limit=300)
            go = await go_get(client, "/v1/corpus/databases", {"q": kw, "limit": 300})
            go_db = go.get("databases") or []
            py_ids = [d["id"] for d in py_db]
            go_ids = [d["id"] for d in go_db]
            if py_ids != go_ids:
                problems.append(
                    f"数据库目录不一致 kw={kw!r}: python={len(py_ids)} go={len(go_ids)} "
                    f"python_only={sorted(set(py_ids) - set(go_ids))[:3]} go_only={sorted(set(go_ids) - set(py_ids))[:3]}"
                )
            else:
                print(f"[OK] 数据库目录 kw={kw!r}: {len(py_ids)} 条，顺序一致")

    if problems:
        print("\n发现不一致：")
        for p in problems:
            print(" -", p)
        return 1
    print("\n结论：Go 核心与 Python 旧实现的语料 / 搜索结果完全一致")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
