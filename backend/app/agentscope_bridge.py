"""把 AgentScope 挂成门户 Agent 的**唯一后端**（全线切换）。

设计取舍
--------
前端 `Agent.tsx` 认的是一套固定契约（会话列表 / 新建会话 / 消息列表 /
SSE 五事件），pi 网关时代就是这个形状。切换后端时**不动前端**，在本文件里
把 AgentScope 的数据映射成同一形状；这样回滚只是把开关调回 ``pi``。

多用户：AgentScope 的 credential 与 agent 都是按 user_id 存的。首次使用的用户
没有 agent，需要按平台模型配置自动配一个（``ensure_agent``），否则每个新用户
都要管理员手工 create，实际不可用。
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

# 刻意**不**重导出 adapter 的 chat/stream/list_sessions 等同名符号：
# 两个模块暴露同名函数时，调用方无法判断用的是哪一个。这里统一走 adapter.xxx。
from . import agentscope_adapter as adapter
from .agentscope_adapter import TIMEOUT, build_headers, list_credentials
from .config import settings

log = logging.getLogger("labspace.agentscope.bridge")

# 平台默认模型：取自门户 Agent 配置（管理员可改），没有就用环境默认值。
DEFAULT_MODEL = "MiniMax-M3.1-Flash"


def _model_config(credential_id: str, model: str) -> dict[str, Any]:
    return {
        "type": "openai_credential",
        "credential_id": credential_id,
        "model": model,
        "model_class": "openai_chat",
        "parameters": {},
    }


async def _create_credential(user_sub: str, model_cfg: dict[str, Any]) -> str:
    payload = {
        "data": {
            "type": "openai_credential",
            "name": "门户平台模型",
            "api_key": model_cfg.get("api_key", ""),
            "base_url": model_cfg.get("base_url", ""),
        }
    }
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.post(
            f"{settings.agentscope_base}/credential/", json=payload, headers=build_headers(user_sub)
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"创建模型凭据失败（{resp.status_code}）")
    return str(resp.json().get("credential_id") or "")


async def ensure_agent(user_sub: str, model_cfg: dict[str, Any] | None = None) -> tuple[str, str, str]:
    """返回 ``(agent_id, model_name)``；没有就按平台配置自动建一个。

    ``model_cfg`` 形如 ``{"base_url": ..., "api_key": ..., "model": ...}``；
    缺省时只用环境里的模型名，凭据为空会在真实调用时报错——这里不伪造可用性。
    """
    data = await adapter.list_agents(user_sub)
    agents: list[dict[str, Any]] = []
    if isinstance(data, list):
        agents = [a for a in data if isinstance(a, dict)]
    else:
        raw_agents = data.get("agents") or data.get("items") or []
        agents = [a for a in raw_agents if isinstance(a, dict)]
    model_name = (model_cfg or {}).get("model") or settings.agent_default_model or DEFAULT_MODEL
    if agents:
        first = agents[0]
        agent_id = str(first.get("id") or "")
        # 已存在的 agent 不重建：它可能已经被用户改过 system prompt。
        # credential 存在 agent 的 chat_config 里；读不到就留空，由调用方提示。
        cfg0 = first.get("data") or {}
        chat0 = (cfg0.get("chat_config") or {}) if isinstance(cfg0, dict) else {}
        model0 = chat0.get("model_config") or {}
        credential = str(model0.get("credential_id") or "") if isinstance(model0, dict) else ""
        if not credential:
            # agent 上没有 model_config（2.0.11 把模型放在 session 上），
            # 退一步用该用户的第一条凭据 —— 否则新建的会话没有模型可用。
            creds = await list_credentials(user_sub)
            if creds:
                credential = str(creds[0].get("credential_id") or creds[0].get("id") or "")
        return agent_id, model_name, credential

    cfg = model_cfg or {}
    if not (cfg.get("api_key") and cfg.get("base_url")):
        raise RuntimeError("未配置平台模型凭据（base_url / api_key），无法为新用户自动创建助手")

    credential_id = await _create_credential(user_sub, cfg)
    payload = {
        "name": "D509 科研助手",
        "system_prompt": "你是 D509 实验室门户的科研助手，用中文简洁回答；引用数据时说明来源。",
        # 模型必须挂在 session 上，agent 的 chat_config 里没有 model_config 字段
        # （2.0.11 实测：放进 chat_config 会被忽略，调用时 invalid_request）。
        "chat_config": {"model_config": _model_config(credential_id, model_name)},
    }
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.post(f"{settings.agentscope_base}/agent/", json=payload, headers=build_headers(user_sub))
    if resp.status_code >= 400:
        raise RuntimeError(f"创建助手失败（{resp.status_code}）")
    return str(resp.json().get("agent_id") or ""), model_name, credential_id


async def resolved_agent(
    user_sub: str, model_cfg: dict[str, Any] | None = None
) -> tuple[str, str, str]:
    """带进程内缓存的 ensure_agent：每轮对话都查一次 agent 列表没必要。"""
    cached = _AGENT_CACHE.get(user_sub)
    if cached:
        return cached
    value = await ensure_agent(user_sub, model_cfg)
    _AGENT_CACHE[user_sub] = value
    return value


_AGENT_CACHE: dict[str, tuple[str, str, str]] = {}


def invalidate(user_sub: str) -> None:
    _AGENT_CACHE.pop(user_sub, None)


# --------------------------------------------------------------- 形状映射


def map_session(raw: dict[str, Any], model: str) -> dict[str, Any]:
    """AgentScope 的 session 记录 → 门户前端认的 session 形状。

    列表接口返回的每一项是 ``{"session": {...}, ...}``，真正字段在里层；
    这里先解包再映射，否则前端拿到的 id 恒为空。
    """
    nested = raw.get("session")
    inner: dict[str, Any] = nested if isinstance(nested, dict) else raw
    raw_cfg = inner.get("config")
    cfg: dict[str, Any] = raw_cfg if isinstance(raw_cfg, dict) else {}
    session_id = str(inner.get("id") or inner.get("session_id") or "")
    return {
        "id": session_id,
        "title": cfg.get("name") or inner.get("name") or "新会话",
        "model": model,
        "status": "running" if inner.get("is_running") else "idle",
        "message_count": int(inner.get("message_count") or 0),
        "tokens_in": int(inner.get("input_tokens") or 0),
        "tokens_out": int(inner.get("output_tokens") or 0),
        "created_at": inner.get("created_at"),
        "updated_at": inner.get("updated_at") or inner.get("created_at"),
    }


def map_message(raw: dict[str, Any]) -> dict[str, Any]:
    parts = [c.get("text") for c in (raw.get("content") or []) if isinstance(c, dict) and c.get("text")]
    err = raw.get("error") or {}
    return {
        "id": str(raw.get("id") or ""),
        "role": str(raw.get("role") or "assistant"),
        "content": "\n".join(p for p in parts if p) or (err.get("message") or ""),
        "meta": raw.get("metadata") or {},
        "created_at": raw.get("created_at"),
    }


__all__ = [
    "ensure_agent",
    "invalidate",
    "map_message",
    "map_session",
    "resolved_agent",
]
