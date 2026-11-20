"""Agent 助手：对接宿主机上的 pi RPC 网关。

架构：
    浏览器 → FastAPI(`/api/agent/*`) → 宿主机 Node 网关(172.28.0.1:8110) → pi 子进程 → 模型

要点：
- 网关只在 Docker `lab-tools` 网络可达，不对内网暴露。
- 网关进程携带**用户自己的会话 JWT**（`LAB_PORTAL_BEARER`），插件调用门户接口时与浏览器
  具有完全相同的权限边界；后端同时接受 `Authorization: Bearer <同一 JWT>`。
- 消息落库 `labspace.agent_sessions` / `labspace.agent_messages`；管理员配置落
  `labspace.agent_config`（模型开关、默认模型、配额、系统提示词）。
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import re
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from psycopg2.extras import Json

from . import db
from .config import settings
from .security import require_admin, require_csrf, require_user

router = APIRouter(prefix="/api/agent", tags=["agent"])

log = logging.getLogger("labspace.agent")

# Agent 后端开关：默认已全线切到 AgentScope；设成 pi 可立刻回滚。
AGENT_BACKEND = (os.getenv("LABSPACE_AGENT_BACKEND") or "agentscope").strip().lower()

CONFIG_KEY = "agent"
GW_TIMEOUT = 30
STREAM_TIMEOUT = 600
MAX_CONCURRENT_STREAMS = 3
"""同一用户允许同时保持的 SSE 流数量上限。"""

_stream_lock = asyncio.Lock()
_active_streams: dict[str, int] = {}


async def _acquire_stream_slot(user_id: str) -> None:
    async with _stream_lock:
        current = _active_streams.get(user_id, 0)
        if current >= MAX_CONCURRENT_STREAMS:
            raise HTTPException(status_code=429, detail="并发流过多，请先关闭其它会话窗口")
        _active_streams[user_id] = current + 1


async def _release_stream_slot(user_id: str) -> None:
    async with _stream_lock:
        remaining = _active_streams.get(user_id, 1) - 1
        if remaining <= 0:
            _active_streams.pop(user_id, None)
        else:
            _active_streams[user_id] = remaining

DEFAULT_QUOTAS = {
    "messages_per_hour": 30,
    "messages_per_day": 200,
    "tokens_per_day": 500000,
    "max_sessions": 3,
}


# ------------------------------------------------------------------ 配置与网关


SKILL_ROOT = "/opt/labspace/agent/skills"
BUILTIN_SKILLS = [
    {
        "id": f"{SKILL_ROOT}/plant-database-search",
        "name": "植物数据库检索",
        "description": "植物学与生物信息学数据库检索指南：按对象类型选择数据库并规范调用 lab_database_query。",
        "path": f"{SKILL_ROOT}/plant-database-search",
        "enabled": True,
    },
    {
        "id": f"{SKILL_ROOT}/literature-search",
        "name": "文献与资料检索",
        "description": "文献与外部资料检索指南：优先实验室内知识库，再联网检索并逐条引用来源。",
        "path": f"{SKILL_ROOT}/literature-search",
        "enabled": True,
    },
    {
        "id": f"{SKILL_ROOT}/deep-research",
        "name": "深度研究编排",
        "description": "多步研究编排指南：先定目标与验收标准，再拆任务、逐项取证、复核结论并沉淀到知识库。",
        "path": f"{SKILL_ROOT}/deep-research",
        "enabled": True,
    },
    {
        "id": f"{SKILL_ROOT}/research-workflow",
        "name": "科研助手工作法",
        "description": "长期记忆、计划拆解与一次性代码沙箱的使用规范，跨会话延续科研上下文。",
        "path": f"{SKILL_ROOT}/research-workflow",
        "enabled": True,
    },
]

MODEL_APIS = {"openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"}
MCP_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
PROVIDER_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def _default_config() -> dict[str, Any]:
    return {
        "models": [],
        "default_model": settings.agent_default_model,
        "quotas": dict(DEFAULT_QUOTAS),
        "plugins": [{"id": "lab-portal", "name": "实验室门户能力插件", "enabled": True}],
        "system_prompt": "",
        "skills": [dict(item) for item in BUILTIN_SKILLS],
        "mcp_servers": [],
        "model_endpoints": [],
    }


def get_config() -> dict[str, Any]:
    rows = db.query("SELECT value FROM labspace.agent_config WHERE key=%s", (CONFIG_KEY,))
    cfg = _default_config()
    if rows:
        stored = rows[0].get("value")
        if isinstance(stored, dict):
            cfg.update(stored)
    quotas = dict(DEFAULT_QUOTAS)
    quotas.update(cfg.get("quotas") or {})
    cfg["quotas"] = quotas
    return cfg


def save_config(cfg: dict[str, Any]) -> dict[str, Any]:
    db.execute(
        "INSERT INTO labspace.agent_config(key, value, updated_at) VALUES (%s, %s, now()) "
        "ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()",
        (CONFIG_KEY, Json(cfg)),
    )
    return cfg


def _bounded_int(value: Any, default: int, minimum: int) -> int:
    try:
        return max(minimum, int(value))
    except (TypeError, ValueError):
        return default


def _normalize_skills(items: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in items if isinstance(items, list) else []:
        if not isinstance(raw, dict):
            continue
        path = str(raw.get("path") or "").strip()
        if not path or not path.startswith("/"):
            raise HTTPException(status_code=400, detail=f"技能路径必须是绝对路径：{path or '（空）'}")
        if path in seen:
            continue
        seen.add(path)
        name = str(raw.get("name") or path.rstrip("/").rsplit("/", 1)[-1])[:120]
        out.append(
            {
                "id": path,
                "name": name,
                "description": str(raw.get("description") or "")[:1024],
                "path": path,
                "enabled": bool(raw.get("enabled", True)),
            }
        )
    return out


def _normalize_mcp_servers(items: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in items if isinstance(items, list) else []:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()
        if not MCP_NAME_RE.match(name):
            raise HTTPException(
                status_code=400,
                detail=f"MCP 服务器名称只能包含字母、数字、下划线和短横线：{name or '（空）'}",
            )
        if name in seen:
            raise HTTPException(status_code=400, detail=f"MCP 服务器名称重复：{name}")
        seen.add(name)
        description = str(raw.get("description") or "")[:1024]
        if raw.get("transport") == "http":
            url = str(raw.get("url") or "").strip()
            if not url.startswith(("http://", "https://")):
                raise HTTPException(status_code=400, detail=f"MCP「{name}」需要合法的 http(s) URL")
            headers = {
                str(k).strip(): str(v)
                for k, v in (raw.get("headers") or {}).items()
                if str(k).strip() and v is not None
            }
            item: dict[str, Any] = {
                "id": name,
                "name": name,
                "transport": "http",
                "url": url,
                "headers": headers,
                "description": description,
            }
        else:
            command = str(raw.get("command") or "").strip()
            if not command:
                raise HTTPException(status_code=400, detail=f"MCP「{name}」缺少启动命令")
            args = [str(a) for a in (raw.get("args") or []) if str(a).strip()]
            env = {
                str(k).strip(): str(v)
                for k, v in (raw.get("env") or {}).items()
                if str(k).strip() and v is not None
            }
            item = {
                "id": name,
                "name": name,
                "transport": "stdio",
                "command": command,
                "args": args,
                "env": env,
                "cwd": str(raw.get("cwd") or "").strip(),
                "description": description,
            }
        item["enabled"] = bool(raw.get("enabled", True))
        out.append(item)
    return out


def _normalize_model_endpoints(items: Any, existing: Any) -> list[dict[str, Any]]:
    existing_map = {
        str(ep.get("provider")): ep
        for ep in (existing if isinstance(existing, list) else [])
        if isinstance(ep, dict) and ep.get("provider")
    }
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in items if isinstance(items, list) else []:
        if not isinstance(raw, dict):
            continue
        provider = str(raw.get("provider") or "").strip().lower()
        if not PROVIDER_RE.match(provider):
            raise HTTPException(
                status_code=400,
                detail=f"模型端点标识只能使用小写字母、数字、下划线和短横线：{provider or '（空）'}",
            )
        if provider in seen:
            raise HTTPException(status_code=400, detail=f"模型端点标识重复：{provider}")
        seen.add(provider)
        base_url = str(raw.get("base_url") or "").strip().rstrip("/")
        if not base_url.startswith(("http://", "https://")):
            raise HTTPException(status_code=400, detail=f"模型端点「{provider}」需要合法的 http(s) Base URL")
        api = str(raw.get("api") or "openai-completions")
        if api not in MODEL_APIS:
            api = "openai-completions"
        models: list[dict[str, Any]] = []
        raw_models = raw.get("models")
        for m in raw_models if isinstance(raw_models, list) else []:
            if not isinstance(m, dict):
                continue
            mid = str(m.get("id") or "").strip()
            if not mid:
                continue
            models.append(
                {
                    "id": mid,
                    "name": str(m.get("name") or mid)[:120],
                    "context": _bounded_int(m.get("context"), 128000, 1024),
                    "max_tokens": _bounded_int(m.get("max_tokens"), 16384, 256),
                    "reasoning": bool(m.get("reasoning")),
                    "image": bool(m.get("image")),
                }
            )
        if not models:
            raise HTTPException(status_code=400, detail=f"模型端点「{provider}」至少需要一个模型")
        if raw.get("clear_api_key"):
            api_key = ""
        elif not raw.get("api_key"):
            api_key = str(existing_map.get(provider, {}).get("api_key") or "")
        else:
            api_key = str(raw["api_key"]).strip()
        out.append(
            {
                "provider": provider,
                "name": str(raw.get("name") or provider)[:120],
                "base_url": base_url,
                "api": api,
                "api_key": api_key,
                "models": models,
                "enabled": bool(raw.get("enabled", True)),
            }
        )
    return out


def _sanitize_config(cfg: dict[str, Any]) -> dict[str, Any]:
    """返回给管理端时剔除明文 API Key，只保留是否已设置。"""
    out = dict(cfg)
    endpoints: list[dict[str, Any]] = []
    for ep in cfg.get("model_endpoints") or []:
        if not isinstance(ep, dict):
            continue
        item = {k: v for k, v in ep.items() if k != "api_key"}
        item["api_key_set"] = bool(ep.get("api_key"))
        endpoints.append(item)
    out["model_endpoints"] = endpoints
    return out


def _runtime_payload(cfg: dict[str, Any]) -> dict[str, Any]:
    skills = [
        {
            "name": s.get("name") or "",
            "path": s.get("path") or "",
            "description": s.get("description") or "",
        }
        for s in cfg.get("skills") or []
        if isinstance(s, dict) and s.get("enabled", True) and s.get("path")
    ]
    mcp_servers: list[dict[str, Any]] = []
    for s in cfg.get("mcp_servers") or []:
        if not isinstance(s, dict) or not s.get("enabled", True) or not s.get("name"):
            continue
        item: dict[str, Any] = {
            "name": s["name"],
            "transport": s.get("transport") or "stdio",
            "description": s.get("description") or "",
        }
        for key in ("command", "args", "env", "cwd", "url", "headers"):
            value = s.get(key)
            if value not in (None, "", [], {}):
                item[key] = value
        mcp_servers.append(item)
    providers: list[dict[str, Any]] = []
    for ep in cfg.get("model_endpoints") or []:
        if not isinstance(ep, dict) or not ep.get("enabled", True) or not ep.get("provider"):
            continue
        providers.append(
            {
                "provider": ep["provider"],
                "name": ep.get("name") or ep["provider"],
                "baseUrl": ep.get("base_url") or "",
                "api": ep.get("api") or "openai-completions",
                "apiKey": ep.get("api_key") or "",
                "models": [
                    {
                        "id": m.get("id"),
                        "name": m.get("name") or m.get("id"),
                        "context": m.get("context"),
                        "max_tokens": m.get("max_tokens"),
                        "reasoning": bool(m.get("reasoning")),
                        "image": bool(m.get("image")),
                    }
                    for m in ep.get("models") or []
                    if isinstance(m, dict) and m.get("id")
                ],
            }
        )
    return {"skills": skills, "mcpServers": mcp_servers, "providers": providers}


def _runtime_version(cfg: dict[str, Any]) -> str:
    payload = _runtime_payload(cfg)
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:16]


_runtime_state: dict[str, Any] = {"version": "", "attempt": 0.0}
_runtime_lock = asyncio.Lock()


async def _sync_runtime(
    cfg: dict[str, Any] | None = None,
    force: bool = False,
    user_id: str = "",
) -> dict[str, Any]:
    cfg = cfg or get_config()
    payload = _runtime_payload(cfg)
    version = _runtime_version(cfg)
    payload["version"] = version
    if not force and _runtime_state.get("version") == version:
        return {"applied": True, "version": version, "unchanged": True}
    async with _runtime_lock:
        # AgentScope 的技能 / MCP 由「能力中心」直接管理（agentscope 自己的记录）；
        # 门户这边只保存配置。这里校验助手服务可达，并把门户配置版本记下来，
        # 让管理页能看出"配置已保存"而不是"已推送到某个已不存在的网关"。
        #
        # 助手服务的 /health **强制要求 X-User-ID**（缺这个头会直接 422），
        # 所以这里必须带上调用者身份，否则管理页永远显示"助手服务返回 422"。
        headers = {"X-User-ID": user_id} if user_id else {}
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.get(f"{settings.agentscope_base}/health", headers=headers)
        except httpx.HTTPError as exc:
            return {"applied": False, "version": version, "error": f"助手服务不可达：{type(exc).__name__}"}
        if resp.status_code != 200:
            detail = resp.text[:120].replace("\n", " ")
            return {
                "applied": False,
                "version": version,
                "error": f"助手服务返回 {resp.status_code}（{detail}）",
            }
    _runtime_state["version"] = version
    return {"applied": True, "version": version, "target": "agentscope"}


def _public_models() -> list[dict[str, Any]]:
    """管理员配置的白名单模型 + 平台默认模型。

    数据只来自门户配置与 AgentScope 侧的平台凭据，不再问已下线的 pi 网关。
    """
    cfg = get_config()
    allowed = {m.get("id"): m for m in (cfg.get("models") or []) if m.get("id")}
    gw_meta: dict[str, Any] = {}
    out: list[dict[str, Any]] = []
    for mid, m in allowed.items():
        g = gw_meta.get(mid) or {}
        out.append(
            {
                "id": mid,
                "provider": m.get("provider") or g.get("provider", ""),
                "label": m.get("label") or g.get("label") or mid,
                "context": m.get("context") if m.get("context") is not None else g.get("context"),
                "enabled": bool(m.get("enabled", True)),
            }
        )
    if out:
        # 白名单为权威；同时带出网关新增的模型（含管理员刚添加的端点），默认未启用，
        # 便于在管理页直接勾选，而不必手工输入模型标识。
        seen = {m["id"] for m in out}
        for m in []:
            mid = m.get("id")
            if not mid or mid in seen:
                continue
            out.append(
                {
                    "id": mid,
                    "provider": m.get("provider", ""),
                    "label": m.get("label") or mid,
                    "context": m.get("context"),
                    "enabled": False,
                }
            )
    if not out:
        # 白名单为空（初始状态 / 刚重置）→ 回退到网关实际提供的模型列表，默认全部可用。
        for m in []:
            if not m.get("id"):
                continue
            out.append(
                {
                    "id": m.get("id"),
                    "provider": m.get("provider", ""),
                    "label": m.get("label") or m.get("id"),
                    "context": m.get("context"),
                    "enabled": True,
                }
            )
    if not out:
        out = [
            {
                "id": cfg.get("default_model") or settings.agent_default_model,
                "provider": "",
                "label": cfg.get("default_model") or settings.agent_default_model,
                "context": None,
                "enabled": True,
            }
        ]
    return out


def _allowed_model_ids() -> set[str]:
    """白名单模型的可用标识：同时接受裸 id（如 MiniMax-M3）与 provider/id 形式。"""
    ids: set[str] = set()
    for m in _public_models():
        if not m.get("enabled") or not m.get("id"):
            continue
        ids.add(str(m["id"]))
        if m.get("provider"):
            ids.add(f"{m['provider']}/{m['id']}")
    return ids


# ------------------------------------------------------------------ 配额


def _usage(user_id: str) -> dict[str, Any]:
    hour = db.query(
        "SELECT count(*) AS n FROM labspace.agent_messages WHERE user_id=%s AND created_at > now() - interval '1 hour'",
        (user_id,),
    )
    day = db.query(
        "SELECT count(*) AS n FROM labspace.agent_messages WHERE user_id=%s AND created_at > now() - interval '1 day'",
        (user_id,),
    )
    tokens = db.query(
        "SELECT COALESCE(sum(COALESCE((meta->'usage'->>'input')::bigint,0)),0) AS tin, "
        "COALESCE(sum(COALESCE((meta->'usage'->>'output')::bigint,0)),0) AS tout "
        "FROM labspace.agent_messages WHERE user_id=%s AND created_at > now() - interval '1 day'",
        (user_id,),
    )
    sessions = db.query(
        "SELECT count(*) AS n FROM labspace.agent_sessions "
        "WHERE user_id=%s AND status <> 'closed' AND created_at > now() - interval '24 hours'",
        (user_id,),
    )
    def _count(rows: list[dict[str, Any]], key: str = "n") -> int:
        """聚合结果转整数：数据库给了数字列，但驱动也可能给字符串/NULL。"""
        if not rows:
            return 0
        try:
            return int(rows[0].get(key) or 0)
        except (TypeError, ValueError):
            return 0

    tokens_today = 0
    if tokens:
        try:
            tokens_today = int(tokens[0].get("tin") or 0) + int(tokens[0].get("tout") or 0)
        except (TypeError, ValueError):
            tokens_today = 0
    return {
        "messagesHour": _count(hour),
        "messagesDay": _count(day),
        "tokensToday": tokens_today,
        "sessionsActive": _count(sessions),
    }


def _check_quota(user_id: str, include_sessions: bool = False) -> None:
    cfg = get_config()
    quotas = cfg["quotas"]
    use = _usage(user_id)
    if use["messagesHour"] >= int(quotas["messages_per_hour"]):
        raise HTTPException(status_code=429, detail="已超出每小时消息配额，请稍后再试")
    if use["messagesDay"] >= int(quotas["messages_per_day"]):
        raise HTTPException(status_code=429, detail="已超出每日消息配额，请明天再试")
    if use["tokensToday"] >= int(quotas["tokens_per_day"]):
        raise HTTPException(status_code=429, detail="已超出每日令牌配额，请明天再试")
    # 会话数量上限只限制“新建会话”，不影响已在进行的会话继续对话
    if include_sessions and use["sessionsActive"] >= int(quotas["max_sessions"]):
        raise HTTPException(status_code=429, detail="已达到活动会话上限，请先关闭其它会话")


# ------------------------------------------------------------------ 会话工具


def _iso(value: Any) -> str | None:
    """把数据库里的时间字段安全地转成 ISO 字符串。

    psycopg2 在 timestamptz 上返回 datetime，但取值为 NULL、或将来换成
    文本列时这里都不能炸——统一走一个收窄点，而不是每个序列化处各写一遍。
    """
    if value is None:
        return None
    if isinstance(value, str):
        return value
    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        return str(isoformat())
    return str(value)


def _platform_model() -> dict[str, Any]:
    """把门户里的模型配置翻译成 AgentScope credential + model 需要的形状。

    管理员在「管理端 → Agent」里配的 provider（base_url / api_key / model）是
    唯一真源；这里只做字段改名，不维护第二份配置。
    """
    try:
        cfg = get_config()
    except Exception:  # noqa: BLE001 - 配置读取失败时退回环境默认
        cfg = {}
    providers = cfg.get("providers") or {}
    default_model = str(cfg.get("default_model") or settings.agent_default_model or "")
    provider_key = default_model.split("/", 1)[0] if "/" in default_model else ""
    model_name = default_model.split("/", 1)[1] if "/" in default_model else default_model
    provider = providers.get(provider_key) or {}
    # 管理员没配 provider 时回落到环境里的平台凭据（/etc/labspace/agent-model.env）。
    return {
        "base_url": str(provider.get("base_url") or settings.agent_model_base or "").rstrip("/"),
        "api_key": str(provider.get("api_key") or settings.agent_model_key or ""),
        "model": model_name or default_model or settings.agent_model_name,
    }


def _use_agentscope() -> bool:
    """是否使用 AgentScope 后端。

    pi 网关已于 2026-11-10 整体下线（源码、systemd 单元、配置一并移除），
    因此这里不再提供 pi 分支：把开关设成 pi 会显式 410，而不是静默走到一条
    已经不存在的服务上。
    """
    if AGENT_BACKEND == "pi":
        raise HTTPException(
            status_code=410,
            detail="pi 网关已下线，助手统一由 AgentScope 提供；请移除 LABSPACE_AGENT_BACKEND=pi。",
        )
    return True


def _session_out(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row.get("title") or "新会话",
        "model": row.get("model") or "",
        "status": row.get("status") or "idle",
        "message_count": int(row.get("message_count") or 0),
        "tokens_in": int(row.get("tokens_in") or 0),
        "tokens_out": int(row.get("tokens_out") or 0),
        "created_at": _iso(row.get("created_at")),
        "updated_at": _iso(row.get("updated_at")),
    }


def _message_out(row: dict[str, Any]) -> dict[str, Any]:
    meta = row.get("meta") or {}
    return {
        "id": row["id"],
        "role": row.get("role"),
        "content": row.get("content") or "",
        "meta": meta if isinstance(meta, dict) else {},
        "created_at": _iso(row.get("created_at")),
    }


def _own_session(session_id: str, user_id: str) -> dict[str, Any]:
    rows = db.query(
        "SELECT * FROM labspace.agent_sessions WHERE id=%s AND user_id=%s", (session_id, user_id)
    )
    if not rows:
        raise HTTPException(status_code=404, detail="会话不存在")
    return rows[0]


# ------------------------------------------------------------------ 长期记忆

MEMORY_KINDS = {"fact", "preference", "lesson", "project", "note"}
MAX_MEMORIES = 400
MEMORY_PROMPT_LIMIT = 24

ASSISTANT_GUIDE = """你是 D509 实验室门户的科研助手，服务于实验室成员的科研、学习与日常工作。
工作方式：
1. 先理解目标；复杂任务先拆成 2–6 步再动手，完成后说明验收结果。
2. 涉及实验室资料、历史记录或方法学问题时，先调用 lab_knowledge_search 检索私有知识库，并在回答中注明来源。
3. 需要外部文献或最新进展时调用 lab_web_search；需要植物/组学数据时调用 lab_database_query。
4. 需要数值计算、数据处理或临时脚本时调用 lab_sandbox_run：一次性安全沙箱、无网络、限内存与时长，执行后容器立即销毁；不要臆造计算结果。
5. 重要结论、用户偏好或可复用方法，调用 lab_memory_save 写入长期记忆；用户明确要求忘记时调用 lab_memory_forget。
6. 需要持续跟进的事项，调用 lab_workbench_capture 记录到个人工作台。
回答使用简体中文：先给结论，再给依据；不确定就明确说明。"""


def _memory_out(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "title": row["title"],
        "content": row["content"],
        "sourceSession": row["source_session"],
        "pinned": bool(row["pinned"]),
        "createdAt": row["created_at"].isoformat() if row.get("created_at") else "",
        "updatedAt": row["updated_at"].isoformat() if row.get("updated_at") else "",
    }


def _memory_digest(user_id: str) -> str:
    rows = db.query(
        "SELECT kind, title, content FROM labspace.agent_memories WHERE user_id=%s "
        "ORDER BY pinned DESC, updated_at DESC LIMIT %s",
        (user_id, MEMORY_PROMPT_LIMIT),
    )
    if not rows:
        return ""
    lines = [f"- [{r['kind']}] {r['title']}：{r['content'][:400]}" for r in rows]
    return "\n\n## 关于当前用户的长期记忆（仅本人可见）\n" + "\n".join(lines)


def _system_prompt(user_id: str, cfg: dict[str, Any]) -> str:
    custom = str(cfg.get("system_prompt") or "").strip()
    base = f"{custom}\n\n{ASSISTANT_GUIDE}" if custom else ASSISTANT_GUIDE
    return base + _memory_digest(user_id)


def _insert_message(session_id: str, user_id: str, role: str, content: str, meta: dict[str, Any] | None = None) -> str:
    mid = uuid.uuid4().hex
    db.execute(
        "INSERT INTO labspace.agent_messages(id, session_id, user_id, role, content, meta, created_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, now())",
        (mid, session_id, user_id, role, content, Json(meta or {})),
    )
    return mid


def _update_message(mid: str, content: str, meta: dict[str, Any] | None = None) -> None:
    """用本轮真正的答复覆盖先前落库的空助手消息。"""
    db.execute(
        "UPDATE labspace.agent_messages SET content = %s, meta = %s WHERE id = %s",
        (content, Json(meta or {}), mid),
    )


def _bump_session(session_id: str, tokens_in: int = 0, tokens_out: int = 0) -> None:
    db.execute(
        "UPDATE labspace.agent_sessions SET message_count = message_count + 1, tokens_in = tokens_in + %s, "
        "tokens_out = tokens_out + %s, updated_at = now() WHERE id=%s",
        (tokens_in, tokens_out, session_id),
    )


def _sandbox_online() -> bool:
    """沙箱心跳由宿主机服务写入 /srv/labgo，容器内只读该文件判断存活。"""
    try:
        with open("/srv/labgo/sandbox-status.json", encoding="utf-8") as fh:
            status = json.load(fh)
        return bool(status.get("ok")) and time.time() - float(status.get("updatedAt") or 0) < 90
    except (OSError, ValueError, TypeError):
        return False


async def _ensure_agentscope_session(session_id: str, user: dict[str, Any]) -> str:
    """确保助手侧存在这个会话；不存在就**迁移**一个出来。

    切换前用 pi 建的会话只存在于门户库，助手侧（AgentScope）没有对应记录，
    直接发消息会 404。这里在助手侧按同样的标题/模型建一个会话，并把门户库里
    的会话与消息指针改到新 id —— 用户的历史不丢，只是"接着上一次继续"。
    """
    from . import agentscope_adapter as adapter
    from . import agentscope_bridge as bridge

    agent_id, model, cred = await bridge.resolved_agent(user["sub"], _platform_model())
    title = ""
    rows = db.query(
        "SELECT title, model FROM labspace.agent_sessions WHERE id=%s AND user_id=%s",
        (session_id, user["sub"]),
    )
    if rows:
        title = str(rows[0].get("title") or "")

    exists = False
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{settings.agentscope_base}/sessions/{session_id}/status",
                params={"agent_id": agent_id},
                headers={"X-User-ID": user["sub"]},
            )
        exists = resp.status_code == 200
    except httpx.HTTPError:
        exists = False
    if exists:
        return session_id

    created = await adapter.create_session(
        agent_id,
        user["sub"],
        title or "迁移的会话",
        {
            "type": "openai_credential",
            "credential_id": cred,
            "model": model,
            "model_class": "openai_chat",
            "parameters": {},
        },
    )
    new_id = str(created.get("session_id") or created.get("id") or "")
    if not new_id:
        raise HTTPException(status_code=502, detail="助手服务未返回会话 ID")
    # 门户库里改指针：会话行与消息行都要跟着走
    db.execute("UPDATE labspace.agent_messages SET session_id=%s WHERE session_id=%s", (new_id, session_id))
    db.execute("UPDATE labspace.agent_sessions SET id=%s WHERE id=%s AND user_id=%s", (new_id, session_id, user["sub"]))
    return new_id


async def _agentscope_delete_session(session_id: str, user_sub: str) -> None:
    """删除助手侧的会话（AgentScope 的 DELETE /sessions/{id}）。"""
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.delete(
            f"{settings.agentscope_base}/sessions/{session_id}",
            headers={"X-User-ID": user_sub},
        )
    if resp.status_code >= 400 and resp.status_code != 404:
        raise RuntimeError(f"助手服务返回 {resp.status_code}")


async def _agentscope_interrupt(session_id: str, user_sub: str) -> None:
    """中断当前回复（AgentScope 的 POST /sessions/{id}/interrupt）。"""
    agent_id = await _agentscope_agent_id(user_sub)
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{settings.agentscope_base}/sessions/{session_id}/interrupt",
            params={"agent_id": agent_id},
            headers={"X-User-ID": user_sub},
        )
    if resp.status_code >= 400 and resp.status_code != 404:
        raise RuntimeError(f"助手服务返回 {resp.status_code}")


async def _agentscope_agent_id(user_sub: str) -> str:
    """取当前用户的助手 id（AgentScope 的 GET /agent/）。"""
    from . import agentscope_bridge as bridge

    agent_id, _model, _cred = await bridge.resolved_agent(user_sub, _platform_model())
    return agent_id


# ------------------------------------------------------------------ 路由


@router.get("/status")
async def agent_status(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    cfg = get_config()
    available = False
    reason = ""
    # 助手后端就是 AgentScope（pi 网关已下线）：直接问它自己的 /health
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(
                f"{settings.agentscope_base}/health", headers={"X-User-ID": user["sub"]}
            )
        available = resp.status_code == 200
        if not available:
            reason = f"助手服务返回 {resp.status_code}"
    except httpx.HTTPError as exc:
        reason = f"助手服务不可达：{type(exc).__name__}"
    skills = [
        {"name": s.get("name") or "", "description": s.get("description") or ""}
        for s in cfg.get("skills") or []
        if isinstance(s, dict) and s.get("enabled", True) and s.get("name")
    ]
    return {
        "available": available,
        "reason": reason,
        "backend": "agentscope",
        "model": cfg.get("default_model"),
        "models": _public_models(),
        "quotas": cfg["quotas"],
        "skills": skills,
        "sandbox": _sandbox_online(),
        "memoryCount": int(
            (db.query("SELECT count(*) AS n FROM labspace.agent_memories WHERE user_id=%s", (user["sub"],)) or [{"n": 0}])[0]["n"]
        ),
    }


@router.get("/models")
async def agent_models(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    """可用模型列表。

    pi 网关已下线，不能再去问它要模型清单（那会 503，Agent 页一直报红）。
    AgentScope 侧直接用**平台模型配置**：管理员白名单优先，缺省用
    /etc/labspace/agent-model.env 里的那一个。
    """
    platform = _platform_model()
    model_name = platform.get("model") or settings.agent_default_model
    cfg = get_config()
    allowed = {m.get("id"): m for m in (cfg.get("models") or []) if m.get("id")}
    models: list[dict[str, Any]] = []
    for mid, m in allowed.items():
        models.append(
            {
                "id": mid,
                "provider": m.get("provider") or "",
                "label": m.get("label") or mid,
                "context": m.get("context"),
                "enabled": bool(m.get("enabled", True)),
            }
        )
    if model_name and not any(m["id"] == model_name for m in models):
        models.insert(
            0,
            {
                "id": model_name,
                "provider": "platform",
                "label": model_name,
                "context": None,
                "enabled": True,
            },
        )
    return {"models": models}


@router.get("/sessions")
async def list_sessions(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    # 门户库是权威：会话详情、配额、消息都按 labspace.agent_sessions 走。
    # （之前这里直接返回 AgentScope 的列表，两边对不上 → 点进会话就是 404。）
    rows = db.query(
        "SELECT * FROM labspace.agent_sessions WHERE user_id=%s ORDER BY updated_at DESC LIMIT 50",
        (user["sub"],),
    )
    return {"sessions": [_session_out(r) for r in rows]}


@router.post("/sessions")
async def create_session(
    request: Request,
    title: str = Query(default=""),
    model: str = Query(default=""),
    user: dict[str, Any] = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    _check_quota(user["sub"], include_sessions=True)
    if _use_agentscope():
        from . import agentscope_adapter as adapter
        from . import agentscope_bridge as bridge

        platform = _platform_model()
        try:
            agent_id, chosen_model, credential_id = await bridge.resolved_agent(user["sub"], platform)
            created = await adapter.create_session(
                agent_id,
                user["sub"],
                title or "",
                {
                    "type": "openai_credential",
                    "credential_id": credential_id,
                    "model": chosen_model,
                    "model_class": "openai_chat",
                    "parameters": {},
                },
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        sid = str(created.get("session_id") or created.get("id") or "")
        if not sid:
            raise HTTPException(status_code=502, detail="助手服务未返回会话 ID")
        # 本地也留一行：权限校验、额度统计、会话列表回退都依赖它。
        db.execute(
            "INSERT INTO labspace.agent_sessions(id, user_id, title, model, status, message_count, tokens_in, tokens_out, created_at, updated_at) "
            "VALUES (%s, %s, %s, %s, 'idle', 0, 0, 0, now(), now())",
            (sid, user["sub"], title or "新会话", chosen_model),
        )
        rows = db.query("SELECT * FROM labspace.agent_sessions WHERE id=%s", (sid,))
        session = _session_out(rows[0]) if rows else {"id": sid, "title": title or "新会话", "model": chosen_model}
        return {"session": session}

    # 助手后端只有 AgentScope 一套实现（pi 网关已下线）：
    # 走到这里说明上游分支没接住，直接给明确错误而不是回退到已下线的网关。
    raise HTTPException(status_code=501, detail="助手后端未初始化，请检查 AgentScope 服务")


@router.get("/sessions/{session_id}")
async def get_session(session_id: str, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    row = _own_session(session_id, user["sub"])
    rows = db.query(
        "SELECT * FROM labspace.agent_messages WHERE session_id=%s ORDER BY created_at ASC LIMIT 200",
        (session_id,),
    )
    return {"session": _session_out(row), "messages": [_message_out(r) for r in rows]}


@router.delete("/sessions/{session_id}")
async def delete_session(
    session_id: str,
    user: dict[str, Any] = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    _own_session(session_id, user["sub"])
    # 助手侧删除失败不应阻止本地清理：会话记录留着才是真问题。
    with contextlib.suppress(Exception):
        await _agentscope_delete_session(session_id, user["sub"])
    db.execute("DELETE FROM labspace.agent_messages WHERE session_id=%s", (session_id,))
    db.execute("DELETE FROM labspace.agent_sessions WHERE id=%s", (session_id,))
    return {"ok": True}


@router.get("/sessions/{session_id}/messages")
async def list_messages(session_id: str, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    if _use_agentscope():
        from . import agentscope_adapter as as_adapter
        from . import agentscope_bridge as bridge

        agent_id, _model, _cred = await bridge.resolved_agent(user["sub"], _platform_model())
        session_id = await _ensure_agentscope_session(session_id, user)
        async with httpx.AsyncClient(timeout=as_adapter.TIMEOUT) as client:
            resp = await client.get(
                f"{settings.agentscope_base}/sessions/{session_id}/messages",
                params={"agent_id": agent_id},
                headers=as_adapter.build_headers(user["sub"]),
            )
        if resp.status_code == 404:
            raise HTTPException(status_code=404, detail="会话不存在或不属于当前用户")
        if resp.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"读取消息失败（{resp.status_code}）")
        payload = resp.json()
        items = payload if isinstance(payload, list) else payload.get("messages") or []
        return {"messages": [bridge.map_message(m) for m in items if isinstance(m, dict)]}
    _own_session(session_id, user["sub"])
    rows = db.query(
        "SELECT * FROM labspace.agent_messages WHERE session_id=%s ORDER BY created_at ASC LIMIT 200",
        (session_id,),
    )
    return {"messages": [_message_out(r) for r in rows]}


@router.post("/sessions/{session_id}/messages")
async def send_message(
    request: Request,
    session_id: str,
    content: str = Query(default=""),
    regenerate: bool = Query(default=False),
    user: dict[str, Any] = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    text = (content or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="消息内容不能为空")
    _check_quota(user["sub"])
    if _use_agentscope():
        from . import agentscope_adapter as adapter
        from . import agentscope_bridge as bridge

        agent_id, _model, _cred = await bridge.resolved_agent(user["sub"], _platform_model())
        session_id = await _ensure_agentscope_session(session_id, user)
        try:
            await adapter.chat(session_id, agent_id, user["sub"], text)
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        # 本地留痕：历史回放与额度统计都以它为准。
        # 用统一的 _insert_message —— 它带 user_id（NOT NULL 列），此前这段
        # 自己拼 SQL 漏了 user_id，助手一发消息就 500。
        _insert_message(session_id, user["sub"], "user", text)
        db.execute(
            "UPDATE labspace.agent_sessions SET message_count = message_count + 1, updated_at = now() WHERE id=%s",
            (session_id,),
        )
        return {"ok": True}
    _own_session(session_id, user["sub"])
    mid: str | None = None
    if regenerate:
        # 重新生成：清掉最后一轮回答，避免会话里出现两条连续的助手消息
        db.execute(
            "DELETE FROM labspace.agent_messages WHERE session_id=%s AND role='assistant' "
            "AND created_at > COALESCE(("
            "  SELECT max(created_at) FROM labspace.agent_messages "
            "  WHERE session_id=%s AND role='user'"
            "), 'epoch'::timestamptz)",
            (session_id, session_id),
        )
        db.execute(
            "UPDATE labspace.agent_sessions SET status='running', updated_at=now() WHERE id=%s",
            (session_id,),
        )
    else:
        mid = _insert_message(session_id, user["sub"], "user", text)
        _bump_session(session_id)
    db.execute("UPDATE labspace.agent_sessions SET status='running', updated_at=now() WHERE id=%s", (session_id,))
    return {
        "accepted": True,
        "regenerate": regenerate,
        "message": {"id": mid, "role": "user", "content": text, "meta": {}, "created_at": None} if mid else None,
    }


@router.post("/sessions/{session_id}/hitl")
async def submit_hitl(
    session_id: str,
    payload: dict[str, Any] = Body(...),
    user: dict[str, Any] = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    """回传 HITL 结果：工具确认或 AskUser 答案。

    前端只传「用户的选择」，**事件形状在这里构造** —— 防止客户端伪造
    ``tool_call`` / 权限规则（那等于把「批准任意工具调用」交给前端）。
    目前支持：

    * ``kind=confirm``：``approved`` 布尔；服务端按 reply_id + tool_calls 重建
      ``UserConfirmResultEvent``；
    * ``kind=ask``：``answers`` 列表（question / selected / other）；
      重建 ``ExternalExecutionResultEvent``，输出同时写给模型与程序。
    """
    if not _use_agentscope():
        raise HTTPException(status_code=400, detail="当前助手不支持 HITL")
    reply_id = str(payload.get("replyId") or "").strip()
    kind = str(payload.get("kind") or "").strip()
    tool_calls = payload.get("toolCalls") or []
    if not reply_id or not isinstance(tool_calls, list) or not tool_calls:
        raise HTTPException(status_code=400, detail="缺少 replyId 或 toolCalls")

    from . import agentscope_adapter as adapter
    from . import agentscope_bridge as bridge

    agent_id, _model, _cred = await bridge.resolved_agent(user["sub"], _platform_model())

    if kind == "confirm":
        confirmed = bool(payload.get("approved"))
        confirm_results = []
        for call in tool_calls:
            if not isinstance(call, dict):
                continue
            confirm_results.append(
                {
                    "confirmed": confirmed,
                    "tool_call": call,
                    "rules": call.get("suggested_rules") or [],
                }
            )
        event: dict[str, Any] = {
            "type": "USER_CONFIRM_RESULT",
            "reply_id": reply_id,
            "confirm_results": confirm_results,
        }
    elif kind == "ask":
        answers = payload.get("answers") or []
        if not isinstance(answers, list):
            raise HTTPException(status_code=400, detail="answers 必须是数组")
        results = []
        for call in tool_calls:
            if not isinstance(call, dict):
                continue
            name = str(call.get("name") or "")
            if name != "AskUser":
                continue
            clean = []
            for a in answers:
                if not isinstance(a, dict):
                    continue
                clean.append(
                    {
                        "question": str(a.get("question") or ""),
                        "selected": [str(x) for x in (a.get("selected") or [])],
                        "other": a.get("other") or None,
                    }
                )
            text = "；".join(
                f"{a['question']}: {', '.join(a['selected']) or a['other'] or '(未回答)'}"
                for a in clean
            )
            results.append(
                {
                    "type": "tool_result",
                    "id": call.get("id"),
                    "name": name,
                    "output": [{"type": "text", "text": text}],
                    "state": "success",
                    "metadata": {"answers": clean},
                }
            )
        if not results:
            raise HTTPException(status_code=400, detail="没有可回传的 AskUser 工具调用")
        event = {
            "type": "EXTERNAL_EXECUTION_RESULT",
            "reply_id": reply_id,
            "execution_results": results,
        }
    else:
        raise HTTPException(status_code=400, detail="未知的 HITL 类型")

    try:
        await adapter.submit_event(session_id, agent_id, user["sub"], event)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True}


@router.post("/sessions/{session_id}/abort")
async def abort_session(
    session_id: str,
    user: dict[str, Any] = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    _own_session(session_id, user["sub"])
    # 中断失败同样不该挡住本地状态复位：会话必须能回到 idle。
    with contextlib.suppress(Exception):
        await _agentscope_interrupt(session_id, user["sub"])
    db.execute("UPDATE labspace.agent_sessions SET status='idle', updated_at=now() WHERE id=%s", (session_id,))
    return {"ok": True}


@router.get("/sessions/{session_id}/stream")
async def stream_session(
    request: Request, session_id: str, user: dict[str, Any] = Depends(require_user)
) -> StreamingResponse:
    if _use_agentscope():
        from . import agentscope_adapter as adapter
        from . import agentscope_bridge as bridge

        agent_id, _model, _cred = await bridge.resolved_agent(user["sub"], _platform_model())
        session_id = await _ensure_agentscope_session(session_id, user)
        # 并发流保护沿用同一套槽位：两套后端共用一个上限，切不切换都不放开限制。
        await _acquire_stream_slot(user["sub"])

        async def gen_agentscope() -> AsyncIterator[str]:
            try:
                async for frame in adapter.stream(session_id, agent_id, user["sub"]):
                    # done 里带真实 token 用量：这里落库，额度统计才不是空的
                    if frame.startswith("event: done"):
                        try:
                            payload = json.loads(frame.split("\n")[1][6:])
                            usage = payload.get("usage") or {}
                            _bump_session(
                                session_id,
                                tokens_in=int(usage.get("input_tokens") or 0),
                                tokens_out=int(usage.get("output_tokens") or 0),
                            )
                            db.execute(
                                "UPDATE labspace.agent_sessions SET updated_at = now() WHERE id=%s",
                                (session_id,),
                            )
                        except Exception as exc:  # noqa: BLE001 - 记账失败不应中断输出
                            log.warning("agent usage accounting failed: %s", exc)
                    yield frame
            finally:
                await _release_stream_slot(user["sub"])

        return StreamingResponse(
            gen_agentscope(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
        )
    # 助手后端只有 AgentScope 一套实现：没有 AgentScope 分支就没有第二种流。
    raise HTTPException(status_code=501, detail="助手后端未初始化，请检查 AgentScope 服务")


@router.get("/quota")
async def agent_quota(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    cfg = get_config()
    quotas = cfg["quotas"]
    use = _usage(user["sub"])
    return {
        "limits": quotas,
        "usage": use,
        "remaining": {
            "messagesHour": max(0, int(quotas["messages_per_hour"]) - use["messagesHour"]),
            "messagesDay": max(0, int(quotas["messages_per_day"]) - use["messagesDay"]),
            "tokensToday": max(0, int(quotas["tokens_per_day"]) - use["tokensToday"]),
        },
    }


# ------------------------------------------------------------------ 长期记忆接口


@router.get("/memories")
async def list_memories(
    q: str = Query(default=""),
    kind: str = Query(default=""),
    limit: int = Query(default=50, ge=1, le=200),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    # SQL 保持完全静态：可选条件用「参数为空则短路」表达，不拼 where 子句。
    # 拼接式写法即使当前安全，也挡不住后人插入未转义片段。
    needle = q.strip()
    kind_key = kind if kind in MEMORY_KINDS else ""
    like = f"%{needle}%" if needle else "%"
    rows = db.query(
        """
        SELECT * FROM labspace.agent_memories
         WHERE user_id = %s
           AND (%s = '' OR kind = %s)
           AND (%s = '' OR title ILIKE %s OR content ILIKE %s)
         ORDER BY pinned DESC, updated_at DESC
         LIMIT %s
        """,
        (user["sub"], kind_key, kind_key, needle, like, like, limit),
    )
    total = db.query("SELECT count(*) AS n FROM labspace.agent_memories WHERE user_id=%s", (user["sub"],))
    return {"memories": [_memory_out(r) for r in rows], "total": int(total[0]["n"]) if total else 0}


@router.post("/memories")
async def create_memory(
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    payload = await request.json()
    kind = str(payload.get("kind") or "fact")
    if kind not in MEMORY_KINDS:
        kind = "fact"
    title = str(payload.get("title") or "").strip()[:160]
    content = str(payload.get("content") or "").strip()[:4000]
    if not content:
        raise HTTPException(status_code=400, detail="记忆内容不能为空")
    if not title:
        title = content[:40]
    source_session = str(payload.get("sourceSession") or "")[:64]
    count = db.query("SELECT count(*) AS n FROM labspace.agent_memories WHERE user_id=%s", (user["sub"],))
    if count and int(count[0]["n"]) >= MAX_MEMORIES:
        raise HTTPException(status_code=400, detail=f"记忆条目已达上限（{MAX_MEMORIES}），请先清理")
    existing = db.query(
        "SELECT * FROM labspace.agent_memories WHERE user_id=%s AND kind=%s AND title=%s AND content=%s LIMIT 1",
        (user["sub"], kind, title, content),
    )
    if existing:
        db.execute(
            "UPDATE labspace.agent_memories SET updated_at=now() WHERE id=%s", (existing[0]["id"],)
        )
        return {"memory": _memory_out(existing[0]), "deduped": True}
    mid = uuid.uuid4().hex
    db.execute(
        "INSERT INTO labspace.agent_memories(id, user_id, kind, title, content, source_session, pinned) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s)",
        (mid, user["sub"], kind, title, content, source_session, bool(payload.get("pinned"))),
    )
    rows = db.query("SELECT * FROM labspace.agent_memories WHERE id=%s", (mid,))
    return {"memory": _memory_out(rows[0])}


@router.put("/memories/{memory_id}")
async def update_memory(
    memory_id: str,
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    rows = db.query(
        "SELECT * FROM labspace.agent_memories WHERE id=%s AND user_id=%s", (memory_id, user["sub"])
    )
    if not rows:
        raise HTTPException(status_code=404, detail="记忆不存在")
    payload = await request.json()
    kind = str(payload.get("kind") or rows[0]["kind"])
    if kind not in MEMORY_KINDS:
        kind = rows[0]["kind"]
    title = str(payload.get("title") or rows[0]["title"]).strip()[:160]
    content = str(payload.get("content") or rows[0]["content"]).strip()[:4000]
    pinned = bool(payload.get("pinned", rows[0]["pinned"]))
    db.execute(
        "UPDATE labspace.agent_memories SET kind=%s, title=%s, content=%s, pinned=%s, updated_at=now() "
        "WHERE id=%s AND user_id=%s",
        (kind, title, content, pinned, memory_id, user["sub"]),
    )
    fresh = db.query("SELECT * FROM labspace.agent_memories WHERE id=%s", (memory_id,))
    return {"memory": _memory_out(fresh[0])}


@router.delete("/memories/{memory_id}")
async def delete_memory(
    memory_id: str,
    user: dict[str, Any] = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    db.execute(
        "DELETE FROM labspace.agent_memories WHERE id=%s AND user_id=%s", (memory_id, user["sub"])
    )
    return {"ok": True}


# ------------------------------------------------------------------ 管理


@router.get("/admin/config")
async def admin_config(user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    cfg = get_config()
    if not cfg.get("models"):
        # 首次读取时用**平台模型**初始化，便于管理员直接勾选。
        # （此前这里问的是已下线的 pi 网关，于是管理页永远是空的。）
        platform = _platform_model()
        model_name = platform.get("model") or settings.agent_default_model
        if model_name:
            cfg["models"] = [
                {
                    "id": model_name,
                    "provider": "platform",
                    "label": model_name,
                    "context": None,
                    "enabled": True,
                }
            ]
            save_config(cfg)

    # 管理员打开页面时校对一次助手服务运行配置；限频避免服务故障时每次加载都长时间等待。
    last_attempt = 0.0
    try:
        last_attempt = float(_runtime_state.get("attempt") or 0)
    except (TypeError, ValueError):
        last_attempt = 0.0
    runtime_result: dict[str, Any] = {
        "applied": _runtime_state.get("version") == _runtime_version(cfg),
        "version": _runtime_state.get("version") or "",
    }
    if not runtime_result["applied"] and time.time() - last_attempt > 30:
        _runtime_state["attempt"] = time.time()
        runtime_result = await _sync_runtime(cfg, user_id=str(user.get("sub") or ""))

    out = _sanitize_config(cfg)
    out["runtime_applied"] = bool(runtime_result.get("applied"))
    if runtime_result.get("error"):
        out["runtime_error"] = runtime_result["error"]
    return out


@router.put("/admin/config")
async def update_admin_config(
    payload: dict[str, Any],
    user: dict[str, Any] = Depends(require_admin),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    cfg = get_config()
    if isinstance(payload.get("models"), list):
        cfg["models"] = payload["models"]
    if payload.get("default_model"):
        cfg["default_model"] = payload["default_model"]
    if isinstance(payload.get("quotas"), dict):
        quotas = dict(cfg["quotas"])
        for key in DEFAULT_QUOTAS:
            if key in payload["quotas"]:
                # 非法配额值直接忽略：保留原值比存进一个 NaN/字符串更安全。
                with contextlib.suppress(TypeError, ValueError):
                    quotas[key] = int(payload["quotas"][key])
        cfg["quotas"] = quotas
    if isinstance(payload.get("plugins"), list):
        cfg["plugins"] = payload["plugins"]
    if "system_prompt" in payload:
        cfg["system_prompt"] = str(payload["system_prompt"])[:4000]
    if "skills" in payload:
        cfg["skills"] = _normalize_skills(payload.get("skills"))
    if "mcp_servers" in payload:
        cfg["mcp_servers"] = _normalize_mcp_servers(payload.get("mcp_servers"))
    if "model_endpoints" in payload:
        cfg["model_endpoints"] = _normalize_model_endpoints(
            payload.get("model_endpoints"), cfg.get("model_endpoints")
        )
    save_config(cfg)

    # 保存后立即推送到网关；网关不可用时配置仍然保留，页面会提示未生效。
    runtime_result = await _sync_runtime(cfg, force=True, user_id=str(user.get("sub") or ""))
    out = _sanitize_config(cfg)
    out["runtime_applied"] = bool(runtime_result.get("applied"))
    if runtime_result.get("error"):
        out["runtime_error"] = runtime_result["error"]
    return out


@router.get("/admin/skills")
async def admin_skills(user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    """技能列表：来自 AgentScope 自己的技能记录（GET /skill）。

    技能目录、启用/安装都在「能力中心」里操作，门户这里只做只读展示。
    """
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{settings.agentscope_base}/skill", headers={"X-User-ID": user["sub"]}
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail=f"助手服务不可达：{type(exc).__name__}") from exc
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"技能读取失败（{resp.status_code}）")
    return resp.json()


@router.get("/admin/usage")
async def admin_usage(user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    rows = db.query(
        "SELECT user_id, count(*) AS messages, "
        "COALESCE(sum(COALESCE((meta->'usage'->>'input')::bigint,0)),0) AS tokens_in, "
        "COALESCE(sum(COALESCE((meta->'usage'->>'output')::bigint,0)),0) AS tokens_out "
        "FROM labspace.agent_messages WHERE created_at > now() - interval '30 days' "
        "GROUP BY user_id ORDER BY messages DESC LIMIT 100"
    )
    sessions = db.query("SELECT user_id, count(*) AS n FROM labspace.agent_sessions GROUP BY user_id")
    sess_map = {r["user_id"]: int(r["n"]) for r in sessions}
    users = [
        {
            "user_id": r["user_id"],
            "messages": int(r["messages"]),
            "tokens_in": int(r["tokens_in"]),
            "tokens_out": int(r["tokens_out"]),
            "sessions": sess_map.get(r["user_id"], 0),
        }
        for r in rows
    ]
    return {
        "users": users,
        "totals": {
            "messages": sum(u["messages"] for u in users),
            "tokens_in": sum(u["tokens_in"] for u in users),
            "tokens_out": sum(u["tokens_out"] for u in users),
            "sessions": sum(sess_map.values()),
        },
    }


# ---------------------------------------------------------------- AgentScope
# 与上面 pi 网关的接口**并存**：路径前缀相同但挂在 /agentscope 下，
# 灰度期两套都能用，切换只是前端选择哪一组 URL 的事。


@router.get("/agentscope/agents")
async def agentscope_agents(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    """当前用户在 AgentScope 里的助手列表（按 X-User-ID 隔离）。"""
    from . import agentscope_adapter as as_adapter

    try:
        return await as_adapter.list_agents(user["sub"])
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/agentscope/sessions")
async def agentscope_sessions(
    agent_id: str = Query(...),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    from . import agentscope_adapter as as_adapter

    try:
        return await as_adapter.list_sessions(agent_id, user["sub"])
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/agentscope/sessions")
async def agentscope_create_session(
    payload: dict[str, Any],
    user: dict[str, Any] = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    from . import agentscope_adapter as as_adapter

    agent_id = str(payload.get("agentId") or "").strip()
    if not agent_id:
        raise HTTPException(status_code=400, detail="缺少 agentId")
    try:
        return await as_adapter.create_session(agent_id, user["sub"], str(payload.get("name") or ""))
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/agentscope/sessions/{session_id}/messages")
async def agentscope_send(
    session_id: str,
    payload: dict[str, Any],
    user: dict[str, Any] = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    """投递一条消息。真正的增量从下面的 stream 推送。"""
    from . import agentscope_adapter as as_adapter

    agent_id = str(payload.get("agentId") or "").strip()
    text = str(payload.get("text") or "").strip()
    if not agent_id or not text:
        raise HTTPException(status_code=400, detail="缺少 agentId 或消息内容")
    if len(text) > 8000:
        raise HTTPException(status_code=413, detail="单条消息过长（上限 8000 字符）")
    try:
        return await as_adapter.chat(session_id, agent_id, user["sub"], text)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/agentscope/sessions/{session_id}/stream")
async def agentscope_stream(
    session_id: str,
    agent_id: str = Query(...),
    user: dict[str, Any] = Depends(require_user),
) -> StreamingResponse:
    """把 AgentScope 的事件翻译成前端认的 ready/delta/tool/done/error。"""
    from . import agentscope_adapter as as_adapter

    async def gen() -> AsyncIterator[str]:
        async for frame in as_adapter.stream(session_id, agent_id, user["sub"]):
            yield frame

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )
