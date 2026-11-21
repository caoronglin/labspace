"""LabSpace 后端入口（FastAPI）。

职责边界：OIDC 会话、用户身份、服务目录与健康检查、收藏/最近访问、
受控的绘图文件保存，以及管理端只读系统信息。不承担第二套认证/文件系统/容器编排。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import urllib.parse
from datetime import date
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import (
    Body,
    Depends,
    FastAPI,
    HTTPException,
    Query,
    Request,
    Response,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.concurrency import run_in_threadpool

from . import (
    account_security as account_security,
)
from . import (
    accounts as accounts_mod,
)
from . import (
    admin_research as admin_research_mod,
)
from . import (
    admin_tasks as admin_tasks_mod,
)
from . import (
    agent as agent_mod,
)
from . import (
    agentscope_router as agentscope_router_mod,
)
from . import (
    audit as audit,
)
from . import (
    background as background_mod,
)
from . import (
    baserow as baserow_mod,
)
from . import (
    biotools_proxy as biotools_proxy_mod,
)
from . import (
    casdoor,
    db,
    db_apis,
)
from . import (
    corpus as corpus_mod,
)
from . import (
    dailypapers as dailypapers_mod,
)
from . import (
    debug_api as debug_api_mod,
)
from . import (
    decision as decision_mod,
)
from . import (
    genomes as genomes_mod,
)
from . import (
    knowledge as knowledge_mod,
)
from . import (
    lab_shared as lab_shared_mod,
)
from . import (
    labops as labops_mod,
)
from . import (
    latex as latex_mod,
)
from . import (
    meetings as meetings_mod,
)
from . import (
    mt as mt_mod,
)
from . import (
    office as office_mod,
)
from . import (
    seed_tables as seed_tables_mod,
)
from . import (
    snapotter as snapotter_mod,
)
from . import (
    sso as sso_mod,
)
from . import (
    weather as weather_mod,
)
from . import (
    wecom as wecom_mod,
)
from . import (
    workbench as workbench_mod,
)
from .catalog import adapt_host, load_catalog
from .config import settings
from .routers.admin import router as admin_router
from .routers.catalog import router as catalog_router
from .routers.deps import (
    client_host as _client_host,
)
from .routers.docs import router as docs_router
from .routers.drawings import router as drawings_router
from .routers.misc import router as misc_router
from .routers.search import go_portal_search  # noqa: F401 - 测试与旧调用点按 main.<name> 取
from .routers.search import router as search_router
from .routers.snapotter import router as snapotter_router
from .security import (
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

log = logging.getLogger("labspace.main")

app = FastAPI(title="LabSpace API", version="1.0.0", docs_url="/api/docs", openapi_url="/api/openapi.json")


@app.on_event("startup")
async def _warm_caches() -> None:
    """启动时预热 SnapOtter 工具目录，使统一语料立即可搜到文件处理工具。

    启动瞬间 SnapOtter 可能还没就绪，这里重试几次；仍失败则由后台任务补上。
    """
    for _attempt in range(3):
        try:
            await snapotter_mod.get_tool_catalog()
            corpus_mod.corpus(refresh=True)
            return
        except Exception:  # noqa: BLE001 - 预热失败不应阻断门户启动
            await asyncio.sleep(5)


@app.on_event("startup")
async def _start_catalog_refresher() -> None:
    """启动后台任务，定期刷新 SnapOtter 工具目录并重建语料缓存。

    工具目录有 243 个文件处理能力，缺失时命令面板与全局搜索都搜不到；
    Go 核心已经能独立取到这份目录，Python 侧作为回退实现保持同步。
    注意：必须是后台任务，不能直接 await，否则应用启动永远不会完成。
    """
    app.state.catalog_refresher = asyncio.create_task(_refresh_snapotter_catalog())
    app.state.wecom_digest = asyncio.create_task(wecom_mod.digest_loop())


async def _refresh_snapotter_catalog() -> None:
    while True:
        await asyncio.sleep(600)
        try:
            await snapotter_mod.get_tool_catalog()
            corpus_mod.corpus(refresh=True)
        except Exception as exc:  # noqa: BLE001 - 刷新失败不应影响门户
            log.debug("定时刷新失败（下轮重试）: %s", exc)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-CSRF-Token", "Authorization", "X-Lab-Service-Token"],
)


app.include_router(admin_router)
app.include_router(search_router)
app.include_router(snapotter_router)
app.include_router(docs_router)
app.include_router(drawings_router)
app.include_router(misc_router)
app.include_router(catalog_router)
app.include_router(workbench_mod.router)
app.include_router(accounts_mod.router)
app.include_router(background_mod.router)
app.include_router(knowledge_mod.router)
app.include_router(agent_mod.router)
app.include_router(agentscope_router_mod.router)
app.include_router(mt_mod.router)
app.include_router(mt_mod.internal_router)
app.include_router(weather_mod.router)
app.include_router(sso_mod.router)
app.include_router(wecom_mod.router)
app.include_router(debug_api_mod.router)
app.include_router(baserow_mod.router)
# 统一生信工具（Biopython + scikit-bio）：取代已废弃的 CropGenome 序列工具，纯计算只读
# 生信工具跑在独立的 biotools 容器里，这里只挂代理（鉴权在代理层）
app.include_router(biotools_proxy_mod.router)
app.include_router(office_mod.router)
app.include_router(genomes_mod.router)
app.include_router(labops_mod.router)
app.include_router(latex_mod.router)
app.include_router(decision_mod.router)
app.include_router(admin_tasks_mod.router)
app.include_router(admin_research_mod.router)
app.include_router(admin_research_mod.student_router)
app.include_router(meetings_mod.router)
app.include_router(lab_shared_mod.router)
app.include_router(seed_tables_mod.router)


@app.middleware("http")
async def _auto_sso_follow(request: Request, call_next):
    """记录来访客户端所属网段（仅用于状态展示），**不**在此自动切换第三方服务的 OIDC issuer。

    历史版本在这里按客户端网段自动重建第三方服务容器来切换 issuer，
    后果是：内网与 Tailscale 用户交替访问时容器被反复重建（每次约 10~30 秒），
    这期间直接访问 :8080 会撞上 docker-proxy 的 **502 Bad Gateway**。

    现在 issuer 只在用户明确点击「一键登录」时切换：
    /api/sso/{id}/prepare → 宿主机 lab-oidc-sync 改配置 → 等容器 healthy → 才返回登录地址。
    """
    try:
        client_ip = sso_mod._client_ip(request)
        if client_ip:
            sso_mod._auto_state["last_seen_ip"] = client_ip
            sso_mod._auto_state["last_seen_host"] = sso_mod.desired_host(client_ip)
    except Exception as exc:  # noqa: BLE001 - 自适应失败不应影响门户响应
        log.debug("入口自适应失败: %s", exc)
    return await call_next(request)


SAFE_NAME = re.compile(r"[^A-Za-z0-9._\-一-鿿]+")








































# ------------------------------------------------------------------ 公告

@app.get("/api/announcements")


@app.post("/api/announcements")


@app.delete("/api/announcements/{aid}")


# ------------------------------------------------------------------ 基础


@app.get("/api/health")
async def api_health() -> dict[str, Any]:
    return {"status": "ok", "service": "labspace-backend", "version": app.version}


_DISPATCH_ROLES = {"lab-teacher", "lab-postdoc", "lab-phd", "lab-master", "lab-undergrad"}


def _can_dispatch(roles: list[str]) -> bool:
    names = {str(r).lower() for r in roles}
    admin = {str(r).lower() for r in settings.admin_roles}
    return bool(names & admin or names & _DISPATCH_ROLES)


@app.get("/api/auth/check")
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


#: 已被 Go 核心（labgo :8122）接管、Python 侧只作兼容备份的路由前缀。
#: 还在被访问说明有调用方没切过去，所以先计数 + 打 Deprecation 头，
#: 等观测到一整轮发布周期零命中，再从 main.py 里删实现（别凭感觉删）。
_DEPRECATED_PREFIXES = (
    "/api/services",
    "/api/corpus",
    "/api/search",
    "/api/favorites",
    "/api/recent",
)
_DEPRECATED_HITS: dict[str, int] = {}


@app.middleware("http")
async def _mark_deprecated_routes(request: Request, call_next):
    path = request.url.path
    if any(path.startswith(p) for p in _DEPRECATED_PREFIXES):
        _DEPRECATED_HITS[path] = _DEPRECATED_HITS.get(path, 0) + 1
        response = await call_next(request)
        response.headers["Deprecation"] = "true"
        response.headers["Link"] = '</api/admin/deprecated-hits>; rel="successor-version"'
        return response
    return await call_next(request)


@app.get("/api/admin/deprecated-hits")
async def api_deprecated_hits(_admin: dict = Depends(require_admin)) -> dict[str, Any]:
    """管理员看：还有谁在打 Python 侧的兼容路由（决定何时能删实现）。"""
    return {
        "prefixes": list(_DEPRECATED_PREFIXES),
        "items": [{"path": k, "hits": v} for k, v in sorted(_DEPRECATED_HITS.items(), key=lambda kv: -kv[1])],
    }


@app.middleware("http")
async def _stamp_audit_ip(request: Request, call_next):
    """把客户端 IP 放进 contextvar，供 audit.record() 使用。

    审计要回答「谁从哪改的」，但写接口分散在若干模块，让每个函数多接一个
    request 参数既啰嗦又容易漏。中间件统一塞进上下文，业务侧只管调
    audit.record(...) 即可。

    取 X-Forwarded-For 的第一段（nginx 是唯一可信来源，且它会覆写这个头）。
    """
    forwarded = request.headers.get("x-forwarded-for") or ""
    ip = forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else "")
    audit.set_request_ip(ip)
    return await call_next(request)


@app.middleware("http")
async def _enforce_password_change(request: Request, call_next):
    """未修改初始口令的用户，除少数豁免路径外一律 428。

    用中间件而不是逐路由加依赖：后者一定会漏挂，而漏挂的那个接口就是后门。
    判定只认会话里的 ``pwd_reset`` claim：每请求查库既慢又会在库里出现异常时
    反向变成 Fail-Open。置位/复位都在签发方（登录时查一次、改密后重签）。
    管理员重置口令会顺带吊销会话，用户重登拿到的就是带 claim 的新令牌。
    """
    path = request.url.path
    if path.startswith("/api/") and not _password_exempt_path(path):
        user = read_session(request.cookies.get(settings.cookie_name))
        if user and session_pwd_reset(user):
            return JSONResponse(
                status_code=428,
                content={
                    "detail": "请先修改初始密码后再使用其它功能",
                    "code": "PASSWORD_CHANGE_REQUIRED",
                },
            )
    return await call_next(request)


@app.post("/api/me/password")
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


@app.get("/api/people")
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


@app.get("/api/me")
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


@app.get("/api/saying")
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


# ------------------------------------------------------------------ OIDC


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







@app.get("/api/auth/login")
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


@app.get("/api/auth/callback")
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


@app.post("/api/auth/logout")
async def api_logout(
    request: Request, response: Response, _: None = Depends(require_csrf)
) -> dict[str, Any]:
    clear_session_cookies(response)
    return {"ok": True, "logoutUrl": casdoor.logout_url(_casdoor_issuer(request))}


@app.get("/api/auth/logout-redirect")
async def api_logout_redirect(request: Request) -> RedirectResponse:
    return RedirectResponse(casdoor.logout_url(_casdoor_issuer(request)), status_code=302)


# ------------------------------------------------------------------ 服务目录


@app.get("/api/services")
@app.get("/v1/services")


@app.get("/api/services/{service_id}/health")
@app.get("/v1/services/{service_id}/health")


@app.get("/api/services/health")
@app.get("/v1/services/health")


# ------------------------------------------------------------------ 收藏 / 最近


@app.get("/api/favorites")
@app.get("/v1/favorites")


@app.post("/api/favorites/{service_id}")
@app.post("/v1/favorites/{service_id}")


@app.delete("/api/favorites/{service_id}")
@app.delete("/v1/favorites/{service_id}")


@app.get("/api/recent")
@app.get("/v1/recent")


@app.post("/api/recent/{service_id}")
@app.post("/v1/recent/{service_id}")


# ------------------------------------------------------------------ 植物数据库目录

@app.get("/api/databases")


@app.get("/api/databases/apis")


@app.post("/api/databases/{db_id}/query")
async def api_databases_query(
    db_id: str,
    payload: dict[str, Any] = Body(default_factory=dict),
    _: dict = Depends(require_user_or_service),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    """对指定数据库执行一次真实 API 查询（服务端代理）。"""
    query = str(payload.get("query") or "").strip()
    # limit 来自请求体：脏值不能让整个接口 500
    try:
        limit = int(payload.get("limit") or 5)
    except (TypeError, ValueError):
        limit = 5
    limit = max(1, min(limit, 200))
    params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
    result = await db_apis.run_query(db_id, query, limit, params)
    return result


@app.get("/api/databases/{db_id}/probe")
async def api_databases_probe(db_id: str, _: dict = Depends(require_user_or_service)) -> dict[str, Any]:
    """探测单个数据库 API 的可用性。"""
    ok, detail = await db_apis.probe(db_id)
    spec = db_apis.ADAPTERS.get(db_id)
    return {"id": db_id, "ok": ok, "detail": detail, "api": spec.as_dict(ok) if spec else None}


# ------------------------------------------------------------------ 网络 / 入口自检

SERVICE_ENTRIES = [
    ("门户 D509 工作台", "http://192.0.2.10/", "/"),
    ("统一认证 Casdoor", "http://192.0.2.10:8090/", "/"),
    ("生信实训平台", "http://192.0.2.10:8102/", "/"),
    ("draw.io 绘图", "http://192.0.2.10:8082/", "/"),
    ("Linux 命令速查", "http://192.0.2.10:8086/", "/"),
    ("JBrowse 2 基因组浏览器", "http://192.0.2.10:8091/index.html?config=data/demo/config.zh.json", "/index.html"),
]


@app.get("/api/network/entries")
async def api_network_entries(request: Request, _: dict = Depends(require_user)) -> dict[str, Any]:
    """各服务入口（当前访问主机 + 端口）的实时可用性自检。"""
    import httpx

    host = _client_host(request)
    entries = adapt_host(
        [{"name": n, "url": u, "path": p} for n, u, p in SERVICE_ENTRIES], host
    )

    async def probe(url: str, path: str) -> tuple[bool, str]:
        target = url.rsplit("/", 1)[0] + path if path != "/" else url
        try:
            # 不跟随跳转：目标主机虽来自白名单，但上游 302 仍可能把我们带到任意地址
            # （重定向放大）。自检只需要“这个入口现在通不通”，3xx 也算活着。
            async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
                resp = await client.get(target)
                return resp.status_code < 400, f"HTTP {resp.status_code}"
        except Exception as exc:  # noqa: BLE001
            return False, type(exc).__name__

    results = await asyncio.gather(*[probe(u["url"], u["path"]) for u in entries])
    items = [
        {"name": e["name"], "url": e["url"], "up": up, "detail": detail}
        for e, (up, detail) in zip(entries, results, strict=True)
    ]
    return {"items": items, "host": host or "192.0.2.10"}


# ------------------------------------------------------------------ 内嵌能力探测


def _service_for_user(service_id: str, user: dict[str, Any]):
    """服务存在且当前用户满足其角色限制，否则 404/403。"""
    svc = next((s for s in load_catalog() if s.id == service_id), None)
    if not svc:
        raise HTTPException(status_code=404, detail="服务不存在")
    if svc.roles and not has_role(user, svc.roles):
        raise HTTPException(status_code=403, detail="无权访问该服务")
    return svc


@app.get("/api/services/{service_id}/embed")
@app.get("/v1/services/{service_id}/embed")
async def api_service_embed(service_id: str, request: Request, user: dict = Depends(require_user)) -> dict[str, Any]:
    """探测某服务是否允许 iframe 内嵌。

    实际探测由 Go 核心完成（``internal/embed``）：它读取目标站点的
    ``X-Frame-Options`` 与 CSP ``frame-ancestors``，并缓存 5 分钟。
    """
    from .golink import embed_info

    svc = _service_for_user(service_id, user)
    info = await embed_info(svc.id)
    if not info:
        raise HTTPException(status_code=404, detail="服务不存在")
    return adapt_host(info, _client_host(request))


@app.get("/api/services/{service_id}/sso")
@app.get("/v1/services/{service_id}/sso")
async def api_service_sso(service_id: str, request: Request, user: dict = Depends(require_user)) -> dict[str, Any]:
    """返回服务的免密登录入口（Casdoor OIDC 起跳地址）。

    已由 Go 核心接管，此处保留仅为兼容直连后端端口的旧客户端。
    """
    svc = _service_for_user(service_id, user)
    return adapt_host(
        {
            "id": svc.id,
            "name": svc.name,
            "ssoUrl": svc.sso_url or "",
            "url": svc.url,
            "hasSso": bool(svc.sso_url),
        },
        _client_host(request),
    )
























































# ------------------------------------------------------------------ 管理端












@app.exception_handler(HTTPException)
async def http_exc_handler(request: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


# ------------------------------------------------------------------ 每日论文

def _parse_day_param(raw: str | None) -> date:
    """解析 day 查询参数（YYYY-MM-DD）；空值取今天，格式错误直接 400。"""
    value = (raw or "").strip()
    if not value:
        return date.today()
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="day 需要 YYYY-MM-DD 格式") from exc


@app.get("/api/daily-papers")
async def api_daily_papers(
    day: str = Query("", max_length=10),
    topic: str = Query("", max_length=200),
    page: int = Query(1, ge=1, le=1000),
    page_size: int = Query(20, ge=1, le=100),
    user: dict = Depends(require_user),
) -> dict[str, Any]:
    """按人读取某天的「每日论文」。跨用户不可见：查询始终带调用者的 sub。"""
    target = _parse_day_param(day)
    return await dailypapers_mod.list_daily(
        user["sub"],
        target,
        topic=topic,
        page=page,
        page_size=page_size,
    )


@app.get("/api/daily-papers/subscriptions")
async def api_daily_subs(user: dict = Depends(require_user)) -> dict[str, Any]:
    """我的每日论文订阅。"""
    return {"subscriptions": await dailypapers_mod.list_subs(user["sub"])}


@app.put("/api/daily-papers/subscriptions")
async def api_daily_sub_upsert(
    payload: dict[str, Any] = Body(default_factory=dict),
    user: dict = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    """新增/修改订阅：主题 + 每天抓几篇 + 是否启用。"""
    topic = str(payload.get("topic") or "").strip()
    if not topic:
        raise HTTPException(status_code=400, detail="topic 不能为空")
    if len(topic) > 120:
        raise HTTPException(status_code=400, detail="主题最长 120 字")
    try:
        limit = int(payload.get("limit") or 10)
    except (TypeError, ValueError):
        limit = 10
    limit = max(1, min(limit, 50))
    enabled = bool(payload.get("enabled", True))
    sub = await dailypapers_mod.upsert_sub(user["sub"], topic, limit, enabled)
    return {"ok": True, "subscription": sub}


@app.delete("/api/daily-papers/subscriptions/{topic}")
async def api_daily_sub_delete(
    topic: str,
    user: dict = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    """取消订阅。"""
    await dailypapers_mod.delete_sub(user["sub"], topic)
    return {"ok": True, "topic": topic}


@app.post("/api/daily-papers/subscriptions/run")
async def api_daily_sub_run(
    user: dict = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    """立即抓取我的全部订阅（不用等到明天）。"""
    return await dailypapers_mod.run_subs(user["sub"])


@app.post("/api/daily-papers/refresh")
async def api_daily_papers_refresh(
    payload: dict[str, Any] = Body(default_factory=dict),
    user: dict = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    """抓取并落库某天的论文（主题必填）。

    同一 (天, 人, 主题) 已有数据时直接读库返回，不会重复打文献源。
    文献源全败时返回 source="none"、count=0，不会伪造条目。
    """
    topic = str(payload.get("topic") or "").strip()
    if not topic:
        raise HTTPException(status_code=400, detail="topic 不能为空")
    target = _parse_day_param(str(payload.get("day") or ""))
    return await dailypapers_mod.build_daily(user["sub"], topic, target)

#: 历史重定向命中计数（进程内）。目的是「敢不敢删」，不是精确统计 ——
#: 重启归零没关系，运维看的是「一天里还有没有在跳」。
_LEGACY_HITS: dict[str, int] = {}


@app.post("/api/legacy-hit")
async def api_legacy_hit(request: Request) -> Response:
    """记录一次旧路径命中（前端跳转前打点）。

    隐私上只记路径，不记用户、不记来源页：这里要回答的是「这条重定向还有人用吗」。
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - 打点坏数据不该报错
        body = {}
    path = str((body or {}).get("path") or "")[:200]
    if path:
        _LEGACY_HITS[path] = _LEGACY_HITS.get(path, 0) + 1
    return Response(status_code=204)


@app.get("/api/admin/legacy-hits")
async def api_legacy_hits(_admin: dict = Depends(require_admin)) -> dict[str, Any]:
    """给管理员看：哪些旧路径还在被访问（决定什么时候能从重定向表里删）。"""
    return {"items": [{"path": k, "hits": v} for k, v in sorted(_LEGACY_HITS.items(), key=lambda kv: -kv[1])]}


@app.get("/api/admin/audit")
async def api_admin_audit(
    request: Request,
    actor: str = Query(default=""),
    action: str = Query(default=""),
    since: str = Query(default=""),
    until: str = Query(default=""),
    limit: int = Query(default=500, ge=1, le=5000),
    format: str = Query(default="json"),
    _admin: dict[str, Any] = Depends(require_admin),
) -> Any:
    """按时间、操作人、动作导出审计日志（JSON 或 CSV）。

    审计表是全实验室的写操作底账：种子台账改动、组会授权、跨目录共享、账号变更
    都往这里写。导出走服务端过滤而不是把全表丢给前端 —— 表会一直长。
    """
    clauses = ["1=1"]
    params: list[Any] = []
    if actor:
        clauses.append("actor = %s")
        params.append(actor.strip().lower())
    if action:
        clauses.append("action LIKE %s")
        params.append(f"{action.strip()}%")
    if since:
        clauses.append("created_at >= %s")
        params.append(since)
    if until:
        clauses.append("created_at < %s")
        params.append(until)
    where = " AND ".join(clauses)
    rows = db.query(
        f"SELECT id, actor, action, target, detail, ip, created_at "
        f"FROM labspace.account_audit WHERE {where} ORDER BY created_at DESC LIMIT %s",  # noqa: S608 - where 由固定子句拼成，值走占位符
        (*params, limit),
    )
    if format.lower() == "csv":
        import csv
        import io

        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["id", "actor", "action", "target", "detail", "ip", "created_at"])
        for r in rows:
            writer.writerow([
                r["id"], r["actor"], r["action"], r["target"],
                json.dumps(r["detail"], ensure_ascii=False), r["ip"], r["created_at"],
            ])
        from fastapi.responses import PlainTextResponse

        return PlainTextResponse(
            buf.getvalue(),
            media_type="text/csv; charset=utf-8",
            headers={"content-disposition": 'attachment; filename="labspace-audit.csv"'},
        )
    return {"items": rows, "count": len(rows)}
