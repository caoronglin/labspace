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
import hashlib
import json
import re
import time
import uuid
from typing import Any, AsyncIterator

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from psycopg2.extras import Json

from . import db
from .config import settings
from .security import require_admin, require_csrf, require_user

router = APIRouter(prefix="/api/agent", tags=["agent"])

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
        for m in raw.get("models") if isinstance(raw.get("models"), list) else []:
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


async def _sync_runtime(cfg: dict[str, Any] | None = None, force: bool = False) -> dict[str, Any]:
    cfg = cfg or get_config()
    payload = _runtime_payload(cfg)
    version = _runtime_version(cfg)
    payload["version"] = version
    if not force and _runtime_state.get("version") == version:
        return {"applied": True, "version": version, "unchanged": True}
    async with _runtime_lock:
        try:
            resp = await gw("PUT", "/admin/runtime", json=payload)
        except HTTPException as exc:
            return {"applied": False, "version": version, "error": str(exc.detail)}
        if resp.status_code != 200:
            return {
                "applied": False,
                "version": version,
                "error": resp.text[:300] or f"网关返回 {resp.status_code}",
            }
    _runtime_state["version"] = version
    _model_cache["at"] = 0.0
    return {"applied": True, "version": version}


def _headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if settings.agent_token:
        headers["X-Agent-Token"] = settings.agent_token
    return headers


async def gw(method: str, path: str, **kwargs: Any) -> httpx.Response:
    url = f"{settings.agent_gateway.rstrip('/')}{path}"
    try:
        async with httpx.AsyncClient(timeout=GW_TIMEOUT) as client:
            return await client.request(method, url, headers=_headers(), **kwargs)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail=f"Agent 网关不可用：{type(exc).__name__}") from exc


_model_cache: dict[str, Any] = {"at": 0.0, "models": []}


async def gateway_models() -> list[dict[str, Any]]:
    if time.time() - _model_cache["at"] < 60 and _model_cache["models"]:
        return _model_cache["models"]
    resp = await gw("GET", "/models")
    if resp.status_code != 200:
        return _model_cache["models"]
    data = resp.json()
    models = data.get("models") or []
    _model_cache.update({"at": time.time(), "models": models})
    return models


def _public_models() -> list[dict[str, Any]]:
    cfg = get_config()
    allowed = {m.get("id"): m for m in (cfg.get("models") or []) if m.get("id")}
    gw_meta = {m.get("id"): m for m in (_model_cache.get("models") or []) if m.get("id")}
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
        for m in _model_cache.get("models") or []:
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
        for m in _model_cache.get("models") or []:
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
    return {
        "messagesHour": int(hour[0]["n"]) if hour else 0,
        "messagesDay": int(day[0]["n"]) if day else 0,
        "tokensToday": int(tokens[0]["tin"] or 0) + int(tokens[0]["tout"] or 0) if tokens else 0,
        "sessionsActive": int(sessions[0]["n"]) if sessions else 0,
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


def _session_out(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row.get("title") or "新会话",
        "model": row.get("model") or "",
        "status": row.get("status") or "idle",
        "message_count": int(row.get("message_count") or 0),
        "tokens_in": int(row.get("tokens_in") or 0),
        "tokens_out": int(row.get("tokens_out") or 0),
        "created_at": row.get("created_at").isoformat() if row.get("created_at") else None,
        "updated_at": row.get("updated_at").isoformat() if row.get("updated_at") else None,
    }


def _message_out(row: dict[str, Any]) -> dict[str, Any]:
    meta = row.get("meta") or {}
    return {
        "id": row["id"],
        "role": row.get("role"),
        "content": row.get("content") or "",
        "meta": meta if isinstance(meta, dict) else {},
        "created_at": row.get("created_at").isoformat() if row.get("created_at") else None,
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


async def _ensure_gateway_session(session_id: str, row: dict[str, Any], request: Request) -> None:
    """网关重启后内存会话会丢失，按库中记录重建，避免历史会话无法继续对话。"""
    cfg = get_config()
    lab_portal = next(
        (p for p in (cfg.get("plugins") or []) if isinstance(p, dict) and p.get("id") == "lab-portal"),
        None,
    )
    resp = await gw(
        "POST",
        "/sessions",
        json={
            "sessionId": session_id,
            "userId": row["user_id"],
            "model": row.get("model") or cfg.get("default_model") or settings.agent_default_model,
            "userToken": getattr(request.state, "session_token", "") or "",
            "systemPrompt": _system_prompt(row["user_id"], cfg),
            "noTools": bool(lab_portal and not lab_portal.get("enabled", True)),
        },
    )
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"恢复 Agent 会话失败：{resp.text[:200]}")


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


# ------------------------------------------------------------------ 路由


@router.get("/status")
async def agent_status(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    cfg = get_config()
    available = False
    reason = ""
    try:
        resp = await gw("GET", "/health")
        available = resp.status_code == 200 and bool(resp.json().get("ok"))
        if not available:
            reason = "网关返回异常"
    except HTTPException as exc:
        reason = str(exc.detail)
    skills = [
        {"name": s.get("name") or "", "description": s.get("description") or ""}
        for s in cfg.get("skills") or []
        if isinstance(s, dict) and s.get("enabled", True) and s.get("name")
    ]
    return {
        "available": available,
        "reason": reason,
        "gateway": settings.agent_gateway,
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
    await gateway_models()
    return {"models": _public_models()}


@router.get("/sessions")
async def list_sessions(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
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
    cfg = get_config()
    chosen = model or cfg.get("default_model") or settings.agent_default_model
    # 白名单为空 = 「自动放行网关提供的模型」；管理员显式配置过才做限制。
    if (cfg.get("models") or []) and chosen not in _allowed_model_ids():
        raise HTTPException(status_code=400, detail="所选模型未在管理员白名单中")
    sid = uuid.uuid4().hex
    user_token = getattr(request.state, "session_token", "") or ""
    lab_portal = next(
        (p for p in (cfg.get("plugins") or []) if isinstance(p, dict) and p.get("id") == "lab-portal"),
        None,
    )
    resp = await gw(
        "POST",
        "/sessions",
        json={
            "sessionId": sid,
            "userId": user["sub"],
            "model": chosen,
            "userToken": user_token,
            "systemPrompt": _system_prompt(user["sub"], cfg),
            "noTools": bool(lab_portal and not lab_portal.get("enabled", True)),
        },
    )
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"启动 Agent 失败：{resp.text[:200]}")
    db.execute(
        "INSERT INTO labspace.agent_sessions(id, user_id, title, model, status, message_count, tokens_in, tokens_out, created_at, updated_at) "
        "VALUES (%s, %s, %s, %s, 'idle', 0, 0, 0, now(), now())",
        (sid, user["sub"], title or "新会话", chosen),
    )
    rows = db.query("SELECT * FROM labspace.agent_sessions WHERE id=%s", (sid,))
    return {"session": _session_out(rows[0])}


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
    try:
        await gw("DELETE", f"/sessions/{session_id}")
    except HTTPException:
        pass
    db.execute("DELETE FROM labspace.agent_messages WHERE session_id=%s", (session_id,))
    db.execute("DELETE FROM labspace.agent_sessions WHERE id=%s", (session_id,))
    return {"ok": True}


@router.get("/sessions/{session_id}/messages")
async def list_messages(session_id: str, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
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
    row = _own_session(session_id, user["sub"])
    text = (content or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="消息内容不能为空")
    _check_quota(user["sub"])
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
    await _ensure_gateway_session(session_id, row, request)
    resp = await gw("POST", f"/sessions/{session_id}/messages", json={"text": text})
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Agent 网关拒绝请求：{resp.text[:200]}")
    db.execute("UPDATE labspace.agent_sessions SET status='running', updated_at=now() WHERE id=%s", (session_id,))
    return {
        "accepted": True,
        "regenerate": regenerate,
        "message": {"id": mid, "role": "user", "content": text, "meta": {}, "created_at": None} if mid else None,
    }


@router.post("/sessions/{session_id}/abort")
async def abort_session(
    session_id: str,
    user: dict[str, Any] = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    _own_session(session_id, user["sub"])
    try:
        await gw("POST", f"/sessions/{session_id}/abort")
    except HTTPException:
        pass
    db.execute("UPDATE labspace.agent_sessions SET status='idle', updated_at=now() WHERE id=%s", (session_id,))
    return {"ok": True}


@router.get("/sessions/{session_id}/stream")
async def stream_session(
    request: Request, session_id: str, user: dict[str, Any] = Depends(require_user)
) -> StreamingResponse:
    row = _own_session(session_id, user["sub"])
    await _ensure_gateway_session(session_id, row, request)
    url = f"{settings.agent_gateway.rstrip('/')}/sessions/{session_id}/stream"

    # 并发流保护：同一用户同时最多开 MAX_CONCURRENT_STREAMS 条 SSE 流。
    # 否则可以开大量长连接（每条最长 STREAM_TIMEOUT）耗尽网关与后端资源。
    _acquire_stream_slot(user["sub"])

    async def gen() -> AsyncIterator[str]:
        assistant_buf: list[str] = []
        usage = {"input": 0, "output": 0}
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(STREAM_TIMEOUT, connect=10)) as client:
                async with client.stream("GET", url, headers=_headers()) as resp:
                    if resp.status_code != 200:
                        yield 'event: error\ndata: {"message":"网关未返回流式响应"}\n\n'
                        return
                    event_name = ""
                    finished = False
                    got_assistant = False
                    assistant_mid: str | None = None
                    usage_bumped = False
                    buf = ""
                    async for raw in resp.aiter_text():
                        if finished:
                            break
                        # SSE 文本可能被分片切断，必须跨 chunk 保留半行
                        buf += raw
                        lines = buf.split("\n")
                        buf = lines.pop() or ""
                        for line in lines:
                            line = line.rstrip("\r")
                            if not line:
                                continue
                            if line.startswith("event:"):
                                event_name = line[6:].strip()
                                continue
                            if not line.startswith("data:"):
                                continue
                            payload = line[5:].strip()
                            if event_name != "delta" and event_name != "tool" and event_name != "assistant_message":
                                if event_name in ("ready", "settled", "exit", "log", "thinking", "error"):
                                    if event_name == "error":
                                        yield f'event: error\ndata: {payload}\n\n'
                                    elif event_name == "settled" and got_assistant:
                                        yield 'event: done\ndata: {"message_id":"","usage":{}}\n\n'
                                # 只有拿到助手正式回复后才认为本轮结束；
                                # pi 启动阶段也会发一次 settled，提前断流会丢掉本轮增量
                                if event_name in ("settled", "exit") and got_assistant:
                                    finished = True
                                    break
                                continue
                            try:
                                data = json.loads(payload)
                            except json.JSONDecodeError:
                                continue
                            if event_name == "delta":
                                text = data.get("text") or ""
                                assistant_buf.append(text)
                                yield f'event: delta\ndata: {json.dumps({"text": text}, ensure_ascii=False)}\n\n'
                            elif event_name == "tool":
                                yield (
                                    "event: tool\ndata: "
                                    + json.dumps(
                                        {
                                            "name": data.get("name") or "",
                                            "phase": data.get("phase") or "",
                                            "summary": data.get("name") or "",
                                            "isError": bool(data.get("isError")),
                                        },
                                        ensure_ascii=False,
                                    )
                                    + "\n\n"
                                )
                            elif event_name == "assistant_message":
                                usage = {
                                    "input": int(data.get("usage", {}).get("input") or 0),
                                    "output": int(data.get("usage", {}).get("output") or 0),
                                }
                                content = data.get("content") or ""
                                # 部分模型在工具链场景只发 thinking + toolCall、不发正文块，
                                # 此时用本轮已收到的增量文本兜底，避免落库空消息。
                                if not content.strip() and assistant_buf:
                                    content = "".join(assistant_buf).strip()
                                if not content.strip():
                                    # 纯工具调用轮次：模型还没给正文。
                                    # 这时既不落库也不发 done，否则会话记录会出现空助手消息，
                                    # 且前端会提前结束本轮、丢掉网关自动补问后的真实答复。
                                    continue
                                got_assistant = True
                                if assistant_mid is None:
                                    assistant_mid = _insert_message(
                                        session_id, user["sub"], "assistant", content, {"usage": usage}
                                    )
                                else:
                                    _update_message(assistant_mid, content, {"usage": usage})
                                if not usage_bumped:
                                    _bump_session(session_id, usage["input"], usage["output"])
                                    usage_bumped = True
                                yield (
                                    "event: done\ndata: "
                                    + json.dumps(
                                        {"message_id": assistant_mid, "usage": usage}, ensure_ascii=False
                                    )
                                    + "\n\n"
                                )
                if not got_assistant:
                    # 网关流已结束但本轮没有正文（例如模型只报了 error）：
                    # 补一个空 id 的 done，让前端正常收尾，不留下悬挂的加载状态。
                    yield 'event: done\ndata: {"message_id":"","usage":{}}\n\n'
        except httpx.HTTPError as exc:
            yield f'event: error\ndata: {json.dumps({"message": f"流式中断：{type(exc).__name__}"}, ensure_ascii=False)}\n\n'
        finally:
            db.execute("UPDATE labspace.agent_sessions SET status='idle', updated_at=now() WHERE id=%s", (session_id,))
            _release_stream_slot(user["sub"])

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


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
    clauses = ["user_id=%s"]
    params: list[Any] = [user["sub"]]
    if kind in MEMORY_KINDS:
        clauses.append("kind=%s")
        params.append(kind)
    needle = q.strip()
    if needle:
        clauses.append("(title ILIKE %s OR content ILIKE %s)")
        params.extend([f"%{needle}%", f"%{needle}%"])
    params.append(limit)
    rows = db.query(
        "SELECT * FROM labspace.agent_memories WHERE "
        + " AND ".join(clauses)
        + " ORDER BY pinned DESC, updated_at DESC LIMIT %s",
        tuple(params),
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
        # 首次读取时用网关模型列表初始化，便于管理员直接勾选
        gw_models = await gateway_models()
        cfg["models"] = [
            {
                "id": m["id"],
                "provider": m.get("provider", ""),
                "label": m.get("label") or m["id"],
                "context": m.get("context"),
                "enabled": True,
            }
            for m in gw_models
        ]
        save_config(cfg)

    # 管理员打开页面时校对一次网关运行配置；限频避免网关故障时每次加载都长时间等待。
    runtime_result: dict[str, Any] = {
        "applied": _runtime_state.get("version") == _runtime_version(cfg),
        "version": _runtime_state.get("version") or "",
    }
    if not runtime_result["applied"] and time.time() - float(_runtime_state.get("attempt") or 0) > 30:
        _runtime_state["attempt"] = time.time()
        runtime_result = await _sync_runtime(cfg)

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
                try:
                    quotas[key] = int(payload["quotas"][key])
                except (TypeError, ValueError):
                    pass
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
    runtime_result = await _sync_runtime(cfg, force=True)
    out = _sanitize_config(cfg)
    out["runtime_applied"] = bool(runtime_result.get("applied"))
    if runtime_result.get("error"):
        out["runtime_error"] = runtime_result["error"]
    return out


@router.get("/admin/skills")
async def admin_skills(user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    """扫描网关宿主机上的技能目录，供管理员挑选启用。"""
    try:
        resp = await gw("GET", "/admin/skills")
    except HTTPException as exc:
        raise HTTPException(status_code=503, detail=str(exc.detail)) from exc
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"技能扫描失败：{resp.text[:200]}")
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
