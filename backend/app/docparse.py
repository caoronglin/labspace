"""文档解析：OXR-1.0 优先，Docling 作为回退。

OXR（SoMark/OXR-1.0）是 1.3B 的开源文档解析模型，把 PDF / 图片解析为
Markdown / JSON 并给出版面信息。其 HTTP 接口为 SoMark 兼容协议：

    POST {base}/parse/sync
      multipart: file=<二进制>, api_key=<密钥>, output_formats=markdown|json

默认**不使用**任何公网文档解析服务：只有当 `LABSPACE_OXR_BASE_URL` 指向
内网地址（10./172.16-31./192.168./.internal/.local/127.0.0.1），或显式设置
`LABSPACE_OXR_ALLOW_EXTERNAL=1` 时才会调用 OXR；否则直接走内网 Docling。
这是为了避免把用户上传的 PDF 静默发给公网第三方实例。
"""
from __future__ import annotations

import os
import time
from typing import Any

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from .http import async_client as http_client
from .security import require_csrf, require_user
from .uploads import read_upload_capped

router = APIRouter(prefix="/api/docparse", tags=["docparse"])

OXR_BASE = os.getenv("LABSPACE_OXR_BASE_URL", "https://free-oxr.somark.ai/api/v1").rstrip("/")
OXR_API_KEY = os.getenv("LABSPACE_OXR_API_KEY", "dummy")
OXR_MODEL = os.getenv("LABSPACE_OXR_MODEL", "OXR-1.0")
DOCLING_BASE = os.getenv("LABSPACE_DOCLING_URL", "http://lab-docling:5001").rstrip("/")
MODEL_BASE = os.getenv("LABSPACE_MODEL_URL", "http://192.0.2.17:8000").rstrip("/")
MINERU_TIMEOUT = float(os.getenv("LABSPACE_MINERU_TIMEOUT", "180"))
MINERU_MAX_BYTES = 20 * 1024 * 1024
MAX_BYTES = int(os.getenv("LABSPACE_DOCPARSE_MAX_BYTES", str(40 * 1024 * 1024)))
TIMEOUT = float(os.getenv("LABSPACE_DOCPARSE_TIMEOUT", "180"))

# 结构化解析链路只覆盖 PDF/图片；Office 与纯文本由 Tika/直读处理。
PDF_IMAGE_SUFFIXES = {
    ".pdf", ".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp",
}
# MinerU / RapidOCR 只接受图片（PDF 会返回 UnidentifiedImageError）
IMAGE_SUFFIXES = PDF_IMAGE_SUFFIXES - {".pdf"}


def _is_internal_host(host: str) -> bool:
    """判断主机是否属于内网/本机。"""
    h = (host or "").split("://")[-1].split("/")[0].split(":")[0].lower()
    if not h:
        return False
    if h in ("localhost", "127.0.0.1", "::1"):
        return True
    if h.startswith("127.") or h.startswith("10.") or h.startswith("192.168."):
        return True
    if h.startswith("172."):
        try:
            second = int(h.split(".")[1])
        except (IndexError, ValueError):
            return False
        return 16 <= second <= 31
    return h.endswith(".internal") or h.endswith(".local")


OXR_EXTERNAL_ALLOWED = os.getenv("LABSPACE_OXR_ALLOW_EXTERNAL", "0") == "1"
"""默认不允许把文档发往公网解析服务（需显式打开）。"""

OXR_ENABLED = _is_internal_host(OXR_BASE) or OXR_EXTERNAL_ALLOWED
"""OXR 是否可用；为 False 时解析直接回退到内网 Docling。"""


async def _read_capped(file: UploadFile, limit: int) -> bytes:
    """分块读取上传文件，超过 limit 立即中断（避免整包进内存）。"""
    return await read_upload_capped(file, limit)

# 探活用的最小合法 PDF（OXR 只接受 PDF/图片，纯文本会返回 415）
_MINIMAL_PDF = (
    b"%PDF-1.4\x0a1 0 obj\x0a<< /Type /Catalog /Pages 2 0 R >>\x0aendobj\x0a2 0 obj\x0a<< /Type /Pages /Kids [3 0 R] /Count 1 >>\x0aendobj\x0a3 0 obj\x0a<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\x0aendobj\x0a4 0 obj\x0a<< /Length 46 >>\x0astream\x0aBT /F1 12 Tf 20 100 Td (Hello D509 OXR) Tj ET\x0aendstream\x0aendobj\x0a5 0 obj\x0a<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\x0aendobj\x0axref\x0a0 6\x0a0000000000 65535 f \x0a0000000009 00000 n \x0a0000000058 00000 n \x0a0000000115 00000 n \x0a0000000241 00000 n \x0a0000000336 00000 n \x0atrailer\x0a<< /Size 6 /Root 1 0 R >>\x0astartxref\x0a406\x0a%%EOF\x0a"
)

_status_cache: dict[str, Any] = {"at": 0.0, "value": {}}


async def _oxr_probe() -> tuple[bool, str]:
    try:
        async with http_client(timeout=20) as client:
            resp = await client.post(
                f"{OXR_BASE}/parse/sync",
                data={"api_key": OXR_API_KEY, "output_formats": "markdown"},
                files={"file": ("probe.pdf", _MINIMAL_PDF, "application/pdf")},
            )
    except httpx.HTTPError as exc:
        return False, f"OXR 连接失败：{type(exc).__name__}"
    if resp.status_code >= 500:
        return False, f"OXR 服务异常（HTTP {resp.status_code}）"
    if resp.status_code >= 400:
        return False, f"OXR 返回 HTTP {resp.status_code}：{resp.text[:120]}"
    try:
        payload = resp.json()
    except ValueError:
        return True, "OXR-1.0 在线（响应非 JSON）"
    if (payload.get("code") or 0) != 0:
        return False, f"OXR 返回业务错误：{payload.get('message') or payload}"
    return True, "OXR-1.0 在线"


async def _docling_probe() -> tuple[bool, str]:
    try:
        async with http_client(timeout=8) as client:
            resp = await client.get(f"{DOCLING_BASE}/health")
        if resp.status_code == 200:
            return True, "Docling 在线（回退）"
        return False, f"Docling 健康检查 HTTP {resp.status_code}"
    except httpx.HTTPError as exc:
        return False, f"Docling 连接失败：{type(exc).__name__}"


async def _mineru_probe() -> tuple[bool, str]:
    try:
        async with http_client(timeout=8) as client:
            resp = await client.get(f"{MODEL_BASE}/health")
        if resp.status_code != 200:
            return False, f"本地 AI 模型服务 HTTP {resp.status_code}"
        models = (resp.json().get("models") or {})
        if "mineru" in (models.get("loaded") or {}):
            return True, "MinerU 已加载（本地 GPU）"
        if "mineru" in (models.get("available") or []):
            return True, "MinerU 可用（按需加载）"
        return False, "本地模型服务未提供 mineru"
    except (httpx.HTTPError, ValueError) as exc:
        return False, f"本地模型服务不可达（{type(exc).__name__}）"


async def _parse_mineru(content: bytes, filename: str, mime: str = "image/png") -> dict[str, Any]:
    """图片版面解析（MinerU 2.5，输出 Markdown / 公式 / 表格）。"""
    started = time.time()
    async with http_client(timeout=MINERU_TIMEOUT) as client:
        resp = await client.post(
            f"{MODEL_BASE}/v1/parse",
            files={"file": (filename, content, mime or "application/octet-stream")},
            data={"engine": "mineru", "mode": "fast"},
        )
    if resp.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"MinerU 解析失败（HTTP {resp.status_code}）：{resp.text[:180]}",
        )
    payload = resp.json()
    markdown = payload.get("markdown") or ""
    return {
        "provider": "MinerU",
        "markdown": markdown,
        "text": markdown,
        "pages": None,
        "fileType": "image",
        "taskId": None,
        "elapsed_ms": int((time.time() - started) * 1000),
    }


async def _status() -> dict[str, Any]:
    if time.time() - _status_cache["at"] < 60 and _status_cache["value"]:
        return _status_cache["value"]
    if OXR_ENABLED:
        oxr_ok, oxr_reason = await _oxr_probe()
    else:
        oxr_ok, oxr_reason = False, "外部 OXR 已禁用（仅允许内网自建实例；需 LABSPACE_OXR_ALLOW_EXTERNAL=1 显式开启）"
    doc_ok, doc_reason = await _docling_probe()
    mineru_ok, mineru_reason = await _mineru_probe()
    value = {
        "provider": OXR_MODEL,
        "available": oxr_ok,
        "enabled": OXR_ENABLED,
        "reason": oxr_reason,
        "base_url": OXR_BASE if OXR_ENABLED else "",
        "mineru": {"available": mineru_ok, "detail": mineru_reason, "url": MODEL_BASE},
        "fallback": {"name": "Docling", "available": doc_ok, "detail": doc_reason, "url": DOCLING_BASE},
        "maxBytes": MAX_BYTES,
    }
    _status_cache.update({"at": time.time(), "value": value})
    return value


async def _parse_oxr(content: bytes, filename: str, mime: str = "application/pdf") -> dict[str, Any]:
    started = time.time()
    async with http_client(timeout=TIMEOUT) as client:
        resp = await client.post(
            f"{OXR_BASE}/parse/sync",
            data={"api_key": OXR_API_KEY, "output_formats": "markdown"},
            files={"file": (filename, content, mime or "application/pdf")},
        )
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"OXR 解析失败（HTTP {resp.status_code}）：{resp.text[:200]}")
    payload = resp.json()
    data = payload.get("data") or {}
    outputs = ((data.get("result") or {}).get("outputs")) or {}
    markdown = outputs.get("markdown") or ""
    meta = data.get("metadata") or {}
    return {
        "provider": OXR_MODEL,
        "markdown": markdown,
        "text": markdown,
        "pages": meta.get("page_num"),
        "fileType": meta.get("file_type"),
        "taskId": (data.get("result") or {}).get("task_id"),
        "elapsed_ms": int((time.time() - started) * 1000),
    }


async def _parse_docling(content: bytes, filename: str, mime: str = "application/pdf") -> dict[str, Any]:
    started = time.time()
    async with http_client(timeout=TIMEOUT) as client:
        resp = await client.post(
            f"{DOCLING_BASE}/v1/convert/file",
            files={"files": (filename, content, mime or "application/pdf")},
            data={"to_formats": "md"},
        )
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Docling 解析失败（HTTP {resp.status_code}）")
    payload = resp.json()
    document = payload.get("document") or {}
    markdown = document.get("md_content") or payload.get("md_content") or ""
    return {
        "provider": "Docling",
        "markdown": markdown,
        "text": markdown,
        "pages": len(document.get("pages") or []) or None,
        "fileType": "pdf",
        "taskId": None,
        "elapsed_ms": int((time.time() - started) * 1000),
    }


async def document_to_text(content: bytes, filename: str, mime: str = "") -> tuple[str, str]:
    """PDF/图片按 OXR → Docling 顺序抽取，返回 (抽取器, 文本)。

    两者均失败时抛出 HTTPException，由调用方决定是否继续回退 Tika。
    """
    errors: list[str] = []
    suffix = os.path.splitext(filename or "")[1].lower()
    if suffix in IMAGE_SUFFIXES and len(content) <= MINERU_MAX_BYTES:
        try:
            result = await _parse_mineru(content, filename, mime)
            text = (result.get("markdown") or "").strip()
            if text:
                return "MinerU", text
            errors.append("MinerU 未返回文本")
        except HTTPException as exc:
            errors.append(f"MinerU：{exc.detail}")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"MinerU 异常：{type(exc).__name__}")
    if OXR_ENABLED:
        try:
            result = await _parse_oxr(content, filename, mime)
            text = (result.get("markdown") or "").strip()
            if text:
                return str(result.get("provider") or OXR_MODEL), text
            errors.append("OXR 未返回文本")
        except HTTPException as exc:
            errors.append(f"OXR：{exc.detail}")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"OXR 异常：{type(exc).__name__}")
    try:
        result = await _parse_docling(content, filename, mime)
        text = (result.get("markdown") or "").strip()
        if text:
            return "Docling", text
        errors.append("Docling 未返回文本")
    except HTTPException as exc:
        errors.append(f"Docling：{exc.detail}")
    except Exception as exc:  # noqa: BLE001
        errors.append(f"Docling 异常：{type(exc).__name__}")
    raise HTTPException(status_code=502, detail="结构化解析失败：" + "；".join(errors[:2]))


@router.get("/status")
async def docparse_status(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    return await _status()


@router.post("/parse")
async def docparse_parse(
    file: UploadFile = File(...),
    fallback: bool = True,
    user: dict[str, Any] = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    content = await _read_capped(file, MAX_BYTES)
    if not content:
        raise HTTPException(status_code=400, detail="上传文件为空")
    name = file.filename or "document.pdf"
    errors: list[str] = []
    suffix = os.path.splitext(name)[1].lower()
    if suffix in IMAGE_SUFFIXES:
        if len(content) > MINERU_MAX_BYTES:
            errors.append("图片超过 MinerU 上传上限（20 MB），已改用 Docling")
        else:
            try:
                result = await _parse_mineru(content, name, file.content_type or "image/png")
                if result.get("markdown"):
                    result["fallbackUsed"] = False
                    result["warnings"] = errors
                    return result
                errors.append("MinerU 未返回文本")
            except HTTPException as exc:
                errors.append(str(exc.detail))
            except Exception as exc:  # noqa: BLE001
                errors.append(f"MinerU 异常：{type(exc).__name__}")
    if not OXR_ENABLED:
        errors.append("外部文档解析服务未启用（仅内网自建实例可用），已直接使用 Docling")
        result = await _parse_docling(content, name)
        result["fallbackUsed"] = True
        result["warnings"] = errors
        return result
    try:
        result = await _parse_oxr(content, name)
        result["fallbackUsed"] = False
        if not result.get("markdown"):
            raise HTTPException(status_code=502, detail="OXR 未返回解析内容")
        return result
    except HTTPException as exc:
        errors.append(str(exc.detail))
    except Exception as exc:  # noqa: BLE001 - 统一转中文提示
        errors.append(f"OXR 解析异常：{type(exc).__name__}")
    if fallback:
        try:
            result = await _parse_docling(content, name)
            result["fallbackUsed"] = True
            result["warnings"] = errors
            return result
        except HTTPException as exc:
            errors.append(str(exc.detail))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"Docling 解析异常：{type(exc).__name__}")
    raise HTTPException(status_code=502, detail="文档解析失败：" + "；".join(errors[:2]))
