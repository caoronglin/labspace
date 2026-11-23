"""LabSpace 后端入口（FastAPI）。

职责边界：OIDC 会话、用户身份、服务目录与健康检查、收藏/最近访问、
受控的绘图文件保存，以及管理端只读系统信息。不承担第二套认证/文件系统/容器编排。
"""
from __future__ import annotations

import asyncio
import logging
import re

from fastapi import (
    FastAPI,
    HTTPException,
    Request,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

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
    corpus as corpus_mod,
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
from .config import settings
from .routers.admin import router as admin_router
from .routers.auth import _password_exempt_path as _password_exempt_path
from .routers.auth import router as auth_router
from .routers.catalog import router as catalog_router
from .routers.docs import router as docs_router
from .routers.drawings import router as drawings_router
from .routers.misc import router as misc_router
from .routers.network import router as network_router
from .routers.reports import router as reports_router
from .routers.search import go_portal_search  # noqa: F401 - 测试与旧调用点按 main.<name> 取
from .routers.search import router as search_router
from .routers.snapotter import router as snapotter_router
from .security import (
    read_session,
    session_pwd_reset,
)

log = logging.getLogger("labspace.main")

app = FastAPI(title="LabSpace API", version="2026.11.22.4", docs_url="/api/docs", openapi_url="/api/openapi.json")


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


app.include_router(network_router)
app.include_router(reports_router)
app.include_router(auth_router)
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












# ------------------------------------------------------------------ OIDC























# ------------------------------------------------------------------ 服务目录










# ------------------------------------------------------------------ 内嵌能力探测






























































# ------------------------------------------------------------------ 管理端












@app.exception_handler(HTTPException)
async def http_exc_handler(request: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})




















