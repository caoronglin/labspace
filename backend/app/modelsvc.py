"""本地模型服务客户端：bge-m3 语义向量与 bge-reranker 重排序。

站内不再提供独立的「本地 AI」页面——这两种能力是知识库检索、统一检索的结果融合器，
文档解析（docparse）与翻译（mt）各自直连 /v1/parse 与 /v1/translate。

约定：所有对外函数在模型主机不可用时返回 ``None`` 而不抛异常，由调用方退回关键词
路径。语义能力是增量优化，不能成为故障源。
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any

import httpx

from .http import async_client as http_client

logger = logging.getLogger(__name__)

MODEL_BASE = os.getenv("LABSPACE_MODEL_URL", "http://192.0.2.17:8000").rstrip("/")
EMBEDDING_DIM = int(os.getenv("LABSPACE_EMBEDDING_DIM", "1024"))
MAX_TEXTS = 128
MAX_TEXT_CHARS = 8000
BATCH = 32
PROBE_TTL = 20.0

_probe_cache: dict[str, Any] = {"at": 0.0, "value": {}}


async def probe(*, timeout: float = 8.0) -> dict[str, Any]:
    """带 20 秒缓存的健康检查：``{"reachable", "reason", "available", "loaded"}``。"""
    now = time.time()
    if now - _probe_cache["at"] < PROBE_TTL and _probe_cache["value"]:
        return _probe_cache["value"]
    value: dict[str, Any]
    try:
        async with http_client(timeout=timeout) as client:
            resp = await client.get(f"{MODEL_BASE}/health")
        if resp.status_code >= 400:
            value = {"reachable": False, "reason": f"模型服务 HTTP {resp.status_code}",
                     "available": [], "loaded": []}
        else:
            payload = resp.json()
            models = payload.get("models") or {}
            value = {
                "reachable": True,
                "reason": "",
                "available": models.get("available") or [],
                "loaded": list((models.get("loaded") or {}).keys()),
                "gpu": payload.get("gpu") or {},
            }
    except (httpx.HTTPError, ValueError) as exc:
        value = {"reachable": False, "reason": f"模型服务不可达（{type(exc).__name__}）",
                 "available": [], "loaded": []}
    _probe_cache.update({"at": now, "value": value})
    return value


async def ready() -> bool:
    """语义链路是否可用：embedding 与 reranker 都在服务侧存在。"""
    health = await probe()
    if not health.get("reachable"):
        return False
    offered = set(health.get("available") or []) | set(health.get("loaded") or [])
    return "bge-m3" in offered and "bge-reranker-v2-m3" in offered


async def embed(texts: list[str], *, timeout: float = 60.0) -> list[list[float]] | None:
    """批量取密集向量；任何异常都记日志并返回 ``None``。"""
    cleaned = [t.strip()[:MAX_TEXT_CHARS] for t in texts]
    if not cleaned or any(not t for t in cleaned):
        return None
    vectors: list[list[float]] = []
    try:
        async with http_client(timeout=httpx.Timeout(timeout, connect=5.0)) as client:
            for start in range(0, len(cleaned), BATCH):
                batch = cleaned[start:start + BATCH]
                resp = await client.post(
                    f"{MODEL_BASE}/v1/embeddings",
                    json={
                        "texts": batch,
                        "return_sparse": False,
                        "return_colbert": False,
                        "max_length": 512,
                    },
                )
                if resp.status_code >= 400:
                    logger.info("向量化失败 HTTP %s：%s", resp.status_code, resp.text[:200])
                    return None
                dense = (resp.json() or {}).get("dense") or []
                if len(dense) != len(batch):
                    logger.info("向量化返回条数不匹配：期望 %s，实际 %s", len(batch), len(dense))
                    return None
                vectors.extend(dense)
    except (httpx.HTTPError, ValueError) as exc:
        logger.info("向量化不可用：%s", exc)
        return None
    if len(vectors) != len(cleaned):
        return None
    return vectors


async def embed_one(text: str, *, timeout: float = 8.0) -> list[float] | None:
    """查询侧单条向量化，超时压到 8 秒以免拖慢检索。"""
    vectors = await embed([text], timeout=timeout)
    if not vectors:
        return None
    vector = vectors[0]
    return vector if len(vector) == EMBEDDING_DIM else vector[:EMBEDDING_DIM]


async def rerank(
    query: str, documents: list[str], *, timeout: float = 6.0
) -> list[tuple[int, float]] | None:
    """重排序，返回 ``[(原始下标, 分数)]``（分数降序）；不可用时 ``None``。"""
    query = (query or "").strip()[:MAX_TEXT_CHARS]
    docs = [d.strip()[:MAX_TEXT_CHARS] or " " for d in documents[:MAX_TEXTS]]
    if not query or len(docs) < 2:
        return None
    try:
        async with http_client(timeout=httpx.Timeout(timeout, connect=5.0)) as client:
            resp = await client.post(
                f"{MODEL_BASE}/v1/rerank",
                json={
                    "query": query,
                    "documents": docs,
                    "return_text": False,
                    "max_length": 512,
                },
            )
        if resp.status_code >= 400:
            logger.info("重排序失败 HTTP %s：%s", resp.status_code, resp.text[:200])
            return None
        results = (resp.json() or {}).get("results") or []
    except (httpx.HTTPError, ValueError) as exc:
        logger.info("重排序不可用：%s", exc)
        return None
    ordered: list[tuple[int, float]] = []
    for item in results:
        try:
            ordered.append((int(item["index"]), float(item.get("score") or 0.0)))
        except (KeyError, TypeError, ValueError):
            continue
    if len(ordered) != len(docs):
        return None
    ordered.sort(key=lambda pair: pair[1], reverse=True)
    return ordered
