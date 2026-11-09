"""LaTeX 写作与投稿管理。

- 文稿按 ``owner`` 隔离，模板 / 编译 / PDF 预览都在门户内完成；
- 编译交给独立 sidecar（``latex_worker.py``），门户数据卷不会暴露给编译器；
- 投稿状态变更写入 ``latex_events``，前端以时间线呈现完整投稿轨迹。
"""
from __future__ import annotations

import asyncio
import base64
import re
import shutil
import uuid
from datetime import date
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import db
from .config import settings
from .security import require_csrf, require_user

router = APIRouter(prefix="/api/latex", tags=["latex"])

ROOT = Path(settings.latex_root)
MAX_CONTENT = 400_000
MAX_TITLE = 200
LOG_LIMIT = 20_000

STATUSES = (
    ("draft", "草稿"),
    ("writing", "撰写中"),
    ("submitted", "已投稿"),
    ("under_review", "审稿中"),
    ("revision", "返修中"),
    ("accepted", "已录用"),
    ("rejected", "未录用"),
)
STATUS_KEYS = tuple(k for k, _ in STATUSES)

TEMPLATES: list[dict[str, Any]] = [
    {
        "id": "article-cn",
        "name": "中文期刊论文",
        "description": "ctexart 单栏排版，含摘要、关键词、章节与图表示例，适合投稿中文期刊。",
        "kind": "article",
        "content": r"""\documentclass[UTF8,11pt,fontset=fandol]{ctexart}
\usepackage[margin=2.54cm]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{booktabs}
\usepackage{graphicx}
\usepackage{hyperref}
\hypersetup{hidelinks}
\title{论文标题}
\author{作者一\thanks{单位：D509 实验室}\quad 作者二}
\date{\today}
\begin{document}
\maketitle
\begin{abstract}
在这里写摘要：研究背景、方法、主要结果与结论，通常 200--300 字。
\par\noindent\textbf{关键词：}关键词一；关键词二；关键词三
\end{abstract}

\section{引言}
研究背景与科学问题。

\section{材料与方法}
实验材料、数据来源与分析方法。

\section{结果}
\begin{table}[htbp]
  \centering
  \caption{示例表格}
  \begin{tabular}{lrr}
    \toprule
    处理 & 均值 & 标准差 \\
    \midrule
    对照 & 1.00 & 0.05 \\
    处理 & 1.42 & 0.08 \\
    \bottomrule
  \end{tabular}
\end{table}

\section{讨论}
结果解释、局限与展望。

\section{结论}
一句话总结核心发现。

\bibliographystyle{plain}
% \bibliography{refs}

\end{document}
""",
    },
    {
        "id": "manuscript-en",
        "name": "英文 Manuscript",
        "description": "标准 article 类，含 Abstract / Introduction / Results 与图表占位，适合英文期刊初稿。",
        "kind": "article",
        "content": r"""\documentclass[11pt]{article}
\usepackage[margin=2.54cm]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{booktabs}
\usepackage{graphicx}
\usepackage{hyperref}
\hypersetup{hidelinks}
\title{Manuscript Title}
\author{Author One \and Author Two\\ D509 Laboratory}
\date{\today}
\begin{document}
\maketitle
\begin{abstract}
Write the abstract here: background, methods, key results, and conclusion.
\end{abstract}

\section{Introduction}
Background and the question this study addresses.

\section{Materials and Methods}
Data sources, experimental design, and statistical analysis.

\section{Results}
Present the main findings; reference Figure~\ref{fig:overview}.

\begin{figure}[htbp]
  \centering
  % \includegraphics[width=0.8\linewidth]{figure.pdf}
  \fbox{\parbox[c][4cm][c]{0.7\linewidth}{\centering Figure placeholder}}
  \caption{Overview of the study design.}
  \label{fig:overview}
\end{figure}

\section{Discussion}
Interpretation, limitations, and future directions.

\section*{Data availability}
Data and code will be deposited in a public repository upon acceptance.

\bibliographystyle{plain}
% \bibliography{refs}

\end{document}
""",
    },
    {
        "id": "thesis-chapter",
        "name": "学位论文章节",
        "description": "ctexrep 章节骨架，含节、小节、公式与参考文献占位，可直接并入学位论文。",
        "kind": "thesis",
        "content": r"""\documentclass[UTF8,12pt,fontset=fandol]{ctexrep}
\usepackage[margin=2.8cm]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{booktabs}
\usepackage{graphicx}
\title{第 X 章\quad 章节标题}
\author{姓名}
\date{\today}
\begin{document}
\maketitle
\section{引言}
\subsection{研究背景}
\subsection{研究目标}

\section{材料与方法}
公式示例：
\begin{equation}
  E = mc^2
\end{equation}

\section{结果与分析}
\subsection{主要发现}

\section{小结}

\bibliographystyle{plain}
% \bibliography{refs}

\end{document}
""",
    },
    {
        "id": "cover-letter",
        "name": "投稿信",
        "description": "给编辑部的 Cover Letter 模板，包含贡献声明、推荐审稿人与声明事项。",
        "kind": "letter",
        "content": r"""\documentclass[UTF8,11pt,fontset=fandol]{ctexart}
\usepackage[margin=2.54cm]{geometry}
\pagestyle{empty}
\begin{document}
\begin{flushright}
\today
\end{flushright}

\noindent 尊敬的编辑：

\vspace{0.5em}
\noindent 我们谨此提交题为《论文标题》的稿件，申请在 \textbf{期刊名称} 发表。

\vspace{0.5em}
\noindent 本研究的主要贡献包括：
\begin{itemize}
  \item 贡献一；
  \item 贡献二；
  \item 贡献三。
\end{itemize}

\vspace{0.5em}
\noindent 我们声明：本稿件未曾发表，也未同时投递其他期刊；所有作者均已审阅并同意投稿；不存在利益冲突。

\vspace{0.5em}
\noindent 感谢您和审稿人付出的时间。

\vspace{1.5em}
\noindent 此致\\
敬礼

\vspace{1.5em}
\noindent 通讯作者：姓名\\
单位：D509 实验室\\
邮箱：name@example.com
\end{document}
""",
    },
]


# ---------------------------------------------------------------- 工具


async def _aq(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    return await asyncio.to_thread(db.query, sql, params)


async def _ax(sql: str, params: tuple = ()) -> None:
    await asyncio.to_thread(db.execute, sql, params)


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (date,)):
        return value.isoformat()
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _doc_out(row: dict[str, Any]) -> dict[str, Any]:
    doc_id = row["id"]
    pdf = ROOT / doc_id / "main.pdf"
    return {
        "id": doc_id,
        "title": row.get("title") or "未命名文稿",
        "kind": row.get("kind") or "article",
        "venue": row.get("venue") or "",
        "authors": row.get("authors") or "",
        "status": row.get("status") or "draft",
        "abstract": row.get("abstract") or "",
        "keywords": list(row.get("keywords") or []),
        "content": row.get("content") or "",
        "projectId": row.get("project_id"),
        "knowledgeDocId": row.get("knowledge_doc_id"),
        "dueDate": _iso(row.get("due_date")),
        "compiledAt": _iso(row.get("compiled_at")),
        "compileOk": row.get("compile_ok"),
        "compileLog": row.get("compile_log") or "",
        "pdfBytes": int(row.get("pdf_bytes") or 0),
        "hasPdf": pdf.exists() and pdf.stat().st_size > 0,
        "createdAt": _iso(row.get("created_at")),
        "updatedAt": _iso(row.get("updated_at")),
    }


def _template(template_id: str) -> dict[str, Any]:
    for tpl in TEMPLATES:
        if tpl["id"] == template_id:
            return tpl
    return TEMPLATES[0]


def _doc_dir(doc_id: str) -> Path:
    safe = "".join(ch for ch in doc_id if ch.isalnum() or ch in "-_")
    if not safe:
        raise HTTPException(status_code=400, detail="文稿编号非法")
    return ROOT / safe


async def _event(doc_id: str, owner: str, kind: str, note: str = "") -> None:
    await _ax(
        "INSERT INTO labspace.latex_events (doc_id, owner, kind, note) VALUES (%s,%s,%s,%s)",
        (doc_id, owner, kind, note[:500]),
    )


async def _owned(doc_id: str, owner: str) -> dict[str, Any]:
    rows = await _aq("SELECT * FROM labspace.latex_documents WHERE id=%s AND owner=%s", (doc_id, owner))
    if not rows:
        raise HTTPException(status_code=404, detail="文稿不存在或无权访问")
    return rows[0]


# ---------------------------------------------------------------- 请求体


class DocCreate(BaseModel):
    title: str = Field(default="未命名文稿", max_length=MAX_TITLE)
    template: str = "article-cn"
    venue: str = Field(default="", max_length=200)
    authors: str = Field(default="", max_length=300)
    abstract: str = Field(default="", max_length=8000)
    keywords: list[str] = []
    project_id: str | None = None
    knowledge_doc_id: int | None = None
    due_date: str | None = None


class DocUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=MAX_TITLE)
    venue: str | None = Field(default=None, max_length=200)
    authors: str | None = Field(default=None, max_length=300)
    status: str | None = None
    abstract: str | None = Field(default=None, max_length=8000)
    keywords: list[str] | None = None
    content: str | None = Field(default=None, max_length=MAX_CONTENT)
    project_id: str | None = None
    knowledge_doc_id: int | None = None
    due_date: str | None = None


class EventIn(BaseModel):
    kind: str = "note"
    note: str = Field(default="", max_length=500)


# ---------------------------------------------------------------- 路由


@router.get("/templates")
async def list_templates(user: dict = Depends(require_user)) -> dict[str, Any]:
    return {
        "templates": [{k: v for k, v in t.items() if k != "content"} for t in TEMPLATES],
        "statuses": [{"value": k, "label": v} for k, v in STATUSES],
    }


@router.get("/documents")
async def list_documents(
    q: str = Query(default="", max_length=120),
    status: str = Query(default=""),
    user: dict = Depends(require_user),
) -> dict[str, Any]:
    where = ["owner=%s"]
    params: list[Any] = [user["sub"]]
    if q.strip():
        where.append("(title ILIKE %s OR venue ILIKE %s OR abstract ILIKE %s)")
        like = f"%{q.strip()}%"
        params.extend([like, like, like])
    if status in STATUS_KEYS:
        where.append("status=%s")
        params.append(status)
    rows = await _aq(
        f"SELECT * FROM labspace.latex_documents WHERE {' AND '.join(where)}"
        " ORDER BY updated_at DESC LIMIT 200",
        tuple(params),
    )
    docs = [_doc_out(r) for r in rows]
    counts = {k: 0 for k in STATUS_KEYS}
    for d in docs:
        counts[d["status"]] = counts.get(d["status"], 0) + 1
    return {"documents": docs, "counts": counts, "total": len(docs)}


@router.post("/documents")
async def create_document(body: DocCreate, user: dict = Depends(require_user), _: None = Depends(require_csrf)) -> dict[str, Any]:
    tpl = _template(body.template)
    doc_id = uuid.uuid4().hex
    owner = user["sub"]
    await _ax(
        """
        INSERT INTO labspace.latex_documents
          (id, owner, title, kind, venue, authors, status, abstract, keywords, content, project_id, knowledge_doc_id, due_date)
        VALUES (%s,%s,%s,%s,%s,%s,'draft',%s,%s,%s,%s,%s,%s)
        """,
        (
            doc_id,
            owner,
            body.title.strip() or "未命名文稿",
            tpl["kind"],
            body.venue.strip(),
            body.authors.strip(),
            body.abstract.strip(),
            body.keywords,
            tpl["content"],
            body.project_id or None,
            body.knowledge_doc_id,
            body.due_date or None,
        ),
    )
    await _event(doc_id, owner, "created", f"从模板「{tpl['name']}」创建")
    return {"document": _doc_out(await _owned(doc_id, owner))}


@router.get("/documents/{doc_id}")
async def get_document(doc_id: str, user: dict = Depends(require_user)) -> dict[str, Any]:
    return {"document": _doc_out(await _owned(doc_id, user["sub"]))}


@router.patch("/documents/{doc_id}")
async def update_document(
    doc_id: str,
    body: DocUpdate,
    user: dict = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    current = await _owned(doc_id, user["sub"])
    fields: list[str] = []
    params: list[Any] = []
    payload = body.model_dump(exclude_unset=True)
    if "status" in payload and payload["status"] not in STATUS_KEYS:
        raise HTTPException(status_code=400, detail="未知的投稿状态")
    mapping = {
        "title": "title",
        "venue": "venue",
        "authors": "authors",
        "status": "status",
        "abstract": "abstract",
        "keywords": "keywords",
        "content": "content",
        "project_id": "project_id",
        "knowledge_doc_id": "knowledge_doc_id",
        "due_date": "due_date",
    }
    for key, column in mapping.items():
        if key not in payload:
            continue
        value = payload[key]
        if key == "title":
            value = (value or "").strip() or "未命名文稿"
        if key == "content" and not (value or "").strip():
            continue
        if key == "due_date" and value == "":
            value = None
        fields.append(f"{column}=%s")
        params.append(value)
    if not fields:
        return {"document": _doc_out(current)}
    params.extend([doc_id, user["sub"]])
    await _ax(
        f"UPDATE labspace.latex_documents SET {', '.join(fields)}, updated_at=now() WHERE id=%s AND owner=%s",
        tuple(params),
    )
    new_status = payload.get("status")
    if new_status and new_status != current.get("status"):
        label = dict(STATUSES)
        await _event(
            doc_id,
            user["sub"],
            "status",
            f"{label.get(current.get('status'), current.get('status'))} → {label.get(new_status, new_status)}",
        )
    return {"document": _doc_out(await _owned(doc_id, user["sub"]))}


@router.delete("/documents/{doc_id}")
async def delete_document(doc_id: str, user: dict = Depends(require_user), _: None = Depends(require_csrf)) -> dict[str, Any]:
    await _owned(doc_id, user["sub"])
    await _ax("DELETE FROM labspace.latex_documents WHERE id=%s AND owner=%s", (doc_id, user["sub"]))
    await _ax("DELETE FROM labspace.latex_events WHERE doc_id=%s AND owner=%s", (doc_id, user["sub"]))
    await asyncio.to_thread(shutil.rmtree, _doc_dir(doc_id), True)
    return {"ok": True}


@router.get("/documents/{doc_id}/events")
async def list_events(doc_id: str, user: dict = Depends(require_user)) -> dict[str, Any]:
    await _owned(doc_id, user["sub"])
    rows = await _aq(
        "SELECT kind, note, created_at FROM labspace.latex_events WHERE doc_id=%s AND owner=%s"
        " ORDER BY created_at DESC LIMIT 100",
        (doc_id, user["sub"]),
    )
    return {
        "events": [
            {"kind": r.get("kind") or "note", "note": r.get("note") or "", "createdAt": _iso(r.get("created_at"))}
            for r in rows
        ]
    }


@router.post("/documents/{doc_id}/events")
async def add_event(
    doc_id: str,
    body: EventIn,
    user: dict = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    await _owned(doc_id, user["sub"])
    await _event(doc_id, user["sub"], body.kind or "note", body.note)
    return {"ok": True}


@router.post("/documents/{doc_id}/compile")
async def compile_document(doc_id: str, user: dict = Depends(require_user), _: None = Depends(require_csrf)) -> dict[str, Any]:
    row = await _owned(doc_id, user["sub"])
    content = row.get("content") or ""
    if not content.strip():
        raise HTTPException(status_code=400, detail="文稿内容为空")
    try:
        async with httpx.AsyncClient(timeout=settings.latex_timeout) as client:
            resp = await client.post(f"{settings.latex_worker}/compile", json={"content": content})
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="编译服务不可用，请稍后重试") from exc
    if resp.status_code != 200:
        raise HTTPException(status_code=503, detail=f"编译服务返回 {resp.status_code}")
    result = resp.json()
    ok = bool(result.get("ok"))
    log = str(result.get("log") or "")[:LOG_LIMIT]
    ms = int(result.get("ms") or 0)
    pdf_bytes = 0
    if ok and result.get("pdf"):
        try:
            data = base64.b64decode(result["pdf"])
        except (ValueError, TypeError):
            ok, log = False, "编译服务返回的 PDF 无法解码"
        else:
            target = _doc_dir(doc_id)
            await asyncio.to_thread(target.mkdir, 0o755, True, True)
            await asyncio.to_thread((target / "main.pdf").write_bytes, data)
            pdf_bytes = len(data)
    if not ok:
        await _ax(
            "UPDATE labspace.latex_documents SET compiled_at=now(), compile_ok=false, compile_log=%s, updated_at=now()"
            " WHERE id=%s AND owner=%s",
            (log, doc_id, user["sub"]),
        )
        await _event(doc_id, user["sub"], "compile", "编译失败")
        return {"ok": False, "log": log, "ms": ms}
    await _ax(
        "UPDATE labspace.latex_documents SET compiled_at=now(), compile_ok=true, compile_log=%s, pdf_bytes=%s, updated_at=now()"
        " WHERE id=%s AND owner=%s",
        (log, pdf_bytes, doc_id, user["sub"]),
    )
    await _event(doc_id, user["sub"], "compile", f"编译成功 · {pdf_bytes // 1024} KB · {ms} ms")
    return {"ok": True, "log": log, "ms": ms, "pdfBytes": pdf_bytes}


@router.get("/documents/{doc_id}/pdf")
async def get_pdf(doc_id: str, download: int = 0, user: dict = Depends(require_user)):
    row = await _owned(doc_id, user["sub"])
    path = _doc_dir(doc_id) / "main.pdf"
    if not path.exists():
        raise HTTPException(status_code=404, detail="尚未生成 PDF，请先编译")
    title = re.sub(r"[\\/:*?\"<>|\r\n]+", " ", row.get("title") or "manuscript").strip()[:80] or "manuscript"
    disposition = "attachment" if download else "inline"
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=f"{title}.pdf",
        content_disposition_type=disposition,
        headers={"Cache-Control": "private, no-store"},
    )