"""Casdoor OIDC 客户端（Discovery / authorize / token / userinfo / logout）。

只用 httpx + PyJWT 手写，便于严格控制 state/nonce 与 id_token 校验。
"""
from __future__ import annotations

import os
import secrets
import time
from typing import Any

import httpx
import jwt
from fastapi import HTTPException

from .config import settings

_state_store: dict[str, dict[str, Any]] = {}
STATE_TTL = 600


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


def new_state(redirect_uri: str = "", issuer: str = "", back: str = "") -> str:
    """创建 state，并绑定本次流程使用的 redirect_uri 与 Casdoor issuer。

    回调时直接复用这里的 redirect_uri / issuer，保证与授权请求完全一致
    （IP 访问与 Tailscale 访问的 issuer 不同，不能在回调端重新推断）。
    """
    state = secrets.token_urlsafe(24)
    nonce = secrets.token_urlsafe(16)
    _state_store[state] = {
        "nonce": nonce,
        "ts": time.time(),
        "redirect_uri": redirect_uri,
        "issuer": issuer,
        "back": back,
    }
    # 清理过期 state
    now = time.time()
    for k in [k for k, v in _state_store.items() if now - v["ts"] > STATE_TTL]:
        _state_store.pop(k, None)
    return state


def pop_state(state: str) -> dict[str, Any] | None:
    """取出并作废 state，返回 {nonce, redirect_uri, issuer, back}。"""
    entry = _state_store.pop(state, None)
    if not entry or time.time() - entry["ts"] > STATE_TTL:
        return None
    return entry


def _discovery(issuer: str = "") -> dict[str, Any]:
    base = (issuer or settings.issuer).rstrip("/")
    url = f"{base}/.well-known/openid-configuration"
    try:
        resp = httpx.get(url, timeout=10)
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"OIDC Discovery 失败: {type(exc).__name__}") from exc


def authorization_url(
    state: str,
    redirect_uri: str | None = None,
    issuer: str = "",
    prompt_consent: bool | None = None,
) -> str:
    base = (issuer or settings.issuer).rstrip("/")
    disc = _discovery(base)
    params = {
        "client_id": settings.client_id,
        "redirect_uri": redirect_uri or settings.redirect_uri,
        "response_type": "code",
        "scope": settings.scopes,
        "state": state,
        "nonce": _state_store[state]["nonce"],
    }
    # Casdoor 的 prompt=consent 会**每次**都弹同意页：已登录用户回到门户也会被
    # 拦一次，同意页一旦失败又跳回 /login，形成"登录 → 同意 → 失败 → 再登录"的
    # 反复跳转。默认不再强制，内部网用单点登录即可。
    if prompt_consent is None:
        prompt_consent = _bool_env("LABSPACE_OIDC_PROMPT_CONSENT", False)
    if prompt_consent:
        params["prompt"] = "consent"
    endpoint = disc.get("authorization_endpoint") or f"{base}/login/oauth/authorize"
    from urllib.parse import urlencode

    return f"{endpoint}?{urlencode(params)}"


async def exchange_code(code: str, redirect_uri: str | None = None, issuer: str = "") -> dict[str, Any]:
    base = (issuer or settings.issuer).rstrip("/")
    disc = _discovery(base)
    token_ep = disc.get("token_endpoint") or f"{base}/api/login/oauth/access_token"
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "client_id": settings.client_id,
        "client_secret": settings.client_secret,
        "redirect_uri": redirect_uri or settings.redirect_uri,
    }
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(token_ep, data=data, headers={"Accept": "application/json"})
            resp.raise_for_status()
            return resp.json()
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"令牌交换失败: {type(exc).__name__}") from exc


async def fetch_userinfo(access_token: str, id_token: str | None, issuer: str = "") -> dict[str, Any]:
    """读取 userinfo。

    安全约定：这里**绝不**返回未验签的 id_token claims。
    userinfo 拿不到时返回空字典，由调用方只使用「已验签」的 id_token claims 建立身份；
    既没有 userinfo 又没有 id_token 时直接失败（502），不允许匿名登录。
    """
    base = (issuer or settings.issuer).rstrip("/")
    disc = _discovery(base)
    userinfo_ep = disc.get("userinfo_endpoint") or f"{base}/api/userinfo"
    headers = {"Authorization": f"Bearer {access_token}"}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(userinfo_ep, headers=headers)
            if resp.status_code != 200:
                if id_token:
                    return {}
                raise HTTPException(status_code=502, detail="获取用户信息失败: 上游返回异常状态")
            resp.raise_for_status()
            data = resp.json()
            return data if isinstance(data, dict) else {}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        if id_token:
            return {}
        raise HTTPException(status_code=502, detail=f"获取用户信息失败: {type(exc).__name__}") from exc


def verify_id_token(id_token: str, nonce: str | None, issuer_base: str = "") -> dict[str, Any]:
    """校验 id_token：签名（JWKS）、issuer、audience、exp、nonce。"""
    base = (issuer_base or settings.issuer).rstrip("/")
    disc = _discovery(base)
    jwks_uri = disc.get("jwks_uri")
    # 以 Casdoor 自己声明的 issuer 为准（按访问主机回显，可能与内置默认值不同）
    issuer = disc.get("issuer") or base
    if not jwks_uri:
        # 拿不到 JWKS 就无法验签：必须失败关闭，绝不能退化成「不验签的 claims」
        raise HTTPException(status_code=401, detail="身份提供方未发布 jwks_uri，拒绝未验签的身份")
    try:
        jwk_client = jwt.PyJWKClient(jwks_uri)
        signing_key = jwk_client.get_signing_key_from_jwt(id_token)
        claims = jwt.decode(
            id_token,
            signing_key.key,
            # 只接受非对称算法：加入 HS256 会带来「用公钥当 HMAC 密钥」的算法混淆风险
            algorithms=["RS256", "ES256"],
            audience=settings.client_id,
            issuer=issuer,
            options={"verify_exp": True},
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=401, detail=f"id_token 校验失败: {type(exc).__name__}") from exc
    if nonce and claims.get("nonce") and claims["nonce"] != nonce:
        raise HTTPException(status_code=401, detail="nonce 不匹配")
    return claims


def normalize_user(claims: dict[str, Any]) -> dict[str, Any]:
    """把 Casdoor claims 归一化为 LabSpace 用户对象。

    Casdoor 的角色可能出现在 groups（逗号分隔字符串）或 roles（数组）。
    """
    roles: list[str] = []
    groups = claims.get("groups") or claims.get("roles") or claims.get("role") or []
    if isinstance(groups, str):
        groups = [g.strip() for g in groups.split(",") if g.strip()]
    for g in groups:
        if g and g not in roles:
            roles.append(str(g))
    email = (claims.get("email") or claims.get("preferred_username") or "").strip().lower()
    return {
        "id": str(claims.get("sub") or claims.get("preferred_username") or email),
        "email": email,
        "name": claims.get("name") or claims.get("preferred_username") or email,
        "avatar": claims.get("avatar") or claims.get("picture") or "",
        "roles": roles,
    }


def logout_url(issuer: str = "") -> str:
    """Casdoor 的登出端点（id_token_hint 可选）。"""
    return f"{(issuer or settings.issuer).rstrip('/')}/api/logout"
