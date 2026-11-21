"""auth 路由（由 ops/split_main_module.py 从 main.py 搬出）。"""
from __future__ import annotations

import logging

from .. import (
    account_security as account_security,
)
from .. import (
    accounts as accounts_mod,
)
from .. import (
    casdoor,
    db,
    db_apis,
)
from ..config import settings
from ..routers.deps import (
    client_host as _client_host,
)
from ..security import (
    clear_session_cookies,
    current_user,
    has_role,
    issue_session,
    read_session,
    require_admin,
    require_csrf,
    require_user,
    require_user_or_service,
    session_pwd_reset,
    set_session_cookies,
    verify_csrf,
)
from datetime import date
from fastapi import (
    Body,
    Depends,
    FastAPI,
    HTTPException,
    Query,
    Request,
    Response,
)
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.concurrency import run_in_threadpool
from typing import Any
from urllib.parse import urlsplit
import asyncio
import httpx
import time
import urllib.parse
from fastapi import APIRouter

log = logging.getLogger("labspace.routers.auth")

router = APIRouter()


# ------------------------------------------------------------------ 公告

@router.get("/api/announcements")


@router.post("/api/announcements")


@router.delete("/api/announcements/{aid}")


# ------------------------------------------------------------------ 基础


@router.get("/api/health")
async def api_health() -> dict[str, Any]:
    return {"status": "ok", "service": "labspace-backend", "version": "1.0.0"}

_DISPATCH_ROLES = {"lab-teacher", "lab-postdoc", "lab-phd", "lab-master", "lab-undergrad"}

def _can_dispatch(roles: list[str]) -> bool:
    names = {str(r).lower() for r in roles}
    admin = {str(r).lower() for r in settings.admin_roles}
    return bool(names & admin or names & _DISPATCH_ROLES)

@router.get("/api/auth/check")
async def api_auth_check(
    request: Request, user: dict[str, Any] | None = Depends(current_user)
) -> Response:
    """给 nginx ``auth_request`` 用的会话探针。

    有效 -> 204 并把用户 ID 放进 ``X-Auth-User``；无效 -> 401。
    nginx 用 ``auth_request_set`` 取这个头，再注入到下游服务（例如 AgentScope
    的 ``X-User-ID``），因此**客户端自带的 X-User-ID 会被覆盖**，无法伪造。

    这里也是**直连旁路服务的唯一鉴权关口**：``/pdf-api/``、``/mail/`` 与前台的
    AgentScope 都不经过 FastAPI 业务代码，nginx 子请求是它们能看到的全部。
    因此两件事必须在这里做，否则就是后门：

    1. 未改初始口令（``pwd_reset``）一律 403，除非原始请求本身就是改密/探活；
    2. 非幂等方法必须带 CSRF 双提交（``X-Original-Method`` + ``X-CSRF-Token``）。

    只回一个 ID，不返回用户资料：这个端点会被反向代理在每次子请求里调用。
    """
    if not user:
        return Response(status_code=401)

    original = (request.headers.get("x-original-uri") or "").split("?", 1)[0]
    if original and not _password_exempt_path(original) and session_pwd_reset(user):
        return JSONResponse(
            status_code=403,
            content={"detail": "请先修改初始密码后再使用其它功能", "code": "PASSWORD_CHANGE_REQUIRED"},
        )

    method = (request.headers.get("x-original-method") or request.method or "GET").upper()
    if method not in ("GET", "HEAD", "OPTIONS"):
        verify_csrf(
            request,
            request.headers.get("x-csrf-token"),
            request.cookies.get(settings.csrf_cookie),
        )

    return Response(status_code=204, headers={"X-Auth-User": str(user.get("sub") or "")})

def _account_name(user: dict[str, Any]) -> str:
    """会话里的账号名 → Casdoor 的 user.name。

    邮箱是登录标识，但 Casdoor 的 name 不一定是邮箱本地部分；这里按邮箱本地
    部分取，与 lab-sync-passwords 的约定一致。
    """
    email = str(user.get("email") or "")
    local = email.split("@", 1)[0]
    return (local or str(user.get("sub") or "")).strip().lower()

# 未改初始口令时仍然放行的路径：否则用户连改密都做不了。
_PASSWORD_EXEMPT = {
    "/api/me",
    "/api/me/password",
    "/api/auth/check",
    "/api/auth/login",
    "/api/auth/callback",
    "/api/auth/logout",
}

# nginx 子请求会把原始 URI 带在 X-Original-URI 里，前缀同样享受豁免。
_PASSWORD_EXEMPT_PREFIXES = ("/api/auth/",)

def _password_exempt_path(path: str) -> bool:
    """该路径是否允许未改密用户访问。"""
    clean = (path or "").split("?", 1)[0]
    if clean in _PASSWORD_EXEMPT:
        return True
    return any(clean.startswith(p) for p in _PASSWORD_EXEMPT_PREFIXES)

#: 「确需改密」的正结果缓存（秒）。只缓存 True：异常/查不到一律不缓存，
#: 避免一次库抖动就把所有用户钉在 428 上（之前缓存 False 则是相反方向的漏洞）。
_PWD_RESET_TTL = 60.0
_PWD_RESET_CACHE: dict[str, float] = {}

async def _must_change_now(name: str) -> bool:
    """该账号当前是否必须改密。

    会话里的 ``pwd_reset`` claim 是主判据（零 IO、三端一致）；这里补的是
    「登录后才被管理员置位」的情形：最多 60s 生效，且查库放到线程池，
    不阻塞事件循环。
    """
    if not name:
        return False
    ts = _PWD_RESET_CACHE.get(name)
    if ts is not None and time.time() - ts <= _PWD_RESET_TTL:
        return True
    try:
        flag = await run_in_threadpool(account_security.must_change_password, name)
    except Exception as exc:  # noqa: BLE001
        # 读不到标记表就不缓存、按“不拦”处理：这张表与业务库同源，读不到时
        # 整个门户都不可用，不该由一个中间件把请求变成 500。
        log.debug("读取账号改密标记失败，本次放行: %s", exc)
        return False
    if flag:
        _PWD_RESET_CACHE[name] = time.time()
    else:
        _PWD_RESET_CACHE.pop(name, None)
    return flag

@router.post("/api/me/password")
async def api_change_password(
    body: dict[str, Any],
    user: dict[str, Any] = Depends(require_user),
    _csrf: None = Depends(require_csrf),
) -> Response:
    """用户自助改密：必须校验旧口令；新口令 ≥10 位且不得与初始口令相同。"""
    old = str(body.get("oldPassword") or "")
    new = str(body.get("newPassword") or "")
    if not old or not new:
        raise HTTPException(status_code=400, detail="旧口令与新口令都必须填写")
    if len(new) < 10:
        raise HTTPException(status_code=400, detail="新口令至少 10 个字符")
    if new == accounts_mod.INITIAL_PASSWORD:
        raise HTTPException(status_code=400, detail="新口令不能与初始口令相同")
    name = _account_name(user)
    if not accounts_mod.verify_password(name, old):
        raise HTTPException(status_code=400, detail="旧口令不正确")
    accounts_mod.set_user_password(name, new)
    _PWD_RESET_CACHE.pop(name, None)
    # 改密成功必须重签 Cookie：旧会话里的 pwd_reset claim 还在，
    # 否则 Go 侧与 nginx 子请求会继续把用户挡在门外（裂脑）。
    resp = JSONResponse(content={"ok": True})
    reissued = {"id": user.get("sub"), "email": user.get("email", ""), "name": user.get("name", ""), "roles": user.get("roles", [])}
    set_session_cookies(resp, issue_session(reissued, pwd_reset=False))
    return resp

@router.get("/api/people")
async def api_people(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    """轻量人员目录：只给 id / 用户名 / 姓名，供界面把用户名显示成姓名。

    刻意不返回邮箱与用户组：那两样属于管理信息，普通成员不该看到。
    这里存在的意义是让「共享给我」「指派给」「作者」这些位置显示**姓名**，
    而不是裸的用户名或邮箱。
    """
    import asyncio

    people = await asyncio.to_thread(accounts_mod.directory)
    return {
        "people": [
            {"id": p.get("id"), "name": p.get("name"), "displayName": p.get("displayName") or p.get("name")}
            for p in people
        ]
    }

@router.get("/api/me")
async def api_me(user: dict[str, Any] | None = Depends(current_user)) -> dict[str, Any]:
    if not user:
        return {"authenticated": False}
    roles = user.get("roles", [])
    return {
        "authenticated": True,
        "id": user.get("sub"),
        "email": user.get("email"),
        # name 是会话里的显示名；displayName 再从 Casdoor 取一次，
        # 覆盖"会话签发时 display_name 还为空"的历史账号。
        # 界面一律优先用 displayName —— 全站只显示姓名，不显示账号名。
        "name": user.get("name"),
        "displayName": await asyncio.to_thread(_display_name_of, user),
        "roles": roles,
        # 两级管理员：
        #   isAdmin       平台管理员（lab-admin）—— 管账号、用户组、公告、Agent、备份等业务
        #   isSuperAdmin  系统管理员（lab-superadmin）—— 额外能重启/触发运维任务、看诊断诊断
        #   isTeacher     教师（lab-teacher）—— 管学生的课题资料/组会目录
        # 教师判定**不含**管理员：管理员不自动获得教师视图（职责不互相穿透）。
        "isAdmin": any(r.lower() in [x.lower() for x in settings.admin_roles] for r in roles),
        "isSuperAdmin": any(
            r.lower() in [x.lower() for x in settings.superadmin_roles] for r in roles
        ),
        "isTeacher": any(
            r.lower() in [x.lower() for x in settings.teacher_roles] for r in roles
        ),
        "canDispatch": _can_dispatch(roles),
        # 初始口令未改时前端必须弹不可关闭的改密框；存量账号走不到这里。
        "mustChangePassword": account_security.must_change_password(_account_name(user)),
        # 端到端测试账号：前端据此跳过新手引导（见 config.e2e_accounts 的说明）
        "e2e": _account_name(user).lower() in settings.e2e_accounts,
    }

# ------------------------------------------------------------------ 每日一言

_SAYING_CACHE: dict[str, str] = {"day": "", "text": ""}
_SAYING_FALLBACK = "保持热爱，奔赴山海。"

@router.get("/api/saying")
async def api_saying() -> dict[str, Any]:
    """每日诗词（今日诗词 jinrishici.com）。

    与原「每日一言」的区别：返回的是古诗词，并带作者与出处，因此响应里多两个
    字段。仍按自然日缓存 —— 首页刷新不该换诗，否则「每日」就名不副实。
    """
    today = date.today().isoformat()
    if _SAYING_CACHE.get("day") == today and _SAYING_CACHE.get("text"):
        return {
            "text": _SAYING_CACHE["text"],
            "author": _SAYING_CACHE.get("author", ""),
            "origin": _SAYING_CACHE.get("origin", ""),
            "date": today,
            "cached": True,
        }
    try:
        async with httpx.AsyncClient(timeout=6, follow_redirects=True) as client:
            resp = await client.get("https://v1.jinrishici.com/all.json")
            resp.raise_for_status()
            data = resp.json()
        text = str(data.get("content") or "").strip()
        if text:
            _SAYING_CACHE.update(
                day=today,
                text=text,
                author=str(data.get("author") or "").strip(),
                origin=str(data.get("origin") or "").strip(),
            )
            return {
                "text": text,
                "author": _SAYING_CACHE.get("author", ""),
                "origin": _SAYING_CACHE.get("origin", ""),
                "date": today,
                "cached": False,
            }
    except Exception as exc:  # noqa: BLE001 - 外部语料不可用不应影响首页
        log.debug("今日诗词接口不可用，使用缓存/兜底: %s", exc)
    return {
        "text": _SAYING_CACHE.get("text") or _SAYING_FALLBACK,
        "author": _SAYING_CACHE.get("author", ""),
        "origin": _SAYING_CACHE.get("origin", ""),
        "date": today,
        "cached": True,
    }

def _casdoor_issuer(request: Request) -> str:
    """按当前访问主机推导 Casdoor issuer。

    Casdoor 以"回显请求 Host"的方式发布 issuer，因此门户必须使用与浏览器
    实际访问主机一致的 Casdoor 地址，授权回调与 token 交换才能对齐。
    例：访问 http://192.0.2.10/ → http://192.0.2.10:8090
        访问 http://198.51.100.71/ → http://198.51.100.71:8090
    """
    import ipaddress

    host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(":")[0]
    proto = request.headers.get("x-forwarded-proto", "http")
    if not host:
        return settings.issuer
    try:
        ipaddress.ip_address(host)
    except ValueError:
        # 域名别名：Casdoor 对非 IP 主机默认按 https 生成 issuer，而内网是纯 HTTP，
        # 因此别名统一回落到规范的 IP issuer（授权地址仍为 IP）
        return settings.issuer
    return f"{proto}://{host}:{settings.casdoor_port}"

def _request_base(request: Request) -> str:
    """按用户实际访问的主机名生成基址（IP 直连或域名皆可）。

    Host 头受白名单约束：伪造 Host 不但会把服务地址指错，还能把 OIDC
    ``redirect_uri`` 带向外部地址，所以这里跟 ``_client_host`` 用同一套判定。
    """
    raw = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    host = _client_host(request)
    if not host:
        return settings.public_url
    # 端口保留（平台多个服务靠端口区分），但主机名必须来自白名单
    port = ""
    if ":" in raw and "[" not in raw:  # 简单 hostname:port，不处理 IPv6 字面量
        port = ":" + raw.split(":")[-1]
    proto = request.headers.get("x-forwarded-proto", "http")
    return f"{proto}://{host}{port}"

def _display_name_of(user: dict[str, Any]) -> str:
    """会话用户的显示名（中文姓名）；取不到时退回会话里的 name。"""
    from . import accounts as accounts_mod

    fallback = str(user.get("name") or "")
    sub = str(user.get("sub") or "")
    try:
        rows = accounts_mod._query(
            'SELECT display_name FROM public."user" WHERE owner = %s AND (id = %s OR name = %s) LIMIT 1',
            (accounts_mod.OWNER, sub, fallback),
        )
    except Exception:  # noqa: BLE001 - 取不到显示名不该让 /api/me 失败
        return fallback
    if rows:
        shown = str(rows[0].get("display_name") or "").strip()
        if shown:
            return shown
    return fallback

def _safe_back(raw: str, request: Request | None = None) -> str:
    """把"登录后回哪去"规整成安全的回跳目标。

    允许两种形态：
      * 站内相对路径（"/workbench"）；
      * **同一主机**的绝对地址（"http://192.0.2.10:8097/"）——平台有多个
        独立端口的服务，登录后必须能回到那个端口，否则会停在门户首页。

    仍然禁止：协议相对地址（"//evil.com"）、换主机名的绝对地址、
    带反斜杠或换行的值（防 header 注入与解析歧义）。
    """
    value = (raw or "").strip()
    if any(ch in value for ch in ("\\", "\n", "\r")):
        return ""
    if value.startswith("//"):
        return ""
    if value.startswith("/"):
        return value[:200]
    if value.startswith(("http://", "https://")):
        if request is None:
            return ""
        try:
            target = urlsplit(value)
        except ValueError:
            return ""
        host = _client_host(request)
        if not host or target.hostname != host:
            return ""
        # 端口保留：同主机不同端口是本平台的不同服务
        port = f":{target.port}" if target.port else ""
        return f"{target.scheme}://{host}{port}{target.path or '/'}"[:200]
    return ""

@router.get("/api/auth/login")
async def api_login(request: Request, back: str = Query(default="")) -> RedirectResponse:
    """发起 OIDC 登录；``back`` 记住登录后要回到的站内路径。

    ``back`` 允许带**端口**（如 ``http://192.0.2.10:8097/``）：
    平台有多个独立端口的服务（primer 8097、图纸 8093 …），登录页在 80 端口，
    登录完必须能回到原来那个端口的服务，否则用户会停在门户首页、
    以为"登录后还是进不去那个页面"。
    跨主机仍然是禁止的（只允许本站主机名）。
    """
    redirect_uri = f"{_request_base(request)}/api/auth/callback"
    issuer = _casdoor_issuer(request)
    state = casdoor.new_state(
        redirect_uri=redirect_uri, issuer=issuer, back=_safe_back(back, request)
    )
    return RedirectResponse(casdoor.authorization_url(state, redirect_uri, issuer), status_code=302)

@router.get("/api/auth/callback")
async def api_callback(
    request: Request,
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
    error_description: str | None = Query(default=None),
) -> RedirectResponse:
    # 身份提供方返回错误时（如用户拒绝授权、state 失效）给友好提示，而不是 422
    if error or not code:
        detail = error_description or error or "登录未完成"
        base = _request_base(request)
        return RedirectResponse(f"{base}/login?error={urllib.parse.quote(detail)}", status_code=302)
    entry = casdoor.pop_state(state or "")
    if not entry:
        base = _request_base(request)
        return RedirectResponse(f"{base}/login?error={urllib.parse.quote('登录状态已失效，请重试')}", status_code=302)
    nonce = entry["nonce"]
    # 复用发起授权时使用的 redirect_uri 与 issuer，保证与 Casdoor 完全一致
    redirect_uri = entry.get("redirect_uri") or f"{_request_base(request)}/api/auth/callback"
    issuer = entry.get("issuer") or _casdoor_issuer(request)
    tokens = await casdoor.exchange_code(code, redirect_uri, issuer)
    id_token = tokens.get("id_token")
    access_token = tokens.get("access_token", "")
    claims: dict[str, Any] = {}
    if id_token:
        claims = casdoor.verify_id_token(id_token, nonce, issuer)
    info = await casdoor.fetch_userinfo(access_token, id_token, issuer)
    merged = {**info, **claims}
    user = casdoor.normalize_user(merged)
    if not user["email"]:
        raise HTTPException(status_code=400, detail="OIDC 未返回邮箱，无法建立身份")

    # 回调后回到用户实际访问的主机名（IP 直连或域名都用同一入口）
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    proto = request.headers.get("x-forwarded-proto", "http")
    base = f"{proto}://{host}" if host else settings.public_url
    resp = RedirectResponse(f"{base}{entry.get('back') or '/'}", status_code=302)
    set_session_cookies(
        resp,
        issue_session(user, pwd_reset=await _must_change_now(_account_name(user))),
    )
    return resp

@router.post("/api/auth/logout")
async def api_logout(
    request: Request, response: Response, _: None = Depends(require_csrf)
) -> dict[str, Any]:
    clear_session_cookies(response)
    return {"ok": True, "logoutUrl": casdoor.logout_url(_casdoor_issuer(request))}

@router.get("/api/auth/logout-redirect")
async def api_logout_redirect(request: Request) -> RedirectResponse:
    return RedirectResponse(casdoor.logout_url(_casdoor_issuer(request)), status_code=302)
