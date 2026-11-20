"""会话签发/校验、CSRF 与权限判定。"""
from __future__ import annotations

import secrets
import time
from typing import Any

import jwt
from fastapi import Cookie, Header, HTTPException, Request

from . import db
from .config import settings


def _secret() -> str:
    if not settings.session_secret:
        raise RuntimeError("LABSPACE_SESSION_SECRET 未设置")
    return settings.session_secret


def issue_session(user: dict[str, Any], *, pwd_reset: bool = False) -> str:
    """签发门户会话。

    ``pwd_reset`` 写进 JWT 而不是靠每请求查库：强制改密要在 Python、Go 与 nginx
    三处得出同一个结论，唯一能保证一致的就是把这个事实放进令牌本身。
    """
    now = int(time.time())
    payload = {
        "sub": user["id"],
        "email": user.get("email", ""),
        "name": user.get("name", ""),
        "roles": user.get("roles", []),
        "iat": now,
        "exp": now + settings.session_hours * 3600,
    }
    if pwd_reset:
        payload["pwd_reset"] = True
    return jwt.encode(payload, _secret(), algorithm="HS256")


def session_pwd_reset(claims: dict[str, Any] | None) -> bool:
    """会话是否标记了「必须改密」。"""
    if not claims:
        return False
    return bool(claims.get("pwd_reset"))


def read_session(token: str | None) -> dict[str, Any] | None:
    if not token:
        return None
    try:
        return jwt.decode(token, _secret(), algorithms=["HS256"])
    except jwt.PyJWTError:
        return None


def session_live(claims: dict[str, Any] | None) -> bool:
    """吊销检查：早于 revoked_at 签发的会话一律作废。

    会话是无状态 JWT，签名与 exp 之外没有任何失效途径；没有这一步，禁用或
    删除账号在最长 ``LABSPACE_SESSION_HOURS`` 小时内都拦不住已经在用的 Cookie。
    """
    if not claims:
        return False
    subject = str(claims.get("sub") or "")
    if not subject or subject == "service":
        return True
    revoked_at = db.revoked_before(subject)
    if revoked_at is None:
        return True
    issued = int(claims.get("iat") or 0)
    return issued >= revoked_at


def set_session_cookies(response, token: str) -> None:
    max_age = settings.session_hours * 3600
    response.set_cookie(
        settings.cookie_name,
        token,
        max_age=max_age,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    # 双提交 CSRF 令牌：非 HttpOnly，供前端读取后放进 X-CSRF-Token
    response.set_cookie(
        settings.csrf_cookie,
        secrets.token_urlsafe(24),
        max_age=max_age,
        httponly=False,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


def clear_session_cookies(response) -> None:
    response.delete_cookie(settings.cookie_name, path="/")
    response.delete_cookie(settings.csrf_cookie, path="/")


def _bearer_token(authorization: str | None) -> str | None:
    """提取 `Authorization: Bearer <jwt>` 中的令牌。

    内部服务（如 pi Agent 网关）以“用户自己的会话令牌”作为 Bearer 调用后端，
    从而与浏览器会话具有完全相同的权限边界。
    """
    if not authorization:
        return None
    if not authorization.lower().startswith("bearer "):
        return None
    token = authorization[7:].strip()
    return token or None


async def current_user(
    request: Request,
    labspace_session: str | None = Cookie(default=None, alias="labspace_session"),
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> dict[str, Any] | None:
    token = labspace_session or _bearer_token(authorization)
    user = read_session(token)
    if user and not session_live(user):
        user = None
    if user:
        request.state.user = user
        request.state.session_token = token
    return user


async def require_user(
    request: Request,
    labspace_session: str | None = Cookie(default=None, alias="labspace_session"),
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> dict[str, Any]:
    """依赖注入：未登录直接 401。"""
    token = labspace_session or _bearer_token(authorization)
    user = read_session(token)
    if not user:
        raise HTTPException(status_code=401, detail="未登录或会话已过期")
    _require_live(user)
    request.state.user = user
    request.state.session_token = token
    return user


def service_token_valid(request: Request) -> bool:
    """校验内部服务令牌 `X-Lab-Service-Token`（常量时间比较）。

    服务令牌只代表「门户自身的可信内部调用」，权限等同于只读公共数据，
    详见 docs/CONTRACT_WORKBENCH_AGENT.md §3。
    """
    expected = (settings.service_token or "").strip()
    got = (request.headers.get("x-lab-service-token") or "").strip()
    if not expected or not got:
        return False
    return secrets.compare_digest(expected, got)


def _require_live(user: dict[str, Any]) -> None:
    if not session_live(user):
        raise HTTPException(status_code=401, detail="会话已被吊销，请重新登录")


async def require_user_or_service(
    request: Request,
    labspace_session: str | None = Cookie(default=None, alias="labspace_session"),
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> dict[str, Any]:
    """依赖注入：接受「用户会话（Cookie / Bearer）」或「内部服务令牌」。

    服务令牌对应的身份标记为 `service`，仅用于公共只读数据接口。
    """
    token = labspace_session or _bearer_token(authorization)
    user = read_session(token)
    if user:
        _require_live(user)
        request.state.user = user
        request.state.session_token = token
        return user
    if service_token_valid(request):
        svc = {
            "sub": "service",
            "name": "门户内部服务",
            "email": "",
            "roles": ["service"],
            "is_service": True,
        }
        request.state.user = svc
        request.state.session_token = ""
        return svc
    raise HTTPException(status_code=401, detail="未登录或会话已过期")


def has_role(user: dict[str, Any] | None, roles: list[str]) -> bool:
    if not user:
        return False
    user_roles = {str(r).lower() for r in (user.get("roles") or [])}
    return any(r.lower() in user_roles for r in roles)


async def require_admin(
    request: Request,
    labspace_session: str | None = Cookie(default=None, alias="labspace_session"),
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> dict[str, Any]:
    """依赖注入：需登录且具备 lab-admin 角色。

    同时支持 Cookie 会话与 Authorization: Bearer（内部服务用同一用户令牌调用）。
    """
    token = labspace_session or _bearer_token(authorization)
    user = read_session(token)
    if not user:
        raise HTTPException(status_code=401, detail="未登录或会话已过期")
    _require_live(user)
    if not has_role(user, settings.admin_roles):
        raise HTTPException(status_code=403, detail="需要 lab-admin 权限")
    request.state.user = user
    request.state.session_token = token
    return user


async def require_superadmin(
    request: Request,
    labspace_session: str | None = Cookie(default=None, alias="labspace_session"),
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> dict[str, Any]:
    """依赖注入：需具备 **系统管理员**（lab-superadmin）角色。

    与平台管理员（lab-admin）的分工：
      * 平台管理员：账号、用户组、公告、Agent 配置、备份、共享目录等**业务**管理；
      * 系统管理员：在业务之上，额外能执行**平台级**操作——重启/触发运维任务、
        看调试诊断、改全局配置与密钥。
    这类能力不该和"改谁是什么角色"放在同一个账号里：后者一旦被滥用，
    会直接改掉整个实验室的权限结构。
    """
    token = labspace_session or _bearer_token(authorization)
    user = read_session(token)
    if not user:
        raise HTTPException(status_code=401, detail="未登录或会话已过期")
    _require_live(user)
    if not has_role(user, settings.superadmin_roles):
        raise HTTPException(status_code=403, detail="需要系统管理员权限（lab-superadmin）")
    request.state.user = user
    request.state.session_token = token
    return user


def verify_csrf(request: Request, x_csrf_token: str | None, csrf_cookie: str | None) -> None:
    """双提交 CSRF 校验的**纯函数**版本。

    抽出来的原因：代理类路由（例如 `/api/biotools/*` 转发到独立服务）需要在函数体里
    主动校验，而不能把它当 `Depends` 用；直接调用 `require_csrf(request)` 会把
    FastAPI 的 `Header(...)`/`Cookie(...)` 哨兵对象当成真实值传进去，报
    `TypeError: unsupported operand types for compare_digest`（实测踩过）。
    这样两边共用一套判定，不会出现"代理层少校验一次"的口子。
    """
    origin = request.headers.get("origin")
    if origin and origin not in settings.allowed_origins:
        raise HTTPException(status_code=403, detail="来源不被允许")
    if request.headers.get("authorization", "").lower().startswith("bearer "):
        return
    # 内部服务令牌：非浏览器调用，同样豁免双提交 CSRF
    if service_token_valid(request):
        return
    if not csrf_cookie or not x_csrf_token or not secrets.compare_digest(csrf_cookie, x_csrf_token):
        raise HTTPException(status_code=403, detail="CSRF 校验失败")


async def require_csrf(
    request: Request,
    x_csrf_token: str | None = Header(default=None, alias="X-CSRF-Token"),
    labspace_csrf: str | None = Cookie(default=None, alias="labspace_csrf"),
) -> None:
    """FastAPI 依赖形态：参数由框架注入，判定逻辑在 `verify_csrf`。"""
    verify_csrf(request, x_csrf_token, labspace_csrf)
