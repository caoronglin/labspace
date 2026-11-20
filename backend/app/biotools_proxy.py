"""`/api/biotools/*` 的门户侧代理。

生信计算跑在独立的 `biotools` 容器里（科学计算依赖太重，不该塞进门户后台镜像），
这里只做三件事：**鉴权 → 转发 → 原样回传**。

为什么是"薄代理"而不是把 router 复制一份：
- 鉴权必须留在门户（内网那台不做鉴权，也不暴露宿主端口）；
- 请求体可能是 JSON，也可能是 multipart（`.ab1` / FASTA 上传），所以按**原始字节**
  转发、只透传 Content-Type，不在中间反序列化；
- 响应可能是 JSON，也可能是 `image/png`（质粒图谱），所以按字节回传并保留 media type。
"""
from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse

from .config import settings
from .security import require_user, verify_csrf

router = APIRouter(prefix="/api/biotools", tags=["biotools"])

#: 与后端其它上游调用保持一致的超时：比对/建树可能算几秒，术语上给足。
_TIMEOUT = httpx.Timeout(60.0, connect=5.0)


def _upstream_url(path: str) -> str:
    """拼出上游地址；未配置时给可行动的 503（而不是 500 堆栈）。"""
    base = (settings.biotools_url or "").rstrip("/")
    if not base:
        raise HTTPException(status_code=503, detail="生信工具服务未配置（LABSPACE_BIOTOOLS_URL）")
    return f"{base}/api/biotools/{path.lstrip('/')}"


# 注意顺序：FastAPI 按注册顺序匹配，`/{path:path}` 会把 /health 也吃掉，
# 所以自检路由必须注册在 catch-all 之前。
@router.get("/health", include_in_schema=False)
async def proxy_health(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    """代理层的自检：上游连不上时这里也返回 503，便于运维定位是哪一段坏了。"""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=3.0)) as client:
            resp = await client.get(f"{(settings.biotools_url or '').rstrip('/')}/health")
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="生信工具服务不可用") from exc
    return {"ok": resp.status_code == 200, "upstream": resp.json() if resp.status_code == 200 else resp.text[:200]}


@router.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PATCH", "DELETE"],
    dependencies=[Depends(require_user)],
)
async def forward(path: str, request: Request) -> Response:
    """把请求原样转给生信服务。

    写操作（POST/PATCH）要求 CSRF 双提交，和门户其它写接口一致：
    代理层是唯一的鉴权点，如果这里不校验，前端就少了一道保护。
    """
    if request.method not in ("GET", "HEAD"):
        # 代理层是唯一的鉴权/防伪点：不能因为"转发给内部服务"就跳过 CSRF
        verify_csrf(request, request.headers.get("x-csrf-token"), request.cookies.get(settings.csrf_cookie))

    headers: dict[str, str] = {}
    content_type = request.headers.get("content-type")
    if content_type:
        headers["content-type"] = content_type
    accept = request.headers.get("accept")
    if accept:
        headers["accept"] = accept

    body = await request.body()
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            upstream = await client.request(
                request.method,
                _upstream_url(path),
                params=list(request.query_params.multi_items()),
                content=body or None,
                headers=headers,
            )
    except httpx.HTTPError as exc:
        # 上游不可达/超时：给可行动的提示，不把 httpx 的异常类名抛给用户
        raise HTTPException(
            status_code=503,
            detail="生信工具服务暂不可用（计算服务未就绪或超时），请稍后重试",
        ) from exc

    media_type = upstream.headers.get("content-type", "application/json")
    # 大响应（图谱 PNG、批量筛选结果）直接流式回传，避免在代理里再拼一份内存
    if len(upstream.content) > 512 * 1024:
        return StreamingResponse(
            iter([upstream.content]),
            status_code=upstream.status_code,
            media_type=media_type,
        )
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=media_type,
    )


