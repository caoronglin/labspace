"""DOCX → LaTeX 转换：结构映射与转义。

用 python-docx 现场生成文档再转换 —— 断言的是真实 OOXML 解析结果，
而不是手工构造的假对象。
"""
from __future__ import annotations

import io

import docx
import pytest

from app.docx2latex import convert_docx, escape_latex


def _docx_bytes(build) -> bytes:
    document = docx.Document()
    build(document)
    buf = io.BytesIO()
    document.save(buf)
    return buf.getvalue()


def test_escape_covers_backslash_first():
    # 反斜杠若在其它规则之后替换，会把新插入的 \ 再转义一次
    assert escape_latex("a\\b") == r"a\textbackslash{}b"
    assert escape_latex("100% & $5 #1 _x_ {y} ~z ^") == (
        r"100\% \& \$5 \#1 \_x\_ \{y\} \textasciitilde{}z \textasciicircum{}"
    )


def test_headings_paragraphs_and_inline_styles():
    def build(d):
        d.add_heading("Introduction", level=1)
        p = d.add_paragraph()
        p.add_run("Bold").bold = True
        p.add_run(" and ")
        it = p.add_run("italic")
        it.italic = True
        d.add_heading("Method", level=2)

    conv = convert_docx(_docx_bytes(build))
    assert r"\section{Introduction}" in conv.latex
    assert r"\subsection{Method}" in conv.latex
    assert r"\textbf{Bold}" in conv.latex
    assert r"\textit{italic}" in conv.latex
    assert conv.stats["headings"] == 2


def test_table_becomes_booktabs():
    def build(d):
        table = d.add_table(rows=3, cols=2)
        table.cell(0, 0).text = "处理"
        table.cell(0, 1).text = "均值"
        table.cell(1, 0).text = "对照"
        table.cell(1, 1).text = "1.0"
        table.cell(2, 0).text = "处理"
        table.cell(2, 1).text = "2.5"

    conv = convert_docx(_docx_bytes(build))
    assert r"\begin{tabular}{ll}" in conv.latex
    assert r"\toprule" in conv.latex and r"\bottomrule" in conv.latex
    assert "处理 & 均值" in conv.latex
    assert conv.stats["tables"] == 1


def test_cjk_document_uses_ctexart():
    def build(d):
        d.add_heading("材料与方法", level=1)
        d.add_paragraph("本文以水稻为材料。")

    conv = convert_docx(_docx_bytes(build))
    assert "ctexart" in conv.latex
    assert r"\section{材料与方法}" in conv.latex


def test_latin_document_uses_plain_article():
    def build(d):
        d.add_heading("Results", level=1)
        d.add_paragraph("Yield increased.")

    conv = convert_docx(_docx_bytes(build))
    assert r"\documentclass[11pt]{article}" in conv.latex
    assert "ctexart" not in conv.latex


def test_nwafu_template_compiles_without_school_class_file():
    """学位论文模板必须**开箱可编译**。

    以前这里生成的是 school 类（nwafuthesis），而学校类文件不在仓库里，
    用户点「编译」只会停在 "File `nwafuthesis.cls' not found"。
    现在改用 ctexbook，并在注释里说明怎么换成官方类文件。
    """

    def build(d):
        d.add_heading("摘要", level=1)

    conv = convert_docx(_docx_bytes(build), template="nwafu")
    assert r"\documentclass[UTF8,zihao=-4,openany]{ctexbook}" in conv.latex
    # 官方类文件留成注释里的可切换说明，而不是直接用
    assert "% 想用学校官方 nwafuthesis" in conv.latex


def test_title_style_becomes_title_command():
    def build(d):
        d.add_paragraph("我的论文", style="Title")
        d.add_heading("引言", level=1)

    conv = convert_docx(_docx_bytes(build))
    assert r"\title{我的论文}" in conv.latex
    assert r"\maketitle" in conv.latex


def test_missing_heading_styles_produce_warning():
    def build(d):
        d.add_paragraph("just text")

    conv = convert_docx(_docx_bytes(build))
    assert any("未识别到标题样式" in w for w in conv.warnings)


def test_invalid_payload_raises_value_error():
    with pytest.raises(ValueError, match="无法解析 DOCX"):
        convert_docx(b"not a zip")


def test_images_are_reported_not_silently_dropped(tmp_path):
    from PIL import Image  # noqa: PLC0415

    img_path = tmp_path / "plot.png"
    Image.new("RGB", (10, 10), "white").save(img_path)

    def build(d):
        d.add_heading("Fig", level=1)
        d.add_picture(str(img_path))

    conv = convert_docx(_docx_bytes(build))
    assert any("图片" in w for w in conv.warnings)
