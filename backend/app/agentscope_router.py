"""受控的 AgentScope 能力代理。

门户前端要**同源**调用 AgentScope 的全部能力组（agent / channels / credential /
hub / knowledge_bases / mcp / schedule / sessions / skill / sop / workspace /
embedding-model / model / tts-model / realtime），但后端只应转发**白名单里的
能力组**，并且必须把身份换成当前登录用户。

三条硬规则
----------
1. **白名单**：``group`` 不在 :data:`ALLOWED_GROUPS` 一律 404（不是 403 —— 403
   等于告诉调用方「这个能力组存在但你没权限」，404 才不泄露能力清单）。
   ``chat`` 与 ``health`` 故意不在白名单里：门户自己有聊天契约与健康检查。
2. **身份覆盖**：出站请求的 ``X-User-ID`` 永远取当前门户会话的 ``sub``；客户端
   自带的 ``X-User-ID`` / ``Authorization`` **一律不转发**。跨用户访问别人的
   资源由 AgentScope 按 ``X-User-ID`` 自己拒绝。
3. **只代理到 AgentScope**：出站地址由 ``settings.agentscope_base`` + 白名单
   group + 受检路径拼出，路径里出现 ``..`` 直接拒绝，因此不存在「代理到任意
   地址」的可能（见 :func:`_assert_upstream_origin`）。

与 ``/api/agent/*`` 的区别
--------------------------
``/api/agent/*``（:mod:`app.agent`）是**门户自己的**助手契约：会话/消息落门户库，
SSE 事件被翻译成 ``ready / delta / tool / done / error`` 五种前端事件。
本模块是**透明代理**：不落库、不翻译，把 AgentScope 的原始 JSON 与原始 SSE
事件原样转发出去，给「管理 AgentScope 全能力」的后台页面用。

两个 SSE 入口
------------
* ``GET /api/agent/as/sessions/{session_id}/stream``：**原始** AgentScope 事件流
  （``REPLY_START`` / ``TEXT_BLOCK_DELTA`` / ``MODEL_CALL_END`` / ``REPLY_END`` …），
  逐字节透传，不翻译。
* ``GET /api/agent/agentscope/sessions/{session_id}/stream``（以及门户契约的
  ``GET /api/agent/sessions/{session_id}/stream``）：**翻译后**的事件流，只有
  ``ready/delta/tool/done/error``，并顺手落库与记账。

两者路径前缀不同，互不冲突。
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from .config import settings
from .security import require_csrf, require_user

router = APIRouter(prefix="/api/agent/as", tags=["agentscope"])

log = logging.getLogger("labspace.agentscope.proxy")

ALLOWED_GROUPS: frozenset[str] = frozenset(
    {
        "agent",
        "channels",
        "credential",
        "hub",
        "knowledge_bases",
        "mcp",
        "schedule",
        "sessions",
        "skill",
        "sop",
        "workspace",
        "embedding-model",
        "model",
        "tts-model",
        "realtime",
    }
)
"""允许被代理的 AgentScope 能力组。其余（chat / health / 未来新增组）一律 404。

注意：这里是**能力组**，不是端点清单。子资源一律通过 `group + path` 表达，
例如知识库检索是 ``knowledge_bases`` + ``{kb_id}/search``。
不要往这个集合里塞 ``knowledge_bases/chunkers`` 这类子路径 ——
那会让白名单同时承担两种语义，以后分不清"组"和"路径"。
"""

TIMEOUT = httpx.Timeout(60.0)
"""普通代理请求的上游超时（秒）。"""

STREAM_TIMEOUT = httpx.Timeout(connect=10.0, read=None, write=30.0, pool=10.0)
"""SSE 不设读超时：事件流本来就长时间不结束。"""

MAX_BODY_BYTES = 1024 * 1024
"""请求体上限 1 MiB。"""


# ------------------------------------------------------------------ 基础工具


def _build_client(timeout: httpx.Timeout) -> httpx.AsyncClient:
    """构造出站客户端。

    单独抽成函数是为了让测试能换成 ``httpx.MockTransport``：业务代码只认
    「一个能发请求的 client」，不关心它是真的连还是打桩。
    """
    return httpx.AsyncClient(timeout=timeout)


# 出站请求头统一由 agentscope_adapter 提供（全仓唯一实现），这里只导入。
from .agentscope_adapter import build_headers as _headers  # noqa: E402


def _assert_upstream_origin(url: str) -> str:
    """确保出站地址与 ``agentscope_base`` 同源。

    目标地址本来就是自己拼出来的（base + 白名单 group + 受检路径），这一步是
    显式的最后一道闸：万一将来有人把「客户端提供的 query 片段」拼进地址，
    这里会当场拦住。
    """
    base = urlsplit(settings.agentscope_base.rstrip("/"))
    target = urlsplit(url)
    if (target.scheme, target.hostname, target.port) != (base.scheme, base.hostname, base.port):
        raise HTTPException(status_code=502, detail="代理目标不在允许的上游地址内")
    return url


def _clean_group(group: str) -> str:
    """校验能力组白名单。"""
    name = str(group or "").strip()
    if name not in ALLOWED_GROUPS:
        raise HTTPException(status_code=404, detail="未知的能力组")
    return name


def _clean_path(path: str) -> str:
    """校验并规范化上游子路径。

    禁止 ``..``（含百分号编码后的形态）与反斜杠；空段直接丢掉。
    """
    raw = str(path or "").replace("\\", "/")
    if ".." in raw:
        raise HTTPException(status_code=400, detail="路径中不允许 '..'")
    segments = [seg for seg in raw.split("/") if seg]
    for seg in segments:
        if seg in (".", ".."):
            raise HTTPException(status_code=400, detail="路径中不允许 '..'")
        if any(ch < " " or ch == "\x7f" for ch in seg):
            raise HTTPException(status_code=400, detail="路径中包含非法字符")
    return "/".join(segments)


def _upstream_url(group: str, path: str = "") -> str:
    """拼出上游地址：``{base}/{group}/`` 或 ``{base}/{group}/{path}``。"""
    base = settings.agentscope_base.rstrip("/")
    cleaned = _clean_path(path)
    url = f"{base}/{group}/" if not cleaned else f"{base}/{group}/{cleaned}"
    return _assert_upstream_origin(url)


def _query(request: Request) -> httpx.QueryParams:
    """原样转发查询参数（保留重复参数）。"""
    return httpx.QueryParams(list(request.query_params.multi_items()))


async def _read_body(request: Request) -> bytes:
    """读取请求体，超过上限立刻拒绝。"""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail=f"请求体超过上限 {MAX_BODY_BYTES // 1024 // 1024} MiB")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_BODY_BYTES:
            raise HTTPException(status_code=413, detail=f"请求体超过上限 {MAX_BODY_BYTES // 1024 // 1024} MiB")
        chunks.append(chunk)
    return b"".join(chunks)


async def _read_json_body(request: Request) -> Any:
    """读取并解析 JSON 请求体；空体视为没有 body。"""
    raw = await _read_body(request)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="请求体不是合法的 JSON") from exc


# ------------------------------------------------------------------ 转发


async def _send(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    params: httpx.QueryParams | None = None,
    body: Any = None,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    """发一次请求，并处理同源 307/308 跳转。

    AgentScope 的 ``/mcp`` 与 ``/skill`` 没有结尾斜杠，而能力组根路径按约定
    带斜杠（``{base}/{group}/``），上游会回 307 把斜杠去掉。这里只在**本服务
    内部**重发一次：只取 Location 的 path+query，host 一律回到
    ``agentscope_base``，绝不跟随到第三方地址。
    """
    resp = await client.request(method, url, params=params, json=body, headers=headers)
    for _ in range(2):
        if resp.status_code not in (307, 308):
            break
        location = resp.headers.get("location") or ""
        if not location:
            break
        parts = urlsplit(location)
        target = f"{settings.agentscope_base.rstrip('/')}{parts.path}"
        if parts.query:
            target = f"{target}?{parts.query}"
        _assert_upstream_origin(target)
        resp = await client.request(method, target, json=body, headers=headers)
    return resp


def _upstream_response(resp: httpx.Response) -> Response:
    """把上游响应原样交回浏览器：状态码与 JSON 都不改写。

    上游 4xx/5xx 也照原样返回（不吞成 502）——前端要看到「参数非法」和
    「上游挂了」的区别。
    """
    content_type = resp.headers.get("content-type", "")
    if "json" in content_type.lower():
        try:
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
        except ValueError:
            pass
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=content_type.split(";")[0] or None,
    )


async def _forward(
    method: str,
    group: str,
    path: str,
    user_sub: str,
    *,
    params: httpx.QueryParams | None = None,
    body: Any = None,
) -> Response:
    """执行一次白名单代理。"""
    url = _upstream_url(group, path)
    headers = _headers(user_sub, json_body=body is not None)
    try:
        async with _build_client(TIMEOUT) as client:
            resp = await _send(client, method, url, params=params, body=body, headers=headers)
    except httpx.HTTPError as exc:
        log.warning("agentscope proxy failed: %s %s %s", method, url, exc)
        raise HTTPException(status_code=502, detail=f"助手服务不可用（{type(exc).__name__}）") from exc
    return _upstream_response(resp)


async def _forward_raw(
    method: str,
    group: str,
    path: str,
    user_sub: str,
    *,
    params: httpx.QueryParams | None = None,
    raw: bytes = b"",
    content_type: str = "application/octet-stream",
) -> Response:
    """转发非 JSON 请求体（multipart 文件上传）的写操作。

    与 :func:`_forward` 的区别只有"body 怎么带"：这里把原始字节与
    Content-Type 原样送出，不再 json 序列化。身份头仍由 :func:`_headers`
    统一覆盖，所以安全边界与 JSON 路径完全一致。
    """
    url = _upstream_url(group, path)
    headers = _headers(user_sub, json_body=False)
    headers["content-type"] = content_type
    try:
        async with _build_client(TIMEOUT) as client:
            resp = await client.request(method, url, params=params, content=raw, headers=headers)
    except httpx.HTTPError as exc:
        log.warning("agentscope raw proxy failed: %s %s %s", method, url, exc)
        raise HTTPException(status_code=502, detail=f"助手服务不可用（{type(exc).__name__}）") from exc
    return _upstream_response(resp)


# ------------------------------------------------------------------ 路由


@router.get("/sessions/{session_id}/stream")
async def proxy_session_stream(
    request: Request,
    session_id: str,
    user: dict[str, Any] = Depends(require_user),
) -> StreamingResponse:
    """**原始** AgentScope 会话事件流（透传，不翻译）。

    与 ``/api/agent/agentscope/sessions/{id}/stream`` 的区别：那条把 AgentScope
    的 ``REPLY_START`` / ``TEXT_BLOCK_DELTA`` / ``MODEL_CALL_END`` / ``REPLY_END``
    等事件**翻译**成门户前端的 ``ready/delta/tool/done/error``；这条逐字节透传
    原始事件，供需要自己解析事件语义的管理页面使用。
    """
    sid = _clean_path(session_id)
    url = _upstream_url("sessions", f"{sid}/stream")
    params = _query(request)

    async def gen() -> AsyncIterator[bytes]:
        try:
            async with (
                _build_client(STREAM_TIMEOUT) as client,
                client.stream(
                    "GET",
                    url,
                    params=params,
                    headers=_headers(user["sub"], accept="text/event-stream"),
                ) as resp,
            ):
                if resp.status_code != 200:
                    payload = {"message": f"助手服务返回 {resp.status_code}", "status": resp.status_code}
                    yield f"event: error\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()
                    return
                async for chunk in resp.aiter_bytes():
                    yield chunk
        except httpx.HTTPError as exc:
            log.warning("agentscope raw stream failed: %s", exc)
            payload = {"message": f"助手服务连接中断（{type(exc).__name__}）"}
            yield f"event: error\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@router.get("/{group}/{path:path}")
async def proxy_get(
    group: str,
    path: str,
    request: Request,
    user: dict[str, Any] = Depends(require_user),
) -> Response:
    """转发能力组下的 GET（带查询参数）。"""
    name = _clean_group(group)
    return await _forward("GET", name, path, user["sub"], params=_query(request))


@router.get("/{group}")
async def proxy_group_get(
    group: str,
    request: Request,
    user: dict[str, Any] = Depends(require_user),
) -> Response:
    """转发能力组根路径的 GET：``{base}/{group}/``。"""
    name = _clean_group(group)
    return await _forward("GET", name, "", user["sub"], params=_query(request))


async def _write(group: str, path: str, request: Request, user: dict[str, Any]) -> Response:
    """写操作的共同实现：校验白名单 → 读 JSON 体 → 转发。

    写操作必须过 CSRF 双提交校验（见各路由的 ``require_csrf`` 依赖）：浏览器
    会自动带上会话 Cookie，没有这层校验的话，任何第三方页面都能借用户身份
    改 AgentScope 里的数据。
    """
    name = _clean_group(group)
    # 文件上传（知识库文档）走 multipart，不是 JSON。
    # 之前对所有写操作一律 ``_read_json_body``，上传接口直接返回
    # 「请求体不是合法的 JSON」——知识库建得出来、文档传不进去，
    # RAG 永远是空库。这里把原始字节与 Content-Type 原样透传。
    ctype = request.headers.get("content-type", "")
    if ctype.startswith(("multipart/form-data", "application/octet-stream")):
        raw = await _read_body(request)
        return await _forward_raw(
            request.method, name, path, user["sub"], params=_query(request), raw=raw, content_type=ctype
        )
    body = await _read_json_body(request)
    return await _forward(request.method, name, path, user["sub"], params=_query(request), body=body)


@router.post("/{group}")
async def proxy_group_post(
    group: str,
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> Response:
    """在能力组根路径创建资源：``POST {base}/{group}/``。"""
    return await _write(group, "", request, user)


@router.post("/{group}/{path:path}")
async def proxy_path_post(
    group: str,
    path: str,
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> Response:
    """在能力组下的子路径创建资源：``POST {base}/{group}/{path}``。"""
    return await _write(group, path, request, user)


@router.patch("/{group}")
async def proxy_group_patch(
    group: str,
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> Response:
    """修改能力组根路径的对象：``PATCH {base}/{group}/``。"""
    return await _write(group, "", request, user)


@router.patch("/{group}/{path:path}")
async def proxy_path_patch(
    group: str,
    path: str,
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> Response:
    """修改能力组下的子路径对象：``PATCH {base}/{group}/{path}``。"""
    return await _write(group, path, request, user)


@router.delete("/{group}")
async def proxy_group_delete(
    group: str,
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> Response:
    """删除能力组根路径的对象：``DELETE {base}/{group}/``。"""
    return await _write(group, "", request, user)


@router.delete("/{group}/{path:path}")
async def proxy_path_delete(
    group: str,
    path: str,
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> Response:
    """删除能力组下的子路径对象：``DELETE {base}/{group}/{path}``。"""
    return await _write(group, path, request, user)
