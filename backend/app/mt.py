"""Machine translation backed by the local Hy-MT2 service.

The primary path is always the local GPU model (`/v1/translate`). The legacy
pi-gateway is kept only as a best-effort fallback for styled/terminology
requests when the local service is unreachable.

An internal OpenAI-compatible shim is exposed for pdf2zh-next so PDF
translation runs through the same local model instead of a public MT engine.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import time
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from .config import settings
from .http import async_client
from .security import require_user

router = APIRouter(prefix="/api/mt", tags=["mt"])
internal_router = APIRouter(prefix="/internal/mt", tags=["mt-internal"])

MODEL_BASE = os.environ.get("MODEL_BASE", "http://192.0.2.17:8000").rstrip("/")
MODEL_TIMEOUT = int(os.environ.get("MODEL_TIMEOUT", "180"))
MAX_CHARS = int(os.environ.get("MT_MAX_CHARS", "8000"))
INTERNAL_TOKEN = os.environ.get("LABSPACE_INTERNAL_MT_TOKEN", "").strip()

TARGET_LANGS = {
    "zh": "中文",
    "en": "英语",
    "ja": "日语",
    "ko": "韩语",
    "fr": "法语",
    "de": "德语",
    "es": "西班牙语",
    "ru": "俄语",
    "pt": "葡萄牙语",
    "it": "意大利语",
    "ar": "阿拉伯语",
}

SYSTEM_PROMPT = (
    "You are a professional scientific translator. Translate the user's text into "
    "{target}. Output the translation only. Preserve formulas, citations, gene names, "
    "and placeholders such as {{1}} exactly as they appear."
)


def build_prompt(source: str, target_lang: str, style: str, terminology: str) -> str:
    parts = [SYSTEM_PROMPT.format(target=target_lang)]
    if style.strip():
        parts.append(f"Writing style: {style.strip()}")
    if terminology.strip():
        parts.append("Terminology (follow strictly):\n" + terminology.strip())
    parts.append("Text:\n" + source)
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# Local Hy-MT2
# ---------------------------------------------------------------------------

_probe_state: dict[str, Any] = {"at": 0.0, "models": []}
PROBE_GRACE = 20.0
"""单次探测失败后的宽限期：模型换载或 GC 停顿造成的瞬时超时不应把可用服务判死。"""


async def _probe_model() -> dict[str, Any]:
    last_error = ""
    for attempt in range(2):
        try:
            async with async_client(timeout=6.0) as c:
                r = await c.get(f"{MODEL_BASE}/health")
                r.raise_for_status()
                data = r.json()
            if str(data.get("status") or "").lower() not in ("ok", "healthy", "ready"):
                raise RuntimeError(f"模型服务状态异常：{data.get('status') or '未知'}")
            models = data.get("models") or {}
            available = models.get("available") if isinstance(models, dict) else models
            loaded = models.get("loaded") if isinstance(models, dict) else None
            names = [str(m) for m in (available or []) if m]
            _probe_state.update({"at": time.time(), "models": names})
            return {"ok": True, "models": names, "loaded": loaded or {}}
        except Exception as exc:  # noqa: BLE001
            last_error = _brief(exc)
            if attempt == 0:
                await asyncio.sleep(0.4)
    if time.time() - float(_probe_state["at"]) < PROBE_GRACE:
        return {"ok": True, "models": _probe_state["models"], "grace": True, "reason": last_error}
    return {"ok": False, "models": [], "reason": last_error or "模型服务无响应"}


def _brief(exc: Exception) -> str:
    text = str(exc).strip() or exc.__class__.__name__
    return text[:240]


async def _model_translate(source: str, target_lang: str) -> dict[str, Any]:
    payload = {
        "texts": [source],
        "target_lang": target_lang,
        "batch_size": 1,
        "max_new_tokens": 512,
        "greedy": True,
        "engine": "fp16",
    }
    async with async_client(timeout=MODEL_TIMEOUT) as c:
        r = await c.post(f"{MODEL_BASE}/v1/translate", json=payload)
        r.raise_for_status()
        data = r.json()
    translations = data.get("translations") or []
    text = (translations[0] if translations else "").strip()
    if not text:
        raise RuntimeError("hy-mt2 返回空译文")
    return {
        "text": text,
        "model": data.get("model") or "hy-mt2",
        "elapsed": data.get("elapsed_seconds"),
        "gpu": data.get("gpu"),
    }


def _protect_placeholders(text: str) -> tuple[str, list[str]]:
    keep: list[str] = []

    def repl(m: re.Match[str]) -> str:
        keep.append(m.group(0))
        return f"<ph{len(keep) - 1}>"

    return re.sub(r"\{\{\d+\}\}", repl, text), keep


def _restore_placeholders(text: str, keep: list[str]) -> str:
    for i, token in enumerate(keep):
        text = re.sub(rf"<ph{i}>", token, text, flags=re.IGNORECASE)
        text = text.replace(f"＜ph{i}＞", token)
    return text


# ---------------------------------------------------------------------------
# Fallback：Pi 网关一次性会话（本地 GPU 不可用时兜底）
# ---------------------------------------------------------------------------

MT_FALLBACK_SYSTEM = (
    "你是专业学术翻译引擎。严格按指令输出译文本身，"
    "不要解释、不要加前后缀、不要使用代码块。"
)


def _gw_headers() -> dict[str, str]:
    return {"x-agent-token": settings.agent_token} if settings.agent_token else {}


async def _probe_fallback() -> dict[str, Any]:
    if not settings.agent_gateway:
        return {"configured": False}
    try:
        async with async_client(timeout=6.0) as c:
            r = await c.get(f"{settings.agent_gateway}/health", headers=_gw_headers())
        ok = r.status_code == 200 and bool((r.json() or {}).get("ok"))
        out: dict[str, Any] = {"configured": True, "ok": ok, "status": r.status_code}
        if not ok:
            out["reason"] = f"网关 HTTP {r.status_code}"
        return out
    except Exception as exc:  # noqa: BLE001
        return {"configured": True, "ok": False, "reason": _brief(exc)}


async def _fallback_translate(prompt: str) -> str:
    base = settings.agent_gateway.rstrip("/")
    if not base:
        raise RuntimeError("未配置备用翻译网关")
    sid = f"mt-{uuid.uuid4().hex[:12]}"
    url = f"{base}/sessions/{sid}"
    headers = _gw_headers()
    chunks: list[str] = []
    final = ""
    async with async_client(timeout=httpx.Timeout(MODEL_TIMEOUT, connect=10.0)) as c:
        created = await c.post(
            f"{base}/sessions",
            headers=headers,
            json={
                "sessionId": sid,
                "userId": "mt-fallback",
                "model": settings.agent_default_model,
                "systemPrompt": MT_FALLBACK_SYSTEM,
                "noTools": True,
            },
        )
        if created.status_code != 200:
            raise RuntimeError(f"备用网关会话创建失败 HTTP {created.status_code}")
        try:
            async with c.stream("GET", f"{url}/stream", headers=headers) as stream:
                if stream.status_code != 200:
                    raise RuntimeError(f"备用网关流式接口 HTTP {stream.status_code}")
                event = ""
                sent = False
                async for raw in stream.aiter_lines():
                    line = raw.rstrip("\r")
                    if line.startswith("event:"):
                        event = line[6:].strip()
                        if event == "ready" and not sent:
                            sent = True
                            await c.post(
                                f"{url}/messages",
                                headers={**headers, "Content-Type": "application/json"},
                                json={"text": prompt},
                            )
                        continue
                    if not line.startswith("data:"):
                        continue
                    try:
                        data = json.loads(line[5:].strip())
                    except json.JSONDecodeError:
                        continue
                    if event == "delta":
                        chunks.append(str(data.get("text") or ""))
                    elif event == "assistant_message":
                        content = str(data.get("content") or "")
                        if content.strip():
                            final = content
                            break
                    elif event in ("settled", "exit"):
                        if final or "".join(chunks).strip():
                            break
                    elif event == "error":
                        raise RuntimeError(str(data.get("error") or data.get("message") or "备用网关返回错误"))
        finally:
            with contextlib.suppress(httpx.HTTPError):
                await c.delete(url, headers=headers)
    result = (final or "".join(chunks)).strip()
    if not result:
        raise RuntimeError("备用网关未返回内容")
    return result



# ---------------------------------------------------------------------------
# Status / text API
# ---------------------------------------------------------------------------

@router.get("/status")
async def status(_: dict = Depends(require_user)):
    local = await _probe_model()
    fallback = await _probe_fallback()
    fallback.update(
        {
            "available": bool(fallback.get("ok")),
            "provider": "pi-gateway",
            "model": settings.agent_default_model,
        }
    )
    return {
        "provider": "hy-mt2（本地 GPU）",
        "model": "hy-mt2",
        "base_url": MODEL_BASE,
        "available": local["ok"],
        "reason": None if local["ok"] and not local.get("grace") else local.get("reason"),
        "grace": bool(local.get("grace")),
        "models": local.get("models", []),
        "languages": TARGET_LANGS,
        "maxChars": MAX_CHARS,
        "fallback": fallback,
        "effective_available": local["ok"] or fallback.get("ok", False),
    }


@router.post("/translate")
async def translate(body: dict[str, Any], _: dict = Depends(require_user)):
    source = str(body.get("source") or "").strip()
    target_lang = str(body.get("targetLang") or "英语").strip()
    style = str(body.get("style") or "")
    terminology = str(body.get("terminology") or "")
    if not source:
        raise HTTPException(400, "source 不能为空")
    if len(source) > MAX_CHARS:
        raise HTTPException(400, f"原文过长（上限 {MAX_CHARS} 字符）")

    protected, keep = _protect_placeholders(source)
    local_error: str | None = None
    started = time.time()
    try:
        result = await _model_translate(protected, target_lang)
        result["text"] = _restore_placeholders(result["text"], keep)
        return {
            "translation": result["text"],
            "provider": "hy-mt2",
            "model": result["model"],
            "targetLang": target_lang,
            "elapsed_seconds": result.get("elapsed") or round(time.time() - started, 2),
            "fallback": False,
            "style_applied": False,
            "terminology_applied": False,
        }
    except Exception as exc:  # noqa: BLE001
        local_error = _brief(exc)

    prompt = build_prompt(source, target_lang, style, terminology)
    try:
        text = await _fallback_translate(prompt)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            502,
            f"本地 hy-mt2 不可用（{local_error}），备用网关也失败（{_brief(exc)}）",
        ) from exc
    return {
        "translation": _restore_placeholders(text, keep),
        "provider": "pi-gateway",
        "model": settings.agent_default_model,
        "targetLang": target_lang,
        "elapsed_seconds": round(time.time() - started, 2),
        "fallback": True,
        "local_error": local_error,
        "style_applied": bool(style.strip() or terminology.strip()),
        "terminology_applied": bool(terminology.strip()),
    }


# ---------------------------------------------------------------------------
# pdf2zh-next OpenAI-compatible shim (internal, token protected)
# ---------------------------------------------------------------------------

_LANG_RE = re.compile(
    r"translate it into ([^,\n.]+)",
    re.IGNORECASE,
)

_LANG_HINTS = [
    ("chinese", "中文"),
    ("english", "英语"),
    ("japanese", "日语"),
    ("korean", "韩语"),
    ("french", "法语"),
    ("german", "德语"),
    ("spanish", "西班牙语"),
    ("russian", "俄语"),
    ("portuguese", "葡萄牙语"),
    ("italian", "意大利语"),
]


def _require_internal(request: Request) -> None:
    if not INTERNAL_TOKEN:
        raise HTTPException(503, "internal MT token not configured")
    auth = request.headers.get("authorization", "")
    token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    token = token or request.headers.get("x-internal-token", "").strip()
    if token != INTERNAL_TOKEN:
        raise HTTPException(401, "invalid internal token")


def _map_lang(raw: str | None) -> str:
    if not raw:
        return "中文"
    label = raw.strip()
    lowered = label.lower()
    for hint, name in _LANG_HINTS:
        if hint in lowered:
            return name
    key = lowered.split("-")[0].split("_")[0]
    return TARGET_LANGS.get(key, label)


def _extract_source(content: str) -> tuple[str, str]:
    """Split a pdf2zh prompt into (text, target language)."""
    marker = "Input:\n\n"
    idx = content.rfind(marker)
    if idx >= 0:
        text = content[idx + len(marker):]
        lang_match = _LANG_RE.search(content[:idx])
        return text.strip(), _map_lang(lang_match.group(1) if lang_match else None)
    return content.strip(), "中文"


@internal_router.post("/v1/chat/completions")
async def chat_completions(request: Request):
    _require_internal(request)
    body = await request.json()
    messages = body.get("messages") or []
    content = ""
    for msg in messages:
        if msg.get("role") == "user":
            raw = msg.get("content")
            if isinstance(raw, list):
                content = "".join(
                    part.get("text", "") for part in raw if isinstance(part, dict)
                )
            else:
                content = raw or ""
    if not content.strip():
        raise HTTPException(400, "empty prompt")

    source, target_lang = _extract_source(content)
    if not source:
        raise HTTPException(400, "empty source text")

    protected, keep = _protect_placeholders(source)
    started = time.time()
    try:
        result = await _model_translate(protected, target_lang)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"hy-mt2: {_brief(exc)}") from exc
    text = _restore_placeholders(result["text"], keep)

    created = int(started)
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion",
        "created": created,
        "model": result["model"],
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": max(1, len(source) // 4),
            "completion_tokens": max(1, len(text) // 4),
            "total_tokens": max(1, (len(source) + len(text)) // 4),
        },
    }
