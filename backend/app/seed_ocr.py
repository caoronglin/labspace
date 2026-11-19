"""种子标签 OCR：拍照 → 文字 → 预填表单字段。

为什么是 Tesseract 而不是 RapidOCR / PaddleOCR
------------------------------------------------
本机 Python 是 3.15，``onnxruntime`` 与 ``paddlepaddle`` 都还没有 cp315 轮子，
RapidOCR 系列装不上。Tesseract 是系统二进制（``tesseract-ocr`` +
``tesseract-ocr-chi-sim``），不绑定 Python ABI，印刷体标签的识别率够用。

设计约束
--------
1. **只做预填，不做提交。** OCR 必然有错字，尤其曲面/反光/手写标签。
   识别结果一律回填到表单由人确认，绝不自动入库。
2. **不出网。** 全程本地二进制，种子信息不外传。
3. **失败不抛 500。** 识别不出内容时返回空字段 + 原始文本，
   让前端提示"没认出来，请手动填"，而不是给用户一个报错页。
"""

from __future__ import annotations

import asyncio
import logging
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

log = logging.getLogger("seed_ocr")

# 单张图识别上限：标签照片几秒足够，超时说明图太大或 tesseract 卡住
_TIMEOUT_SECONDS = 25.0

# 手机直拍常见 4000x3000，直接喂给 tesseract 又慢又差；先缩到这个宽度
_MAX_WIDTH = 2200

# 标签上会出现的字段关键词（中英混排），用于把一行文字归到对应字段
_KEYWORDS = {
    "species": ("物种", "种名", "拉丁", "学名", "species"),
    "variety": ("品种", "品系", "材料", "基因型", "variety", "line"),
    "code": ("编号", "批次", "批号", "种子号", "code", "batch", "lot"),
    "owner": ("负责人", "保管人", "owner", "联系人"),
    "location": ("位置", "存放", "冷库", "货架", "冰箱", "location", "box"),
    "quantity": ("数量", "粒", "克", "g", "粒数", "quantity", "count"),
}

# 常见计数单位，用于把数量后面的单位剥掉
_UNITS = ("粒", "g", "克", "管", "袋", "份", "包", "支", "ml", "mL")


def _available() -> bool:
    return shutil.which("tesseract") is not None


async def _run_tesseract(image_path: Path) -> str:
    """跑 tesseract，返回原始文本。失败返回空串（调用方按"没认出来"处理）。"""
    proc = await asyncio.create_subprocess_exec(
        "tesseract",
        str(image_path),
        "stdout",
        "-l",
        "chi_sim+eng",
        "--psm",
        "6",  # 假定是一块统一的文本块，适合整块标签
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=_TIMEOUT_SECONDS)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        log.warning("tesseract 超时（%ss）", _TIMEOUT_SECONDS)
        return ""
    if proc.returncode != 0:
        log.warning("tesseract 退出码 %s：%s", proc.returncode, stderr[:200].decode("utf-8", "replace"))
        return ""
    return stdout.decode("utf-8", "replace")


def _clean_lines(text: str) -> list[str]:
    """把 OCR 原始输出拆成有意义的行：去空行、去纯符号行。"""
    lines = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        # tesseract 会给整行加一堆噪声符号，先清掉
        line = re.sub(r"[|_~`^]+", " ", line)
        line = re.sub(r"\s{2,}", " ", line).strip()
        if not line:
            continue
        # 至少要有中文或字母数字才算内容
        if not re.search(r"[\u4e00-\u9fff A-Za-z0-9]", line):
            continue
        lines.append(line)
    return lines


def _strip_label(line: str) -> str:
    """去掉 "品种：" / "Species:" 这类前缀，只留值。"""
    return re.sub(r"^[^:：]{1,8}[:：]\s*", "", line).strip()


def _match_field(line: str) -> str | None:
    """判断这一行描述的是哪个字段。命中关键词、且后面确实跟着值才算。"""
    low = line.lower()
    for field, words in _KEYWORDS.items():
        for word in words:
            idx = low.find(word.lower())
            if idx < 0:
                continue
            # 关键词后面必须还有内容，否则只是标题行
            rest = line[idx + len(word) :]
            rest = re.sub(r"^[\s:：=]+", "", rest).strip()
            if rest:
                return field
    return None


def parse_label(text: str) -> dict[str, Any]:
    """把 OCR 文本解析成种子字段。

    返回 ``{"fields": {...}, "lines": [...], "matched": 命中字段数}``。
    ``fields`` 里只放**有把握**的键；没认出来的字段不出现，前端保持原值。
    """
    lines = _clean_lines(text)
    fields: dict[str, str] = {}

    for line in lines:
        field = _match_field(line)
        if not field or field in fields:
            continue
        value = _strip_label(line)
        # 值里还可能残留关键词本身（"品种 品种A"），再剥一次
        for word in _KEYWORDS[field]:
            value = re.sub(rf"^{re.escape(word)}[\s:：=]*", "", value, flags=re.IGNORECASE)
        value = value.strip(" :：-—|")
        if value:
            fields[field] = value

    # 数量单独规整：剥掉单位，只留数字
    if "quantity" in fields:
        raw = fields["quantity"]
        num = re.search(r"\d+(?:\.\d+)?", raw)
        if num:
            fields["quantity"] = num.group(0)
        else:
            fields.pop("quantity", None)

    # 没匹配到任何字段时，退化处理：把**最像编号**的一行当 code。
    # 不能取第一个匹配就收：标签顶上常有 "D509 种子库" 这种表头，
    # 也会命中 "字母+数字"，取第一个就会把库名当编号。
    # 按"有分隔符 + 数字够长"打分，选更像编号的那条。
    if not fields and lines:
        best: tuple[int, str] | None = None
        for line in lines:
            value = _strip_label(line)
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9\-_/ .]{2,40}", value):
                continue
            digits = len(re.findall(r"\d", value))
            if digits < 3:
                continue
            score = digits * 2
            if re.search(r"[-_/]", value):
                score += 10  # 带分隔符的更可能是编号而不是标题
            if re.search(r"\d{4,}", value):
                score += 6   # 年份/流水号越长越像编号
            if value.upper() == value and re.search(r"[A-Z]", value):
                score += 4
            if best is None or score > best[0]:
                best = (score, value)
        if best:
            fields["code"] = best[1]

    return {"fields": fields, "lines": lines[:20], "matched": len(fields)}


async def recognize(image_bytes: bytes) -> dict[str, Any]:
    """识别一张标签照片。任何异常都退化成"没认出来"，不向上抛。"""
    if not _available():
        return {"ok": False, "reason": "ocr_unavailable", "fields": {}, "lines": [], "text": ""}
    if not image_bytes:
        return {"ok": False, "reason": "empty", "fields": {}, "lines": [], "text": ""}

    tmp_dir = tempfile.mkdtemp(prefix="seedocr-")
    try:
        path = Path(tmp_dir) / "label.jpg"
        path.write_bytes(image_bytes)
        text = await _run_tesseract(path)
        if not text.strip():
            return {"ok": False, "reason": "no_text", "fields": {}, "lines": [], "text": ""}
        parsed = parse_label(text)
        return {"ok": True, **parsed, "text": text[:4000]}
    except Exception as exc:  # noqa: BLE001 — OCR 失败不该让上传接口 500
        log.warning("OCR 失败：%s", exc)
        return {"ok": False, "reason": "error", "fields": {}, "lines": [], "text": ""}
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
