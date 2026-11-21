"""Bounded, derived-only inline previews (server-side channel for global panel).

Mirrors the Go core ``internal/preview`` contract: never return the source
bytes, cap input/expansion/records/text, and never execute document macros or
render untrusted SVG/HTML. The global debug panel POSTs a locally-selected
file here; the bytes stay inside the request and are discarded afterwards.

The browser-side engine (``src/debug/previewEngine.ts``) implements the same
contract locally so that:
  * a file never has to leave the machine unless the user asks for the
    server cross-check;
  * the panel keeps working when the portal backend is unreachable.

This module is intentionally dependency-free (stdlib only) so it can be unit
tested without installing FastAPI.
"""
from __future__ import annotations

import csv
import gzip
import io
import re
import zipfile
from typing import Any

MAX_INPUT = 8 << 20          # 8 MiB inline limit
MAX_EXPANDED = 24 << 20      # 24 MiB decompression ceiling
MAX_ROWS = 20
MAX_TEXT = 2048
MAX_ZIP_ENTRIES = 256
MAX_CELL = 240

BIOINFO = {
    ".fa": "fasta", ".fna": "fasta", ".faa": "fasta", ".fasta": "fasta",
    ".fq": "fastq", ".fastq": "fastq", ".sam": "sam",
}
TABLE = {".gff", ".gff3", ".gtf", ".vcf", ".bed", ".csv", ".tsv"}
TEXT = {".txt", ".md", ".log", ".json", ".yaml", ".yml"}

#: 源码文件的扩展名 → 语言标识（前端据此上色/标注；不做运行时高亮依赖）
CODE_LANG = {
    ".py": "python", ".ipynb": "json", ".ts": "typescript", ".tsx": "tsx",
    ".js": "javascript", ".jsx": "jsx", ".mjs": "javascript", ".cjs": "javascript",
    ".go": "go", ".rs": "rust", ".java": "java", ".c": "c", ".h": "c",
    ".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp", ".rb": "ruby", ".php": "php",
    ".sh": "bash", ".bash": "bash", ".zsh": "bash", ".ps1": "powershell",
    ".sql": "sql", ".css": "css", ".scss": "scss", ".html": "html", ".vue": "vue",
    ".toml": "toml", ".ini": "ini", ".cfg": "ini", ".conf": "nginx",
    ".dockerfile": "dockerfile", ".mk": "makefile", ".lua": "lua", ".r": "r",
    ".pl": "perl", ".kt": "kotlin", ".swift": "swift", ".scala": "scala",
}
#: 无扩展名但按文件名识别的
CODE_NAMES = {"dockerfile": "dockerfile", "makefile": "makefile", "cmakelists.txt": "cmake",
              "requirements.txt": "text", "pyproject.toml": "toml"}
#: 源码可能很长，但预览只给前若干字符（行号与截断提示由前端渲染）
MAX_CODE = 60_000
IMAGE = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
OFFICE = {".docx", ".pptx", ".xlsx"}
WORKER = {".pdf", ".bam", ".cram", ".bai", ".crai", ".bw", ".bigwig"}


class PreviewError(ValueError):
    """Raised for oversized / malformed input; mapped to HTTP 413/400."""


def _short(value: str, n: int) -> str:
    return value if len(value) <= n else value[:n]


def _text(raw: bytes) -> str:
    return raw.decode("utf-8", errors="replace")


def _lines(raw: bytes) -> list[str]:
    return _text(raw).replace("\r\n", "\n").replace("\r", "\n").split("\n")


def unwrap(name: str, raw: bytes) -> tuple[str, bytes]:
    """Strip a single .gz layer with a hard decompression ceiling."""
    if len(raw) > MAX_INPUT:
        raise PreviewError("input exceeds 8MiB inline preview limit")
    lower = name.lower()
    if lower.endswith(".gz"):
        try:
            data = gzip.GzipFile(fileobj=io.BytesIO(raw)).read(MAX_EXPANDED + 1)
        except (OSError, EOFError) as exc:
            raise PreviewError("invalid gzip stream") from exc
        if len(data) > MAX_EXPANDED:
            raise PreviewError("expanded data too large")
        return lower[:-3], data
    return lower, raw


def _fasta(raw: bytes) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    total, current = 0, None
    for line in _lines(raw):
        if line.startswith(">"):
            total += 1
            if len(records) >= MAX_ROWS:
                current = None
                continue
            current = {"header": _short(line[1:].strip(), 200), "length": 0, "snippet": ""}
            records.append(current)
        elif current is not None:
            seq = "".join(c for c in line.strip().upper() if c.isalpha() or c in "*-.")
            current["length"] += len(seq)
            if len(current["snippet"]) < 80:
                current["snippet"] += seq[: 80 - len(current["snippet"])]
    return {"kind": "bioinfo", "format": "fasta", "records": records,
            "records_seen": total, "truncated": total > MAX_ROWS}


def _fastq(raw: bytes) -> dict[str, Any]:
    lines = _lines(raw)
    while lines and lines[-1] == "":
        lines.pop()
    if len(lines) % 4 != 0:
        raise PreviewError("FASTQ incomplete record")
    total = len(lines) // 4
    records: list[dict[str, Any]] = []
    for i in range(total):
        a, seq, plus, qual = lines[i * 4: i * 4 + 4]
        if not a.startswith("@") or not plus.startswith("+") or len(seq) != len(qual):
            raise PreviewError("FASTQ invalid record")
        if i < MAX_ROWS:
            records.append({"header": _short(a[1:], 200), "length": len(seq),
                            "sequence_snippet": _short(seq, 80)})
    return {"kind": "bioinfo", "format": "fastq", "records": records,
            "records_seen": total, "truncated": total > MAX_ROWS}


def _sam(raw: bytes) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    total = 0
    for line in _lines(raw):
        if not line or line.startswith("@"):
            continue
        f = line.split("\t")
        if len(f) < 11:
            continue
        total += 1
        if len(records) < MAX_ROWS:
            records.append({"qname": _short(f[0], 100), "flag": f[1], "rname": f[2],
                            "pos": f[3], "mapq": f[4], "cigar": _short(f[5], 120)})
    return {"kind": "bioinfo", "format": "sam", "records": records,
            "records_seen": total, "truncated": total > MAX_ROWS}


def _table(raw: bytes, ext: str) -> dict[str, Any]:
    sep = "," if ext == ".csv" else "\t"
    rows: list[list[str]] = []
    for line in _lines(raw):
        if not line.strip() or line.startswith("##"):
            continue
        if len(rows) >= MAX_ROWS:
            break
        cells = next(csv.reader([line], delimiter=sep)) if ext == ".csv" else line.split(sep)
        rows.append([_short(c, MAX_CELL) for c in cells[:16]])
    return {"kind": "table", "format": ext[1:], "rows": rows,
            "truncated": len(rows) >= MAX_ROWS}


def _office(raw: bytes, ext: str) -> dict[str, Any]:
    """Extract visible text only; no macros, no DDE, no external entities."""
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            infos = z.infolist()
            if len(infos) > MAX_ZIP_ENTRIES or sum(i.file_size for i in infos) > MAX_EXPANDED:
                raise PreviewError("Office ZIP expansion limit exceeded")
            wanted: list[str] = []
            for info in infos:
                p = info.filename
                if ext == ".docx" and p == "word/document.xml":
                    wanted.append(p)
                elif ext == ".xlsx" and p.startswith("xl/worksheets/sheet") and p.endswith(".xml"):
                    wanted.append(p)
                elif ext == ".pptx" and p.startswith("ppt/slides/slide") and p.endswith(".xml"):
                    wanted.append(p)
            chunks: list[str] = []
            for p in wanted[:MAX_ROWS]:
                xml = z.read(p).decode("utf-8", errors="replace")
                # Strip tags; keep only character data inside <w:t>/<a:t>/<v>.
                chunks.extend(re.findall(r"<(?:w:|a:)?(?:t|v)[^>]*>([^<]*)<", xml))
            text = _short(" ".join(chunks), MAX_TEXT)
            return {"kind": "document", "format": ext[1:], "text": text,
                    "truncated": len(wanted) > MAX_ROWS or len(text) >= MAX_TEXT,
                    "notice": "仅抽取可见文本；不执行宏、不解析外部实体"}
    except (zipfile.BadZipFile, RuntimeError, KeyError) as exc:
        raise PreviewError("invalid Office archive") from exc


def _image_meta(raw: bytes, ext: str) -> dict[str, Any]:
    """Read dimensions from headers only; never decode pixels."""
    width = height = None
    if raw[:8] == b"\x89PNG\r\n\x1a\n" and len(raw) >= 24:
        width = int.from_bytes(raw[16:20], "big")
        height = int.from_bytes(raw[20:24], "big")
    elif raw[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(raw):
            if raw[i] != 0xFF:
                i += 1
                continue
            marker = raw[i + 1]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                height = int.from_bytes(raw[i + 5:i + 7], "big")
                width = int.from_bytes(raw[i + 7:i + 9], "big")
                break
            length = int.from_bytes(raw[i + 2:i + 4], "big")
            if length < 2:
                break
            i += 2 + length
    elif raw[:6] in (b"GIF87a", b"GIF89a") and len(raw) >= 10:
        width = int.from_bytes(raw[6:8], "little")
        height = int.from_bytes(raw[8:10], "little")
    return {"kind": "image-metadata", "format": ext[1:],
            "meta": {"width": width, "height": height},
            "notice": "仅读取头部尺寸；缩略图需在隔离 Worker 中生成"}


def render(name: str, raw: bytes) -> dict[str, Any]:
    """Return bounded derived metadata for one file. Never echoes source bytes."""
    lower, data = unwrap(name, raw)
    ext = "." + lower.rsplit(".", 1)[-1] if "." in lower else ""
    result: dict[str, Any] = {"format": ext[1:], "meta": {"bytes_examined": len(data)},
                              "truncated": False}
    if ext in BIOINFO:
        fmt = BIOINFO[ext]
        result.update({"fasta": _fasta, "fastq": _fastq, "sam": _sam}[fmt](data))
    elif ext in TABLE:
        result.update(_table(data, ext))
    elif ext in CODE_LANG or lower in CODE_NAMES:
        lang = CODE_LANG.get(ext) or CODE_NAMES.get(lower, "text")
        text = _short(_text(data), MAX_CODE)
        lines = text.count("\n") + 1
        result.update({"kind": "code", "format": lang, "language": lang, "text": text,
                       "lines": lines, "truncated": len(_text(data)) > MAX_CODE})
    elif ext in TEXT:
        text = _short(_text(data), MAX_TEXT)
        result.update({"kind": "text", "text": text,
                       "truncated": len(_text(data)) > MAX_TEXT})
    elif ext in OFFICE:
        result.update(_office(data, ext))
    elif ext in IMAGE:
        result.update(_image_meta(data, ext))
    elif ext in WORKER:
        result.update({"kind": "requires-worker",
                       "notice": "该格式需隔离渲染 Worker，不返回原始二进制"})
    else:
        result.update({"kind": "unsupported", "notice": "文件格式未纳入允许的预览器"})
    return result
