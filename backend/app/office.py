"""Office 文档的原生编辑与放映（PPTX/PPT/DOCX/XLSX）。

- 读取/保存结构化内容：DOCX（段落/表格）、XLSX（单元格）、PPTX（文本框/备注）；
- 放映模式：用 LibreOffice 无头模式把演示文稿转成 PDF，前端用 PDF.js 全屏放映。

所有文件读取与写回都复用调用者自己的门户会话（Cookie + CSRF）访问 Go 文件核心，
权限判定始终由文件核心完成，本模块不做任何越权放行。
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import os
import posixpath
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .config import settings
from .http import async_client
from .security import require_csrf, require_user

router = APIRouter(prefix="/api/office/files", tags=["office"])

DOC_EXTS = {"docx", "doc"}
SHEET_EXTS = {"xlsx", "xls", "csv", "tsv"}
SLIDE_EXTS = {"pptx", "ppt"}
LEGACY_TO_MODERN = {"doc": "docx", "xls": "xlsx", "ppt": "pptx"}
CONVERTIBLE_EXTS = DOC_EXTS | SHEET_EXTS | SLIDE_EXTS | {"odt", "ods", "odp", "rtf"}
MAX_OFFICE_BYTES = 40 * 1024 * 1024
MAX_BLOCKS = 4000
MAX_SHEETS = 30
MAX_ROWS = 500
MAX_COLS = 60
MAX_SLIDES = 300
MAX_SHAPES = 150
CACHE_DIR = Path("/tmp/labspace-office")
_CACHE_LOCK = asyncio.Lock()
_CONVERT_LOCKS: dict[str, asyncio.Lock] = {}
_CONVERT_SEMAPHORE = asyncio.Semaphore(2)


def _ext(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def _cookie(request: Request) -> str:
    return request.headers.get("cookie", "")


async def _meta(entry_id: str, request: Request) -> dict[str, Any]:
    if not settings.labgo_base:
        raise HTTPException(status_code=503, detail="文件核心尚未配置")
    try:
        async with async_client(timeout=20) as client:
            resp = await client.get(
                f"{settings.labgo_base}/v1/files/{quote(entry_id)}",
                headers={"cookie": _cookie(request)},
            )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail="文件核心暂不可用") from exc
    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="文件不存在或无权访问")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"文件核心返回 {resp.status_code}")
    data = resp.json() if resp.content else {}
    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="文件核心返回了无法解析的响应")
    return data


async def _download(entry_id: str, request: Request) -> bytes:
    try:
        async with async_client(timeout=120) as client:
            resp = await client.get(
                f"{settings.labgo_base}/v1/files/{quote(entry_id)}/download",
                headers={"cookie": _cookie(request)},
            )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail="文件核心暂不可用") from exc
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"文件核心返回 {resp.status_code}")
    if len(resp.content) > MAX_OFFICE_BYTES:
        raise HTTPException(status_code=413, detail="文件超过 40 MB，请在桌面 Office 中编辑")
    return resp.content


async def _upload(entry_id: str, meta: dict[str, Any], raw: bytes, request: Request) -> dict[str, Any]:
    source = str(meta.get("source") or "")
    path = str(meta.get("path") or "")
    name = str(meta.get("name") or "")
    if not source or not name:
        raise HTTPException(status_code=502, detail="文件核心未返回可写路径")
    csrf = request.headers.get("x-csrf-token", "")
    headers = {"cookie": _cookie(request)}
    if csrf:
        headers["X-CSRF-Token"] = csrf
    params = {"source": source, "dir": posixpath.dirname(path), "overwrite": "1"}
    try:
        async with async_client(timeout=180) as client:
            resp = await client.post(
                f"{settings.labgo_base}/v1/files/upload",
                params=params,
                headers=headers,
                files={"file": (name, raw, "application/octet-stream")},
            )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail="文件核心暂不可用") from exc
    if resp.status_code == 403:
        raise HTTPException(status_code=403, detail="当前账号没有该文件的写入权限")
    if resp.status_code != 200:
        detail = resp.text[:300]
        raise HTTPException(status_code=502, detail=f"写回文件失败：{detail}")
    data = resp.json() if resp.content else {}
    return data if isinstance(data, dict) else {"ok": True}


def _require_kind(meta: dict[str, Any], allowed: set[str], label: str) -> str:
    ext = _ext(str(meta.get("name") or ""))
    if ext not in allowed:
        raise HTTPException(status_code=415, detail=f"{label}不支持该格式（.{ext or '?'}）")
    return ext


def _soffice_binary() -> str:
    binary = shutil.which("soffice") or shutil.which("libreoffice")
    if not binary:
        raise HTTPException(status_code=503, detail="服务器未安装 LibreOffice，无法处理该文档")
    return binary


async def _convert_office(raw: bytes, name: str, target_ext: str) -> bytes:
    """用 LibreOffice 无头模式做一次格式转换（旧版 Office ↔ OOXML / PDF）。"""
    binary = _soffice_binary()
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="work-", dir=CACHE_DIR))
    try:
        suffix = Path(name).suffix or f".{target_ext}"
        source = work / f"source{suffix}"
        source.write_bytes(raw)
        profile = work / "profile"
        env = os.environ.copy()
        env["HOME"] = str(work)
        async with _CONVERT_SEMAPHORE:
            proc = await asyncio.create_subprocess_exec(
                binary, "--headless", "--norestore", "--nolockcheck",
                f"-env:UserInstallation=file://{profile}",
                "--convert-to", target_ext, "--outdir", str(work), str(source),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=240)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                raise HTTPException(status_code=504, detail="文档转换超时，请稍后重试")
        produced = work / f"source.{target_ext}"
        if proc.returncode != 0 or not produced.exists():
            detail = (stderr or stdout or b"").decode("utf-8", "replace")[-400:]
            raise HTTPException(status_code=422, detail=f"无法转换该文档：{detail}")
        return produced.read_bytes()
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ---------------------------------------------------------------- DOCX

def _docx_blocks(raw: bytes) -> dict[str, Any]:
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    doc = Document(io.BytesIO(raw))
    blocks: list[dict[str, Any]] = []
    truncated = False
    for index, child in enumerate(doc.element.body.iterchildren()):
        tag = child.tag.split("}")[-1]
        if tag == "p":
            p = Paragraph(child, doc)
            blocks.append({
                "index": index,
                "type": "paragraph",
                "style": p.style.name if p.style is not None else "",
                "text": p.text,
            })
        elif tag == "tbl":
            table = Table(child, doc)
            rows = [[cell.text for cell in row.cells] for row in table.rows]
            blocks.append({"index": index, "type": "table", "rows": rows})
        else:
            continue
        if len(blocks) >= MAX_BLOCKS:
            truncated = True
            break
    return {"kind": "docx", "blocks": blocks, "truncated": truncated}


def _set_paragraph_text(p: Any, text: str) -> None:
    # 保留段落样式与首个 run 的字体，复杂行内格式会退化为单一文本段。
    if p.runs:
        p.runs[0].text = text
        for run in p.runs[1:]:
            run._element.getparent().remove(run._element)
    else:
        p.add_run(text)


def _save_docx(raw: bytes, blocks: list[dict[str, Any]]) -> bytes:
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    doc = Document(io.BytesIO(raw))
    wanted = {int(b.get("index", -1)): b for b in blocks}
    for index, child in enumerate(doc.element.body.iterchildren()):
        change = wanted.get(index)
        if not change:
            continue
        tag = child.tag.split("}")[-1]
        if tag == "p" and change.get("type") == "paragraph":
            _set_paragraph_text(Paragraph(child, doc), str(change.get("text", "")))
        elif tag == "tbl" and change.get("type") == "table":
            table = Table(child, doc)
            rows = change.get("rows") or []
            for r, row in enumerate(table.rows):
                values = rows[r] if r < len(rows) and isinstance(rows[r], list) else []
                for c, cell in enumerate(row.cells):
                    if c < len(values):
                        text = str(values[c])
                        _set_paragraph_text(cell.paragraphs[0], text)
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


# ---------------------------------------------------------------- XLSX

def _cell_text(value: Any) -> str:
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat(sep=" ")
        except TypeError:
            return value.isoformat()
    return str(value)


def _xlsx_content(raw: bytes) -> dict[str, Any]:
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(raw), data_only=False, read_only=False)
    sheets: list[dict[str, Any]] = []
    for ws in wb.worksheets[:MAX_SHEETS]:
        max_row = min(ws.max_row or 1, MAX_ROWS)
        max_col = min(ws.max_column or 1, MAX_COLS)
        rows: list[list[str]] = []
        for row in ws.iter_rows(min_row=1, max_row=max_row, max_col=max_col, values_only=True):
            rows.append([_cell_text(v) for v in row])
        sheets.append({
            "name": ws.title,
            "rows": rows,
            "maxRow": int(ws.max_row or 0),
            "maxCol": int(ws.max_column or 0),
            "window": {"rows": MAX_ROWS, "cols": MAX_COLS},
        })
    return {"kind": "xlsx", "sheets": sheets, "embedded": bool(getattr(wb, "vc", None))}


def _parse_cell(text: str) -> Any:
    value = text.strip()
    if value == "":
        return None
    if value.startswith("="):
        return value
    if value.lstrip("-").isdigit() and not (len(value.lstrip("-")) > 1 and value.lstrip("-").startswith("0")):
        try:
            return int(value)
        except ValueError:
            pass
    try:
        number = float(value)
        if number == number and number not in (float("inf"), float("-inf")):
            return number
    except ValueError:
        pass
    return text


def _save_xlsx(raw: bytes, sheets: list[dict[str, Any]]) -> bytes:
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(raw), data_only=False)
    for sheet in sheets:
        name = str(sheet.get("name") or "")
        ws = wb[name] if name in wb.sheetnames else None
        if ws is None:
            continue
        rows = sheet.get("rows") or []
        for r, row in enumerate(rows[:MAX_ROWS], start=1):
            if not isinstance(row, list):
                continue
            for c, text in enumerate(row[:MAX_COLS], start=1):
                cell = ws.cell(row=r, column=c)
                new = "" if text is None else str(text)
                if _cell_text(cell.value) == new:
                    continue
                cell.value = _parse_cell(new)
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


# ---------------------------------------------------------------- PPTX

def _pptx_content(raw: bytes) -> dict[str, Any]:
    from pptx import Presentation

    prs = Presentation(io.BytesIO(raw))
    slides: list[dict[str, Any]] = []
    for index, slide in enumerate(prs.slides):
        if index >= MAX_SLIDES:
            break
        shapes = []
        for shape in slide.shapes:
            if index >= MAX_SLIDES or len(shapes) >= MAX_SHAPES:
                break
            if not getattr(shape, "has_text_frame", False):
                continue
            text_frame = getattr(shape, "text_frame", None)
            if text_frame is None:
                continue
            text = text_frame.text
            title = slide.shapes.title
            shapes.append({
                "id": int(shape.shape_id),
                "name": shape.name,
                "text": text,
                "title": bool(title is not None and shape.shape_id == title.shape_id),
            })
        notes = ""
        if slide.has_notes_slide:
            notes_frame = getattr(slide.notes_slide, "notes_text_frame", None)
            notes = notes_frame.text if notes_frame is not None else ""
        slides.append({"index": index, "shapes": shapes, "notes": notes})
    return {"kind": "pptx", "slides": slides, "truncated": len(prs.slides) > MAX_SLIDES}


def _set_text_frame(tf: Any, text: str) -> None:
    lines = text.split("\n")
    first = tf.paragraphs[0]
    if first.runs:
        first.runs[0].text = lines[0]
        for run in first.runs[1:]:
            run._r.getparent().remove(run._r)
    else:
        first.add_run().text = lines[0]
    for extra in list(tf.paragraphs[1:]):
        tf._txBody.remove(extra._p)
    for line in lines[1:]:
        tf.add_paragraph().text = line


def _save_pptx(raw: bytes, slides: list[dict[str, Any]]) -> bytes:
    from pptx import Presentation

    prs = Presentation(io.BytesIO(raw))
    for slide_change in slides:
        index = int(slide_change.get("index", -1))
        if index < 0 or index >= len(prs.slides):
            continue
        slide = prs.slides[index]
        by_id = {int(s.get("id", -1)): s for s in slide_change.get("shapes") or []}
        for shape in slide.shapes:
            change = by_id.get(int(shape.shape_id))
            if not change or not getattr(shape, "has_text_frame", False):
                continue
            text_frame = getattr(shape, "text_frame", None)
            if text_frame is None:
                continue
            new_text = str(change.get("text", ""))
            if text_frame.text != new_text:
                _set_text_frame(text_frame, new_text)
        notes = slide_change.get("notes")
        if notes is not None and slide.has_notes_slide:
            notes_frame = getattr(slide.notes_slide, "notes_text_frame", None)
            if notes_frame is not None:
                notes_frame.text = str(notes)
    out = io.BytesIO()
    prs.save(out)
    return out.getvalue()


# ---------------------------------------------------------------- API

class ContentBody(BaseModel):
    kind: Literal["docx", "xlsx", "pptx"]
    blocks: list[dict[str, Any]] = Field(default_factory=list)
    sheets: list[dict[str, Any]] = Field(default_factory=list)
    slides: list[dict[str, Any]] = Field(default_factory=list)


@router.get("/{entry_id}/content")
async def office_content(entry_id: str, request: Request, _: dict = Depends(require_user)) -> dict[str, Any]:
    meta = await _meta(entry_id, request)
    name = str(meta.get("name") or "")
    ext = _ext(name)
    if ext not in (DOC_EXTS | SHEET_EXTS | SLIDE_EXTS):
        raise HTTPException(status_code=415, detail=f"不支持编辑 .{ext or '?'} 文件")
    raw = await _download(entry_id, request)
    edit_ext = LEGACY_TO_MODERN.get(ext, ext)
    normalized = edit_ext != ext
    try:
        if normalized:
            raw = await _convert_office(raw, name, edit_ext)
        if edit_ext == "docx":
            data = await asyncio.to_thread(_docx_blocks, raw)
        elif edit_ext == "xlsx":
            data = await asyncio.to_thread(_xlsx_content, raw)
        elif edit_ext == "pptx":
            data = await asyncio.to_thread(_pptx_content, raw)
        else:
            raise HTTPException(status_code=415, detail="CSV/TSV 请使用表格工具编辑")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"无法解析该文档：{exc}") from exc
    data.update({
        "name": name,
        "size": meta.get("size") or 0,
        "normalized": normalized,
        "originalExt": ext,
    })
    return data


@router.post("/{entry_id}/content", dependencies=[Depends(require_csrf)])
async def office_save(
    entry_id: str,
    payload: ContentBody,
    request: Request,
    _: dict = Depends(require_user),
) -> dict[str, Any]:
    meta = await _meta(entry_id, request)
    name = str(meta.get("name") or "")
    ext = _ext(name)
    raw = await _download(entry_id, request)
    edit_ext = LEGACY_TO_MODERN.get(ext, ext)
    try:
        if edit_ext in LEGACY_TO_MODERN.values() and payload.kind != edit_ext:
            raise HTTPException(status_code=415, detail="文件类型与内容不匹配")
        if ext in LEGACY_TO_MODERN:
            raw = await _convert_office(raw, name, edit_ext)
        if payload.kind == "docx":
            if edit_ext != "docx":
                raise HTTPException(status_code=415, detail="文件类型与内容不匹配")
            if len(payload.blocks) > MAX_BLOCKS:
                raise HTTPException(status_code=413, detail="段落过多，无法在网页中保存")
            updated = await asyncio.to_thread(_save_docx, raw, payload.blocks)
        elif payload.kind == "xlsx":
            if edit_ext != "xlsx":
                raise HTTPException(status_code=415, detail="文件类型与内容不匹配")
            updated = await asyncio.to_thread(_save_xlsx, raw, payload.sheets)
        elif payload.kind == "pptx":
            if edit_ext != "pptx":
                raise HTTPException(status_code=415, detail="文件类型与内容不匹配")
            if len(payload.slides) > MAX_SLIDES:
                raise HTTPException(status_code=413, detail="幻灯片过多，无法在网页中保存")
            updated = await asyncio.to_thread(_save_pptx, raw, payload.slides)
        else:
            raise HTTPException(status_code=415, detail="不支持的内容类型")
        if ext in LEGACY_TO_MODERN:
            updated = await _convert_office(updated, f"edited.{edit_ext}", ext)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"保存失败：{exc}") from exc
    saved = await _upload(entry_id, meta, updated, request)
    return {"ok": True, "size": len(updated), "entry": saved.get("entry")}


def _cleanup_cache() -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cutoff = time.time() - 3600
    try:
        files = sorted(CACHE_DIR.glob("*.pdf"), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in files[60:]:
            old.unlink(missing_ok=True)
        for work in CACHE_DIR.glob("work-*"):
            try:
                if work.is_dir() and work.stat().st_mtime < cutoff:
                    shutil.rmtree(work, ignore_errors=True)
            except OSError:
                pass
    except OSError:
        pass


async def _convert_pdf(raw: bytes, name: str, key: str) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    target = CACHE_DIR / f"{key}.pdf"
    if target.exists():
        return target
    lock = _CONVERT_LOCKS.setdefault(key, asyncio.Lock())
    async with lock:
        if target.exists():
            return target
        data = await _convert_office(raw, name, "pdf")
        part = CACHE_DIR / f"{key}.part"
        part.write_bytes(data)
        part.replace(target)
        return target


@router.get("/{entry_id}/pdf")
async def office_pdf(entry_id: str, request: Request, _: dict = Depends(require_user)) -> FileResponse:
    meta = await _meta(entry_id, request)
    name = str(meta.get("name") or "")
    ext = _ext(name)
    if ext not in CONVERTIBLE_EXTS:
        raise HTTPException(status_code=415, detail=f"不支持放映 .{ext or '?'} 文件")
    key = hashlib.sha256(
        f"{entry_id}:{meta.get('size') or 0}:{meta.get('modified') or ''}".encode()
    ).hexdigest()[:24]
    raw = await _download(entry_id, request)
    pdf = await _convert_pdf(raw, name, key)
    _cleanup_cache()
    return FileResponse(
        pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"inline; filename*=UTF-8''{quote(name + '.pdf')}",
            "Cache-Control": "private, max-age=3600",
        },
    )
