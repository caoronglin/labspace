"""个人与实验室知识库：分类管理、批量/目录入库、文件空间联动与 RAG 问答。

权限模型（默认拒绝）：
* ``private``  仅创建者与管理员可见；
* ``roles``    创建者、命中角色组的成员、管理员可见；
* ``public``   所有已登录用户可见。

检索与问答由宿主机 FlashRAG 服务完成（BM25s 索引，生成模型可配置），
本模块只负责鉴权、文档入库（Tika / Docling 抽取）与转发 RAG 请求。
从"文件管理"入库时，字节流一律经 Go 核心按其 ACL 重新校验后才落到知识条目，
Python 侧不直接读盘，避免绕过文件权限。
"""
from __future__ import annotations

import json
import logging
import mimetypes
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field

from . import db, semantic
from .config import settings
from .docparse import PDF_IMAGE_SUFFIXES, document_to_text
from .http import async_client
from .security import has_role, require_admin, require_csrf, require_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])

MAX_BODY = 200_000
MAX_INGEST_BYTES = 20 * 1024 * 1024
MAX_CATEGORY = 96
MAX_BATCH = 50
MAX_SPACE_NAME = 48
MAX_SPACE_DESC = 300
TEXT_SUFFIXES = {
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml",
    ".log", ".py", ".r", ".sh", ".sql", ".tex", ".bib", ".html", ".htm", ".xml",
    # 实验室常见纯文本数据格式：不认这些，个人空间里的结果文件基本入不了库
    ".fa", ".fasta", ".fna", ".faa", ".qual", ".fastq", ".gff", ".gff3", ".gtf",
    ".bed", ".bedgraph", ".narrowpeak", ".sam", ".vcf", ".mtx", ".tsne", ".umap",
    ".treefile", ".nwk", ".newick", ".phy", ".aln", ".pdb", ".sdf", ".inchi",
}
VISIBILITIES = {"private", "roles", "public"}


class SpaceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=MAX_SPACE_NAME)
    description: str = Field(default="", max_length=MAX_SPACE_DESC)
    visibility: str = Field(default="private")
    roles: list[str] = Field(default_factory=list)


class SpaceUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=MAX_SPACE_NAME)
    description: str | None = Field(default=None, max_length=MAX_SPACE_DESC)
    visibility: str | None = None
    roles: list[str] | None = None


class DocCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(default="", max_length=MAX_BODY)
    tags: list[str] = Field(default_factory=list)
    category: str = Field(default="", max_length=MAX_CATEGORY)
    visibility: str = Field(default="private")
    roles: list[str] = Field(default_factory=list)
    spaceId: int = Field(default=0, ge=0)


class DocUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    body: str | None = Field(default=None, max_length=MAX_BODY)
    tags: list[str] | None = None
    category: str | None = Field(default=None, max_length=MAX_CATEGORY)
    visibility: str | None = None
    roles: list[str] | None = None
    spaceId: int | None = Field(default=None, ge=0)


class AskIn(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    topK: int = Field(default=6, ge=1, le=12)
    category: str = Field(default="", max_length=MAX_CATEGORY)
    spaceId: int = Field(default=0, ge=0)


class FilePick(BaseModel):
    """一次"从文件管理入库"选中的条目；id 由 Go 核心签发，source/path 仅用于回链展示。"""

    id: str = Field(min_length=1, max_length=64)
    source: str = Field(default="", max_length=48)
    path: str = Field(default="", max_length=1000)


class FromFilesIn(BaseModel):
    """items 必填；其余元数据留空即"不改"，界面里显式清空才写空值。"""

    items: list[FilePick] = Field(min_length=1, max_length=MAX_BATCH)
    category: str | None = Field(default=None, max_length=MAX_CATEGORY)
    tags: list[str] | None = None
    visibility: str | None = None
    roles: list[str] | None = None
    spaceId: int | None = Field(default=None, ge=0)


def _clean_tags(tags: list[str] | None) -> list[str]:
    out: list[str] = []
    for raw in tags or []:
        tag = re.sub(r"\s+", " ", str(raw)).strip()[:32]
        if tag and tag not in out:
            out.append(tag)
    return out[:20]


def _clean_category(value: str) -> str:
    """分类是知识库内的文件夹路径（如 ``项目/2026``），逐段归一化后重新拼接。"""
    parts = []
    for raw in str(value or "").replace("\\", "/").split("/"):
        part = re.sub(r"\s+", " ", raw).strip()
        if part and part not in (".", ".."):
            parts.append(part)
    return "/".join(parts)[:MAX_CATEGORY]


_ROLE_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


def _clean_roles(values: list[str] | None) -> list[str]:
    """角色名来自 Casdoor 组名（如 lab-teacher），只保留合法字符并去重。"""
    out: list[str] = []
    for raw in values or []:
        role = str(raw or "").strip()
        if role and _ROLE_RE.fullmatch(role) and role not in out:
            out.append(role)
    return out[:20]


def _parse_paths(raw: str) -> list[str]:
    """目录上传时前端按提交顺序传来的相对路径，仅用于展示（不做任何路径拼接）。"""
    try:
        value = json.loads(raw or "[]")
    except json.JSONDecodeError:
        return []
    if not isinstance(value, list):
        return []
    return [re.sub(r"\s+", " ", str(item)).strip()[:1000] for item in value]


def _clean_visibility(value: str) -> str:
    v = (value or "private").strip().lower()
    if v not in VISIBILITIES:
        raise HTTPException(status_code=400, detail="可见范围必须是 private / roles / public")
    return v


def _is_admin(user: dict[str, Any]) -> bool:
    return has_role(user, settings.admin_roles)


def _rag_headers() -> dict[str, str]:
    return {"X-LabRAG-Token": settings.rag_token}


async def _rag_post(path: str, payload: dict[str, Any] | None, timeout: float) -> dict[str, Any]:
    if not settings.rag_base or not settings.rag_token:
        raise HTTPException(status_code=503, detail="RAG 服务尚未配置")
    try:
        async with async_client(timeout=timeout) as client:
            resp = await client.post(
                f"{settings.rag_base}{path}", json=payload, headers=_rag_headers()
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("RAG 服务调用失败：%s", exc)
        raise HTTPException(status_code=503, detail="RAG 服务暂不可用") from exc
    if resp.status_code != 200:
        logger.warning("RAG 服务返回 %s：%s", resp.status_code, resp.text[:300])
        raise HTTPException(status_code=503, detail="RAG 服务暂不可用")
    return resp.json()


async def _reindex_background() -> None:
    try:
        await _rag_post("/reindex", None, 180)
    except Exception as exc:  # noqa: BLE001
        logger.warning("知识库索引重建失败：%s", exc)


async def _labfile_meta(entry_id: str, cookie: str) -> dict[str, Any]:
    """向 Go 核心取一条文件元数据；权限由文件核心判定，这里只转达结论。"""
    if not settings.labgo_base:
        raise HTTPException(status_code=503, detail="文件核心尚未配置")
    try:
        async with async_client(timeout=20) as client:
            resp = await client.get(
                f"{settings.labgo_base}/v1/files/{entry_id}",
                headers={"cookie": cookie} if cookie else None,
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("文件核心元数据调用失败：%s", exc)
        raise HTTPException(status_code=503, detail="文件核心暂不可用") from exc
    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="文件不存在或已移出可访问范围")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"文件核心返回 {resp.status_code}")
    try:
        data = resp.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail="文件核心返回了无法解析的响应") from exc
    return data if isinstance(data, dict) else {}


async def _labfile_bytes(entry_id: str, cookie: str) -> tuple[bytes, str]:
    try:
        async with async_client(timeout=120) as client:
            resp = await client.get(
                f"{settings.labgo_base}/v1/files/{entry_id}/download",
                headers={"cookie": cookie} if cookie else None,
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("文件核心下载失败：%s", exc)
        raise HTTPException(status_code=503, detail="文件核心暂不可用") from exc
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"文件核心返回 {resp.status_code}")
    return resp.content, resp.headers.get("content-type", "")


def _decode_text(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _markdown_to_text(md: str) -> str:
    """把 Docling/OXR 的 Markdown 归一为可读纯文本，保留表格列。"""
    out: list[str] = []
    for line in md.splitlines():
        stripped = line.strip()
        if stripped.startswith("|") and stripped.endswith("|"):
            if re.fullmatch(r"\|[\s:|-]+\|", stripped):
                continue
            line = "\t".join(cell.strip() for cell in stripped.strip("|").split("|"))
        line = re.sub(r"^[ \t]{0,3}#{1,6}[ \t]*", "", line)
        line = re.sub(r"^[ \t]{0,3}[-*+][ \t]+", "", line)
        line = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", line)
        line = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", line)
        out.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


async def _extract_text(raw: bytes, filename: str, content_type: str) -> tuple[str, str]:
    suffix = Path(filename).suffix.lower()
    if suffix in TEXT_SUFFIXES:
        return _decode_text(raw), "text"
    mime = content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    if suffix in PDF_IMAGE_SUFFIXES:
        try:
            provider, markdown = await document_to_text(raw, filename, mime)
            text = _markdown_to_text(markdown)
            if text:
                return text, provider
            logger.info("%s 未返回可索引文本，回退 Tika", provider)
        except Exception as exc:  # noqa: BLE001
            logger.info("结构化解析不可用，回退 Tika：%s", exc)
    try:
        async with async_client(timeout=120) as client:
            resp = await client.put(
                f"{settings.tika_url}/tika",
                content=raw,
                headers={"Content-Type": mime, "Accept": "text/plain"},
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Tika 抽取失败：%s", exc)
        raise HTTPException(status_code=502, detail="文档抽取服务暂不可用") from exc
    if resp.status_code != 200:
        logger.warning("Tika 返回 %s：%s", resp.status_code, resp.text[:200])
        raise HTTPException(status_code=422, detail="该文件无法提取文本，请换用 PDF/DOCX/TXT/MD 等格式")
    return resp.text, "Tika"


def _acl_clause(user: dict[str, Any], prefix: str = "") -> tuple[str, tuple]:
    """知识条目与知识库共用同一套可见性规则；prefix 用于带表别名的联表查询。"""
    if _is_admin(user):
        return "TRUE", ()
    roles = [str(r) for r in (user.get("roles") or [])]
    return (
        f"({prefix}owner = %s OR {prefix}visibility = 'public'"
        f" OR ({prefix}visibility = 'roles' AND {prefix}roles && %s::text[]))",
        (str(user.get("sub") or ""), roles),
    )


def _visible_clause(user: dict[str, Any], prefix: str = "") -> tuple[str, tuple]:
    return _acl_clause(user, prefix)


def _get_space(user: dict[str, Any], space_id: int, write: bool = False) -> dict[str, Any]:
    """取知识库并校验可见（write=True 时要求所有者或管理员）。"""
    rows = db.query("SELECT * FROM labspace.knowledge_spaces WHERE id = %s", (space_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="知识库不存在")
    row = rows[0]
    admin = _is_admin(user)
    if not admin and row["owner"] != str(user.get("sub") or ""):
        if write:
            raise HTTPException(status_code=403, detail="只能向自己创建的知识库写入")
        if row["visibility"] != "public" and not (
            row["visibility"] == "roles"
            and set(row.get("roles") or []) & set(str(r) for r in (user.get("roles") or []))
        ):
            raise HTTPException(status_code=404, detail="知识库不存在或无权访问")
    return row


def _resolve_space_id(user: dict[str, Any], space_id: int | None, write: bool = False) -> int | None:
    """0 / None 统一表示"未归档"；其它值必须是可见（可写）的知识库。"""
    if not space_id:
        return None
    _get_space(user, int(space_id), write=write)
    return int(space_id)


def _space_row(row: dict[str, Any], user: dict[str, Any], stats: dict[str, Any] | None = None) -> dict[str, Any]:
    stats = stats or {}
    return {
        "id": int(row["id"]),
        "name": row["name"],
        "description": row.get("description") or "",
        "visibility": row.get("visibility") or "private",
        "roles": row.get("roles") or [],
        "owner": row.get("owner") or "",
        "ownerName": row.get("owner_name") or "",
        "docs": int(stats.get("docs") or 0),
        "chars": int(stats.get("chars") or 0),
        "latest": stats.get("latest"),
        "canEdit": _is_admin(user) or row.get("owner") == str(user.get("sub") or ""),
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
    }


def _row(row: dict[str, Any], full: bool = False) -> dict[str, Any]:
    body = row.get("body") or ""
    out = {
        "id": row["id"],
        "title": row["title"],
        "tags": row.get("tags") or [],
        "category": row.get("category") or "",
        "spaceId": int(row.get("space_id") or 0),
        "spaceName": row.get("space_name") or "",
        "visibility": row.get("visibility") or "private",
        "roles": row.get("roles") or [],
        "source": row.get("source") or "manual",
        "fileSource": row.get("file_source") or "",
        "filePath": row.get("file_path") or "",
        "fileBytes": int(row.get("file_bytes") or 0),
        "fileModified": row.get("file_modified"),
        "owner": row.get("owner") or "",
        "ownerName": row.get("owner_name") or "",
        "updatedAt": row.get("updated_at"),
        "createdAt": row.get("created_at"),
        "excerpt": body if full else (body[:280] + ("…" if len(body) > 280 else "")),
    }
    if full:
        out["body"] = body
    return out


async def _store_extracted(
    *,
    user: dict[str, Any],
    title: str,
    raw: bytes,
    filename: str,
    content_type: str,
    category: str | None,
    tags: list[str] | None,
    visibility: str | None,
    roles: list[str] | None,
    space_id: int | None,
    source_kind: str,
    file_source: str = "",
    file_path: str = "",
    file_modified: str = "",
) -> dict[str, Any]:
    """抽取 → 落库，单个文件失败只影响它自己（批量入库必须能继续跑完）。

    category/tags/visibility/roles 传 None 表示本次不改这些字段（更新时沿用原值）。
    """
    owner = str(user.get("sub") or "")
    out: dict[str, Any] = {
        "name": filename,
        "category": category or "",
        "spaceId": space_id or 0,
        "fileSource": file_source,
        "filePath": file_path,
        "bytes": len(raw),
    }
    try:
        text, extractor = await _extract_text(raw, filename, content_type)
    except HTTPException as exc:
        return {**out, "ok": False, "status": "skipped", "reason": str(exc.detail)}
    text = text.strip()
    if not text:
        return {**out, "ok": False, "status": "skipped", "reason": "未提取到可索引文本（可能是扫描版 PDF 或二进制文件）"}
    truncated = len(text) > MAX_BODY
    if truncated:
        text = text[: MAX_BODY - 80] + "\n\n（文档过长，已截断，仅索引前 199000 字。）"
    doc_title = (title or Path(filename).stem)[:200]
    file_bytes = len(raw)
    existing = (
        db.query(
            "SELECT * FROM labspace.knowledge_docs WHERE owner=%s AND file_source=%s AND file_path=%s",
            (owner, file_source, file_path),
        )
        if file_path
        else []
    )
    # None 表示"这次没提这项元数据"，更新时沿用原来的值；空串/空数组才是明确的清空。
    # 文件管理里的"一键重新入库"就是这么用的，否则会把用户手填的分类和标签抹掉。
    if existing:
        prev = existing[0]
        eff_category = prev["category"] if category is None else category
        eff_tags = list(prev["tags"] or []) if tags is None else tags
        eff_visibility = prev["visibility"] if visibility is None else visibility
        eff_roles = list(prev["roles"] or []) if roles is None else roles
        eff_space = prev.get("space_id") if space_id is None else space_id
        rows = db.query(
            """
            UPDATE labspace.knowledge_docs
            SET title=%s, body=%s, tags=%s, category=%s, visibility=%s, roles=%s,
                space_id=%s, file_bytes=%s, file_modified=%s::timestamptz, updated_at=now()
            WHERE id=%s
            RETURNING *
            """,
            (
                doc_title, text, eff_tags, eff_category, eff_visibility, eff_roles,
                eff_space, file_bytes, file_modified or None, int(existing[0]["id"]),
            ),
        )
        status = "updated"
    else:
        eff_category = category or ""
        eff_tags = tags or []
        eff_visibility = visibility or "private"
        eff_roles = roles or []
        eff_space = space_id
        rows = db.query(
            """
            INSERT INTO labspace.knowledge_docs
                (owner, owner_name, title, body, tags, visibility, roles, source,
                 category, space_id, file_source, file_path, file_bytes, file_modified)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::timestamptz)
            RETURNING *
            """,
            (
                owner, str(user.get("name") or user.get("email") or ""), doc_title, text,
                eff_tags, eff_visibility, eff_roles, source_kind, eff_category, eff_space,
                file_source, file_path, file_bytes, file_modified or None,
            ),
        )
        status = "created"
    return {
        **out,
        "category": eff_category,
        "ok": True,
        "status": status,
        "docId": int(rows[0]["id"]),
        "title": doc_title,
        "chars": len(text),
        "extractor": extractor,
        "truncated": truncated,
    }


@router.get("")
@router.get("/")
async def list_docs(
    q: str = Query("", max_length=200),
    category: str = Query("", max_length=MAX_CATEGORY),
    folder: str = Query("", max_length=MAX_CATEGORY),
    tag: str = Query("", max_length=32),
    space: int | None = Query(None, ge=0),
    limit: int = Query(60, ge=1, le=200),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    where, params = _visible_clause(user, "d.")
    keyword = q.strip()
    wanted_category = _clean_category(category)
    wanted_folder = _clean_category(folder)
    wanted_tag = tag.strip()
    args: list[Any] = list(params)
    search = ""
    if keyword:
        search += " AND (d.title ILIKE %s OR d.body ILIKE %s OR EXISTS (SELECT 1 FROM unnest(d.tags) t WHERE t ILIKE %s))"
        like = f"%{keyword}%"
        args.extend([like, like, like])
    if wanted_category:
        if wanted_category == "未分类":
            search += " AND d.category = ''"
        else:
            search += " AND d.category = %s"
            args.append(wanted_category)
    if wanted_folder:
        search += " AND (d.category = %s OR d.category LIKE %s)"
        args.extend([wanted_folder, f"{wanted_folder}/%"])
    if space is not None:
        if space == 0:
            search += " AND d.space_id IS NULL"
        else:
            search += " AND d.space_id = %s"
            args.append(space)
    if wanted_tag:
        search += " AND d.tags && %s::text[]"
        args.append([wanted_tag])
    rows = db.query(
        f"""
        SELECT d.id, d.owner, d.owner_name, d.title, left(d.body, 600) AS body, d.tags,
               d.category, d.space_id, s.name AS space_name, d.visibility, d.roles, d.source,
               d.file_source, d.file_path, d.file_bytes, d.file_modified,
               d.created_at, d.updated_at
        FROM labspace.knowledge_docs d
        LEFT JOIN labspace.knowledge_spaces s ON s.id = d.space_id
        WHERE {where}{search}
        ORDER BY d.updated_at DESC
        LIMIT %s
        """,
        tuple(args + [limit]),
    )
    items = [_row(r) for r in rows]
    return {
        "items": items,
        "total": len(items),
        "query": keyword,
        "category": wanted_category,
        "folder": wanted_folder,
        "spaceId": space if space is not None else None,
    }


_SEARCH_COLUMNS = """
    d.id, d.owner, d.owner_name, d.title, left(d.body, 300) AS body, d.tags, d.category,
    d.space_id, d.visibility, d.roles, d.source, d.file_source, d.file_path, d.file_bytes,
    d.file_modified, d.created_at, d.updated_at
"""


async def search_hits(query: str, user: dict[str, Any], limit: int = 8) -> list[dict[str, Any]]:
    """把知识库条目包装成统一搜索的本地命中（供 /api/search 合并）。

    必须走调用者自己的可见范围：Go 核心的语料索引是全站的，而知识条目默认私有，
    所以这里只能在 Python 侧按会话 ACL 现查，不能进全局语料。

    检索是混合式的：关键词命中提供精确匹配，bge-m3 分片向量召回提供语义相近的条目，
    两者按条目去重后交给 bge-reranker 定序。向量库或模型主机不可用时自动退回纯关键词，
    此时 `fusion` 标注为 keyword，调用方无需感知降级。
    """
    keyword = (query or "").strip()[:200]
    if not keyword:
        return []
    where, params = _visible_clause(user, "d.")
    like = f"%{keyword}%"
    rows = db.query(
        f"""
        SELECT {_SEARCH_COLUMNS}
        FROM labspace.knowledge_docs d
        WHERE {where}
          AND (d.title ILIKE %s OR d.body ILIKE %s OR d.category ILIKE %s
               OR EXISTS (SELECT 1 FROM unnest(d.tags) t WHERE t ILIKE %s))
        ORDER BY d.updated_at DESC
        LIMIT %s
        """,
        (*params, like, like, like, like, max(1, min(limit * 2, 40))),
    )
    keyword_ids = {int(r["id"]) for r in rows}

    semantic_rows: list[dict[str, Any]] = []
    try:
        semantic_rows = await semantic.hits(keyword, where, params, limit=semantic.RECALL)
    except Exception as exc:  # noqa: BLE001 - 语义召回失败必须退回关键词
        logger.info("知识库语义召回不可用，退回关键词：%s", exc)

    by_id: dict[int, dict[str, Any]] = {int(r["id"]): r for r in rows}
    missing = [int(h["docId"]) for h in semantic_rows if int(h["docId"]) not in by_id]
    if missing:
        # 语义命中但关键词没命中的条目也必须过一次 ACL，避免向量库与文档表权限漂移
        fetched = db.query(
            f"SELECT {_SEARCH_COLUMNS} FROM labspace.knowledge_docs d "
            f"WHERE d.id = ANY(%s) AND {where}",
            (missing, *params),
        )
        for r in fetched:
            by_id[int(r["id"])] = r
    vector_score = {int(h["docId"]): float(h["score"]) for h in semantic_rows}

    order = [int(r["id"]) for r in rows]
    order += [int(h["docId"]) for h in semantic_rows if int(h["docId"]) not in keyword_ids]
    candidates: list[dict[str, Any]] = []
    for doc_id in order:
        raw = by_id.get(doc_id)
        if raw is None:
            continue
        row = _row(raw)
        path = f"/knowledge?doc={row['id']}"
        score = vector_score.get(doc_id)
        candidates.append(
            {
                "id": row["id"],
                "title": row["title"],
                "url": path,
                "content": row["excerpt"][:220],
                "engine": "知识库",
                "category": "knowledge",
                "kind": "local",
                "path": path,
                "tags": row["tags"][:6],
                "docCategory": row["category"] or "未分类",
                "updatedAt": row["updatedAt"],
                "vectorScore": round(score, 4) if score is not None else None,
                "matchType": (
                    "hybrid" if (score is not None and doc_id in keyword_ids)
                    else ("semantic" if score is not None else "keyword")
                ),
            }
        )
    candidates = await semantic.reorder(
        keyword,
        candidates,
        lambda item: f"{item['title']}\n{item['content']}",
        timeout=6.0,
    )
    return candidates[: max(1, min(limit, 20))]


@router.get("/categories")
async def list_categories(
    space: int | None = Query(None, ge=0),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """当前账号可见范围内的分类（文件夹路径）与标签计数。"""
    where, params = _visible_clause(user, "d.")
    space_filter = ""
    args: list[Any] = list(params)
    if space is not None:
        if space == 0:
            space_filter = " AND d.space_id IS NULL"
        else:
            space_filter = " AND d.space_id = %s"
            args.append(space)
    rows = db.query(
        f"""
        SELECT d.category, count(*)::int AS docs,
               coalesce(sum(length(d.body)), 0)::bigint AS chars,
               max(d.updated_at) AS latest
        FROM labspace.knowledge_docs d
        WHERE {where}{space_filter}
        GROUP BY d.category
        ORDER BY docs DESC, d.category
        """,
        tuple(args),
    )
    tag_rows = db.query(
        f"""
        SELECT tag.name AS name, count(DISTINCT tag.id)::int AS docs
        FROM (
            SELECT d.id, unnest(d.tags) AS name
            FROM labspace.knowledge_docs d
            WHERE {where}{space_filter}
        ) tag
        GROUP BY tag.name
        ORDER BY count(DISTINCT tag.id) DESC, tag.name
        LIMIT 40
        """,
        tuple(args),
    )
    return {
        "categories": [
            {
                "name": r["category"] or "",
                "label": r["category"] or "未分类",
                "docs": r["docs"],
                "chars": int(r["chars"] or 0),
                "latest": r["latest"],
            }
            for r in rows
        ],
        "tags": [{"name": r["name"], "docs": r["docs"]} for r in tag_rows],
        "total": sum(int(r["docs"] or 0) for r in rows),
    }


@router.get("/search")
async def search_docs(
    q: str = Query("", max_length=200),
    limit: int = Query(8, ge=1, le=20),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """知识条目的统一搜索片段，供 Go 核心在本地检索阶段回调。

    全站语料索引在 Go 侧，但知识条目默认私有、可见范围只在这份 Python 实现里判定；
    所以由调用方原样带上会话、这里按会话现查，避免两处各写一套 ACL 规则。
    """
    return {"query": q, "hits": await search_hits(q, user, limit)}


@router.get("/spaces")
async def list_spaces(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    where, params = _acl_clause(user, "s.")
    spaces = db.query(
        f"""
        SELECT s.* FROM labspace.knowledge_spaces s
        WHERE {where}
        ORDER BY s.updated_at DESC
        """,
        tuple(params),
    )
    doc_where, doc_params = _visible_clause(user, "d.")
    agg = db.query(
        f"""
        SELECT coalesce(d.space_id, 0)::bigint AS space_id,
               count(*)::int AS docs,
               coalesce(sum(length(d.body)), 0)::bigint AS chars,
               max(d.updated_at) AS latest
        FROM labspace.knowledge_docs d
        WHERE {doc_where}
        GROUP BY 1
        """,
        tuple(doc_params),
    )
    stats = {int(r["space_id"]): r for r in agg}
    items = [_space_row(s, user, stats.get(int(s["id"]))) for s in spaces]
    unfiled = stats.get(0) or {}
    return {
        "items": items,
        "unfiled": {
            "docs": int(unfiled.get("docs") or 0),
            "chars": int(unfiled.get("chars") or 0),
            "latest": unfiled.get("latest"),
        },
        "total": len(items),
    }


@router.post("/spaces")
async def create_space(
    body: SpaceCreate,
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    name = re.sub(r"\s+", " ", body.name).strip()[:MAX_SPACE_NAME]
    if not name:
        raise HTTPException(status_code=400, detail="知识库名称不能为空")
    owner = str(user.get("sub") or "")
    if db.query(
        "SELECT 1 FROM labspace.knowledge_spaces WHERE owner=%s AND name=%s",
        (owner, name),
    ):
        raise HTTPException(status_code=409, detail="同名知识库已存在")
    visibility = _clean_visibility(body.visibility)
    roles = _clean_roles(body.roles) if visibility == "roles" else []
    rows = db.query(
        """
        INSERT INTO labspace.knowledge_spaces (owner, owner_name, name, description, visibility, roles)
        VALUES (%s,%s,%s,%s,%s,%s)
        RETURNING *
        """,
        (
            owner,
            str(user.get("name") or user.get("email") or ""),
            name,
            body.description.strip()[:MAX_SPACE_DESC],
            visibility,
            roles,
        ),
    )
    return {"item": _space_row(rows[0], user)}


@router.patch("/spaces/{space_id}")
async def update_space(
    space_id: int,
    body: SpaceUpdate,
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    row = _get_space(user, space_id, write=True)
    name = row["name"] if body.name is None else re.sub(r"\s+", " ", body.name).strip()[:MAX_SPACE_NAME]
    if not name:
        raise HTTPException(status_code=400, detail="知识库名称不能为空")
    if name != row["name"] and db.query(
        "SELECT 1 FROM labspace.knowledge_spaces WHERE owner=%s AND name=%s AND id<>%s",
        (row["owner"], name, space_id),
    ):
        raise HTTPException(status_code=409, detail="同名知识库已存在")
    visibility = row["visibility"] if body.visibility is None else _clean_visibility(body.visibility)
    roles = (row.get("roles") or []) if body.roles is None else _clean_roles(body.roles)
    if visibility != "roles":
        roles = []
    description = row.get("description") or "" if body.description is None else body.description.strip()[:MAX_SPACE_DESC]
    rows = db.query(
        """
        UPDATE labspace.knowledge_spaces
        SET name=%s, description=%s, visibility=%s, roles=%s, updated_at=now()
        WHERE id=%s
        RETURNING *
        """,
        (name, description, visibility, roles, space_id),
    )
    return {"item": _space_row(rows[0], user)}


@router.delete("/spaces/{space_id}")
async def delete_space(
    space_id: int,
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    """删除知识库但保留文档：空间内的条目回到"未归档"，避免误删资料。"""
    _get_space(user, space_id, write=True)
    moved = db.query(
        "UPDATE labspace.knowledge_docs SET space_id=NULL WHERE space_id=%s RETURNING id",
        (space_id,),
    )
    db.execute("DELETE FROM labspace.knowledge_spaces WHERE id=%s", (space_id,))
    return {"ok": True, "movedToUnfiled": len(moved)}


@router.get("/{doc_id}")
async def get_doc(doc_id: int, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    where, params = _visible_clause(user, "d.")
    rows = db.query(
        f"""
        SELECT d.*, s.name AS space_name
        FROM labspace.knowledge_docs d
        LEFT JOIN labspace.knowledge_spaces s ON s.id = d.space_id
        WHERE d.id = %s AND {where}
        """,
        (doc_id, *params),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="知识条目不存在或无权访问")
    return {"item": _row(rows[0], full=True)}


@router.post("")
@router.post("/")
async def create_doc(
    body: DocCreate,
    background_tasks: BackgroundTasks,
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="标题不能为空")
    visibility = _clean_visibility(body.visibility)
    roles = _clean_roles(body.roles) if visibility == "roles" else []
    space_id = _resolve_space_id(user, body.spaceId, write=True)
    rows = db.query(
        """
        INSERT INTO labspace.knowledge_docs
            (owner, owner_name, title, body, tags, visibility, roles, source, category, space_id)
        VALUES (%s,%s,%s,%s,%s,%s,%s,'manual',%s,%s)
        RETURNING *
        """,
        (
            str(user.get("sub") or ""),
            str(user.get("name") or user.get("email") or ""),
            title,
            body.body,
            _clean_tags(body.tags),
            visibility,
            roles,
            _clean_category(body.category),
            space_id,
        ),
    )
    # 语义分片先入库，避免 FlashRAG 重建耗时长导致新条目短期内检索不到
    background_tasks.add_task(semantic.index_doc, int(rows[0]["id"]))
    background_tasks.add_task(_reindex_background)
    return {"item": _row(rows[0], full=True)}


@router.patch("/{doc_id}")
async def update_doc(
    doc_id: int,
    body: DocUpdate,
    background_tasks: BackgroundTasks,
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    rows = db.query("SELECT * FROM labspace.knowledge_docs WHERE id = %s", (doc_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="知识条目不存在")
    row = rows[0]
    if row["owner"] != str(user.get("sub") or "") and not _is_admin(user):
        raise HTTPException(status_code=403, detail="只能修改自己的知识条目")

    title = row["title"] if body.title is None else body.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="标题不能为空")
    content = row["body"] if body.body is None else body.body
    tags = (row.get("tags") or []) if body.tags is None else _clean_tags(body.tags)
    category = row.get("category") if body.category is None else _clean_category(body.category)
    visibility = row["visibility"] if body.visibility is None else _clean_visibility(body.visibility)
    roles = (row.get("roles") or []) if body.roles is None else _clean_roles(body.roles)
    if visibility != "roles":
        roles = []
    space_id = row.get("space_id") if body.spaceId is None else _resolve_space_id(user, body.spaceId, write=True)

    rows = db.query(
        """
        UPDATE labspace.knowledge_docs
        SET title=%s, body=%s, tags=%s, category=%s, visibility=%s, roles=%s,
            space_id=%s, updated_at=now()
        WHERE id=%s
        RETURNING *
        """,
        (title, content, tags, category, visibility, roles, space_id, doc_id),
    )
    # 语义分片先入库，避免 FlashRAG 重建耗时长导致新条目短期内检索不到
    background_tasks.add_task(semantic.index_doc, int(rows[0]["id"]))
    background_tasks.add_task(_reindex_background)
    return {"item": _row(rows[0], full=True)}


@router.delete("/{doc_id}")
async def delete_doc(
    doc_id: int,
    background_tasks: BackgroundTasks,
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    rows = db.query("SELECT owner FROM labspace.knowledge_docs WHERE id = %s", (doc_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="知识条目不存在")
    if rows[0]["owner"] != str(user.get("sub") or "") and not _is_admin(user):
        raise HTTPException(status_code=403, detail="只能删除自己的知识条目")
    db.execute("DELETE FROM labspace.knowledge_docs WHERE id = %s", (doc_id,))
    background_tasks.add_task(_reindex_background)
    background_tasks.add_task(semantic.drop_doc, doc_id)
    return {"ok": True}


@router.get("/rag/status")
async def rag_status(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    sem = semantic.status()
    if not settings.rag_base or not settings.rag_token:
        return {"available": False, "error": "RAG 服务尚未配置", "semantic": sem}
    try:
        async with async_client(timeout=8) as client:
            resp = await client.get(f"{settings.rag_base}/health", headers=_rag_headers())
        if resp.status_code != 200:
            return {"available": False, "error": f"RAG 服务返回 {resp.status_code}", "semantic": sem}
        data = resp.json()
        data["available"] = True
        data["semantic"] = sem
        return data
    except Exception as exc:  # noqa: BLE001
        logger.warning("RAG 状态查询失败：%s", exc)
        return {"available": False, "error": "RAG 服务暂不可用", "semantic": sem}


@router.post("/ask")
async def ask_rag(
    body: AskIn,
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    payload = {
        "query": body.query.strip(),
        "topK": body.topK,
        "category": _clean_category(body.category),
        "spaceId": _resolve_space_id(user, body.spaceId) or 0,
        "user": {
            "sub": str(user.get("sub") or ""),
            "name": str(user.get("name") or user.get("email") or ""),
            "roles": [str(r) for r in (user.get("roles") or [])],
            "isAdmin": _is_admin(user),
        },
    }
    return await _rag_post("/ask", payload, 100)


@router.post("/reindex")
async def reindex(
    user: dict[str, Any] = Depends(require_admin),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    """重建检索索引：FlashRAG（BM25s）与 pgvector 语义分片一起补。"""
    semantic_stats = (
        await semantic.backfill("TRUE", ())
        if semantic.enabled()
        else {"scanned": 0, "indexed": 0, "vectors": 0}
    )
    result = await _rag_post("/reindex", None, 300)
    return {**result, "semantic": semantic_stats}


def _parse_list(raw: str, limit: int = 20) -> list[str]:
    try:
        value = json.loads(raw or "[]")
    except json.JSONDecodeError:
        value = (raw or "").split(",")
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        name = re.sub(r"\s+", " ", str(item)).strip()
        if name and name not in out:
            out.append(name)
    return out[:limit]


def _skipped(name: str, reason: str, **extra: Any) -> dict[str, Any]:
    return {"name": name, "ok": False, "status": "skipped", "reason": reason, **extra}


def _summary(results: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "created": sum(1 for r in results if r.get("status") == "created"),
        "updated": sum(1 for r in results if r.get("status") == "updated"),
        "skipped": sum(1 for r in results if r.get("status") == "skipped"),
        "chars": sum(int(r.get("chars") or 0) for r in results),
    }


@router.post("/ingest")
async def ingest_docs(
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(...),
    paths: str = Form(""),
    category: str = Form(""),
    tags: str = Form(""),
    visibility: str = Form("private"),
    roles: str = Form("[]"),
    spaceId: int = Form(0),
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    """批量入库（界面支持"选择目录"，一次可提交多个文件）。"""
    if len(files) > MAX_BATCH:
        raise HTTPException(status_code=400, detail=f"单次最多入库 {MAX_BATCH} 个文件")
    vis = _clean_visibility(visibility)
    role_list = _parse_list(roles) if vis == "roles" else []
    space_id = _resolve_space_id(user, spaceId, write=True)
    clean_category = _clean_category(category)
    clean_tags = _parse_list(tags)
    rel_paths = _parse_paths(paths)
    results: list[dict[str, Any]] = []
    for index, upload in enumerate(files):
        # Starlette 会把 multipart 里的路径削成 basename，目录上传的相对路径
        # 由前端按同一顺序放在 paths 字段里，只用于展示与标题。
        name = Path(upload.filename or "document").name
        rel = (rel_paths[index] if index < len(rel_paths) else "") or name
        raw = await upload.read(MAX_INGEST_BYTES + 1)
        if len(raw) > MAX_INGEST_BYTES:
            results.append(_skipped(rel, "文件超过 20 MB 限制", bytes=len(raw)))
            continue
        if not raw:
            results.append(_skipped(rel, "文件为空"))
            continue
        results.append(
            await _store_extracted(
                user=user,
                title=Path(name).stem[:200],
                raw=raw,
                filename=name,
                content_type=upload.content_type or "",
                category=clean_category,
                tags=clean_tags,
                visibility=vis,
                roles=role_list,
                space_id=space_id,
                source_kind="upload",
            )
        )
        results[-1]["name"] = rel
    if any(r.get("ok") for r in results):
        background_tasks.add_task(_reindex_background)
        for item in results:
            if item.get("ok") and item.get("docId"):
                background_tasks.add_task(semantic.index_doc, int(item["docId"]))
    return {"results": results, "summary": _summary(results)}


@router.post("/from-files")
async def ingest_from_files(
    body: FromFilesIn,
    request: Request,
    background_tasks: BackgroundTasks,
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    """把"文件管理"里的文档拉进知识库。

    读字节这一步必须回到 Go 核心，用调用者自己的会话重新过一次文件 ACL；
    同一账号重复入库同一文件时覆盖旧条目，不堆重复文档。
    """
    vis = _clean_visibility(body.visibility) if body.visibility is not None else None
    if body.roles is None:
        role_list: list[str] | None = None
    elif vis == "roles":
        role_list = [str(r) for r in body.roles][:20]
    else:
        role_list = []
    clean_category = _clean_category(body.category) if body.category is not None else None
    clean_tags = _clean_tags(body.tags) if body.tags is not None else None
    space_id = None if body.spaceId is None else _resolve_space_id(user, body.spaceId, write=True)
    cookie = request.headers.get("cookie", "")
    results: list[dict[str, Any]] = []
    for pick in body.items:
        name = Path(pick.path).name or pick.path
        try:
            meta = await _labfile_meta(pick.id, cookie)
        except HTTPException as exc:
            results.append(_skipped(name, str(exc.detail), path=pick.path))
            continue
        if meta.get("dir"):
            results.append(_skipped(name, "目录不能整体入库，请勾选目录内的文件", path=pick.path))
            continue
        size = int(meta.get("size") or 0)
        if size > MAX_INGEST_BYTES:
            results.append(_skipped(name, "文件超过 20 MB 限制", path=pick.path, bytes=size))
            continue
        source = str(meta.get("source") or pick.source or "")
        path = str(meta.get("path") or pick.path or "")
        try:
            raw, content_type = await _labfile_bytes(pick.id, cookie)
            stored = await _store_extracted(
                user=user,
                title=Path(name).stem[:200],
                raw=raw,
                filename=name,
                content_type=content_type,
                category=clean_category,
                tags=clean_tags,
                visibility=vis,
                roles=role_list,
                space_id=space_id,
                source_kind="file",
                file_source=source,
                file_path=path,
                file_modified=str(meta.get("modified") or ""),
            )
        except HTTPException as exc:
            results.append(_skipped(name, str(exc.detail), path=path))
            continue
        stored["name"] = path or name
        stored["path"] = path
        results.append(stored)
    if any(r.get("ok") for r in results):
        background_tasks.add_task(_reindex_background)
        for item in results:
            if item.get("ok") and item.get("docId"):
                background_tasks.add_task(semantic.index_doc, int(item["docId"]))
    return {"results": results, "summary": _summary(results)}
