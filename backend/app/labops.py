"""实验室延伸功能：ELN、库存、流水线、文献管理、仪器预约与耗材申领。

所有个人数据按 ``owner`` 隔离；实验室共享的库存台账、仪器与预约允许所有登录用户
查看，写操作仍记录操作者，审批仅限 lab-admin / lab-teacher 或资源创建者。
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import html
import json
import os
import re
import shutil
import uuid
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
)
from fastapi.responses import FileResponse, PlainTextResponse

from . import db, inventory_baserow, modelsvc, semantic
from .security import has_role, require_csrf, require_user

router = APIRouter(prefix="/api/labops", tags=["labops"])

PIPELINE_ROOT = Path(os.getenv("LABOPS_PIPELINE_ROOT", "/srv/labdata/labops/pipelines"))
SHARED_REFERENCE = Path(os.getenv("LABOPS_REFERENCE_ROOT", "/srv/labops/shared/reference"))
SHARED_RAW = Path(os.getenv("LABOPS_RAW_ROOT", "/srv/labops/shared/raw"))
MAX_UPLOAD = int(os.getenv("LABOPS_MAX_UPLOAD", str(2 * 1024**3)))

PIPELINE_CATALOG = [
    {
        "id": "fastp_qc",
        "name": "fastp 质控",
        "tool": "fastp",
        "description": "双端/单端 FASTQ 去接头、低质量过滤，并生成 fastp 报告与 MultiQC 汇总。",
        "needs_reference": False,
        "inputs": "fastq",
        "params": {"adapter": "", "min_length": 30, "qualified_quality": 20},
    },
    {
        "id": "fastqc",
        "name": "FastQC + MultiQC",
        "tool": "fastqc",
        "description": "原始测序数据质量评估，输出逐样本 HTML 报告与 MultiQC 汇总。",
        "needs_reference": False,
        "inputs": "fastq",
        "params": {},
    },
    {
        "id": "minimap2_align",
        "name": "minimap2 比对",
        "tool": "minimap2",
        "description": "长读长/短读长比对到参考基因组，samtools 排序建索引并输出 flagstat。",
        "needs_reference": True,
        "inputs": "fastq",
        "params": {"preset": "map-ont", "threads": 4},
    },
    {
        "id": "bwa_align",
        "name": "bwa-mem2 比对",
        "tool": "bwa-mem2",
        "description": "短读长比对，自动建立参考索引，输出排序 BAM 与比对统计。",
        "needs_reference": True,
        "inputs": "fastq",
        "params": {"threads": 4},
    },
    {
        "id": "hisat2_align",
        "name": "HISAT2 转录组比对",
        "tool": "hisat2",
        "description": "RNA-seq 剪接感知比对，自动建立 HISAT2 索引，输出排序 BAM。",
        "needs_reference": True,
        "inputs": "fastq",
        "params": {"threads": 4},
    },
    {
        "id": "bismark_align",
        "name": "Bismark 甲基化比对",
        "tool": "bismark",
        "description": "WGBS/RRBS 亚硫酸氢盐比对，自动完成基因组转化与 bowtie2 比对。",
        "needs_reference": True,
        "inputs": "fastq",
        "params": {"threads": 4},
    },
    {
        "id": "scanpy_qc",
        "name": "scanpy 单细胞质控",
        "tool": "scanpy",
        "description": "读取 h5ad/10x MTX/CSV，完成 QC、归一化、PCA/UMAP 与 Leiden 聚类。",
        "needs_reference": False,
        "inputs": "matrix",
        "params": {"min_genes": 200, "max_pct_mt": 20, "resolution": 1.0},
    },
]

DEFAULT_TEMPLATES = [
    {
        "id": "tpl-general",
        "name": "通用实验记录",
        "description": "日期、目的、材料、步骤、结果与结论。",
        "fields": [
            {"key": "purpose", "label": "实验目的", "type": "textarea"},
            {"key": "materials", "label": "材料与试剂", "type": "textarea"},
            {"key": "steps", "label": "实验步骤", "type": "textarea"},
            {"key": "results", "label": "结果", "type": "textarea"},
            {"key": "conclusion", "label": "结论与下一步", "type": "textarea"},
        ],
    },
    {
        "id": "tpl-molecular",
        "name": "分子克隆",
        "description": "载体、插入片段、酶切/连接、转化与鉴定。",
        "fields": [
            {"key": "vector", "label": "载体", "type": "text"},
            {"key": "insert", "label": "插入片段", "type": "text"},
            {"key": "enzymes", "label": "酶与条件", "type": "text"},
            {"key": "colony", "label": "克隆鉴定", "type": "textarea"},
            {"key": "result", "label": "结果", "type": "textarea"},
        ],
    },
    {
        "id": "tpl-seq",
        "name": "测序分析",
        "description": "样本、文库、参考基因组、分析流程与质控指标。",
        "fields": [
            {"key": "samples", "label": "样本", "type": "textarea"},
            {"key": "library", "label": "文库策略", "type": "text"},
            {"key": "reference", "label": "参考基因组", "type": "text"},
            {"key": "pipeline", "label": "分析流程", "type": "textarea"},
            {"key": "qc", "label": "质控指标", "type": "textarea"},
        ],
    },
]


def _iso(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return value


def _row(row: dict[str, Any]) -> dict[str, Any]:
    return {k: _iso(v) for k, v in row.items()}


async def _q(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    rows = await asyncio.to_thread(db.query, sql, params)
    return [_row(r) for r in rows]


async def _q_one(sql: str, params: tuple = ()) -> dict[str, Any] | None:
    rows = await _q(sql, params)
    return rows[0] if rows else None


async def _x(sql: str, params: tuple = ()) -> None:
    await asyncio.to_thread(db.execute, sql, params)


def _uid() -> str:
    return uuid.uuid4().hex


def _clean_name(name: str, fallback: str = "file") -> str:
    base = os.path.basename((name or "").replace("\\", "/")).strip()
    base = re.sub(r"[^A-Za-z0-9._\-\u4e00-\u9fff]+", "-", base).strip("-.")
    return base[:120] or fallback


async def _ensure_templates() -> None:
    for tpl in DEFAULT_TEMPLATES:
        await _x(
            "INSERT INTO labspace.labops_eln_templates (id, name, description, fields, builtin) "
            "VALUES (%s,%s,%s,%s::jsonb,true) ON CONFLICT (id) DO NOTHING",
            (tpl["id"], tpl["name"], tpl["description"], json.dumps(tpl["fields"], ensure_ascii=False)),
        )


# ---------------------------------------------------------------- ELN

@router.get("/status")
async def labops_status(user: dict = Depends(require_user)) -> dict[str, Any]:
    tools = await asyncio.to_thread(_read_json, PIPELINE_ROOT / "tools.json", {})
    worker = await asyncio.to_thread(_read_json, PIPELINE_ROOT / "worker.json", {})
    return {"ok": True, "pipelines": tools or {}, "worker": worker or {}, "user": user.get("sub")}


@router.get("/eln/templates")
async def eln_templates(user: dict = Depends(require_user)) -> dict[str, Any]:
    await _ensure_templates()
    rows = await _q(
        "SELECT id, name, description, fields, builtin FROM labspace.labops_eln_templates "
        "WHERE builtin OR owner=%s ORDER BY builtin DESC, name",
        (user["sub"],),
    )
    return {"items": rows}


@router.post("/eln/templates")
async def eln_template_create(payload: dict, user: dict = Depends(require_user), _: None = Depends(require_csrf)) -> dict:
    tid = f"tpl-{_uid()[:10]}"
    await _x(
        "INSERT INTO labspace.labops_eln_templates (id, name, description, fields, owner) VALUES (%s,%s,%s,%s::jsonb,%s)",
        (tid, str(payload.get("name") or "自定义模板"), str(payload.get("description") or ""),
         json.dumps(payload.get("fields") or [], ensure_ascii=False), user["sub"]),
    )
    return {"id": tid}


@router.get("/eln/entries")
async def eln_entries(
    q: str = Query("", max_length=120),
    template: str = Query("", max_length=80),
    limit: int = Query(50, ge=1, le=200),
    user: dict = Depends(require_user),
) -> dict[str, Any]:
    where = ["owner=%s"]
    params: list[Any] = [user["sub"]]
    if q.strip():
        where.append("(title ILIKE %s OR tags::text ILIKE %s OR content::text ILIKE %s)")
        like = f"%{q.strip()}%"
        params += [like, like, like]
    if template:
        where.append("template_id=%s")
        params.append(template)
    rows = await _q(  # noqa: S608 - 条件片段固定白名单
        "SELECT id, owner, template_id, title, content, tags, status, links, entry_date, created_at, updated_at "  # noqa: S608 - 条件片段固定白名单
        f"FROM labspace.labops_eln_entries WHERE {' AND '.join(where)} ORDER BY entry_date DESC, updated_at DESC LIMIT %s",  # noqa: S608 - 条件片段固定白名单
        (*params, limit),
    )
    return {"items": rows}


async def _eln_get(entry_id: str, owner: str) -> dict[str, Any]:
    row = await _q_one("SELECT * FROM labspace.labops_eln_entries WHERE id=%s AND owner=%s", (entry_id, owner))
    if not row:
        raise HTTPException(status_code=404, detail="实验记录不存在")
    return row


@router.get("/eln/entries/{entry_id}")
async def eln_entry(entry_id: str, user: dict = Depends(require_user)) -> dict:
    return await _eln_get(entry_id, user["sub"])


@router.post("/eln/entries")
async def eln_entry_create(payload: dict, user: dict = Depends(require_user), _: None = Depends(require_csrf)) -> dict:
    eid = _uid()
    await _x(
        "INSERT INTO labspace.labops_eln_entries "
        "(id, owner, template_id, title, content, tags, status, links, entry_date) "
        "VALUES (%s,%s,%s,%s,%s::jsonb,%s,%s,%s::jsonb,COALESCE(%s::date,current_date))",
        (eid, user["sub"], payload.get("template_id") or None, str(payload.get("title") or "未命名记录"),
         json.dumps(payload.get("content") or {}, ensure_ascii=False),
         list(payload.get("tags") or []), str(payload.get("status") or "draft"),
         json.dumps(payload.get("links") or {}, ensure_ascii=False), payload.get("entry_date")),
    )
    return await _eln_get(eid, user["sub"])


@router.patch("/eln/entries/{entry_id}")
async def eln_entry_update(entry_id: str, payload: dict, user: dict = Depends(require_user), _: None = Depends(require_csrf)) -> dict:
    await _eln_get(entry_id, user["sub"])
    fields, params = [], []
    for key, _cast in (("template_id", ""), ("title", ""), ("status", "")):
        if key in payload:
            fields.append(f"{key}=%s")
            params.append(payload.get(key))
    for key in ("content", "links"):
        if key in payload:
            fields.append(f"{key}=%s::jsonb")
            params.append(json.dumps(payload.get(key) or {}, ensure_ascii=False))
    if "tags" in payload:
        fields.append("tags=%s")
        params.append(list(payload.get("tags") or []))
    if "entry_date" in payload:
        fields.append("entry_date=COALESCE(%s::date,current_date)")
        params.append(payload.get("entry_date"))
    if fields:
        params += [entry_id, user["sub"]]
        await _x(f"UPDATE labspace.labops_eln_entries SET {', '.join(fields)}, updated_at=now() "  # noqa: S608 - 字段名固定白名单
                 "WHERE id=%s AND owner=%s", tuple(params))
    return await _eln_get(entry_id, user["sub"])


@router.delete("/eln/entries/{entry_id}")
async def eln_entry_delete(entry_id: str, user: dict = Depends(require_user), _: None = Depends(require_csrf)) -> dict:
    await _eln_get(entry_id, user["sub"])
    await _x("DELETE FROM labspace.labops_eln_entries WHERE id=%s AND owner=%s", (entry_id, user["sub"]))
    return {"ok": True}


def _eln_markdown(entry: dict[str, Any]) -> str:
    tpl_name = ""
    content = entry.get("content") or {}
    lines = [f"# {entry.get('title') or '实验记录'}", "", f"- 日期：{entry.get('entry_date')}", f"- 模板：{tpl_name or entry.get('template_id') or '通用'}"]
    for key, value in content.items():
        if isinstance(value, (dict, list)):
            value = json.dumps(value, ensure_ascii=False)
        lines += ["", f"## {key}", "", str(value or "")]
    links = entry.get("links") or {}
    if links:
        lines += ["", "## 关联", ""]
        for k, v in links.items():
            lines.append(f"- {k}：{v}")
    return "\n".join(lines) + "\n"


@router.post("/eln/entries/{entry_id}/to-task")
async def eln_to_task(entry_id: str, user: dict = Depends(require_user), _: None = Depends(require_csrf)) -> dict:
    entry = await _eln_get(entry_id, user["sub"])
    tid = _uid()
    await _x(
        "INSERT INTO labspace.workbench_items (id, user_id, kind, title, content, source, tags) "
        "VALUES (%s,%s,'note',%s,%s,'eln',%s)",
        (tid, user["sub"], entry["title"], _eln_markdown(entry), ["ELN"]),
    )
    return {"id": tid}


@router.post("/eln/entries/{entry_id}/to-knowledge")
async def eln_to_knowledge(
    entry_id: str, background: BackgroundTasks, user: dict = Depends(require_user), _: None = Depends(require_csrf)
) -> dict:
    entry = await _eln_get(entry_id, user["sub"])
    rows = await _q(
        "INSERT INTO labspace.knowledge_docs (owner, owner_name, title, body, tags, visibility, source, category) "
        "VALUES (%s,%s,%s,%s,%s,'private','eln','实验记录') RETURNING id",
        (user["sub"], user.get("name") or user["sub"], entry["title"], _eln_markdown(entry),
         list(entry.get("tags") or []) + ["ELN"]),
    )
    doc_id = int(rows[0]["id"])
    background.add_task(semantic.index_doc, doc_id)
    return {"docId": doc_id}


# ---------------------------------------------------------------- 库存

@router.get("/inventory/items")
async def inventory_items(
    kind: str = Query("", max_length=20),
    q: str = Query("", max_length=120),
    low: bool = Query(False),
    user: dict = Depends(require_user),
) -> dict[str, Any]:
    where = ["1=1"]
    params: list[Any] = []
    if kind:
        where.append("kind=%s")
        params.append(kind)
    if q.strip():
        where.append("(name ILIKE %s OR code ILIKE %s OR location ILIKE %s)")
        like = f"%{q.strip()}%"
        params += [like, like, like]
    if low:
        where.append("quantity <= low_threshold")
    rows = await _q(  # noqa: S608 - 条件片段固定白名单
        "SELECT id, owner, kind, name, code, location, quantity::float8 AS quantity, unit, "  # noqa: S608 - 条件片段固定白名单
        "low_threshold::float8 AS low_threshold, metadata, notes, created_at, updated_at "
        f"FROM labspace.labops_inventory_items WHERE {' AND '.join(where)} ORDER BY updated_at DESC LIMIT 500",  # noqa: S608 - 条件片段固定白名单
        tuple(params),
    )
    return {"items": rows}


def _inv_code(kind: str) -> str:
    prefix = {"sample": "S", "plasmid": "P", "strain": "M", "consumable": "C"}.get(kind, "I")
    return f"{prefix}-{datetime.now().strftime('%y%m%d')}-{_uid()[:6].upper()}"


@router.post("/inventory/items")
async def inventory_create(payload: dict, user: dict = Depends(require_user), _: None = Depends(require_csrf)) -> dict:
    iid = _uid()
    kind = str(payload.get("kind") or "sample")
    code = str(payload.get("code") or "").strip() or _inv_code(kind)
    try:
        await _x(
            "INSERT INTO labspace.labops_inventory_items "
            "(id, owner, kind, name, code, location, quantity, unit, low_threshold, metadata, notes) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s)",
            (iid, user["sub"], kind, str(payload.get("name") or "未命名条目"), code,
             str(payload.get("location") or ""), float(payload.get("quantity") or 0),
             str(payload.get("unit") or "份"), float(payload.get("low_threshold") or 0),
             json.dumps(payload.get("metadata") or {}, ensure_ascii=False), str(payload.get("notes") or "")),
        )
    except Exception as exc:  # 唯一编号冲突
        raise HTTPException(status_code=409, detail=f"编号已存在：{code}") from exc
    if float(payload.get("quantity") or 0):
        await _x(
            "INSERT INTO labspace.labops_inventory_tx (item_id, owner, delta, kind, reason, operator) VALUES (%s,%s,%s,'in','初始入库',%s)",
            (iid, user["sub"], float(payload.get("quantity") or 0), user.get("name") or user["sub"]),
        )
    row = await _q_one("SELECT *, quantity::float8 AS quantity, low_threshold::float8 AS low_threshold "
                       "FROM labspace.labops_inventory_items WHERE id=%s", (iid,))
    return row or {}


@router.patch("/inventory/items/{item_id}")
async def inventory_update(item_id: str, payload: dict, user: dict = Depends(require_user), _: None = Depends(require_csrf)) -> dict:
    row = await _inv_get(item_id)
    if row["owner"] != user["sub"] and not has_role(user, ["lab-admin", "lab-teacher"]):
        raise HTTPException(status_code=403, detail="只有创建者或老师可修改")
    fields, params = [], []
    for key in ("name", "location", "unit", "notes", "kind", "metadata"):
        if key in payload:
            if key == "metadata":
                fields.append("metadata=%s::jsonb")
                params.append(json.dumps(payload.get(key) or {}, ensure_ascii=False))
            else:
                fields.append(f"{key}=%s")
                params.append(payload.get(key))
    for key in ("quantity", "low_threshold"):
        if key in payload:
            fields.append(f"{key}=%s")
            params.append(float(payload.get(key) or 0))
    if fields:
        params.append(item_id)
        await _x(f"UPDATE labspace.labops_inventory_items SET {', '.join(fields)}, updated_at=now() WHERE id=%s", tuple(params))  # noqa: S608 - 字段名固定白名单
    return await _inv_get(item_id)


async def _inv_get(item_id: str) -> dict[str, Any]:
    row = await _q_one(
        "SELECT *, quantity::float8 AS quantity, low_threshold::float8 AS low_threshold "
        "FROM labspace.labops_inventory_items WHERE id=%s", (item_id,)
    )
    if not row:
        raise HTTPException(status_code=404, detail="库存条目不存在")
    return row


@router.get("/inventory/items/{item_id}")
async def inventory_item(item_id: str, user: dict = Depends(require_user)) -> dict:
    return await _inv_get(item_id)


@router.post("/inventory/items/{item_id}/transactions")
async def inventory_tx(item_id: str, payload: dict, user: dict = Depends(require_user), _: None = Depends(require_csrf)) -> dict:
    item = await _inv_get(item_id)
    kind = str(payload.get("kind") or "out")
    delta = float(payload.get("delta") or 0)
    if kind in ("out", "loss"):
        delta = -abs(delta)
    else:
        delta = abs(delta)
    if delta == 0:
        raise HTTPException(status_code=422, detail="数量不能为 0")
    if float(item["quantity"]) + delta < 0:
        raise HTTPException(status_code=409, detail="库存不足")
    await _x(
        "INSERT INTO labspace.labops_inventory_tx (item_id, owner, delta, kind, reason, operator) "
        "VALUES (%s,%s,%s,%s,%s,%s)",
        (item_id, user["sub"], delta, kind, str(payload.get("reason") or ""), user.get("name") or user["sub"]),
    )
    await _x("UPDATE labspace.labops_inventory_items SET quantity=quantity+%s, updated_at=now() WHERE id=%s", (delta, item_id))
    return await _inv_get(item_id)


@router.get("/inventory/items/{item_id}/transactions")
async def inventory_txs(item_id: str, user: dict = Depends(require_user)) -> dict:
    await _inv_get(item_id)
    rows = await _q(
        "SELECT id, delta::float8 AS delta, kind, reason, operator, created_at "
        "FROM labspace.labops_inventory_tx WHERE item_id=%s ORDER BY created_at DESC LIMIT 200", (item_id,)
    )
    return {"items": rows}


@router.get("/inventory/items/{item_id}/label")
async def inventory_label(item_id: str, user: dict = Depends(require_user)) -> dict:
    item = await _inv_get(item_id)
    return {
        "code": item["code"],
        "name": item["name"],
        "kind": item["kind"],
        "location": item["location"],
        "payload": f"LABSPACE:INV:{item['code']}",
    }


@router.get("/inventory/low-count")
async def inventory_low(user: dict = Depends(require_user)) -> dict:
    rows = await _q(
        "SELECT id, name, code, quantity::float8 AS quantity, low_threshold::float8 AS low_threshold, unit "
        "FROM labspace.labops_inventory_items WHERE quantity <= low_threshold ORDER BY quantity"
    )
    return {"items": rows, "count": len(rows)}


@router.post("/inventory/publish", dependencies=[Depends(require_csrf)])
async def inventory_publish(user: dict = Depends(require_user)) -> dict[str, Any]:
    """把本地库存发布成多维表格工作区「实验室物资」（幂等，不改动本地数据）。"""
    return await inventory_baserow.publish(user)


# ---------------------------------------------------------------- 流水线

def _read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _pipeline_refs() -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    if SHARED_REFERENCE.is_dir():
        for path in SHARED_REFERENCE.rglob("*"):
            if path.is_file() and path.suffix.lower() in (".fa", ".fasta", ".fna", ".fa.gz", ".fasta.gz"):
                refs.append({"path": str(path), "name": path.name, "size": path.stat().st_size})
    for path in (PIPELINE_ROOT / "references").glob("*") if (PIPELINE_ROOT / "references").is_dir() else []:
        if path.is_file() and path.suffix.lower() in (".fa", ".fasta", ".fna", ".fa.gz", ".fasta.gz"):
            refs.append({"path": str(path), "name": path.name, "size": path.stat().st_size})
    return refs[:200]


def _pipeline_demos() -> list[dict[str, Any]]:
    demos: list[dict[str, Any]] = []
    if SHARED_RAW.is_dir():
        for folder in sorted(SHARED_RAW.iterdir()):
            if folder.is_dir():
                files = [p for p in sorted(folder.iterdir()) if p.is_file()]
                if files:
                    demos.append({
                        "name": folder.name,
                        "files": [{"path": str(p), "name": p.name, "size": p.stat().st_size} for p in files],
                    })
    return demos[:50]


@router.get("/pipelines/meta")
async def pipelines_meta(user: dict = Depends(require_user)) -> dict[str, Any]:
    tools = await asyncio.to_thread(_read_json, PIPELINE_ROOT / "tools.json", {})
    worker = await asyncio.to_thread(_read_json, PIPELINE_ROOT / "worker.json", {})
    return {
        "catalog": PIPELINE_CATALOG,
        "tools": tools.get("tools", tools) if isinstance(tools, dict) else {},
        "tools_checked_at": tools.get("checked_at") if isinstance(tools, dict) else None,
        "worker": worker,
        "references": _pipeline_refs(),
        "demos": _pipeline_demos(),
    }


def _job_public(job: dict[str, Any]) -> dict[str, Any]:
    workdir = Path(job["workdir"])
    status = _read_json(workdir / "status.json", {})
    if status:
        job = {**job,
               "status": status.get("status", job["status"]),
               "progress": status.get("progress", job.get("progress", 0)),
               "message": status.get("message", job.get("message", "")),
               "outputs": status.get("outputs", job.get("outputs", [])),
               "started_at": status.get("started_at", job.get("started_at")),
               "finished_at": status.get("finished_at", job.get("finished_at"))}
    return job


@router.get("/pipelines/jobs")
async def pipeline_jobs(limit: int = Query(50, ge=1, le=200), user: dict = Depends(require_user)) -> dict[str, Any]:
    rows = await _q(
        "SELECT id, owner, pipeline, name, params, status, progress, message, outputs, workdir, "
        "created_at, started_at, finished_at FROM labspace.labops_pipeline_jobs "
        "WHERE owner=%s ORDER BY created_at DESC LIMIT %s", (user["sub"], limit)
    )
    return {"items": [_job_public(r) for r in rows]}


@router.get("/pipelines/jobs/{job_id}")
async def pipeline_job(job_id: str, user: dict = Depends(require_user)) -> dict:
    row = await _q_one("SELECT * FROM labspace.labops_pipeline_jobs WHERE id=%s AND owner=%s", (job_id, user["sub"]))
    if not row:
        raise HTTPException(status_code=404, detail="任务不存在")
    return _job_public(row)


@router.get("/pipelines/jobs/{job_id}/log")
async def pipeline_log(job_id: str, user: dict = Depends(require_user)) -> PlainTextResponse:
    row = await _q_one("SELECT workdir, owner FROM labspace.labops_pipeline_jobs WHERE id=%s AND owner=%s", (job_id, user["sub"]))
    if not row:
        raise HTTPException(status_code=404, detail="任务不存在")
    log_path = Path(row["workdir"]) / "run.log"
    if log_path.is_file():
        text = await asyncio.to_thread(lambda: log_path.read_text(encoding="utf-8", errors="replace")[-200_000:])
    else:
        text = "任务尚未开始或暂无日志。"
    return PlainTextResponse(text)


@router.post("/pipelines/jobs")
async def pipeline_create(
    pipeline: str = Form(...),
    name: str = Form(""),
    reference: str = Form(""),
    demo: str = Form(""),
    inputs: str = Form("[]"),
    params: str = Form("{}"),
    files: list[UploadFile] = File(default=[]),
    user: dict = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict:
    catalog = {p["id"]: p for p in PIPELINE_CATALOG}
    if pipeline not in catalog:
        raise HTTPException(status_code=400, detail="未知流水线")
    job_id = _uid()
    workdir = PIPELINE_ROOT / job_id / "work"
    workdir.mkdir(parents=True, exist_ok=True)
    saved: list[str] = []

    # 共享演示数据：只允许复制已知路径，杜绝任意文件读取。
    # inputs 来自作业记录，可能是脏 JSON（手工改过、旧版本写入）——
    # 解析失败按"没有选中输入"处理，不要因此让整个作业 500。
    try:
        chosen_inputs = json.loads(inputs or "[]")
    except (TypeError, ValueError):
        chosen_inputs = []
    if not isinstance(chosen_inputs, list):
        chosen_inputs = []
    if demo:
        allowed = {f["path"] for d in _pipeline_demos() if d["name"] == demo for f in d["files"]}
        for idx, src in enumerate(chosen_inputs):
            if src not in allowed:
                continue
            target = workdir / f"input_{idx}_{_clean_name(Path(src).name)}"
            await asyncio.to_thread(shutil.copyfile, src, target)
            saved.append(str(target))

    for upload in files:
        if not upload.filename:
            continue
        target = workdir / _clean_name(upload.filename)
        size = 0
        try:
            with target.open("wb") as fh:
                while chunk := await upload.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_UPLOAD:
                        raise HTTPException(status_code=413, detail="单文件超过 2 GiB")
                    fh.write(chunk)
        finally:
            await upload.close()
        saved.append(str(target))

    ref_path = ""
    if reference:
        allowed_refs = {r["path"] for r in _pipeline_refs()}
        if reference not in allowed_refs:
            raise HTTPException(status_code=400, detail="参考基因组不在允许列表")
        ref_path = reference

    if not saved:
        raise HTTPException(status_code=422, detail="请上传输入数据或选择演示数据")
    if catalog[pipeline]["needs_reference"] and not ref_path:
        raise HTTPException(status_code=422, detail="该流程需要选择参考基因组")

    try:
        params_obj = json.loads(params or "{}")
    except ValueError:
        params_obj = {}
    payload = {"id": job_id, "pipeline": pipeline, "name": name or catalog[pipeline]["name"],
               "reference": ref_path, "inputs": saved, "params": params_obj,
               "created_at": datetime.now(UTC).isoformat()}
    _write_json(PIPELINE_ROOT / job_id / "job.json", payload)
    _write_json(PIPELINE_ROOT / job_id / "status.json", {"status": "queued", "progress": 0, "message": "等待执行"})
    await _x(
        "INSERT INTO labspace.labops_pipeline_jobs (id, owner, pipeline, name, params, workdir) "
        "VALUES (%s,%s,%s,%s,%s::jsonb,%s)",
        (job_id, user["sub"], pipeline, payload["name"], json.dumps(params_obj, ensure_ascii=False), str(workdir.parent)),
    )
    return _job_public({"id": job_id, "owner": user["sub"], "pipeline": pipeline, "name": payload["name"],
                        "params": params_obj, "status": "queued", "progress": 0, "message": "等待执行",
                        "outputs": [], "workdir": str(workdir.parent),
                        "created_at": payload["created_at"], "started_at": None, "finished_at": None})


@router.post("/pipelines/jobs/{job_id}/cancel")
async def pipeline_cancel(job_id: str, user: dict = Depends(require_user), _: None = Depends(require_csrf)) -> dict:
    row = await _q_one("SELECT workdir, status, owner FROM labspace.labops_pipeline_jobs WHERE id=%s AND owner=%s", (job_id, user["sub"]))
    if not row:
        raise HTTPException(status_code=404, detail="任务不存在")
    if row["status"] in ("succeeded", "failed", "cancelled"):
        return {"ok": True}
    _write_json(Path(row["workdir"]) / "cancel", {"at": datetime.now(UTC).isoformat()})
    await _x("UPDATE labspace.labops_pipeline_jobs SET status='cancelling', message='正在取消' WHERE id=%s", (job_id,))
    return {"ok": True}


@router.get("/pipelines/jobs/{job_id}/file")
async def pipeline_file(job_id: str, path: str = Query(...), user: dict = Depends(require_user)):
    row = await _q_one("SELECT workdir, owner FROM labspace.labops_pipeline_jobs WHERE id=%s AND owner=%s", (job_id, user["sub"]))
    if not row:
        raise HTTPException(status_code=404, detail="任务不存在")
    root = Path(row["workdir"]).resolve()
    work = root / "work"
    base = work if work.is_dir() else root
    target = (base / path).resolve()
    if base not in target.parents:
        raise HTTPException(status_code=403, detail="路径越界")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(target, filename=target.name)


# ---------------------------------------------------------------- 文献管理

def _strip_tags(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


async def _embed_literature(item_id: str, title: str, abstract: str, notes: str, owner: str) -> None:
    vector = await modelsvc.embed_one(f"{title}\n{abstract}\n{notes}")
    if not vector:
        return
    literal = "[" + ",".join(f"{float(x):.5f}" for x in vector) + "]"
    with contextlib.suppress(Exception):  # 语义能力缺失不应影响保存
        await _x("UPDATE labspace.labops_literature SET embedding=%s::vector WHERE id=%s AND owner=%s", (literal, item_id, owner))


# ---------------------------------------------------------------- 文献库（多库 + 文件夹）

LIBRARY_COLORS = ["#1677ff", "#52c41a", "#fa8c16", "#722ed1", "#eb2f96", "#13c2c2"]
DEFAULT_LIBRARY_NAME = "默认文献库"
ROOT_FOLDER = ""


def _default_library_id(owner: str) -> str:
    """默认库 id 由 owner 派生：同一用户永远得到同一个 id，幂等创建的前提。"""
    return "lib-default-" + hashlib.sha256(owner.encode("utf-8")).hexdigest()[:12]


async def _ensure_default_library(owner: str) -> str:
    """幂等创建用户的默认文献库，返回其 id。"""
    lid = _default_library_id(owner)
    await _x(
        "INSERT INTO labspace.literature_library (id, owner, name, description, color, is_default) "
        "VALUES (%s,%s,%s,'',%s,true) ON CONFLICT (id) DO NOTHING",
        (lid, owner, DEFAULT_LIBRARY_NAME, LIBRARY_COLORS[0]),
    )
    return lid


def _library_scope(owner: str, library_id: str) -> tuple[str, list[Any]]:
    """文献归属过滤条件。

    默认库同时容纳历史数据（library_id=''），所以旧文献不需要回填迁移。
    """
    default_id = _default_library_id(owner)
    if not library_id or library_id == default_id:
        return "(library_id=%s OR library_id='')", [default_id]
    return "library_id=%s", [library_id]


async def _library_or_404(owner: str, library_id: str) -> dict[str, Any]:
    row = await _q_one(
        "SELECT id, name, is_default FROM labspace.literature_library WHERE id=%s AND owner=%s",
        (library_id, owner),
    )
    if not row:
        raise HTTPException(status_code=404, detail="文献库不存在")
    return row


async def _folder_or_404(owner: str, folder_id: str) -> dict[str, Any]:
    row = await _q_one(
        "SELECT id, name, library_id, parent_id FROM labspace.literature_folder WHERE id=%s AND owner=%s",
        (folder_id, owner),
    )
    if not row:
        raise HTTPException(status_code=404, detail="文件夹不存在")
    return row


async def _resolve_library(owner: str, library_id: str) -> str:
    """校验目标文献库：空串表示默认库，返回入库用的真实库 id。"""
    await _ensure_default_library(owner)
    target = (library_id or "").strip() or _default_library_id(owner)
    await _library_or_404(owner, target)
    return target


async def _resolve_folder(owner: str, library_id: str, folder_id: str) -> str:
    """校验目标文件夹：必须属于同一 owner 且挂在目标文献库下。"""
    target = (folder_id or "").strip()
    if not target:
        return ROOT_FOLDER
    folder = await _folder_or_404(owner, target)
    if folder["library_id"] != library_id:
        raise HTTPException(status_code=422, detail="文件夹不属于目标文献库")
    return target


@router.get("/libraries")
async def library_list(user: dict = Depends(require_user)) -> dict[str, Any]:
    owner = user["sub"]
    default_id = await _ensure_default_library(owner)
    rows = await _q(
        "SELECT l.id, l.name, l.description, l.color, l.is_default, l.created_at, l.updated_at, "
        "(SELECT count(*) FROM labspace.labops_literature t WHERE t.owner=l.owner "
        " AND (t.library_id=l.id OR (l.is_default AND t.library_id=''))) AS item_count, "
        "(SELECT count(*) FROM labspace.literature_folder f WHERE f.owner=l.owner AND f.library_id=l.id) AS folder_count "
        "FROM labspace.literature_library l WHERE l.owner=%s ORDER BY l.is_default DESC, l.created_at",
        (owner,),
    )
    return {"items": rows, "defaultId": default_id}


@router.post("/libraries")
async def library_create(
    payload: dict, user: dict = Depends(require_user), _: None = Depends(require_csrf)
) -> dict[str, Any]:
    owner = user["sub"]
    await _ensure_default_library(owner)
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="请填写文献库名称")
    color = str(payload.get("color") or "").strip()
    if not color:
        counted = await _q_one("SELECT count(*) AS n FROM labspace.literature_library WHERE owner=%s", (owner,))
        color = LIBRARY_COLORS[int((counted or {}).get("n") or 0) % len(LIBRARY_COLORS)]
    lid = _uid()
    await _x(
        "INSERT INTO labspace.literature_library (id, owner, name, description, color, is_default) "
        "VALUES (%s,%s,%s,%s,%s,false)",
        (lid, owner, name[:80], str(payload.get("description") or "")[:500], color[:32]),
    )
    return {"id": lid}


@router.patch("/libraries/{library_id}")
async def library_update(
    library_id: str, payload: dict, user: dict = Depends(require_user), _: None = Depends(require_csrf)
) -> dict[str, Any]:
    owner = user["sub"]
    await _library_or_404(owner, library_id)
    fields, params = [], []
    if "name" in payload:
        name = str(payload.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=422, detail="请填写文献库名称")
        fields.append("name=%s")
        params.append(name[:80])
    if "description" in payload:
        fields.append("description=%s")
        params.append(str(payload.get("description") or "")[:500])
    if "color" in payload:
        fields.append("color=%s")
        params.append(str(payload.get("color") or "")[:32])
    if fields:
        params += [library_id, owner]
        await _x(
            f"UPDATE labspace.literature_library SET {', '.join(fields)}, updated_at=now() WHERE id=%s AND owner=%s",  # noqa: S608 - 字段名固定白名单
            tuple(params),
        )
    return await _q_one("SELECT * FROM labspace.literature_library WHERE id=%s AND owner=%s", (library_id, owner)) or {}


@router.delete("/libraries/{library_id}")
async def library_delete(
    library_id: str, move_to: str = Query("", max_length=64),
    user: dict = Depends(require_user), _: None = Depends(require_csrf),
) -> dict[str, Any]:
    """删除文献库。

    库里还有文献时必须显式指定 ``move_to``（目标文献库 id），否则 409——
    不能静默丢掉用户的文献。
    """
    owner = user["sub"]
    row = await _library_or_404(owner, library_id)
    if row["is_default"]:
        raise HTTPException(status_code=409, detail="默认文献库不可删除")
    counted = await _q_one(
        "SELECT count(*) AS n FROM labspace.labops_literature WHERE owner=%s AND library_id=%s",
        (owner, library_id),
    )
    total = int((counted or {}).get("n") or 0)
    if total:
        target = (move_to or "").strip()
        if not target:
            raise HTTPException(status_code=409, detail="该文献库仍有文献，请先选择要移动到的文献库")
        if target == library_id:
            raise HTTPException(status_code=422, detail="目标文献库不能是它自己")
        await _library_or_404(owner, target)
        await _x(
            "UPDATE labspace.labops_literature SET library_id=%s, folder_id='', updated_at=now() "
            "WHERE owner=%s AND library_id=%s",
            (target, owner, library_id),
        )
    await _x("DELETE FROM labspace.literature_folder WHERE owner=%s AND library_id=%s", (owner, library_id))
    await _x("DELETE FROM labspace.literature_library WHERE id=%s AND owner=%s", (library_id, owner))
    return {"ok": True, "moved": total}


@router.get("/libraries/{library_id}/folders")
async def folder_list(library_id: str, user: dict = Depends(require_user)) -> dict[str, Any]:
    owner = user["sub"]
    await _library_or_404(owner, library_id)
    rows = await _q(
        "SELECT f.id, f.name, f.library_id, f.parent_id, f.created_at, f.updated_at, "
        "(SELECT count(*) FROM labspace.labops_literature t WHERE t.owner=f.owner AND t.folder_id=f.id) AS item_count "
        "FROM labspace.literature_folder f WHERE f.owner=%s AND f.library_id=%s ORDER BY f.created_at",
        (owner, library_id),
    )
    return {"items": rows}


@router.post("/libraries/{library_id}/folders")
async def folder_create(
    library_id: str, payload: dict, user: dict = Depends(require_user), _: None = Depends(require_csrf)
) -> dict[str, Any]:
    owner = user["sub"]
    await _library_or_404(owner, library_id)
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="请填写文件夹名称")
    parent_id = str(payload.get("parent_id") or "").strip()
    if parent_id:
        parent = await _folder_or_404(owner, parent_id)
        if parent["library_id"] != library_id:
            raise HTTPException(status_code=422, detail="父文件夹不属于该文献库")
    fid = _uid()
    await _x(
        "INSERT INTO labspace.literature_folder (id, owner, library_id, parent_id, name) VALUES (%s,%s,%s,%s,%s)",
        (fid, owner, library_id, parent_id, name[:120]),
    )
    return {"id": fid}


@router.patch("/folders/{folder_id}")
async def folder_update(
    folder_id: str, payload: dict, user: dict = Depends(require_user), _: None = Depends(require_csrf)
) -> dict[str, Any]:
    owner = user["sub"]
    folder = await _folder_or_404(owner, folder_id)
    fields, params = [], []
    if "name" in payload:
        name = str(payload.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=422, detail="请填写文件夹名称")
        fields.append("name=%s")
        params.append(name[:120])
    if "parent_id" in payload:
        parent_id = str(payload.get("parent_id") or "").strip()
        if parent_id:
            if parent_id == folder_id:
                raise HTTPException(status_code=422, detail="文件夹不能作为自己的父级")
            parent = await _folder_or_404(owner, parent_id)
            if parent["library_id"] != folder["library_id"]:
                raise HTTPException(status_code=422, detail="父文件夹不属于同一文献库")
            await _assert_not_descendant(owner, folder_id, parent_id)
        fields.append("parent_id=%s")
        params.append(parent_id)
    if fields:
        params += [folder_id, owner]
        await _x(
            f"UPDATE labspace.literature_folder SET {', '.join(fields)}, updated_at=now() WHERE id=%s AND owner=%s",  # noqa: S608 - 字段名固定白名单
            tuple(params),
        )
    return await _q_one("SELECT * FROM labspace.literature_folder WHERE id=%s AND owner=%s", (folder_id, owner)) or {}


async def _assert_not_descendant(owner: str, folder_id: str, parent_id: str) -> None:
    """父级不能是自身后代，否则文件夹树会成环。"""
    current = parent_id
    for _ in range(64):
        row = await _q_one(
            "SELECT id, parent_id FROM labspace.literature_folder WHERE id=%s AND owner=%s",
            (current, owner),
        )
        if not row:
            return
        if row["id"] == folder_id:
            raise HTTPException(status_code=422, detail="不能把文件夹移动到它自己的子目录里")
        current = str(row["parent_id"] or "")
        if not current:
            return
    raise HTTPException(status_code=422, detail="文件夹层级过深")


@router.delete("/folders/{folder_id}")
async def folder_delete(
    folder_id: str, move_to: str = Query("", max_length=64),
    user: dict = Depends(require_user), _: None = Depends(require_csrf),
) -> dict[str, Any]:
    """删除文件夹。

    文件夹里还有文献或子文件夹时必须显式指定 ``move_to``：
    ``root`` 表示移到库根目录（未分类），否则是目标文件夹 id。
    """
    owner = user["sub"]
    folder = await _folder_or_404(owner, folder_id)
    library_id = folder["library_id"]
    items = await _q_one(
        "SELECT count(*) AS n FROM labspace.labops_literature WHERE owner=%s AND folder_id=%s",
        (owner, folder_id),
    )
    children = await _q_one(
        "SELECT count(*) AS n FROM labspace.literature_folder WHERE owner=%s AND parent_id=%s",
        (owner, folder_id),
    )
    item_count = int((items or {}).get("n") or 0)
    child_count = int((children or {}).get("n") or 0)
    if item_count or child_count:
        target = (move_to or "").strip()
        if not target:
            raise HTTPException(status_code=409, detail="该文件夹非空，请先选择文献/子文件夹的去处")
        if target == "root":
            await _x(
                "UPDATE labspace.labops_literature SET folder_id='', updated_at=now() WHERE owner=%s AND folder_id=%s",
                (owner, folder_id),
            )
            await _x(
                "UPDATE labspace.literature_folder SET parent_id='', updated_at=now() WHERE owner=%s AND parent_id=%s",
                (owner, folder_id),
            )
        else:
            if target == folder_id:
                raise HTTPException(status_code=422, detail="目标文件夹不能是它自己")
            dest = await _folder_or_404(owner, target)
            if dest["library_id"] != library_id:
                raise HTTPException(status_code=422, detail="目标文件夹不属于同一文献库")
            await _assert_not_descendant(owner, folder_id, target)
            await _x(
                "UPDATE labspace.labops_literature SET folder_id=%s, updated_at=now() WHERE owner=%s AND folder_id=%s",
                (target, owner, folder_id),
            )
            await _x(
                "UPDATE labspace.literature_folder SET parent_id=%s, updated_at=now() WHERE owner=%s AND parent_id=%s",
                (target, owner, folder_id),
            )
    await _x("DELETE FROM labspace.literature_folder WHERE id=%s AND owner=%s", (folder_id, owner))
    return {"ok": True, "moved": item_count}


@router.post("/literature/move")
async def literature_move(
    payload: dict, user: dict = Depends(require_user), _: None = Depends(require_csrf)
) -> dict[str, Any]:
    """批量移动文献到指定文献库 / 文件夹。"""
    owner = user["sub"]
    ids = [str(x) for x in (payload.get("ids") or []) if str(x)]
    if not ids:
        raise HTTPException(status_code=422, detail="请选择要移动的文献")
    library_id = str(payload.get("libraryId") or payload.get("library_id") or "")
    folder_id = str(payload.get("folderId") or payload.get("folder_id") or "")
    target_library = await _resolve_library(owner, library_id)
    target_folder = await _resolve_folder(owner, target_library, folder_id)
    await _x(
        "UPDATE labspace.labops_literature SET library_id=%s, folder_id=%s, updated_at=now() "
        "WHERE owner=%s AND id = ANY(%s)",
        (target_library, target_folder, owner, ids),
    )
    return {"ok": True, "moved": len(ids)}


@router.get("/literature")
async def literature_list(
    q: str = Query("", max_length=120),
    status: str = Query("", max_length=20),
    library_id: str = Query("", max_length=64),
    folder_id: str | None = Query(None, max_length=64),
    limit: int = Query(100, ge=1, le=300),
    user: dict = Depends(require_user),
) -> dict[str, Any]:
    owner = user["sub"]
    where = ["owner=%s"]
    params: list[Any] = [owner]
    if q.strip():
        where.append("(title ILIKE %s OR abstract ILIKE %s OR notes ILIKE %s OR doi ILIKE %s)")
        like = f"%{q.strip()}%"
        params += [like, like, like, like]
    if status:
        where.append("status=%s")
        params.append(status)
    scope, scope_params = _library_scope(owner, library_id)
    where.append(scope)
    params += scope_params
    if folder_id is not None:
        where.append("folder_id=%s")
        params.append(folder_id)
    rows = await _q(  # noqa: S608 - 条件片段固定白名单
        "SELECT id, doi, title, authors, journal, pub_year, abstract, url, tags, notes, status, "  # noqa: S608 - 条件片段固定白名单
        "library_id, folder_id, created_at, updated_at "
        f"FROM labspace.labops_literature WHERE {' AND '.join(where)} ORDER BY updated_at DESC LIMIT %s",  # noqa: S608 - 条件片段固定白名单
        (*params, limit),
    )
    return {"items": rows}


@router.get("/literature/search")
async def literature_search(q: str = Query(..., min_length=1, max_length=200), user: dict = Depends(require_user)) -> dict:
    keyword = await _q(
        "SELECT id, doi, title, authors, journal, pub_year, abstract, notes, tags, status, "
        "updated_at, 0.0::float8 AS score, 'keyword' AS mode FROM labspace.labops_literature "
        "WHERE owner=%s AND (title ILIKE %s OR abstract ILIKE %s OR notes ILIKE %s OR doi ILIKE %s) "
        "ORDER BY updated_at DESC LIMIT 50",
        (user["sub"], f"%{q}%", f"%{q}%", f"%{q}%", f"%{q}%"),
    )
    semantic_rows: list[dict[str, Any]] = []
    vector = await modelsvc.embed_one(q)
    if vector:
        literal = "[" + ",".join(f"{float(x):.5f}" for x in vector) + "]"
        try:
            semantic_rows = await _q(
                "SELECT id, doi, title, authors, journal, pub_year, abstract, notes, tags, status, updated_at, "
                "1 - (embedding <=> %s::vector) AS score, 'semantic' AS mode FROM labspace.labops_literature "
                "WHERE owner=%s AND embedding IS NOT NULL ORDER BY embedding <=> %s::vector LIMIT 50",
                (literal, user["sub"], literal),
            )
        except Exception:  # noqa: BLE001
            semantic_rows = []
    merged: dict[str, dict[str, Any]] = {}
    for row in keyword + semantic_rows:
        old = merged.get(row["id"])
        if not old or float(row.get("score") or 0) > float(old.get("score") or 0):
            merged[row["id"]] = row
    items = sorted(merged.values(), key=lambda r: float(r.get("score") or 0), reverse=True)[:80]
    return {"items": items, "semantic": bool(semantic_rows), "mode": "hybrid" if semantic_rows else "keyword"}


async def _crossref(doi: str) -> dict[str, Any]:
    url = f"https://api.crossref.org/works/{doi}"
    async with httpx.AsyncClient(timeout=18, headers={"User-Agent": "LabSpace/1.0 (mailto:lab@example.invalid)"}) as client:
        resp = await client.get(url)
    if resp.status_code != 200:
        raise HTTPException(status_code=404, detail="Crossref 未找到该 DOI")
    msg = resp.json().get("message", {})
    authors = []
    for a in msg.get("author", [])[:20]:
        name = " ".join(x for x in (a.get("given"), a.get("family")) if x)
        if name:
            authors.append(name)
    year = ""
    for key in ("published-print", "published-online", "issued"):
        parts = (msg.get(key) or {}).get("date-parts") or []
        if parts and parts[0]:
            year = str(parts[0][0])
            break
    return {
        "doi": doi,
        "title": _strip_tags((msg.get("title") or [""])[0]),
        "authors": ", ".join(authors),
        "journal": _strip_tags((msg.get("container-title") or [""])[0]),
        "pub_year": year,
        "abstract": _strip_tags(msg.get("abstract") or ""),
        "url": msg.get("URL") or f"https://doi.org/{doi}",
    }


@router.post("/literature/import/batch")
async def literature_import_batch(
    payload: dict,
    background: BackgroundTasks,
    user: dict = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict:
    """批量导入 DOI。

    为什么单独开一个端点而不是让前端循环调单条：
      * 用户从 Excel/EndNote 里一次粘 50 条 DOI 是常见操作，前端循环会打出
        50 个并发请求、并且中途失败时只能看到一个笼统的报错；
      * 这里**逐条独立处理**，任一条失败不影响其它条，最后返回逐条结果
        （成功/重复/未找到/解析失败），用户可以精确知道哪几条没进来。

    输入接受 `dois: string[]` 或 `text: string`（任意分隔：换行/逗号/空格/分号，
    也容忍 ``https://doi.org/`` 前缀与尾部标点）。
    """
    raw: list[str] = []
    if isinstance(payload.get("dois"), list):
        raw = [str(x) for x in payload["dois"]]
    elif payload.get("text"):
        # 用非 DOI 字符切分：DOI 允许的字符集里没有 , ; 空白
        raw = re.split(r"[\s,;，；、]+", str(payload["text"]))

    cleaned: list[str] = []
    seen: set[str] = set()
    for item in raw:
        doi = re.sub(r"^https?://(dx\.)?doi\.org/", "", item.strip(), flags=re.I)
        doi = doi.strip().rstrip(".,;)）】").lower()
        # DOI 必须以 10. 开头；不合规的直接跳过，不去打 Crossref
        if not re.match(r"^10\.\d{4,9}/\S+$", doi):
            continue
        if doi in seen:
            continue
        seen.add(doi)
        cleaned.append(doi)

    if not cleaned:
        raise HTTPException(status_code=422, detail="没有识别到合法的 DOI（需形如 10.xxxx/yyyy）")
    if len(cleaned) > 200:
        raise HTTPException(status_code=422, detail=f"一次最多导入 200 条（收到 {len(cleaned)} 条）")

    library = await _resolve_library(user["sub"], str(payload.get("library_id") or ""))
    folder = await _resolve_folder(user["sub"], library, str(payload.get("folder_id") or ""))
    tags = list(payload.get("tags") or [])

    results: list[dict[str, Any]] = []
    imported = 0
    for doi in cleaned:
        try:
            meta = await _crossref(doi)
        except HTTPException as exc:
            results.append({"doi": doi, "status": "failed", "reason": str(exc.detail)})
            continue
        except Exception as exc:  # noqa: BLE001
            results.append({"doi": doi, "status": "failed", "reason": f"{type(exc).__name__}"})
            continue
        if not meta.get("title"):
            results.append({"doi": doi, "status": "not-found", "reason": "Crossref 没有该 DOI 的元数据"})
            continue
        existing = await _q_one(
            "SELECT id FROM labspace.labops_literature WHERE owner=%s AND doi=%s",
            (user["sub"], meta["doi"]),
        )
        if existing:
            results.append({"doi": doi, "status": "duplicate", "id": existing["id"]})
            continue
        lid = _uid()
        await _x(
            "INSERT INTO labspace.labops_literature (id, owner, doi, title, authors, journal, pub_year, "
            "abstract, url, tags, library_id, folder_id) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                lid, user["sub"], meta["doi"], meta["title"], meta["authors"], meta["journal"],
                meta["pub_year"], meta["abstract"], meta["url"], tags, library, folder,
            ),
        )
        background.add_task(_embed_literature, lid, meta["title"], meta["abstract"], "", user["sub"])
        imported += 1
        results.append({"doi": doi, "status": "imported", "id": lid, "title": meta["title"]})

    return {
        "ok": True,
        "total": len(cleaned),
        "imported": imported,
        "duplicate": sum(1 for r in results if r["status"] == "duplicate"),
        "failed": sum(1 for r in results if r["status"] in ("failed", "not-found")),
        "results": results,
    }


@router.post("/literature/import")
async def literature_import(
    payload: dict, background: BackgroundTasks, user: dict = Depends(require_user), _: None = Depends(require_csrf)
) -> dict:
    doi = re.sub(r"^https?://(dx\.)?doi\.org/", "", str(payload.get("doi") or "").strip(), flags=re.I)
    meta: dict[str, Any]
    if doi:
        meta = await _crossref(doi)
    else:
        meta = {k: str(payload.get(k) or "") for k in ("title", "authors", "journal", "pub_year", "abstract", "url")}
        meta["doi"] = ""
        if not meta["title"]:
            raise HTTPException(status_code=422, detail="请填写 DOI 或标题")
    existing = await _q_one("SELECT id FROM labspace.labops_literature WHERE owner=%s AND doi=%s AND doi<>''", (user["sub"], meta["doi"]))
    if existing:
        return {"id": existing["id"], "duplicate": True}
    lid = _uid()
    target_library = await _resolve_library(user["sub"], str(payload.get("library_id") or ""))
    target_folder = await _resolve_folder(user["sub"], target_library, str(payload.get("folder_id") or ""))
    await _x(
        "INSERT INTO labspace.labops_literature (id, owner, doi, title, authors, journal, pub_year, abstract, url, tags, "
        "library_id, folder_id) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (lid, user["sub"], meta["doi"], meta["title"], meta["authors"], meta["journal"],
         meta["pub_year"], meta["abstract"], meta["url"], list(payload.get("tags") or []),
         target_library, target_folder),
    )
    background.add_task(_embed_literature, lid, meta["title"], meta["abstract"], "", user["sub"])
    return {"id": lid, "duplicate": False}


@router.patch("/literature/{item_id}")
async def literature_update(
    item_id: str, payload: dict, background: BackgroundTasks,
    user: dict = Depends(require_user), _: None = Depends(require_csrf)
) -> dict:
    row = await _q_one("SELECT * FROM labspace.labops_literature WHERE id=%s AND owner=%s", (item_id, user["sub"]))
    if not row:
        raise HTTPException(status_code=404, detail="文献不存在")
    fields, params = [], []
    for key in ("title", "authors", "journal", "pub_year", "abstract", "notes", "status", "url"):
        if key in payload:
            fields.append(f"{key}=%s")
            params.append(str(payload.get(key) or ""))
    if "tags" in payload:
        fields.append("tags=%s")
        params.append(list(payload.get("tags") or []))
    if "library_id" in payload or "folder_id" in payload:
        library_id = str(payload.get("library_id") if "library_id" in payload else row["library_id"] or "")
        folder_id = str(payload.get("folder_id") if "folder_id" in payload else row["folder_id"] or "")
        target_library = await _resolve_library(user["sub"], library_id)
        target_folder = await _resolve_folder(user["sub"], target_library, folder_id)
        fields += ["library_id=%s", "folder_id=%s"]
        params += [target_library, target_folder]
    if fields:
        params += [item_id, user["sub"]]
        await _x(f"UPDATE labspace.labops_literature SET {', '.join(fields)}, updated_at=now() WHERE id=%s AND owner=%s", tuple(params))  # noqa: S608 - 字段名固定白名单
    # 笔记变更后重建向量
    background.add_task(_embed_literature, item_id, payload.get("title", row["title"]),
                        payload.get("abstract", row["abstract"]), payload.get("notes", row["notes"]), user["sub"])
    return await _q_one("SELECT * FROM labspace.labops_literature WHERE id=%s", (item_id,)) or {}


@router.delete("/literature/{item_id}")
async def literature_delete(item_id: str, user: dict = Depends(require_user), _: None = Depends(require_csrf)) -> dict:
    await _x("DELETE FROM labspace.labops_literature WHERE id=%s AND owner=%s", (item_id, user["sub"]))
    return {"ok": True}


def _citation(row: dict[str, Any], style: str) -> str:
    title = row.get("title") or ""
    authors = row.get("authors") or ""
    journal = row.get("journal") or ""
    year = row.get("pub_year") or "n.d."
    doi = row.get("doi") or ""
    if style == "bibtex":
        key = re.sub(r"[^A-Za-z0-9]", "", (authors.split(",")[0] or title)[:20]) or "ref"
        return ("@article{" + key + year + ",\n  title = {" + title + "},\n  author = {" + authors +
                "},\n  journal = {" + journal + "},\n  year = {" + year + "},\n  doi = {" + doi + "}\n}\n")
    if style == "ris":
        return ("TY  - JOUR\nTI  - " + title + "\nAU  - " + authors.replace(", ", "\nAU  - ") +
                "\nJO  - " + journal + "\nPY  - " + year + "\nDO  - " + doi + "\nER  - \n")
    if style == "apa":
        return f"{authors} ({year}). {title}. {journal}. https://doi.org/{doi}" if doi else f"{authors} ({year}). {title}. {journal}."
    # GB/T 7714
    return f"{authors}. {title}[J]. {journal}, {year}. DOI:{doi}." if doi else f"{authors}. {title}[J]. {journal}, {year}."


@router.get("/literature/export")
async def literature_export(ids: str = Query(""), style: str = Query("bibtex"), user: dict = Depends(require_user)) -> PlainTextResponse:
    wanted = [x for x in ids.split(",") if x]
    if wanted:
        rows = await _q("SELECT * FROM labspace.labops_literature WHERE owner=%s AND id = ANY(%s) ORDER BY created_at", (user["sub"], wanted))
    else:
        rows = await _q("SELECT * FROM labspace.labops_literature WHERE owner=%s ORDER BY created_at", (user["sub"],))
    text = "\n".join(_citation(r, style) for r in rows)
    return PlainTextResponse(text, headers={"Content-Disposition": f'attachment; filename="references.{style}"'})


@router.get("/literature/{item_id}/citation")
async def literature_citation(item_id: str, style: str = Query("gbt7714"), user: dict = Depends(require_user)) -> PlainTextResponse:
    row = await _q_one("SELECT * FROM labspace.labops_literature WHERE id=%s AND owner=%s", (item_id, user["sub"]))
    if not row:
        raise HTTPException(status_code=404, detail="文献不存在")
    return PlainTextResponse(_citation(row, style))


# ---------------------------------------------------------------- 预约与申领

def _can_approve(user: dict, owner: str | None = None) -> bool:
    return has_role(user, ["lab-admin", "lab-teacher"]) or (owner is not None and owner == user["sub"])


async def _ensure_resources() -> None:
    rows = await _q("SELECT count(*) AS n FROM labspace.labops_resources")
    if rows and int(rows[0]["n"]) > 0:
        return
    default = [
        ("res-pcr", "PCR 仪", "instrument", "A-201", "96 孔梯度 PCR 仪"),
        ("res-centrifuge", "高速冷冻离心机", "instrument", "A-105", "最大 21000 rpm"),
        ("res-microscope", "荧光显微镜", "instrument", "B-301", "正置荧光显微镜"),
    ]
    for rid, name, kind, loc, desc in default:
        await _x(
            "INSERT INTO labspace.labops_resources (id, owner, kind, name, description, location) "
            "VALUES (%s,'lab',%s,%s,%s,%s) ON CONFLICT (id) DO NOTHING",
            (rid, kind, name, desc, loc),
        )


@router.get("/resources")
async def resources(user: dict = Depends(require_user)) -> dict:
    await _ensure_resources()
    rows = await _q(
        "SELECT r.*, (SELECT count(*) FROM labspace.labops_bookings b "
        "WHERE b.resource_id=r.id AND b.status='approved' AND b.end_at>now()) AS upcoming "
        "FROM labspace.labops_resources r WHERE active ORDER BY kind, name"
    )
    return {"items": rows}


@router.post("/resources")
async def resource_create(payload: dict, user: dict = Depends(require_user), _: None = Depends(require_csrf)) -> dict:
    if not _can_approve(user):
        raise HTTPException(status_code=403, detail="需要老师或管理员权限")
    rid = _uid()
    await _x(
        "INSERT INTO labspace.labops_resources (id, owner, kind, name, description, location, capacity) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s)",
        (rid, user["sub"], str(payload.get("kind") or "instrument"), str(payload.get("name") or "未命名资源"),
         str(payload.get("description") or ""), str(payload.get("location") or ""), int(payload.get("capacity") or 1)),
    )
    return {"id": rid}


@router.get("/bookings")
async def bookings(
    resource: str = Query("", max_length=80),
    start: str = Query(""),
    end: str = Query(""),
    limit: int = Query(300, ge=1, le=500),
    user: dict = Depends(require_user),
) -> dict:
    where = ["1=1"]
    params: list[Any] = []
    if resource:
        where.append("b.resource_id=%s")
        params.append(resource)
    if start:
        where.append("b.end_at >= %s::timestamptz")
        params.append(start)
    if end:
        where.append("b.start_at <= %s::timestamptz")
        params.append(end)
    rows = await _q(  # noqa: S608 - 条件片段固定白名单
        "SELECT b.*, r.name AS resource_name, r.location FROM labspace.labops_bookings b "  # noqa: S608 - 条件片段固定白名单
        "JOIN labspace.labops_resources r ON r.id=b.resource_id "
        f"WHERE {' AND '.join(where)} ORDER BY b.start_at DESC LIMIT %s",  # noqa: S608 - 条件片段固定白名单
        (*params, limit),
    )
    return {"items": rows, "canApprove": _can_approve(user)}


@router.post("/bookings")
async def booking_create(payload: dict, user: dict = Depends(require_user), _: None = Depends(require_csrf)) -> dict:
    resource_id = str(payload.get("resource_id") or "")
    try:
        start_at = datetime.fromisoformat(str(payload.get("start_at")).replace("Z", "+00:00"))
        end_at = datetime.fromisoformat(str(payload.get("end_at")).replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="时间格式错误") from exc
    if end_at <= start_at:
        raise HTTPException(status_code=422, detail="结束时间必须晚于开始时间")
    if (end_at - start_at).total_seconds() > 24 * 3600:
        raise HTTPException(status_code=422, detail="单次预约不能超过 24 小时")
    res = await _q_one("SELECT * FROM labspace.labops_resources WHERE id=%s AND active", (resource_id,))
    if not res:
        raise HTTPException(status_code=404, detail="仪器不存在")
    conflict = await _q_one(
        "SELECT id, owner, start_at, end_at FROM labspace.labops_bookings "
        "WHERE resource_id=%s AND status IN ('pending','approved') AND start_at < %s AND end_at > %s LIMIT 1",
        (resource_id, end_at, start_at),
    )
    if conflict:
        raise HTTPException(status_code=409, detail=f"时段冲突：{conflict['start_at']} — {conflict['end_at']}")
    bid = _uid()
    status = "approved" if _can_approve(user, res["owner"]) else "pending"
    await _x(
        "INSERT INTO labspace.labops_bookings (id, resource_id, owner, start_at, end_at, purpose, status, approver, decided_at) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,CASE WHEN %s='approved' THEN now() END)",
        (bid, resource_id, user["sub"], start_at, end_at, str(payload.get("purpose") or ""), status,
         user.get("name") or user["sub"], status),
    )
    return {"id": bid, "status": status}


@router.post("/bookings/{booking_id}/decide")
async def booking_decide(booking_id: str, payload: dict, user: dict = Depends(require_user), _: None = Depends(require_csrf)) -> dict:
    row = await _q_one(
        "SELECT b.*, r.owner AS resource_owner FROM labspace.labops_bookings b "
        "JOIN labspace.labops_resources r ON r.id=b.resource_id WHERE b.id=%s", (booking_id,)
    )
    if not row:
        raise HTTPException(status_code=404, detail="预约不存在")
    if not _can_approve(user, row["resource_owner"]):
        raise HTTPException(status_code=403, detail="无权审批")
    decision = str(payload.get("decision") or "")
    if decision not in ("approved", "rejected"):
        raise HTTPException(status_code=422, detail="decision 必须为 approved/rejected")
    if decision == "approved":
        conflict = await _q_one(
            "SELECT id FROM labspace.labops_bookings WHERE resource_id=%s AND id<>%s AND status='approved' "
            "AND start_at < %s AND end_at > %s LIMIT 1",
            (row["resource_id"], booking_id, row["end_at"], row["start_at"]),
        )
        if conflict:
            raise HTTPException(status_code=409, detail="该时段已有已批准预约，不能重复批准")
    await _x(
        "UPDATE labspace.labops_bookings SET status=%s, approver=%s, feedback=%s, decided_at=now() WHERE id=%s",
        (decision, user.get("name") or user["sub"], str(payload.get("feedback") or ""), booking_id),
    )
    return {"ok": True, "status": decision}


@router.post("/bookings/{booking_id}/cancel")
async def booking_cancel(booking_id: str, user: dict = Depends(require_user), _: None = Depends(require_csrf)) -> dict:
    row = await _q_one("SELECT owner FROM labspace.labops_bookings WHERE id=%s", (booking_id,))
    if not row:
        raise HTTPException(status_code=404, detail="预约不存在")
    if row["owner"] != user["sub"] and not _can_approve(user):
        raise HTTPException(status_code=403, detail="无权取消")
    await _x("UPDATE labspace.labops_bookings SET status='cancelled', decided_at=now() WHERE id=%s", (booking_id,))
    return {"ok": True}


@router.get("/supplies")
async def supplies(user: dict = Depends(require_user)) -> dict:
    rows = await _q(
        "SELECT s.*, i.name AS item_name, i.code, i.unit, i.quantity::float8 AS stock "
        "FROM labspace.labops_supply_requests s LEFT JOIN labspace.labops_inventory_items i ON i.id=s.item_id "
        "ORDER BY s.created_at DESC LIMIT 300"
    )
    return {"items": rows, "canApprove": _can_approve(user)}


@router.post("/supplies")
async def supply_create(payload: dict, user: dict = Depends(require_user), _: None = Depends(require_csrf)) -> dict:
    item = await _inv_get(str(payload.get("item_id") or ""))
    qty = float(payload.get("quantity") or 1)
    if qty <= 0:
        raise HTTPException(status_code=422, detail="申领数量必须大于 0")
    sid = _uid()
    await _x(
        "INSERT INTO labspace.labops_supply_requests (id, item_id, owner, quantity, reason) VALUES (%s,%s,%s,%s,%s)",
        (sid, item["id"], user["sub"], qty, str(payload.get("reason") or "")),
    )
    return {"id": sid, "status": "pending"}


@router.post("/supplies/{request_id}/decide")
async def supply_decide(request_id: str, payload: dict, user: dict = Depends(require_user), _: None = Depends(require_csrf)) -> dict:
    if not _can_approve(user):
        raise HTTPException(status_code=403, detail="需要老师或管理员权限")
    row = await _q_one("SELECT * FROM labspace.labops_supply_requests WHERE id=%s", (request_id,))
    if not row:
        raise HTTPException(status_code=404, detail="申领不存在")
    decision = str(payload.get("decision") or "")
    if decision not in ("approved", "rejected"):
        raise HTTPException(status_code=422, detail="decision 必须为 approved/rejected")
    if decision == "approved":
        item = await _inv_get(row["item_id"])
        if float(item["quantity"]) < float(row["quantity"]):
            raise HTTPException(status_code=409, detail="库存不足，无法批准")
        await _x(
            "INSERT INTO labspace.labops_inventory_tx (item_id, owner, delta, kind, reason, operator) "
            "VALUES (%s,%s,%s,'out','耗材申领',%s)",
            (row["item_id"], row["owner"], -float(row["quantity"]), user.get("name") or user["sub"]),
        )
        await _x("UPDATE labspace.labops_inventory_items SET quantity=quantity-%s, updated_at=now() WHERE id=%s",
                 (float(row["quantity"]), row["item_id"]))
    await _x(
        "UPDATE labspace.labops_supply_requests SET status=%s, approver=%s, feedback=%s, decided_at=now() WHERE id=%s",
        (decision, user.get("name") or user["sub"], str(payload.get("feedback") or ""), request_id),
    )
    return {"ok": True, "status": decision}
