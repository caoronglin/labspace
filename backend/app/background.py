"""首页 Hero 背景：Bing 每日图的服务端代理。

上游 https://bing.cnortles.top/api/daily 直接返回图片字节（webp）。
浏览器端需要用同源图片才能通过 canvas 取色（跨域图片会污染画布），
同时也避免每台终端各自去公网拉一份；这里按北京时间自然日缓存，
上游失败时优先回退到最近一次成功缓存，不再让首页背景变成裂图。
"""
from __future__ import annotations

import asyncio
import os
import time
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Response

from .http import async_client

router = APIRouter(prefix="/api/background", tags=["background"])

UPSTREAM = os.getenv("LABSPACE_BING_DAILY", "https://bing.cnortles.top/api/daily")
TZ = ZoneInfo("Asia/Shanghai")
MAX_BYTES = 8 * 1024 * 1024
RETRY_SECONDS = 600

_lock = asyncio.Lock()
_cache: dict[str, Any] = {"day": "", "body": b"", "type": "image/webp", "ts": 0.0}
_retry_after = 0.0


def _today() -> str:
    return datetime.now(TZ).strftime("%Y-%m-%d")


async def _fetch() -> tuple[bytes, str]:
    async with async_client(timeout=20, follow_redirects=True) as client:
        resp = await client.get(UPSTREAM, headers={"Accept": "image/webp,image/*"})
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="背景图上游不可用")
    body = resp.content
    if not body or len(body) > MAX_BYTES:
        raise HTTPException(status_code=502, detail="背景图响应异常")
    ctype = (resp.headers.get("content-type") or "image/webp").split(";")[0].strip()
    if not ctype.startswith("image/"):
        raise HTTPException(status_code=502, detail="背景图响应不是图片")
    return body, ctype


@router.get("/daily")
async def daily_image() -> Response:
    global _retry_after
    day = _today()
    if _cache["day"] != day and time.monotonic() >= _retry_after:
        async with _lock:
            if _cache["day"] != day and time.monotonic() >= _retry_after:
                try:
                    body, ctype = await _fetch()
                    _cache.update({"day": day, "body": body, "type": ctype, "ts": time.time()})
                except HTTPException:
                    # 上游抖动：短时间内不再重试，期间继续用上一张成功缓存
                    _retry_after = time.monotonic() + RETRY_SECONDS
    body = _cache["body"]
    if not body:
        raise HTTPException(status_code=502, detail="背景图暂不可用")
    return Response(
        content=body,
        media_type=str(_cache["type"]),
        headers={
            "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
            "X-Background-Day": str(_cache["day"]),
            "X-Background-Age": str(int(time.time() - float(_cache["ts"]))),
        },
    )
