"""LaTeX 写作与投稿管理。

- 文稿按 ``owner`` 隔离，模板 / 编译 / PDF 预览都在门户内完成；
- 编译交给独立 sidecar（``latex_worker.py``），门户数据卷不会暴露给编译器；
- 投稿状态变更写入 ``latex_events``，前端以时间线呈现完整投稿轨迹。
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import re
import shutil
import uuid
from datetime import date
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from . import db
from .config import settings
from .docx2latex import convert_docx
from .security import require_csrf, require_user
from .uploads import read_upload_capped

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

# 批注状态：待处理 / 已接受 / 已拒绝
REVIEW_STATUSES = ("open", "accepted", "rejected")
REVIEW_STATUS_KEYS = frozenset(REVIEW_STATUSES)
MAX_REVIEWS = 500
MAX_REPLIES = 500
MAX_VERSIONS = 100

# 版本快照保留策略：每个 (doc_id, owner) 只留最近 30 份源码快照，
# 超出部分在写入新版本时立刻删最旧的（见 prune_versions）。
VERSION_KEEP = 30

# 编译素材（.cls / .sty / 图片等）：编译时随源码一起进沙箱，不进版本快照。
ASSET_EXTENSIONS = ("cls", "sty", "bib", "bst", "png", "jpg", "jpeg", "pdf", "eps", "svg")
MAX_ASSET_BYTES = 2 * 1024 * 1024  # 单个素材 2 MB
MAX_ASSETS_PER_DOC = 20  # 每份文稿 20 个素材
MAX_ASSETS_TOTAL_BYTES = 20 * 1024 * 1024  # 每份文稿素材合计 20 MB

TEMPLATES: list[dict[str, Any]] = [
    {
        "id": "article-cn",
        "name": "中文期刊论文",
        "description": "ctexart 单栏排版，含摘要、关键词、章节与图表示例，适合投稿中文期刊。",
        "kind": "article",
        "tags": ["中文", "期刊"],
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
        "id": "article-en",
        "name": "英文 Article",
        "description": "标准 article 单栏，含 Abstract / Introduction / Results 与图表示例，适合英文期刊初稿。",
        "kind": "article",
        "tags": ["英文", "期刊"],
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
        "id": "article-two-column",
        "name": "英文双栏 Article",
        "description": "article 双栏排版，含摘要、公式、表格与图，适合会议与部分英文期刊的最终稿。",
        "kind": "article",
        "tags": ["英文", "期刊", "双栏"],
        "content": r"""\documentclass[11pt,twocolumn]{article}
\usepackage[margin=2.2cm]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{booktabs}
\usepackage{graphicx}
\usepackage{hyperref}
\hypersetup{hidelinks}
\title{Two-Column Manuscript}
\author{Author One \and Author Two\\ D509 Laboratory}
\date{\today}
\begin{document}
\maketitle

\begin{abstract}
Two-column manuscripts are the norm for conference proceedings: keep the
abstract short and move detailed methods into the main text.
\end{abstract}

\section{Introduction}
State the contribution in one or two sentences.

\section{Methods}
A compact description of the experimental design.

\begin{equation}
  y = \beta_0 + \beta_1 x + \varepsilon
\end{equation}

\section{Results}
\begin{table}[htbp]
  \centering
  \caption{Results summary}
  \begin{tabular}{lrr}
    \toprule
    Treatment & Mean & SD \\
    \midrule
    Control & 1.00 & 0.05 \\
    Treated & 1.42 & 0.08 \\
    \bottomrule
  \end{tabular}
\end{table}

\section{Conclusion}
One paragraph, no new claims.

\bibliographystyle{plain}
% \bibliography{refs}

\end{document}
""",
    },
    {
        "id": "thesis",
        "name": "学位论文骨架（可直接编译）",
        "description": "自包含的学位论文骨架：封面 / 中英文摘要 / 目录 / 正文章节 / 参考文献 / 致谢，用 ctexbook 排版，开箱即可编译。"
        "要用学校官方模板，把 nwafuthesis.cls（及 .bst）作为「素材」上传，再把第一行换成 \\documentclass{nwafuthesis} 即可。",
        "kind": "thesis",
        "tags": ["中文", "学位论文"],
        "content": r"""% !TeX program = xelatex
% ---------------------------------------------------------------------------
% 自包含的学位论文骨架：不依赖任何额外的类文件，新建即可编译。
%
% 想换成学校官方模板（nwafuthesis）：
%   1) 在右侧「素材」里上传 nwafuthesis.cls（需要 .bst 的话一并上传）；
%   2) 把下面这行的 ctexbook 换成 nwafuthesis，并按其文档填入 \title 等字段；
%   3) 素材会与 main.tex 放在同一目录，xelatex 按文件名就能找到。
%   缺文件时编译会**提前**报出「缺少 xxx.cls」，而不是停在交互提示符上。
% ---------------------------------------------------------------------------
\documentclass[UTF8,zihao=-4,openany]{ctexbook}

\usepackage[a4paper,left=3cm,right=2.5cm,top=2.8cm,bottom=2.5cm]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{setspace}
\usepackage[hidelinks]{hyperref}
% titling 提供 \thetitle / \theauthor / \thedate：ctexbook 本身没有这几个宏，
% 直接写 \thetitle 会报 "Undefined control sequence"。
\usepackage{titling}
\onehalfspacing

\title{学位论文题目}
\author{作者姓名}
\date{\today}

\begin{document}

% ---------------------------------------------------------------- 封面
\begin{titlepage}
  \centering
  \vspace*{2cm}
  {\zihao{2}\bfseries 西\quad 北\quad 农\quad 林\quad 科\quad 技\quad 大\quad 学\par}
  \vspace{2cm}
  {\zihao{1}\bfseries 学\quad 位\quad 论\quad 文\par}
  \vspace{2.5cm}
  {\zihao{3}\bfseries \thetitle\par}
  \vfill
  \begin{tabular}{rl}
    \zihao{4}学\quad 科 & \zihao{4}作物遗传育种 \\
    \zihao{4}研究方向 & \zihao{4}（填写） \\
    \zihao{4}研究生 & \zihao{4}\theauthor \\
    \zihao{4}指导教师 & \zihao{4}（填写） \\
  \end{tabular}
  \vfill
  {\zihao{4}\thedate\par}
\end{titlepage}

% ---------------------------------------------------------------- 摘要
\frontmatter
\chapter*{摘\quad 要}
\addcontentsline{toc}{chapter}{摘要}

这里是中文摘要。一段话讲清楚：研究背景与问题、用了什么方法、得到什么结果、
结论与意义。摘要里不放图表、不引用文献，一般 300--500 字。

\vspace{1em}
\noindent\textbf{关键词：}关键词一；关键词二；关键词三

\chapter*{Abstract}
\addcontentsline{toc}{chapter}{Abstract}

English abstract goes here. It should mirror the Chinese abstract: background,
methods, results and conclusion, in one paragraph of roughly 250--350 words.

\vspace{1em}
\noindent\textbf{Keywords:} keyword one; keyword two; keyword three

% ---------------------------------------------------------------- 目录
\tableofcontents
\clearpage
\mainmatter

% ---------------------------------------------------------------- 正文
\chapter{绪论}
\section{研究背景}
正文从这里开始。\LaTeX{} 里空行分段，中文标点直接用全角。

\section{研究进展}
引用示例~\cite{example2026}。

\chapter{材料与方法}
\section{试验材料}
\begin{table}[htbp]
  \centering
  \caption{供试材料一览}
  \begin{tabular}{lll}
    \toprule
    编号 & 名称 & 备注 \\
    \midrule
    M1 & 材料一 & 对照 \\
    M2 & 材料二 & 处理 \\
    \bottomrule
  \end{tabular}
\end{table}

\section{统计分析}
\begin{equation}
  y_{ij} = \mu + \tau_i + \varepsilon_{ij}
\end{equation}

\chapter{结果与分析}
\section{主要结果}
把图和表放在论证链上，而不是堆在一起。

\chapter{讨论与结论}
\section{讨论}
\section{结论}

% ---------------------------------------------------------------- 参考文献
% 用 thebibliography 内联，免去 bibtex 的额外步骤；正式投稿可换成
% \bibliographystyle{...} + \bibliography{refs}（refs.bib 作为素材上传）。
\backmatter
\begin{thebibliography}{99}
  \bibitem{example2026} 作者. 文献题名[J]. 期刊名, 2026, 1(1): 1--10.
\end{thebibliography}

\chapter*{致\quad 谢}
\addcontentsline{toc}{chapter}{致谢}
感谢导师、同学与家人的支持。

\end{document}
""",
    },
    {
        "id": "letter",
        "name": "正式信件",
        "description": "letter 类公文写法：右上角落款、称呼、正文与签名，适合合作与事务性信件。",
        "kind": "letter",
        "tags": ["英文", "信件"],
        "content": r"""\documentclass[11pt]{letter}
\usepackage[margin=2.5cm]{geometry}
\usepackage{hyperref}
\hypersetup{hidelinks}
\pagestyle{empty}
\begin{document}

\begin{flushright}
\today\\
\textbf{Editor-in-Chief}\\
\emph{Journal Name}\\
\texttt{editor@example.com}
\end{flushright}

\noindent Dear Editor,

\vspace{0.6em}
\noindent I am writing on behalf of the D509 Laboratory to submit our
manuscript entitled ``Manuscript Title'' for consideration as a
\emph{Article} in \emph{Journal Name}.

\vspace{0.6em}
\noindent The manuscript is original, has not been published elsewhere, and
is not under review by another journal. All authors have approved the
submission and declare no competing interests.

\vspace{0.6em}
\noindent We hope the manuscript is suitable for the journal and look
forward to your response.

\vspace{1.6em}
\noindent Sincerely,\\[0.6em]
\noindent \textbf{Author Name}\\
Researcher\\
D509 Laboratory\\
\texttt{name@example.com}

\end{document}
""",
    },
    {
        "id": "beamer",
        "name": "学术幻灯片",
        "description": "beamer 16:9 幻灯片骨架（标题 / 目录 / 背景 / 方法 / 结果 / 讨论 / 结论），适合组会与答辩。",
        "kind": "slides",
        "tags": ["英文", "幻灯片", "汇报"],
        "content": r"""\documentclass[aspectratio=169,11pt]{beamer}
\usepackage{amsmath,amssymb}
\usepackage{booktabs}
\usepackage{graphicx}
\setbeamertemplate{navigation symbols}{}
\setbeamercolor{structure}{fg=blue!70!black}
\setbeamertemplate{itemize item}{\textbullet}

\title{Presentation Title}
\author{Author Name \and D509 Laboratory}
\date{\today}

\begin{document}

\begin{frame}{Title}
  \titlepage
\end{frame}

\begin{frame}{Outline}
  \begin{enumerate}
    \item Background and question
    \item Materials and methods
    \item Results
    \item Discussion and conclusion
  \end{enumerate}
\end{frame}

\begin{frame}{Background}
  \begin{itemize}
    \item The problem this study addresses.
    \item Why the existing approaches fall short.
    \item The hypothesis, stated in one line.
  \end{itemize}
\end{frame}

\begin{frame}{Methods}
  \begin{itemize}
    \item Samples, treatments and controls.
    \item Measurements and statistics.
  \end{itemize}
  \begin{equation}
    y = \beta_0 + \beta_1 x + \varepsilon
  \end{equation}
\end{frame}

\begin{frame}{Results}
  \begin{table}
    \centering
    \begin{tabular}{lrr}
      \toprule
      Treatment & Mean & SD \\
      \midrule
      Control & 1.00 & 0.05 \\
      Treated & 1.42 & 0.08 \\
      \bottomrule
    \end{tabular}
  \end{table}
\end{frame}

\begin{frame}{Discussion}
  \begin{itemize}
    \item What the numbers mean.
    \item Limitations of the design.
    \item Next experiments.
  \end{itemize}
\end{frame}

\begin{frame}{Conclusion}
  \begin{itemize}
    \item One sentence per contribution.
    \item Take-home message.
  \end{itemize}
\end{frame}

\begin{frame}{Thanks}
  \centering Questions and comments are welcome.
\end{frame}

\end{document}
""",
    },
    {
        "id": "thesis-chapter",
        "name": "学位论文章节",
        "description": "ctexrep 章节骨架，含节、小节、公式与参考文献占位，可直接并入学位论文。",
        "kind": "thesis",
        "tags": ["中文", "学位论文"],
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
        "tags": ["中文", "投稿信"],
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


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


async def prune_versions(doc_id: str, owner: str, keep: int = VERSION_KEEP) -> int:
    """只保留最近 ``keep`` 个版本快照，返回删掉的条数。

    版本表存的是整份源码快照，不设上限会一直涨；每次写入新版本后调用本函数，
    把超出部分（最旧的）立刻删掉。
    """
    keep = max(0, keep)
    rows = await _aq(
        """
        DELETE FROM labspace.latex_versions
         WHERE id IN (
               SELECT id FROM labspace.latex_versions
                WHERE doc_id = %s AND owner = %s
                ORDER BY created_at DESC, id DESC
                OFFSET %s
         )
        RETURNING id
        """,
        (doc_id, owner, keep),
    )
    return len(rows)


async def _version(doc_id: str, owner: str, kind: str, note: str, content: str) -> None:
    """记一个可对比的版本：事件表留时间线，版本表存源码快照。

    - 内容与上一版完全相同（sha256 一致）就不再存第二份源码，只留时间线事件；
    - 存完新快照后调用 ``prune_versions``，把超出保留份数的旧快照删掉。

    事件 id 用 ``INSERT ... RETURNING`` 取回，好让快照挂到具体那一次事件上；
    ``db.query`` 是现成的执行入口，这里不再往 db.py 里加函数。
    """
    latest = await _aq(
        "SELECT content FROM labspace.latex_versions WHERE doc_id=%s AND owner=%s"
        " ORDER BY created_at DESC, id DESC LIMIT 1",
        (doc_id, owner),
    )
    if latest and _sha256(str(latest[0].get("content") or "")) == _sha256(content):
        # 源码没变：只记事件，不重复存同样的快照
        await _event(doc_id, owner, kind, note)
        return
    rows = await _aq(
        "INSERT INTO labspace.latex_events (doc_id, owner, kind, note) VALUES (%s,%s,%s,%s) RETURNING id",
        (doc_id, owner, kind, note[:500]),
    )
    event_id = int(rows[0]["id"]) if rows else 0
    await _ax(
        "INSERT INTO labspace.latex_versions (event_id, doc_id, owner, content) VALUES (%s,%s,%s,%s)",
        (event_id, doc_id, owner, content),
    )
    await prune_versions(doc_id, owner)


def _review_out(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "docId": row.get("doc_id") or "",
        "author": row.get("author") or "",
        "lineFrom": int(row.get("line_from") or 1),
        "lineTo": int(row.get("line_to") or 1),
        "quote": row.get("quote") or "",
        "comment": row.get("comment") or "",
        "status": row.get("status") or "open",
        "replyCount": int(row.get("reply_count") or 0),
        "createdAt": _iso(row.get("created_at")),
        "updatedAt": _iso(row.get("updated_at")),
    }


def _reply_out(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "reviewId": row.get("review_id") or "",
        "author": row.get("author") or "",
        "content": row.get("content") or "",
        "createdAt": _iso(row.get("created_at")),
    }


async def _owned(doc_id: str, owner: str) -> dict[str, Any]:
    rows = await _aq("SELECT * FROM labspace.latex_documents WHERE id=%s AND owner=%s", (doc_id, owner))
    if not rows:
        raise HTTPException(status_code=404, detail="文稿不存在或无权访问")
    return rows[0]


async def _review_row(doc_id: str, owner: str, review_id: str) -> dict[str, Any]:
    """取一条批注（带回复数）；不存在或不属于本人一律 404。"""
    rows = await _aq(
        """
        SELECT r.*,
               (SELECT count(*) FROM labspace.latex_review_replies rp WHERE rp.review_id = r.id) AS reply_count
          FROM labspace.latex_reviews r
         WHERE r.id = %s AND r.doc_id = %s AND r.owner = %s
        """,
        (review_id, doc_id, owner),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="批注不存在")
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


class ReviewCreate(BaseModel):
    """新建批注。前端用 camelCase（lineFrom / lineTo），也接受 snake_case。"""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    line_from: int = Field(default=1, ge=1, alias="lineFrom")
    line_to: int = Field(default=1, ge=1, alias="lineTo")
    quote: str = Field(default="", max_length=2000)
    comment: str = Field(default="", max_length=4000)


class ReviewStatus(BaseModel):
    status: str = "open"


class ReplyCreate(BaseModel):
    content: str = Field(default="", max_length=4000)


# ---------------------------------------------------------------- 路由


@router.get("/templates")
async def list_templates(user: dict = Depends(require_user)) -> dict[str, Any]:
    return {
        "templates": [{k: v for k, v in t.items() if k != "content"} for t in TEMPLATES],
        "statuses": [{"value": k, "label": v} for k, v in STATUSES],
    }


@router.get("/templates/{template_id}")
async def get_template(template_id: str, user: dict = Depends(require_user)) -> dict[str, Any]:
    """单个模板（含源码）：前端「预览源码」用它。"""
    for tpl in TEMPLATES:
        if tpl["id"] == template_id:
            return {"template": tpl}
    raise HTTPException(status_code=404, detail="模板不存在")


@router.get("/documents")
async def list_documents(
    q: str = Query(default="", max_length=120),
    status: str = Query(default=""),
    user: dict = Depends(require_user),
) -> dict[str, Any]:
    # SQL 保持完全静态：筛选条件用「参数为空的短路判断」表达，
    # 不拼 where 子句 —— 拼 SQL 的写法即使当前安全，也挡不住下一个人加一个
    # 未转义的片段进来。
    like = f"%{q.strip()}%" if q.strip() else "%"
    status_key = status if status in STATUS_KEYS else ""
    rows = await _aq(
        """
        SELECT * FROM labspace.latex_documents
         WHERE owner = %s
           AND (%s = '' OR title ILIKE %s OR venue ILIKE %s OR abstract ILIKE %s)
           AND (%s = '' OR status = %s)
         ORDER BY updated_at DESC
         LIMIT 200
        """,
        (user["sub"], q.strip(), like, like, like, status_key, status_key),
    )
    docs = [_doc_out(r) for r in rows]
    counts = dict.fromkeys(STATUS_KEYS, 0)
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
    await _version(doc_id, owner, "created", f"从模板「{tpl['name']}」创建", tpl["content"])
    return {"document": _doc_out(await _owned(doc_id, owner))}


@router.post("/import-docx")
async def import_docx(
    file: UploadFile = File(...),
    template: str = Form("article"),
    user: dict = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    """把 .docx 转成 LaTeX 并建成一份新文稿。

    转换规则与限制见 app/docx2latex.py：图片、公式、合并单元格等无法可靠还原
    的部分会在 warnings 里逐条说明，不静默丢弃。
    """
    filename = (file.filename or "").strip()
    if not filename.lower().endswith(".docx"):
        raise HTTPException(status_code=400, detail="只支持 .docx 文件")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="文件为空")
    if len(data) > MAX_CONTENT * 8:
        raise HTTPException(status_code=413, detail="DOCX 超过 3.2 MB 上限")

    title = Path(filename).stem[:MAX_TITLE] or "未命名文稿"
    try:
        conv = convert_docx(data, template=template, fallback_title=title)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    doc_id = uuid.uuid4().hex
    owner = user["sub"]
    kind = "thesis" if template == "nwafu" else "article"
    await _ax(
        """
        INSERT INTO labspace.latex_documents (id, owner, title, kind, content)
        VALUES (%s,%s,%s,%s,%s)
        """,
        (doc_id, owner, title, kind, conv.latex),
    )
    await _version(doc_id, owner, "created", f"由 DOCX 导入（{filename}）", conv.latex)
    return {
        "document": _doc_out(await _owned(doc_id, owner)),
        "warnings": conv.warnings,
        "stats": conv.stats,
    }


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
    payload = body.model_dump(exclude_unset=True)
    if "status" in payload and payload["status"] not in STATUS_KEYS:
        raise HTTPException(status_code=400, detail="未知的投稿状态")

    def pick(key: str) -> tuple[bool, Any]:
        """返回 (是否要写这一列, 新值)。未出现在请求体里的列保持原值。"""
        if key not in payload:
            return False, None
        value = payload[key]
        if key == "title":
            value = (value or "").strip() or "未命名文稿"
        if key == "content" and not (value or "").strip():
            return False, None
        if key == "due_date" and value == "":
            value = None
        return True, value

    columns = ("title", "venue", "authors", "status", "abstract", "keywords", "content", "project_id", "knowledge_doc_id", "due_date")
    flags_and_values: list[Any] = []
    for key in columns:
        set_flag, value = pick(key)
        flags_and_values.extend([set_flag, value])
    if not any(flags_and_values[0::2]):
        return {"document": _doc_out(current)}
    # 静态 SQL：每列都是 CASE WHEN <是否更新> THEN <新值> ELSE <原值>，
    # 既不需要拼接列名，也能表达"显式清空"（新值为 NULL）。
    await _ax(
        """
        UPDATE labspace.latex_documents SET
          title            = CASE WHEN %s THEN %s ELSE title END,
          venue            = CASE WHEN %s THEN %s ELSE venue END,
          authors          = CASE WHEN %s THEN %s ELSE authors END,
          status           = CASE WHEN %s THEN %s ELSE status END,
          abstract         = CASE WHEN %s THEN %s ELSE abstract END,
          keywords         = CASE WHEN %s THEN %s ELSE keywords END,
          content          = CASE WHEN %s THEN %s ELSE content END,
          project_id       = CASE WHEN %s THEN %s ELSE project_id END,
          knowledge_doc_id = CASE WHEN %s THEN %s ELSE knowledge_doc_id END,
          due_date         = CASE WHEN %s THEN %s ELSE due_date END,
          updated_at       = now()
         WHERE id = %s AND owner = %s
        """,
        tuple(flags_and_values) + (doc_id, user["sub"]),
    )
    new_status = payload.get("status")
    if new_status and new_status != current.get("status"):
        label = dict(STATUSES)
        prev = str(current.get("status") or "")
        nxt = str(new_status)
        await _event(doc_id, user["sub"], "status", f"{label.get(prev, prev)} → {label.get(nxt, nxt)}")
    # 源码变了就留一个版本快照，版本对比才有得比（没变就不重复存）
    new_content = payload.get("content")
    if (
        isinstance(new_content, str)
        and new_content.strip()
        and new_content != (current.get("content") or "")
    ):
        await _version(doc_id, user["sub"], "save", "保存源码", new_content)
    return {"document": _doc_out(await _owned(doc_id, user["sub"]))}


@router.delete("/documents/{doc_id}")
async def delete_document(doc_id: str, user: dict = Depends(require_user), _: None = Depends(require_csrf)) -> dict[str, Any]:
    await _owned(doc_id, user["sub"])
    await _ax("DELETE FROM labspace.latex_documents WHERE id=%s AND owner=%s", (doc_id, user["sub"]))
    await _ax("DELETE FROM labspace.latex_events WHERE doc_id=%s AND owner=%s", (doc_id, user["sub"]))
    await _ax("DELETE FROM labspace.latex_versions WHERE doc_id=%s AND owner=%s", (doc_id, user["sub"]))
    await _ax("DELETE FROM labspace.latex_assets WHERE doc_id=%s AND owner=%s", (doc_id, user["sub"]))
    await _ax(
        "DELETE FROM labspace.latex_review_replies WHERE review_id IN"
        " (SELECT id FROM labspace.latex_reviews WHERE doc_id=%s AND owner=%s)",
        (doc_id, user["sub"]),
    )
    await _ax("DELETE FROM labspace.latex_reviews WHERE doc_id=%s AND owner=%s", (doc_id, user["sub"]))
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


@router.get("/documents/{doc_id}/reviews")
async def list_reviews(doc_id: str, user: dict = Depends(require_user)) -> dict[str, Any]:
    await _owned(doc_id, user["sub"])
    rows = await _aq(
        """
        SELECT r.*,
               (SELECT count(*) FROM labspace.latex_review_replies rp WHERE rp.review_id = r.id) AS reply_count
          FROM labspace.latex_reviews r
         WHERE r.doc_id = %s AND r.owner = %s
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT %s
        """,
        (doc_id, user["sub"], MAX_REVIEWS),
    )
    return {"reviews": [_review_out(r) for r in rows]}


@router.post("/documents/{doc_id}/reviews")
async def create_review(
    doc_id: str,
    body: ReviewCreate,
    user: dict = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    await _owned(doc_id, user["sub"])
    line_from = body.line_from
    line_to = max(body.line_to, body.line_from)
    review_id = uuid.uuid4().hex
    await _ax(
        """
        INSERT INTO labspace.latex_reviews
          (id, doc_id, owner, author, line_from, line_to, quote, comment, status)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'open')
        """,
        (
            review_id,
            doc_id,
            user["sub"],
            user.get("name") or user.get("email") or "",
            line_from,
            line_to,
            body.quote.strip(),
            body.comment.strip(),
        ),
    )
    return {"review": _review_out(await _review_row(doc_id, user["sub"], review_id))}


@router.patch("/documents/{doc_id}/reviews/{review_id}")
async def update_review(
    doc_id: str,
    review_id: str,
    body: ReviewStatus,
    user: dict = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    await _owned(doc_id, user["sub"])
    if body.status not in REVIEW_STATUS_KEYS:
        raise HTTPException(status_code=400, detail="未知的批注状态")
    await _review_row(doc_id, user["sub"], review_id)
    await _ax(
        "UPDATE labspace.latex_reviews SET status=%s, updated_at=now()"
        " WHERE id=%s AND doc_id=%s AND owner=%s",
        (body.status, review_id, doc_id, user["sub"]),
    )
    return {"review": _review_out(await _review_row(doc_id, user["sub"], review_id))}


@router.delete("/documents/{doc_id}/reviews/{review_id}")
async def delete_review(
    doc_id: str,
    review_id: str,
    user: dict = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    await _owned(doc_id, user["sub"])
    await _review_row(doc_id, user["sub"], review_id)
    await _ax("DELETE FROM labspace.latex_review_replies WHERE review_id=%s", (review_id,))
    await _ax(
        "DELETE FROM labspace.latex_reviews WHERE id=%s AND doc_id=%s AND owner=%s",
        (review_id, doc_id, user["sub"]),
    )
    return {"ok": True}


@router.get("/documents/{doc_id}/reviews/{review_id}/replies")
async def list_replies(doc_id: str, review_id: str, user: dict = Depends(require_user)) -> dict[str, Any]:
    await _owned(doc_id, user["sub"])
    await _review_row(doc_id, user["sub"], review_id)
    rows = await _aq(
        "SELECT * FROM labspace.latex_review_replies WHERE review_id=%s ORDER BY created_at ASC, id ASC LIMIT %s",
        (review_id, MAX_REPLIES),
    )
    return {"replies": [_reply_out(r) for r in rows]}


@router.post("/documents/{doc_id}/reviews/{review_id}/replies")
async def add_reply(
    doc_id: str,
    review_id: str,
    body: ReplyCreate,
    user: dict = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    await _owned(doc_id, user["sub"])
    await _review_row(doc_id, user["sub"], review_id)
    reply_id = uuid.uuid4().hex
    await _ax(
        "INSERT INTO labspace.latex_review_replies (id, review_id, owner, author, content)"
        " VALUES (%s,%s,%s,%s,%s)",
        (reply_id, review_id, user["sub"], user.get("name") or user.get("email") or "", body.content.strip()),
    )
    rows = await _aq("SELECT * FROM labspace.latex_review_replies WHERE id=%s", (reply_id,))
    reply = rows[0] if rows else {"id": reply_id, "review_id": review_id, "content": body.content.strip()}
    return {"reply": _reply_out(reply)}


@router.get("/documents/{doc_id}/versions")
async def list_versions(doc_id: str, user: dict = Depends(require_user)) -> dict[str, Any]:
    """版本列表：以事件为时间线（创建 / 保存 / 编译），版本表里存着当时的源码。"""
    await _owned(doc_id, user["sub"])
    rows = await _aq(
        """
        SELECT e.id AS id, e.kind AS kind, e.note AS note, e.created_at AS created_at,
               (v.id IS NOT NULL) AS has_content
          FROM labspace.latex_events e
          LEFT JOIN labspace.latex_versions v ON v.event_id = e.id
         WHERE e.doc_id = %s AND e.owner = %s AND e.kind IN ('created','save','compile')
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT %s
        """,
        (doc_id, user["sub"], MAX_VERSIONS),
    )
    return {
        "versions": [
            {
                "id": int(r["id"]),
                "kind": r.get("kind") or "save",
                "note": r.get("note") or "",
                "createdAt": _iso(r.get("created_at")),
                "hasContent": bool(r.get("has_content")),
            }
            for r in rows
        ]
    }


@router.get("/documents/{doc_id}/versions/{version_id}")
async def get_version(doc_id: str, version_id: str, user: dict = Depends(require_user)) -> dict[str, Any]:
    await _owned(doc_id, user["sub"])
    try:
        vid = int(version_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="版本编号非法") from exc
    rows = await _aq(
        """
        SELECT e.id AS id, e.kind AS kind, e.note AS note, e.created_at AS created_at, v.content AS content
          FROM labspace.latex_events e
          JOIN labspace.latex_versions v ON v.event_id = e.id
         WHERE e.id = %s AND e.doc_id = %s AND e.owner = %s
        """,
        (vid, doc_id, user["sub"]),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="版本不存在")
    row = rows[0]
    return {
        "version": {
            "id": int(row["id"]),
            "kind": row.get("kind") or "save",
            "note": row.get("note") or "",
            "createdAt": _iso(row.get("created_at")),
            "content": row.get("content") or "",
        }
    }


def _asset_out(row: dict[str, Any]) -> dict[str, Any]:
    """素材对外形状：只给元信息，不带二进制内容。"""
    return {
        "id": row["id"],
        "name": row.get("name") or "",
        "bytes": int(row.get("bytes") or 0),
        "contentType": row.get("content_type") or "application/octet-stream",
        "createdAt": _iso(row.get("created_at")),
    }


def _asset_name(raw: str) -> str:
    """文件名规范化：去掉路径成分（不能带目录，也不能带控制字符）。"""
    name = raw.replace("\\", "/").split("/")[-1].strip()
    name = re.sub(r"[\x00-\x1f\x7f]", "", name)
    return name[:120]


def _asset_ext(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


async def _asset_files(doc_id: str, owner: str) -> dict[str, bytes]:
    """取该文稿的全部素材，键为文件名（同名只保留先上传的那个）。"""
    rows = await _aq(
        "SELECT name, data FROM labspace.latex_assets WHERE doc_id=%s AND owner=%s ORDER BY created_at ASC, id ASC",
        (doc_id, owner),
    )
    files: dict[str, bytes] = {}
    for row in rows:
        name = _asset_name(str(row.get("name") or ""))
        if not name or name in files:
            continue
        data = row.get("data")
        files[name] = bytes(data) if data is not None else b""
    return files


@router.get("/documents/{doc_id}/assets")
async def list_assets(doc_id: str, user: dict = Depends(require_user)) -> dict[str, Any]:
    """素材列表（不含二进制）。素材按 owner 隔离，别人的素材看不到也删不掉。"""
    await _owned(doc_id, user["sub"])
    rows = await _aq(
        "SELECT id, name, bytes, content_type, created_at FROM labspace.latex_assets"
        " WHERE doc_id=%s AND owner=%s ORDER BY created_at ASC, id ASC",
        (doc_id, user["sub"]),
    )
    return {"assets": [_asset_out(r) for r in rows]}


@router.post("/documents/{doc_id}/assets")
async def upload_asset(
    doc_id: str,
    file: UploadFile = File(...),
    user: dict = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    """上传编译素材（.cls / .sty / 图片等）：编译时与源码一起进沙箱。"""
    await _owned(doc_id, user["sub"])
    name = _asset_name(file.filename or "")
    if not name:
        raise HTTPException(status_code=400, detail="文件名不能为空")
    ext = _asset_ext(name)
    if ext not in ASSET_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="只支持这些扩展名：" + "、".join("." + e for e in ASSET_EXTENSIONS),
        )
    raw = await read_upload_capped(file, MAX_ASSET_BYTES, message="单个素材不能超过 2 MB")
    if not raw:
        raise HTTPException(status_code=400, detail="文件为空")

    rows = await _aq(
        "SELECT count(*) AS n, coalesce(sum(bytes), 0) AS total FROM labspace.latex_assets"
        " WHERE doc_id=%s AND owner=%s",
        (doc_id, user["sub"]),
    )
    count = int(rows[0].get("n") or 0) if rows else 0
    total = int(rows[0].get("total") or 0) if rows else 0
    if count >= MAX_ASSETS_PER_DOC:
        raise HTTPException(status_code=400, detail=f"每份文稿最多 {MAX_ASSETS_PER_DOC} 个素材")
    if total + len(raw) > MAX_ASSETS_TOTAL_BYTES:
        raise HTTPException(status_code=413, detail="素材总大小超过 20 MB 上限")

    asset_id = uuid.uuid4().hex
    await _ax(
        "INSERT INTO labspace.latex_assets (id, doc_id, owner, name, bytes, content_type, data)"
        " VALUES (%s,%s,%s,%s,%s,%s,%s)",
        (
            asset_id,
            doc_id,
            user["sub"],
            name,
            len(raw),
            file.content_type or "application/octet-stream",
            raw,
        ),
    )
    meta = await _aq(
        "SELECT id, name, bytes, content_type, created_at FROM labspace.latex_assets WHERE id=%s",
        (asset_id,),
    )
    if not meta:
        raise HTTPException(status_code=500, detail="素材保存失败")
    return {"asset": _asset_out(meta[0])}


@router.delete("/documents/{doc_id}/assets/{asset_id}")
async def delete_asset(
    doc_id: str,
    asset_id: str,
    user: dict = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    await _owned(doc_id, user["sub"])
    rows = await _aq(
        "SELECT id FROM labspace.latex_assets WHERE id=%s AND doc_id=%s AND owner=%s",
        (asset_id, doc_id, user["sub"]),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="素材不存在")
    await _ax(
        "DELETE FROM labspace.latex_assets WHERE id=%s AND doc_id=%s AND owner=%s",
        (asset_id, doc_id, user["sub"]),
    )
    return {"ok": True}


@router.post("/documents/{doc_id}/compile")
async def compile_document(doc_id: str, user: dict = Depends(require_user), _: None = Depends(require_csrf)) -> dict[str, Any]:
    row = await _owned(doc_id, user["sub"])
    content = row.get("content") or ""
    if not content.strip():
        raise HTTPException(status_code=400, detail="文稿内容为空")
    # 素材随源码一起送进编译沙箱：nwafuthesis.cls 之类的类文件放进去才能编过
    files = await _asset_files(doc_id, user["sub"])
    payload: dict[str, Any] = {"content": content}
    if files:
        payload["files"] = {name: base64.b64encode(data).decode("ascii") for name, data in files.items()}
    try:
        async with httpx.AsyncClient(timeout=settings.latex_timeout) as client:
            resp = await client.post(f"{settings.latex_worker}/compile", json=payload)
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
        await _version(doc_id, user["sub"], "compile", "编译失败", content)
        return {"ok": False, "log": log, "ms": ms}
    await _ax(
        "UPDATE labspace.latex_documents SET compiled_at=now(), compile_ok=true, compile_log=%s, pdf_bytes=%s, updated_at=now()"
        " WHERE id=%s AND owner=%s",
        (log, pdf_bytes, doc_id, user["sub"]),
    )
    await _version(doc_id, user["sub"], "compile", f"编译成功 · {pdf_bytes // 1024} KB · {ms} ms", content)
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
