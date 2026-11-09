"""实验室延伸功能：ELN、库存、流水线、文献管理、仪器预约与耗材申领。

所有个人数据按 ``owner`` 隔离；实验室共享的库存台账、仪器与预约允许所有登录用户
查看，写操作仍记录操作者，审批仅限 lab-admin / lab-teacher 或资源创建者。
"""
from __future__ import annotations

import asyncio
import html
import json
import os
import re
import shutil
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse

from . import db, modelsvc, semantic
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
    rows = await _q(
        "SELECT id, owner, template_id, title, content, tags, status, links, entry_date, created_at, updated_at "
        f"FROM labspace.labops_eln_entries WHERE {' AND '.join(where)} ORDER BY entry_date DESC, updated_at DESC LIMIT %s",
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
    for key, cast in (("template_id", ""), ("title", ""), ("status", "")):
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
        await _x(f"UPDATE labspace.labops_eln_entries SET {', '.join(fields)}, updated_at=now() "
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
    rows = await _q(
        "SELECT id, owner, kind, name, code, location, quantity::float8 AS quantity, unit, "
        "low_threshold::float8 AS low_threshold, metadata, notes, created_at, updated_at "
        f"FROM labspace.labops_inventory_items WHERE {' AND '.join(where)} ORDER BY updated_at DESC LIMIT 500",
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
        await _x(f"UPDATE labspace.labops_inventory_items SET {', '.join(fields)}, updated_at=now() WHERE id=%s", tuple(params))
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

    # 共享演示数据：只允许复制已知路径，杜绝任意文件读取
    chosen_inputs = json.loads(inputs or "[]")
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
               "created_at": datetime.now(timezone.utc).isoformat()}
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
    _write_json(Path(row["workdir"]) / "cancel", {"at": datetime.now(timezone.utc).isoformat()})
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
    try:
        await _x("UPDATE labspace.labops_literature SET embedding=%s::vector WHERE id=%s AND owner=%s", (literal, item_id, owner))
    except Exception:  # noqa: BLE001 - 语义能力缺失不应影响保存
        pass


@router.get("/literature")
async def literature_list(
    q: str = Query("", max_length=120),
    status: str = Query("", max_length=20),
    limit: int = Query(100, ge=1, le=300),
    user: dict = Depends(require_user),
) -> dict[str, Any]:
    where = ["owner=%s"]
    params: list[Any] = [user["sub"]]
    if q.strip():
        where.append("(title ILIKE %s OR abstract ILIKE %s OR notes ILIKE %s OR doi ILIKE %s)")
        like = f"%{q.strip()}%"
        params += [like, like, like, like]
    if status:
        where.append("status=%s")
        params.append(status)
    rows = await _q(
        "SELECT id, doi, title, authors, journal, pub_year, abstract, url, tags, notes, status, created_at, updated_at "
        f"FROM labspace.labops_literature WHERE {' AND '.join(where)} ORDER BY updated_at DESC LIMIT %s",
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
    await _x(
        "INSERT INTO labspace.labops_literature (id, owner, doi, title, authors, journal, pub_year, abstract, url, tags) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (lid, user["sub"], meta["doi"], meta["title"], meta["authors"], meta["journal"],
         meta["pub_year"], meta["abstract"], meta["url"], list(payload.get("tags") or [])),
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
    if fields:
        params += [item_id, user["sub"]]
        await _x(f"UPDATE labspace.labops_literature SET {', '.join(fields)}, updated_at=now() WHERE id=%s AND owner=%s", tuple(params))
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
    rows = await _q(
        "SELECT b.*, r.name AS resource_name, r.location FROM labspace.labops_bookings b "
        "JOIN labspace.labops_resources r ON r.id=b.resource_id "
        f"WHERE {' AND '.join(where)} ORDER BY b.start_at DESC LIMIT %s",
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