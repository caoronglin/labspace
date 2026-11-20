"""AgentScope 事件 → 门户前端事件 的适配层。

为什么需要这一层
----------------
AgentScope 的 SSE 事件是它自己的语义（REPLY_START / TEXT_BLOCK_DELTA /
MODEL_CALL_END …），而门户前端 `Agent.tsx` 只认 5 个事件：
``ready / delta / tool / done / error``。两边都不该为对方改契约，所以在中间翻译。

事件映射（字段名来自 agentscope 2.0.11 实测，不是文档猜测）：

| AgentScope | 门户 | 说明 |
| --- | --- | --- |
| （连接建立） | ``ready`` | 前端收到后才发消息，避免丢最早增量 |
| ``TEXT_BLOCK_DELTA`` | ``delta`` | `{"text": <delta>}` |
| ``TOOL_CALL_START`` / ``TOOL_RESULT_*`` | ``tool`` | `{"toolName","arguments","result","status"}` |
| ``MODEL_CALL_END`` | （累计） | token 用量，合进 ``done`` |
| ``REPLY_END`` | ``done`` | 带 finishedReason 与 usage |
| 任何 ``error`` | ``error`` | 带 message |

身份
----
AgentScope 用 ``X-User-ID`` 识别用户。这里**只使用门户会话里解出来的 user id**，
绝不透传前端传来的任何标识头，因此跨用户访问别人的 session 会 404/403。
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx

from .config import settings

log = logging.getLogger("labspace.agentscope")

TIMEOUT = httpx.Timeout(connect=8.0, read=None, write=20.0, pool=8.0)


def build_headers(
    user_sub: str,
    accept: str = "application/json",
    *,
    json_body: bool = False,
) -> dict[str, str]:
    """出站请求头（身份 + Accept + 可选 JSON Content-Type）。

    **全仓唯一实现**：原先 agentscope_router 与本模块各有一份同名 ``_headers``，
    读代码时无法判断用的是哪一个。现在统一到这里，router 直接导入。

    身份由门户会话决定，客户端带来的 ``X-User-ID`` / ``Authorization``
    绝不透传（否则等于把「冒充他人」的能力交给前端）。

    SSE 端点必须显式要 ``text/event-stream``：带了 ``application/json`` 时
    AgentScope 会按普通响应处理，增量事件不会被推出来（实测：只能收到
    ready 与最后的 done）。
    """
    headers = {"X-User-ID": user_sub, "Accept": accept}
    if json_body:
        headers["Content-Type"] = "application/json"
    return headers


def sse(event: str, payload: Any) -> str:
    """把一条事件编码成 SSE 帧。"""
    body = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    return f"event: {event}\ndata: {body}\n\n"


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def translate(
    event: dict[str, Any],
    usage: dict[str, int],
    tools: dict[str, dict[str, Any]] | None = None,
) -> str | None:
    """把一条 AgentScope 事件翻译成 SSE 帧；返回 None 表示"不转发"。

    usage 是可变累加器：MODEL_CALL_END 里的 token 数要合进最后的 done。
    """
    kind = str(event.get("type") or "")

    if kind == "TEXT_BLOCK_DELTA":
        delta = event.get("delta")
        if not delta:
            return None
        return sse("delta", {"text": delta})

    if kind == "MODEL_CALL_END":
        for key in ("input_tokens", "output_tokens", "cache_input_tokens", "cache_creation_input_tokens"):
            value = event.get(key)
            if isinstance(value, int):
                usage[key] = usage.get(key, 0) + value
        return None

    # 工具调用需要人确认（2.0.12 HITL）：暂停等待前端答复。
    if kind == "REQUIRE_USER_CONFIRM":
        return sse(
            "confirm",
            {
                "replyId": event.get("reply_id"),
                "toolCalls": _as_list(event.get("tool_calls")),
            },
        )

    # 外部执行的工具（如 AskUser 向用户提问）：把问题原样交给前端渲染。
    if kind == "REQUIRE_EXTERNAL_EXECUTION":
        return sse(
            "ask",
            {
                "replyId": event.get("reply_id"),
                "toolCalls": _as_list(event.get("tool_calls")),
            },
        )

    # 工具事件是**分片**的（2.0.11 实测字段）：
    #   TOOL_CALL_START{tool_call_id, tool_call_name} → TOOL_CALL_DELTA{delta}* → TOOL_CALL_END
    #   TOOL_RESULT_START{tool_call_name} → TOOL_RESULT_TEXT_DELTA{delta}* → TOOL_RESULT_END{state}
    # 因此这里按 tool_call_id 累积参数与结果，只在开始与结束各推一条，避免前端收到
    # 一串空 toolName 的碎片。
    if kind.startswith("TOOL_"):
        store = tools if tools is not None else {}
        call_id = str(event.get("tool_call_id") or "")
        slot = store.setdefault(call_id, {"name": "", "arguments": "", "result": ""})
        if event.get("tool_call_name"):
            slot["name"] = str(event["tool_call_name"])
        delta = event.get("delta")
        if isinstance(delta, str) and delta:
            if kind.startswith("TOOL_RESULT"):
                slot["result"] += delta
            else:
                slot["arguments"] += delta
        if kind == "TOOL_CALL_START":
            return sse("tool", {"toolName": slot["name"], "arguments": "", "result": "", "status": "running"})
        if kind == "TOOL_RESULT_END":
            state = str(event.get("state") or "success")
            return sse(
                "tool",
                {
                    "toolName": slot["name"],
                    "arguments": slot["arguments"],
                    "result": slot["result"][:4000],
                    "status": "done" if state in ("success", "completed", "ok") else state,
                },
            )
        return None

    return None


async def stream(
    session_id: str,
    agent_id: str,
    user_sub: str,
    *,
    client: httpx.AsyncClient | None = None,
) -> AsyncIterator[str]:
    """订阅一个会话的事件流并翻译成本站协议。"""
    owned = client is None
    client = client or httpx.AsyncClient(timeout=TIMEOUT)
    usage: dict[str, int] = {}
    # AgentScope 在连接建立时会先回放**上一轮**的 REPLY_END。若见到 REPLY_END 就
    # 关流，这一轮的增量全部会被自己掐掉（实测：只收到 ready + done）。
    # 因此只认「本次连接里先出现过 REPLY_START」的那个 reply_id 的结束事件。
    started: set[str] = set()
    tools: dict[str, dict[str, Any]] = {}
    # 先发 ready：前端约定「收到 ready 才投递 prompt」，早于任何增量。
    yield sse("ready", {"ok": True, "sessionId": session_id})
    try:
        async with client.stream(
            "GET",
            f"{settings.agentscope_base}/sessions/{session_id}/stream",
            params={"agent_id": agent_id},
            headers=build_headers(user_sub, "text/event-stream"),
        ) as resp:
            if resp.status_code != 200:
                detail = "助手服务拒绝了这次连接"
                if resp.status_code == 404:
                    detail = "会话不存在或不属于当前用户"
                yield sse("error", {"message": detail, "status": resp.status_code})
                return
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if not raw:
                    continue
                try:
                    event = _as_dict(json.loads(raw))
                except json.JSONDecodeError:
                    continue
                kind = str(event.get("type") or "")
                reply_id = str(event.get("reply_id") or "")
                if kind == "REPLY_START" and reply_id:
                    started.add(reply_id)
                if kind == "REPLY_END" and reply_id in started:
                    payload: dict[str, Any] = {
                        "finishedReason": event.get("finished_reason") or "completed",
                        "usage": usage,
                    }
                    err = event.get("error")
                    if isinstance(err, dict) and err.get("message"):
                        payload["error"] = err.get("message")
                    yield sse("done", payload)
                    return

                frame = translate(event, usage, tools)
                if frame:
                    yield frame

    except httpx.HTTPError as exc:
        log.warning("agentscope stream failed: %s", exc)
        yield sse("error", {"message": f"助手服务连接中断（{type(exc).__name__}）"})
    finally:
        if owned:
            await client.aclose()


async def chat(session_id: str, agent_id: str, user_sub: str, text: str) -> dict[str, Any]:
    """投递一条用户消息。返回 AgentScope 的原始响应（前端只需要知道是否成功）。"""
    payload = {
        "agent_id": agent_id,
        "session_id": session_id,
        "input": {
            "name": user_sub,
            "role": "user",
            "content": [{"type": "text", "text": text}],
        },
    }
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.post(
            f"{settings.agentscope_base}/chat/",
            json=payload,
            headers=build_headers(user_sub),
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"助手服务拒绝了消息（{resp.status_code}）")
    return resp.json() if resp.content else {}


async def submit_event(
    session_id: str,
    agent_id: str,
    user_sub: str,
    event: dict[str, Any],
) -> dict[str, Any]:
    """把 HITL 结果事件（确认 / AskUser 答案）投回 AgentScope。

    2.0.12 的 ``ChatRequest.input`` 支持 ``UserConfirmResultEvent`` 与
    ``ExternalExecutionResultEvent``；事件形状由调用方（门户后端）构造，
    这里只负责带上调用者的身份转发，不让前端冒充。
    """
    payload = {"agent_id": agent_id, "session_id": session_id, "input": event}
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.post(
            f"{settings.agentscope_base}/chat/",
            json=payload,
            headers=build_headers(user_sub),
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"助手服务拒绝了确认结果（{resp.status_code}）")
    return resp.json() if resp.content else {}


async def create_session(
    agent_id: str,
    user_sub: str,
    name: str = "",
    model_cfg: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """新建会话。

    ``model_cfg`` 会写进 ``chat_model_config``：AgentScope 2.0.11 的模型配置挂在
    **session** 上，agent 的 ``chat_config`` 里没有这个字段（放进去会被静默忽略，
    调用时直接 invalid_request）。
    """
    body: dict[str, Any] = {"agent_id": agent_id, "name": name or None}
    if model_cfg and model_cfg.get("credential_id"):
        body["chat_model_config"] = model_cfg
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.post(
            f"{settings.agentscope_base}/sessions/",
            json=body,
            headers=build_headers(user_sub),
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"创建会话失败（{resp.status_code}）")
    return resp.json()


async def list_sessions(agent_id: str, user_sub: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(
            f"{settings.agentscope_base}/sessions/",
            params={"agent_id": agent_id},
            headers=build_headers(user_sub),
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"读取会话失败（{resp.status_code}）")
    return resp.json()


async def list_agents(user_sub: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(f"{settings.agentscope_base}/agent/", headers=build_headers(user_sub))
    if resp.status_code >= 400:
        raise RuntimeError(f"读取助手失败（{resp.status_code}）")
    return resp.json()

async def list_credentials(user_sub: str) -> list[dict[str, Any]]:
    """列出该用户在 AgentScope 里的凭据（用于给已存在的 agent 找回 credential_id）。"""
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(f"{settings.agentscope_base}/credential/", headers=build_headers(user_sub))
    if resp.status_code >= 400:
        return []
    payload = resp.json()
    items = payload if isinstance(payload, list) else payload.get("credentials") or payload.get("items") or []
    return [i for i in items if isinstance(i, dict)]
