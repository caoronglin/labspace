"""AgentScope ↔ lab MCP server 之间的身份通道。

为什么需要这一层
----------------
门户把用户身份交给 AgentScope 的方式只有一个头：``X-User-ID``（nginx 的
``auth_request`` 校验过会话后注入，客户端自带的会被覆盖）。但门户后端的
**用户级接口**（工作台 / 绘图）只认**用户会话**，服务令牌只能进公共只读接口。
所以从「一个用户 id」到「门户认得的调用者身份」之间必须有一段可核验的转换，
否则就变成「模型说自己是谁就信谁」。

本模块提供两件事：

* **通道密钥** ``CHANNEL_TOKEN``：进程内随机生成，只有本进程知道。MCP server
  只接受带它的请求 —— 它证明「这个请求确实来自 AgentScope，而不是外部」。
* **用户断言**：AgentScope 对 ``(user_id, 时间戳, nonce)`` 做 HMAC-SHA256 签名，
  作为请求头传下去；MCP server 验签 + 时间窗后才采信这个 user_id。
  user_id 不是模型给的，是 nginx 校验后注入、AgentScope 原样签下来的。

另外提供 ``mint_session_jwt``：用门户会话密钥为**已核验的** user id 签一份
最短有效期的会话 JWT，让门户把这次调用当成「该用户本人」——门户仍按 ``sub``
过滤数据，越权取不到别人的东西；会话被吊销时门户会直接拒绝。

关于重放
--------
断言是**短期、绑定用户 id 的签名凭证**（默认 120 秒），同一轮对话里的多次
工具调用会复用同一条断言，所以**不做一次性 nonce 校验**。真正的门是另外两
道：进程内通道密钥（外部拿不到）与回环绑定（外部连不上这个端口）——断言
的 HMAC 保证「只有本进程能签出某个 user_id」。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any

#: 进程内共享的通道密钥（MCP server 只绑回环，且只接受带它的请求）。
CHANNEL_TOKEN: str = secrets.token_urlsafe(32)

#: 请求头名：通道密钥 / 用户断言。
CHANNEL_HEADER = "X-Lab-Mcp-Token"
ASSERTION_HEADER = "X-Lab-User-Assertion"

#: 断言的时间窗（秒）：签发后这段时间内有效，过期即拒。
ASSERTION_WINDOW = 120.0

#: 门户会话 JWT 的有效期（秒）：够一次工具调用，不够长期滥用。
SESSION_TTL = 300.0


def _b64(raw: bytes) -> str:
    """base64url 编码（无 padding），与 JWT 规范一致。"""
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _sign(secret: str, payload: str) -> str:
    return hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def mint_user_assertion(user_id: str) -> str:
    """为 ``user_id`` 签发一条断言：``user_id.timestamp.nonce.hmac``。

    Args:
        user_id: 已由 nginx 校验过的用户 id。

    Returns:
        可放进 ``X-Lab-User-Assertion`` 请求头的断言串。
    """
    user = (user_id or "").strip()
    if not user:
        raise ValueError("user_id 不能为空")
    timestamp = str(int(time.time()))
    nonce = secrets.token_urlsafe(12)
    signature = _sign(CHANNEL_TOKEN, f"{user}:{timestamp}:{nonce}")
    return f"{user}.{timestamp}.{nonce}.{signature}"


def verify_user_assertion(assertion: str, *, now: float | None = None) -> str | None:
    """校验断言并返回其中的 user_id。

    签名不对、格式不对、超出时间窗（``ASSERTION_WINDOW``）一律返回 ``None``，
    调用方据此拒绝这次调用。

    Args:
        assertion: 请求头里的断言串。
        now: 当前时间（默认取系统时间，便于测试注入）。

    Returns:
        可信的 user_id；不可信时为 ``None``。
    """
    if not assertion:
        return None
    parts = assertion.split(".")
    if len(parts) != 4:
        return None
    user, timestamp, nonce, signature = parts
    if not user or not nonce:
        return None
    try:
        issued = float(timestamp)
    except ValueError:
        return None
    moment = time.time() if now is None else now
    if abs(moment - issued) > ASSERTION_WINDOW:
        return None
    expected = _sign(CHANNEL_TOKEN, f"{user}:{timestamp}:{nonce}")
    if not hmac.compare_digest(expected, signature):
        return None
    return user


def mint_session_jwt(user_id: str, secret: str, *, ttl: float = SESSION_TTL) -> str:
    """为 ``user_id`` 签一份门户会话 JWT（HS256）。

    与门户 ``backend/app/security.py::issue_session`` 同算法同结构，门户的
    ``read_session`` 能直接解出来。**只放用户 id，不放角色**：助手代劳时不应
    携带任何角色权限（角色受限的服务本来也不该由助手代劳），门户按 ``sub``
    过滤数据，会话被吊销时门户照常拒绝。

    Args:
        user_id: 已核验的用户 id。
        secret: 门户会话密钥（``LABSPACE_SESSION_SECRET``）。
        ttl: 有效期（秒）。

    Returns:
        可放进 ``Authorization: Bearer`` 的 JWT。

    Raises:
        ValueError: 缺少 user_id 或 secret。
    """
    user = (user_id or "").strip()
    if not user:
        raise ValueError("user_id 不能为空")
    if not secret:
        raise ValueError("缺少门户会话密钥，无法签发用户会话")
    issued = int(time.time())
    header: dict[str, Any] = {"alg": "HS256", "typ": "JWT"}
    payload: dict[str, Any] = {
        "sub": user,
        "email": "",
        "name": "",
        "roles": [],
        "iat": issued,
        "exp": issued + int(ttl),
    }
    encoded_header = _b64(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    encoded_payload = _b64(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{encoded_header}.{encoded_payload}"
    signature = _b64(hmac.new(secret.encode("utf-8"), signing_input.encode("utf-8"), hashlib.sha256).digest())
    return f"{signing_input}.{signature}"
