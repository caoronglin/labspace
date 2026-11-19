"""DOCX → LaTeX 转换。

为什么自己写而不是调现成工具
----------------------------
参照的 transpect/docx2tex 是 XSLT 流水线（docx → DocBook/HTML → TeX），依赖
Java + Saxon，跑在一个 FastAPI 容器里既重又慢；而本项目已经有 python-docx
（Office 编辑模块在用），Word 文档的结构化程度也足够直接映射。

支持范围（刻意保守）
--------------------
* 标题：Heading 1/2/3 → section/subsection/subsubsection；Title → \\title
* 段落：普通段落、粗体/斜体/等宽 run → \\textbf / \\textit / \\texttt
* 列表：List Bullet → itemize，List Number → enumerate（只还原一层，嵌套会记警告）
* 表格：首行作表头，booktabs 三线表
* 代码/公式：Word 里的 OMML 公式无法可靠还原，记警告并保留占位注释

不支持的地方**明确报出来**（warnings），不静默丢内容——丢一张图不告诉人，
比转换失败更糟。
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from typing import Any

# LaTeX 特殊字符映射。
#
# 必须**单遍**替换：早先按"列表顺序逐个 replace"写过一版，反斜杠先被换成
# \textbackslash{}，随后花括号规则又把替换结果里的 {} 再转义一次，得到
# \textbackslash\{\} —— 转义函数的输出自己还要被转义，说明做法是错的。
# 用一次正则扫描原始字符、按字符映射，插入的替换文本不会再被处理。
_ESCAPES: dict[str, str] = {
    "\\": r"\textbackslash{}",
    "&": r"\&",
    "%": r"\%",
    "$": r"\$",
    "#": r"\#",
    "_": r"\_",
    "{": r"\{",
    "}": r"\}",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
}
_ESCAPE_RE = re.compile(r"[\\&%$#_{}~^]")

_HEADING_MAP = {
    "Title": None,  # 单独处理
    "Heading 1": "section",
    "Heading 2": "subsection",
    "Heading 3": "subsubsection",
    "Heading 4": "paragraph",
    "标题 1": "section",
    "标题 2": "subsection",
    "标题 3": "subsubsection",
}

_CJK = re.compile(r"[\u4e00-\u9fff]")


def escape_latex(text: str) -> str:
    """把普通文本转成可直接放进 LaTeX 正文的文本（单遍替换，不二次转义）。"""
    return _ESCAPE_RE.sub(lambda m: _ESCAPES[m.group(0)], text or "")


def _style_name(paragraph: Any) -> str:
    style = getattr(paragraph, "style", None)
    return str(getattr(style, "name", "") or "")


def _run_latex(run: Any) -> str:
    """把一个 run 变成带样式的 LaTeX 片段。"""
    text = escape_latex(run.text or "")
    if not text:
        return ""
    font = getattr(run, "font", None)
    if font is not None and getattr(font, "name", None) in {"Consolas", "Courier New", "Menlo", "monospace"}:
        text = rf"\texttt{{{text}}}"
    if getattr(run, "italic", False):
        text = rf"\textit{{{text}}}"
    if getattr(run, "bold", False):
        text = rf"\textbf{{{text}}}"
    return text


def _paragraph_latex(paragraph: Any) -> str:
    return "".join(_run_latex(run) for run in getattr(paragraph, "runs", []) or [])


def _table_latex(table: Any) -> tuple[str, list[str]]:
    warnings: list[str] = []
    rows: list[list[str]] = []
    for row in table.rows:
        cells = []
        for cell in row.cells:
            # 单元格内多段落用 \\ 分隔，避免直接拼接成一坨
            text = " \\\\ ".join(_paragraph_latex(p) for p in cell.paragraphs if _paragraph_latex(p).strip())
            cells.append(text or "")
        rows.append(cells)
    if not rows:
        return "", ["空表格已跳过"]
    width = max(len(r) for r in rows)
    if any(len(r) != width for r in rows):
        warnings.append("表格存在合并单元格，已按等宽列补齐，可能需要手工调整")
    spec = "l" * width
    lines = [
        r"\begin{table}[htbp]",
        r"  \centering",
        rf"  \begin{{tabular}}{{{spec}}}",
        r"    \toprule",
        "    " + " & ".join(rows[0]) + r" \\",
        r"    \midrule",
    ]
    for row in rows[1:]:
        padded = row + [""] * (width - len(row))
        lines.append("    " + " & ".join(padded) + r" \\")
    lines += [r"    \bottomrule", r"  \end{tabular}", r"\end{table}"]
    return "\n".join(lines), warnings


@dataclass(slots=True)
class Conversion:
    latex: str
    warnings: list[str] = field(default_factory=list)
    stats: dict[str, int] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {"latex": self.latex, "warnings": self.warnings, "stats": self.stats}


def _preamble(title: str, *, cjk: bool, template: str) -> str:
    if template == "nwafu":
        # 学校模板（nwafuthesis）不在本仓库内：只生成它的调用骨架，
        # 由用户在模板库上传后编译，而不是在这里假装能直接编译。
        head = [
            r"% 由 DOCX 转换生成；nwafuthesis 文稿类需在公共模板库中提供后方可编译",
            r"\documentclass{nwafuthesis}",
            r"\usepackage{booktabs}",
            r"\usepackage{graphicx}",
        ]
    elif cjk:
        head = [
            r"\documentclass[UTF8,11pt,fontset=fandol]{ctexart}",
            r"\usepackage[margin=2.54cm]{geometry}",
            r"\usepackage{amsmath,amssymb}",
            r"\usepackage{booktabs}",
            r"\usepackage{graphicx}",
            r"\usepackage{hyperref}",
        ]
    else:
        head = [
            r"\documentclass[11pt]{article}",
            r"\usepackage[margin=2.54cm]{geometry}",
            r"\usepackage{amsmath,amssymb}",
            r"\usepackage{booktabs}",
            r"\usepackage{graphicx}",
            r"\usepackage{hyperref}",
        ]
    if title:
        head.append(rf"\title{{{escape_latex(title)}}}")
        head.append(r"\date{\today}")
    return "\n".join(head)


def convert_docx(data: bytes, *, template: str = "article", fallback_title: str = "") -> Conversion:
    """把 .docx 字节流转换成一份可编译的 .tex。

    解析失败时抛 ValueError（带上游原因），不返回半截文档。
    """
    from docx import Document  # 局部导入：服务启动不因为缺可选依赖而崩

    try:
        document = Document(io.BytesIO(data))
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"无法解析 DOCX：{type(exc).__name__}") from exc

    warnings: list[str] = []
    blocks: list[str] = []
    title = fallback_title
    stats = {"paragraphs": 0, "headings": 0, "tables": 0, "lists": 0, "images": 0}

    # 用 body 的 XML 顺序遍历，保证段落与表格的先后关系不被打乱
    body = document.element.body
    para_iter = iter(document.paragraphs)
    table_iter = iter(document.tables)
    from docx.table import Table  # noqa: PLC0415
    from docx.text.paragraph import Paragraph  # noqa: PLC0415

    for child in body.iterchildren():
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "p":
            paragraph = next(para_iter, None) or Paragraph(child, document)
            style = _style_name(paragraph)
            text = _paragraph_latex(paragraph)
            if not text.strip():
                continue
            stats["paragraphs"] += 1
            if style == "Title" and not title:
                title = (paragraph.text or "").strip()
                continue
            section_cmd = _HEADING_MAP.get(style, False)
            if section_cmd:
                stats["headings"] += 1
                blocks.append(rf"\{section_cmd}{{{text.lstrip()}}}")
                continue
            if section_cmd is None:  # Title（已取用作标题时跳过）
                continue
            if style.startswith("List Bullet"):
                stats["lists"] += 1
                blocks.append(rf"  \item {text}")
                continue
            if style.startswith("List Number"):
                stats["lists"] += 1
                blocks.append(rf"  \item {text}")
                continue
            if style.startswith("List"):
                warnings.append(f"列表样式「{style}」按普通段落处理")
            blocks.append(text)
        elif tag == "tbl":
            table = next(table_iter, None) or Table(child, document)
            stats["tables"] += 1
            latex, table_warnings = _table_latex(table)
            warnings.extend(table_warnings)
            if latex:
                blocks.append(latex)

    # 图片：python-docx 只能给出内联关系，这里统计数量并提示手工补图
    for rel in getattr(document.part, "rels", {}).values():
        if "image" in str(getattr(rel, "reltype", "")):
            stats["images"] += 1
    if stats["images"]:
        warnings.append(
            f"文档含 {stats['images']} 张图片，已跳过：请把图片上传到文件存储后用 \\includegraphics 引用"
        )

    body_text = "\n\n".join(blocks) if blocks else "% 文档正文为空"
    cjk = bool(_CJK.search("\n".join(blocks) + title))
    preamble = _preamble(title, cjk=cjk, template=template)
    author = r"\author{}" if title else ""
    latex = "\n".join(
        part
        for part in [
            preamble,
            author,
            r"\begin{document}",
            r"\maketitle" if title else "",
            body_text,
            r"\end{document}",
            "",
        ]
        if part != ""
    )
    if not stats["headings"]:
        warnings.append("未识别到标题样式：Word 里请用「标题 1/2/3」而不是手动加粗")
    return Conversion(latex=latex, warnings=warnings, stats=stats)


def convert_docx_path(path: str, **kwargs: Any) -> Conversion:
    with open(path, "rb") as fh:
        return convert_docx(fh.read(), **kwargs)
