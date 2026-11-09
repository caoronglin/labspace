"""知识库语义索引：bge-m3 分片向量 + 余弦召回 + bge-reranker 结果重排。

写入侧在条目保存后异步重建分片，读取侧把语义命中与关键词命中按条目合并后交给
重排序模型定序。pgvector 扩展、模型主机任一不可用时本模块整体静默关闭，知识库
检索与统一搜索退回原有的关键词行为——语义能力是增量，不能变成故障源。

可见性判定不在这里做：调用方（knowledge）负责把 ACL 条件传进来，本模块只保证
"只返回调用者可见的条目"，避免两处各写一套权限规则。
"""
from __future__ import annotations

import logging
import re
import time
from typing import Any, Callable

from . import db, modelsvc

logger = logging.getLogger(__name__)

CHUNK_CHARS = 700
CHUNK_OVERLAP = 120
MAX_CHUNKS = 12
RECALL = 40
MIN_QUERY_CHARS = 1

_state: dict[str, Any] = {"at": 0.0, "ready": False, "reason": ""}

_TABLE = """
CREATE TABLE IF NOT EXISTS labspace.knowledge_chunks (
    id         bigserial PRIMARY KEY,
    doc_id     bigint NOT NULL,
    idx        int NOT NULL DEFAULT 0,
    text       text NOT NULL DEFAULT '',
    embedding  vector,
    updated_at timestamptz NOT NULL DEFAULT now()
)
"""
_DOC_INDEX = (
    "CREATE INDEX IF NOT EXISTS knowledge_chunks_doc_idx "
    "ON labspace.knowledge_chunks (doc_id)"
)


def _literal(vector: list[float]) -> str:
    return "[" + ",".join(f"{float(x):.5f}" for x in vector) + "]"


def enabled(*, refresh: bool = False) -> bool:
    """pgvector 是否可用（扩展已安装且分片表建好）。结果缓存 5 分钟。"""
    now = time.time()
    if not refresh and now - _state["at"] < 300 and _state["reason"]:
        return bool(_state["ready"])
    try:
        if not db.query("SELECT 1 AS ok FROM pg_extension WHERE extname = 'vector'"):
            _state.update({"at": now, "ready": False, "reason": "数据库未安装 pgvector 扩展"})
            return False
        db.execute(_TABLE)
        db.execute(_DOC_INDEX)
        _state.update({"at": now, "ready": True, "reason": ""})
        return True
    except Exception as exc:  # noqa: BLE001 - 索引能力缺失不应影响门户
        _state.update({"at": now, "ready": False, "reason": f"语义索引不可用（{type(exc).__name__}）"})
        logger.info("语义索引未启用：%s", exc)
        return False


def status() -> dict[str, Any]:
    """给状态类接口用的自检片段（不含任何凭据）。"""
    ready = enabled()
    chunks = 0
    docs = 0
    if ready:
        try:
            rows = db.query(
                "SELECT count(*) AS chunks, count(DISTINCT doc_id) AS docs FROM labspace.knowledge_chunks"
            )
            chunks = int(rows[0]["chunks"]) if rows else 0
            docs = int(rows[0]["docs"]) if rows else 0
        except Exception:  # noqa: BLE001
            pass
    return {"vectorStore": ready, "reason": _state["reason"], "chunks": chunks, "indexedDocs": docs}


def _chunks_of(title: str, body: str) -> list[str]:
    """按空行/句号切段并拼接定长窗口，保证每片都带上标题语境。"""
    text = re.sub(r"[ \t]+", " ", (body or "").replace("\r", ""))
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if not text:
        return []
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    pieces: list[str] = []
    buf = ""
    for para in paragraphs:
        if len(buf) + len(para) <= CHUNK_CHARS:
            buf = f"{buf}\n{para}".strip()
            continue
        if buf:
            pieces.append(buf)
            buf = buf[-CHUNK_OVERLAP:] if len(buf) > CHUNK_OVERLAP else ""
        while len(para) > CHUNK_CHARS:
            cut = para.rfind("。", 0, CHUNK_CHARS)
            if cut < CHUNK_CHARS // 3:
                cut = para.rfind(" ", 0, CHUNK_CHARS)
            if cut < CHUNK_CHARS // 3:
                cut = CHUNK_CHARS
            pieces.append(para[:cut].strip())
            para = para[cut:].strip()
        buf = f"{buf}\n{para}".strip() if buf else para
    if buf:
        pieces.append(buf)
    head = (title or "").strip()
    out = [f"{head}\n{p}"[:4000] if head else p[:4000] for p in pieces if p.strip()]
    return out[:MAX_CHUNKS]


async def index_doc(doc_id: int) -> int:
    """重建单条目的分片向量；返回写入片数，0 表示未启用或无文本。"""
    if not enabled():
        return 0
    rows = db.query(
        "SELECT id, title, body FROM labspace.knowledge_docs WHERE id = %s", (doc_id,)
    )
    if not rows:
        await drop_doc(doc_id)
        return 0
    pieces = _chunks_of(rows[0]["title"], rows[0]["body"])
    if not pieces:
        db.execute("DELETE FROM labspace.knowledge_chunks WHERE doc_id = %s", (doc_id,))
        return 0
    vectors = await modelsvc.embed(pieces, timeout=120.0)
    if not vectors:
        return 0
    db.execute("DELETE FROM labspace.knowledge_chunks WHERE doc_id = %s", (doc_id,))
    for idx, (piece, vector) in enumerate(zip(pieces, vectors)):
        db.execute(
            "INSERT INTO labspace.knowledge_chunks (doc_id, idx, text, embedding) "
            "VALUES (%s, %s, %s, %s::vector)",
            (doc_id, idx, piece[:4000], _literal(vector)),
        )
    return len(pieces)


async def drop_doc(doc_id: int) -> None:
    if not enabled():
        return
    try:
        db.execute("DELETE FROM labspace.knowledge_chunks WHERE doc_id = %s", (doc_id,))
    except Exception as exc:  # noqa: BLE001
        logger.info("清理语义分片失败（doc %s）：%s", doc_id, exc)


async def hits(query: str, where: str, params: tuple, *, limit: int = RECALL) -> list[dict[str, Any]]:
    """按调用者的可见范围做余弦召回，返回 ``[{docId, score, text}]``。"""
    if not enabled() or len((query or "").strip()) < MIN_QUERY_CHARS:
        return []
    vector = await modelsvc.embed_one(query)
    if not vector:
        return []
    sql = f"""
        SELECT c.doc_id, c.idx, left(c.text, 600) AS text,
               1 - (c.embedding <=> %s::vector) AS score
        FROM labspace.knowledge_chunks c
        JOIN labspace.knowledge_docs d ON d.id = c.doc_id
        WHERE {where} AND c.embedding IS NOT NULL
        ORDER BY c.embedding <=> %s::vector
        LIMIT %s
    """
    try:
        rows = db.query(sql, (_literal(vector), *params, _literal(vector), max(1, min(limit, 120))))
    except Exception as exc:  # noqa: BLE001
        logger.info("语义召回失败：%s", exc)
        return []
    out: dict[int, dict[str, Any]] = {}
    for row in rows:
        doc_id = int(row["doc_id"])
        score = float(row["score"] or 0.0)
        current = out.get(doc_id)
        if current is None or score > current["score"]:
            out[doc_id] = {"docId": doc_id, "score": score, "text": row["text"]}
    return sorted(out.values(), key=lambda item: item["score"], reverse=True)[: max(1, limit)]


async def backfill(where: str, params: tuple, *, limit: int = 200) -> dict[str, int]:
    """给尚未建向量、且调用者可见的条目补索引（用于首次启用与重建）。"""
    if not enabled():
        return {"scanned": 0, "indexed": 0, "vectors": 0}
    rows = db.query(
        f"""
        SELECT d.id FROM labspace.knowledge_docs d
        WHERE {where}
          AND NOT EXISTS (SELECT 1 FROM labspace.knowledge_chunks c WHERE c.doc_id = d.id)
        ORDER BY d.updated_at DESC
        LIMIT %s
        """,
        (*params, max(1, min(limit, 500))),
    )
    indexed = 0
    vectors = 0
    for row in rows:
        written = await index_doc(int(row["id"]))
        if written:
            indexed += 1
            vectors += written
    return {"scanned": len(rows), "indexed": indexed, "vectors": vectors}


async def reorder(
    query: str,
    items: list[dict[str, Any]],
    text_of: Callable[[dict[str, Any]], str],
    *,
    timeout: float = 6.0,
) -> list[dict[str, Any]]:
    """用重排序模型给候选定序；模型不可用时原序返回，并在条目上标注原因。"""
    if len(items) < 2 or not (query or "").strip():
        return items
    if not await modelsvc.ready():
        for item in items:
            item.setdefault("fusion", "keyword")
        return items
    documents = [text_of(item)[:2000] or " " for item in items]
    ordered = await modelsvc.rerank(query, documents, timeout=timeout)
    if not ordered:
        for item in items:
            item.setdefault("fusion", "keyword")
        return items
    out: list[dict[str, Any]] = []
    for rank, (origin, score) in enumerate(ordered, start=1):
        if origin >= len(items):
            continue
        item = dict(items[origin])
        item["rerankScore"] = round(score, 4)
        item["fusion"] = item.get("fusion") or "semantic"
        item["fusionRank"] = rank
        out.append(item)
    # reranker 只返回它见到的候选，长度一致；保险起见补回漏项
    if len(out) < len(items):
        seen = {id(item) for item in out}
        out.extend(item for item in items if id(item) not in seen)
    return out
