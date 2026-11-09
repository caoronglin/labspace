"""LabSpace 后端入口（FastAPI）。

职责边界：OIDC 会话、用户身份、服务目录与健康检查、收藏/最近访问、
受控的绘图文件保存，以及管理端只读系统信息。不承担第二套认证/文件系统/容器编排。
"""
from __future__ import annotations

import json
import logging
import os
import urllib.parse
import re
import secrets
import shutil
import subprocess
from typing import Any

import httpx
import asyncio

from fastapi import Body, Depends, FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile
from starlette.background import BackgroundTask
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse

from . import (
    accounts as accounts_mod,
    agent as agent_mod,
    background as background_mod,
    baserow as baserow_mod,
    casdoor,
    corpus as corpus_mod,
    db,
    knowledge as knowledge_mod,
    db_apis,
    debug_api as debug_api_mod,
    decision as decision_mod,
    docparse as docparse_mod,
    genomes as genomes_mod,
    labops as labops_mod,
    latex as latex_mod,
    mt as mt_mod,
    office as office_mod,
    semantic as semantic_mod,
    snapotter as snapotter_mod,
    sso as sso_mod,
    weather as weather_mod,
    wecom as wecom_mod,
    workbench as workbench_mod,
)
from .databases import CATEGORIES, PLANT_DATABASES, search_databases

log = logging.getLogger("labspace.main")
from .catalog import adapt_host, load_catalog, visible_services
from .golink import service_health as go_service_health
from .golink import corpus_query as go_corpus_query
from .golink import corpus_suggest as go_corpus_suggest
from .golink import portal_search as go_portal_search
from .golink import search_categories as go_search_categories
from .searchconfig import CATEGORY_ALIASES as _CATEGORY_ALIASES
from .searchconfig import SEARCH_CATEGORIES as _SEARCH_CATEGORIES
from .searchconfig import normalize_category
from .uploads import read_upload_capped as _read_upload_capped
from .config import settings
from .security import (
    clear_session_cookies,
    has_role,
    issue_session,
    current_user,
    require_admin,
    require_csrf,
    require_user,
    require_user_or_service,
    set_session_cookies,
)

app = FastAPI(title="LabSpace API", version="1.0.0", docs_url="/api/docs", openapi_url="/api/openapi.json")


@app.on_event("startup")
async def _warm_caches() -> None:
    """启动时预热 SnapOtter 工具目录，使统一语料立即可搜到文件处理工具。

    启动瞬间 SnapOtter 可能还没就绪，这里重试几次；仍失败则由后台任务补上。
    """
    for attempt in range(3):
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
        except Exception:  # noqa: BLE001 - 刷新失败不应影响门户
            pass

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-CSRF-Token", "Authorization", "X-Lab-Service-Token"],
)

app.include_router(workbench_mod.router)
app.include_router(accounts_mod.router)
app.include_router(background_mod.router)
app.include_router(knowledge_mod.router)
app.include_router(agent_mod.router)
app.include_router(mt_mod.router)
app.include_router(mt_mod.internal_router)
app.include_router(docparse_mod.router)
app.include_router(weather_mod.router)
app.include_router(sso_mod.router)
app.include_router(wecom_mod.router)
app.include_router(debug_api_mod.router)
app.include_router(baserow_mod.router)
app.include_router(office_mod.router)
app.include_router(genomes_mod.router)
app.include_router(labops_mod.router)
app.include_router(latex_mod.router)
app.include_router(decision_mod.router)


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
    except Exception:  # noqa: BLE001 - 自适应失败不应影响门户响应
        pass
    return await call_next(request)


SAFE_NAME = re.compile(r"[^A-Za-z0-9._\-一-鿿]+")


def _safe_component(name: str, fallback: str = "user") -> str:
    name = (name or "").strip().replace("/", "-")
    name = SAFE_NAME.sub("-", name).strip("-.")
    return name[:64] or fallback


def _user_dir(user: dict[str, Any]) -> str:
    """用户在实验室文件空间中的个人目录（/srv/lab/users/<name>）。"""
    candidates = [
        user.get("preferred_username"),
        user.get("name"),
        (user.get("email") or "").split("@")[0],
        user.get("id"),
    ]
    for c in candidates:
        if c:
            comp = _safe_component(str(c))
            path = os.path.join(settings.users_root, comp)
            if os.path.isdir(path):
                return path
    comp = _safe_component(str(user.get("email", "")).split("@")[0] or str(user.get("id")))
    return os.path.join(settings.users_root, comp)


def _grant_user_acl(path: str) -> None:
    """给文件服务账号（UID 1000 / labuser）授予目录读写位。

    用 argv 调 setfacl，不走 shell；setfacl 不存在时静默跳过（不阻断主流程）。
    """
    if not shutil.which("setfacl"):
        return
    for args in (["-m", "u:1000:rwX", path], ["-d", "-m", "u:1000:rwX", path]):
        try:
            subprocess.run(["setfacl", *args], capture_output=True, timeout=5, check=False)
        except (OSError, subprocess.SubprocessError):
            return


def _ensure_user_dir(user: dict[str, Any]) -> str:
    path = _user_dir(user)
    try:
        os.makedirs(path, mode=0o700, exist_ok=True)
        # Go 文件服务以 UID 1000 运行，需要写权限。
        # 用 argv 形式而不是 shell 字符串：路径里出现空格/分号也不会被 shell 解释。
        _grant_user_acl(path)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"无法准备个人目录: {exc}") from exc
    return path


# ------------------------------------------------------------------ Linux 命令库

CMD_ROOT = os.getenv("LABSPACE_COMMANDS_DIR", "/opt/labspace/cmd")
CMD_INDEX = os.getenv("LABSPACE_COMMANDS_INDEX", "/opt/labspace/cmd-index.json")
_cmd_index: dict[str, dict[str, str]] | None = None


def _load_cmd_index() -> dict[str, dict[str, str]]:
    """加载 linux-command 官方命令索引（621 条）。"""
    global _cmd_index
    if _cmd_index is not None:
        return _cmd_index
    import json

    idx: dict[str, dict[str, str]] = {}
    data_path = CMD_INDEX
    if os.path.isfile(data_path):
        with open(data_path, encoding="utf-8") as fh:
            raw = json.load(fh)
        for name, meta in (raw.items() if isinstance(raw, dict) else []):
            idx[str(name)] = {
                "name": str(name),
                "desc": str(meta.get("d", "")),
                "path": str(meta.get("p", f"/{name}")),
            }
    _cmd_index = idx
    return idx


@app.get("/api/commands")
async def api_commands(
    q: str = Query("", max_length=100),
    limit: int = Query(60, ge=1, le=2000),
    _: dict = Depends(require_user),
) -> dict[str, Any]:
    """Linux 命令检索：返回官方命令库中匹配的条目。"""
    idx = _load_cmd_index()
    kw = q.strip().lower()
    items = list(idx.values())
    if kw:
        items = [c for c in items if kw in c["name"].lower() or kw in c["desc"].lower()]
        items.sort(key=lambda c: (0 if c["name"].lower() == kw else 1, len(c["name"])))
    else:
        items.sort(key=lambda c: c["name"])
    return {"total": len(idx), "matched": len(items), "items": items[:limit]}


@app.get("/api/commands/{name}")
async def api_command_detail(name: str, _: dict = Depends(require_user)) -> dict[str, Any]:
    """返回某条命令的完整官方说明（Markdown 原文，前端安全渲染）。"""
    safe = _safe_component(name, "cmd")
    path = os.path.join(CMD_ROOT, f"{safe}.md")
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="未找到该命令的说明")
    with open(path, encoding="utf-8") as fh:
        md = fh.read()
    meta = _load_cmd_index().get(safe, {})
    return {"name": safe, "desc": meta.get("desc", ""), "markdown": md[:200000]}


# ------------------------------------------------------------------ PDF 翻译作业

TRANSLATE_DIR = os.getenv("LABSPACE_TRANSLATE_DIR", "/srv/labdata/translate")
TRANSLATE_MAX_BYTES = int(os.getenv("LABSPACE_TRANSLATE_MAX_BYTES", str(30 * 1024 * 1024)))
TRANSLATE_TIMEOUT = int(os.getenv("LABSPACE_TRANSLATE_TIMEOUT", "900"))


TRANSLATE_META_DIR = os.path.join(TRANSLATE_DIR, "meta")


def _job_paths(job_id: str) -> tuple[str, str, str]:
    return (
        os.path.join(TRANSLATE_DIR, "pending", f"{job_id}.pdf"),
        os.path.join(TRANSLATE_DIR, "done", f"{job_id}.json"),
        os.path.join(TRANSLATE_DIR, "done", f"{job_id}.zip"),
    )


def _translate_meta_path(job_id: str) -> str:
    return os.path.join(TRANSLATE_META_DIR, f"{job_id}.json")


def _remember_translate_owner(job_id: str, user: dict[str, Any]) -> None:
    """记录作业归属（工作进程只处理 pending/ 与 done/，不会碰 meta/）。"""
    os.makedirs(TRANSLATE_META_DIR, exist_ok=True)
    path = _translate_meta_path(job_id)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(
            {"owner": str(user.get("sub") or ""), "name": str(user.get("name") or "")},
            fh,
        )
    os.chmod(path, 0o644)


def _translate_job_allowed(job_id: str, user: dict[str, Any]) -> bool:
    if has_role(user, settings.admin_roles):
        return True
    try:
        with open(_translate_meta_path(job_id), encoding="utf-8") as fh:
            owner = str((json.load(fh) or {}).get("owner") or "")
    except (OSError, json.JSONDecodeError, AttributeError):
        return False
    return bool(owner) and owner == str(user.get("sub") or "")


@app.get("/api/pdf-translate/status")
async def api_translate_status(_: dict = Depends(require_user)) -> dict[str, Any]:
    """翻译服务运行状态（容器、队列深度）。"""
    pending = 0
    pdir = os.path.join(TRANSLATE_DIR, "pending")
    if os.path.isdir(pdir):
        pending = len([f for f in os.listdir(pdir) if f.endswith(".pdf")])
    return {"service": "pdf2zh", "pending": pending, "max_bytes": TRANSLATE_MAX_BYTES, "timeout": TRANSLATE_TIMEOUT}


@app.post("/api/pdf-translate/jobs")
async def api_translate_job(
    request: Request,
    user: dict = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    """上传 PDF 排队翻译（大小与类型均受限）。"""
    import uuid

    form = await request.form()
    upload = form.get("file")
    if upload is None or not hasattr(upload, "filename"):
        raise HTTPException(status_code=400, detail="缺少文件")
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail="文件为空")
    if len(data) > TRANSLATE_MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"文件超过上限 {TRANSLATE_MAX_BYTES // 1024 // 1024} MB")
    if not data.startswith(b"%PDF"):
        raise HTTPException(status_code=400, detail="仅支持 PDF 文件")
    job_id = str(uuid.uuid4())
    pdir = os.path.join(TRANSLATE_DIR, "pending")
    os.makedirs(pdir, exist_ok=True)
    path, _, _ = _job_paths(job_id)
    with open(path, "wb") as fh:
        fh.write(data)
    # 工作进程容器以非 root 用户运行，需可读
    os.chmod(path, 0o644)
    _remember_translate_owner(job_id, user)
    return {"job_id": job_id, "status": "queued", "size": len(data)}


@app.get("/api/pdf-translate/jobs/{job_id}")
async def api_translate_job_status(job_id: str, user: dict = Depends(require_user)) -> dict[str, Any]:
    import time as _t

    safe = _safe_component(job_id, "job")
    if not _translate_job_allowed(safe, user):
        raise HTTPException(status_code=404, detail="作业不存在")
    pending_path, done_json, done_zip = _job_paths(safe)
    if os.path.isfile(done_json):
        with open(done_json, encoding="utf-8") as fh:
            try:
                meta = json.load(fh)
            except json.JSONDecodeError:
                meta = {"status": "done"}
        meta["has_result"] = os.path.isfile(done_zip)
        return meta
    if os.path.isfile(pending_path):
        age = _t.time() - os.path.getmtime(pending_path)
        return {"status": "processing" if age > 5 else "queued", "age": int(age)}
    raise HTTPException(status_code=404, detail="作业不存在")


@app.get("/api/pdf-translate/jobs/{job_id}/result")
async def api_translate_result(job_id: str, user: dict = Depends(require_user)):
    from fastapi.responses import FileResponse

    safe = _safe_component(job_id, "job")
    if not _translate_job_allowed(safe, user):
        raise HTTPException(status_code=404, detail="作业不存在")
    _, _, done_zip = _job_paths(safe)
    if not os.path.isfile(done_zip):
        raise HTTPException(status_code=404, detail="结果尚未生成")
    return FileResponse(done_zip, media_type="application/zip", filename=f"translated-{safe}.zip")


# ------------------------------------------------------------------ 公告

@app.get("/api/announcements")
async def api_announcements(_: dict = Depends(require_user)) -> dict[str, Any]:
    return {"announcements": db.list_announcements()}


@app.post("/api/announcements")
async def api_add_announcement(
    request: Request,
    user: dict = Depends(require_admin),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    payload = await request.json()
    title = str(payload.get("title") or "").strip()[:120]
    content = str(payload.get("content") or "").strip()[:4000]
    level = str(payload.get("level") or "info")[:16]
    if not title or not content:
        raise HTTPException(status_code=400, detail="标题与内容不能为空")
    row = db.add_announcement(title, content, level, user.get("email") or user.get("name") or "admin")
    # 企业微信推送是尽力而为：失败只记日志，不能让公告发布跟着失败。
    asyncio.create_task(wecom_mod.notify_announcement(title, content, level))
    return {"ok": True, "announcement": row}


@app.delete("/api/announcements/{aid}")
async def api_delete_announcement(
    aid: str, user: dict = Depends(require_admin), _: None = Depends(require_csrf)
) -> dict[str, Any]:
    db.delete_announcement(_safe_component(aid, "a"))
    return {"ok": True}


# ------------------------------------------------------------------ 基础


@app.get("/api/health")
async def api_health() -> dict[str, Any]:
    return {"status": "ok", "service": "labspace-backend", "version": app.version}


_DISPATCH_ROLES = {"lab-teacher", "lab-postdoc", "lab-phd", "lab-master", "lab-undergrad"}


def _can_dispatch(roles: list[str]) -> bool:
    names = {str(r).lower() for r in roles}
    admin = {str(r).lower() for r in settings.admin_roles}
    return bool(names & admin or names & _DISPATCH_ROLES)


@app.get("/api/me")
async def api_me(user: dict[str, Any] | None = Depends(current_user)) -> dict[str, Any]:
    if not user:
        return {"authenticated": False}
    roles = user.get("roles", [])
    return {
        "authenticated": True,
        "id": user.get("sub"),
        "email": user.get("email"),
        "name": user.get("name"),
        "roles": roles,
        "isAdmin": any(r.lower() in [x.lower() for x in settings.admin_roles] for r in roles),
        "isTeacher": any(
            r.lower() in [x.lower() for x in settings.admin_roles + settings.teacher_roles]
            for r in roles
        ),
        "canDispatch": _can_dispatch(roles),
    }


# ------------------------------------------------------------------ 每日一言

_SAYING_CACHE: dict[str, str] = {"day": "", "text": ""}
_SAYING_FALLBACK = "保持热爱，奔赴山海。"


@app.get("/api/saying")
async def api_saying() -> dict[str, Any]:
    """每日一言（uapis.cn）。按自然日缓存，刷新页面不会换句子。"""
    import httpx
    from datetime import date

    today = date.today().isoformat()
    if _SAYING_CACHE.get("day") == today and _SAYING_CACHE.get("text"):
        return {"text": _SAYING_CACHE["text"], "date": today, "cached": True}
    try:
        async with httpx.AsyncClient(timeout=6, follow_redirects=True) as client:
            resp = await client.get("https://uapis.cn/api/v1/saying")
            resp.raise_for_status()
            text = str(resp.json().get("text") or "").strip()
        if text:
            _SAYING_CACHE.update(day=today, text=text)
            return {"text": text, "date": today, "cached": False}
    except Exception:  # noqa: BLE001 - 外部语料不可用不应影响首页
        pass
    return {"text": _SAYING_CACHE.get("text") or _SAYING_FALLBACK, "date": today, "cached": True}


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
    """按用户实际访问的主机名生成基址（IP 直连或域名皆可）。"""
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    proto = request.headers.get("x-forwarded-proto", "http")
    return f"{proto}://{host}" if host else settings.public_url


def _client_host(request: Request) -> str:
    """用户当前实际访问的主机名（不含端口）。

    用于“服务地址自适应”：从 192.0.2.10 进来就给出 192.0.2.10 的服务地址，
    从 Tailscale IP 进来就给出 Tailscale IP 的服务地址。
    """
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    return host.split(":")[0].strip()


@app.get("/api/auth/login")
async def api_login(request: Request) -> RedirectResponse:
    redirect_uri = f"{_request_base(request)}/api/auth/callback"
    issuer = _casdoor_issuer(request)
    state = casdoor.new_state(redirect_uri=redirect_uri, issuer=issuer)
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
    user = casdoor.normalize_user(merged)  # noqa: F841  (供会话签发使用)
    if not user["email"]:
        raise HTTPException(status_code=400, detail="OIDC 未返回邮箱，无法建立身份")

    # 回调后回到用户实际访问的主机名（IP 直连或域名都用同一入口）
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    proto = request.headers.get("x-forwarded-proto", "http")
    base = f"{proto}://{host}" if host else settings.public_url
    resp = RedirectResponse(f"{base}/", status_code=302)
    set_session_cookies(resp, issue_session(user))
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
async def api_services(request: Request, user: dict[str, Any] | None = Depends(current_user)) -> dict[str, Any]:
    """服务目录。

    已由 Go 核心接管：nginx 将 ``/api/services`` 转发到 LabGo 的 ``/v1/services``。
    本路由保留仅为兼容直连后端端口（127.0.0.1:8088）的旧客户端。
    """
    services = visible_services(user, host=_client_host(request))
    return {"services": services, "count": len(services)}


@app.get("/api/services/{service_id}/health")
@app.get("/v1/services/{service_id}/health")
async def api_service_health(service_id: str) -> dict[str, Any]:
    """单服务健康状态（由 Go 核心 ``internal/health`` 执行探测）。"""
    if not any(s.id == service_id for s in load_catalog()):
        raise HTTPException(status_code=404, detail="服务不存在")
    if not settings.enable_health:
        return {"status": "unknown", "detail": "健康检查已关闭"}
    return await go_service_health(service_id)


@app.get("/api/services/health")
@app.get("/v1/services/health")
async def api_services_health(request: Request, user: dict[str, Any] | None = Depends(current_user)) -> dict[str, Any]:
    """批量健康状态（外部服务故障归外部主机）。"""
    import asyncio

    services = visible_services(user, host=_client_host(request))
    results = await asyncio.gather(*[go_service_health(svc["id"]) for svc in services])
    out = []
    for svc, health in zip(services, results):
        # 外部内网服务的故障归外部主机，不计入本机巡检失败
        if svc.get("external") and health.get("status") == "down":
            health = {**health, "status": "external-down", "detail": (health.get("detail") or "") + "（外部内网服务，需在 192.0.2.29 上恢复）"}
        out.append({**svc, "health": health})
    return {"services": out}


# ------------------------------------------------------------------ 收藏 / 最近


@app.get("/api/favorites")
@app.get("/v1/favorites")
async def api_favorites(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    return {"favorites": db.list_favorites(user["sub"])}


@app.post("/api/favorites/{service_id}")
@app.post("/v1/favorites/{service_id}")
async def api_add_favorite(service_id: str, user: dict = Depends(require_user), __: None = Depends(require_csrf)) -> dict[str, Any]:
    if not any(s.id == service_id for s in load_catalog()):
        raise HTTPException(status_code=404, detail="服务不存在")
    db.add_favorite(user["sub"], service_id)
    return {"ok": True, "favorites": db.list_favorites(user["sub"])}


@app.delete("/api/favorites/{service_id}")
@app.delete("/v1/favorites/{service_id}")
async def api_remove_favorite(
    service_id: str, user: dict[str, Any] = Depends(require_user), __: None = Depends(require_csrf)
) -> dict[str, Any]:
    db.remove_favorite(user["sub"], service_id)
    return {"ok": True, "favorites": db.list_favorites(user["sub"])}


@app.get("/api/recent")
@app.get("/v1/recent")
async def api_recent(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    return {"recent": db.list_recent(user["sub"])}


@app.post("/api/recent/{service_id}")
@app.post("/v1/recent/{service_id}")
async def api_touch_recent(
    service_id: str, user: dict[str, Any] = Depends(require_user), __: None = Depends(require_csrf)
) -> dict[str, Any]:
    db.touch_recent(user["sub"], service_id)
    return {"ok": True}


# ------------------------------------------------------------------ 植物数据库目录

@app.get("/api/databases")
async def api_databases(
    q: str = Query("", max_length=100),
    category: str = Query(""),
    _: dict = Depends(require_user_or_service),
) -> dict[str, Any]:
    """植物领域数据库/资源目录检索（本地数据，不出网）。"""
    items = search_databases(q, category)
    api_map = {entry["id"]: entry for entry in db_apis.api_index()}
    for item in items:
        entry = api_map.get(item["id"])
        item["api"] = {
            "hasApi": bool(entry and entry["hasApi"]),
            "name": entry["api"]["name"] if entry and entry["api"] else "",
            "summary": entry["api"]["summary"] if entry and entry["api"] else "",
            "queryHint": entry["api"]["queryHint"] if entry and entry["api"] else "",
            "kind": entry["api"]["kind"] if entry and entry["api"] else "",
            "note": entry["note"] if entry else "",
        }
    return {"total": len(PLANT_DATABASES), "matched": len(items), "categories": CATEGORIES, "items": items}


@app.get("/api/databases/apis")
async def api_databases_apis(_: dict = Depends(require_user_or_service)) -> dict[str, Any]:
    """数据库 API 能力清单（含无 API 的原因说明）。"""
    entries = db_apis.api_index()
    statuses = await db_apis.probe_all()
    for entry in entries:
        if entry["hasApi"]:
            ok, detail = statuses.get(entry["id"], (False, "未探测"))
            entry["api"]["available"] = ok
            entry["api"]["statusDetail"] = detail
    summary = db_apis.api_summary()
    summary["items"] = entries
    return summary


@app.post("/api/databases/{db_id}/query")
async def api_databases_query(
    db_id: str,
    payload: dict[str, Any] = Body(default_factory=dict),
    _: dict = Depends(require_user_or_service),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    """对指定数据库执行一次真实 API 查询（服务端代理）。"""
    query = str(payload.get("query") or "").strip()
    limit = int(payload.get("limit") or 5)
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
            async with httpx.AsyncClient(timeout=8, follow_redirects=True) as client:
                resp = await client.get(target)
                return resp.status_code < 400, f"HTTP {resp.status_code}"
        except Exception as exc:  # noqa: BLE001
            return False, type(exc).__name__

    results = await asyncio.gather(*[probe(u["url"], u["path"]) for u in entries])
    items = [
        {"name": e["name"], "url": e["url"], "up": up, "detail": detail}
        for e, (up, detail) in zip(entries, results)
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


# ------------------------------------------------------------------ 检索 / 文献代理

# 门户对外暴露的检索分类与别名统一放在 app/searchconfig.py，
# 与 Go 核心（LabGo）共用同一份数据，避免两端分类名漂移。
SEARCH_CATEGORIES: list[dict[str, str]] = _SEARCH_CATEGORIES
_CATEGORY_ALIASES: dict[str, str] = _CATEGORY_ALIASES


async def _rerank_local(query: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """本地命中统一交给 bge-reranker 定序；联网结果保持原序并排在后面。

    重排只影响顺序，不增删条目；模型不可用时 semantic.reorder 原样返回，
    条目上带 fusion=keyword，前端可据此展示匹配方式。
    """
    local = [item for item in items if item.get("kind") == "local"]
    if len(local) < 2:
        return items
    try:
        ordered = await semantic_mod.reorder(
            query,
            local,
            lambda item: f"{item.get('title') or ''}\n{item.get('content') or ''}",
            timeout=5.0,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("本地检索重排不可用：%s", exc)
        return items
    others = [item for item in items if item.get("kind") != "local"]
    return ordered + others


@app.get("/api/search/categories")
@app.get("/v1/portal/search/categories")
async def api_search_categories(_: dict = Depends(require_user_or_service)) -> dict[str, Any]:
    """检索分类清单，前端据此渲染分类切换，避免前后端分类名漂移。"""
    data = await go_search_categories()
    if data:
        return data
    return {"categories": SEARCH_CATEGORIES, "default": "general"}


@app.get("/api/search")
@app.get("/v1/portal/search")
async def api_search(
    request: Request,
    q: str = Query(..., min_length=1, max_length=200),
    categories: str = Query("general"),
    scope: str = Query("web"),
    user: dict = Depends(require_user_or_service),
) -> dict[str, Any]:
    """统一搜索。

    scope=web      仅联网结果（SearXNG 聚合）
    scope=local    仅本地语料（服务 / 数据库 / 命令 / 工具 / 页面）
    scope=all      两者合并（本地命中置顶）

    categories 透传给 SearXNG：general / science / scientific publications / images / videos / it / news / books
    """
    categories = normalize_category(categories)
    scope = (scope or "web").lower()

    # 知识条目是按人可见的，只能在 Python 侧用调用者会话现查，不能进 Go 核心的全局语料索引。
    knowledge_hits: list[dict[str, Any]] = []
    if scope in ("local", "all") and not user.get("is_service"):
        try:
            knowledge_hits = await knowledge_mod.search_hits(q, user, limit=8)
        except Exception as exc:  # noqa: BLE001 - 联动失败不能拖垮搜索
            log.warning("知识库检索联动失败：%s", exc)

    # Go 核心（LabGo）已经接管统一搜索：本地语料 + SearXNG 联网结果。
    # 只有在 Go 核心不可达时才回退到本模块的实现。
    go_result = await go_portal_search(q, categories, scope)
    if go_result is not None:
        if knowledge_hits:
            merged = knowledge_hits + list(go_result.get("results") or [])
            go_result["results"] = merged
            go_result["localTotal"] = int(go_result.get("localTotal") or 0) + len(knowledge_hits)
            go_result["count"] = len(merged)
        go_result["results"] = await _rerank_local(q, list(go_result.get("results") or []))
        return go_result

    web_results: list[dict[str, Any]] = []
    engines: list[str] | None = None
    web_error: str | None = None

    if scope in ("web", "all"):
        try:
            async with httpx.AsyncClient(timeout=45) as client:
                resp = await client.get(
                    # 容器内用服务名访问 SearXNG（127.0.0.1 指向容器自身）
                    "http://lab-searxng:8080/search",
                    params={"q": q, "format": "json", "categories": categories},
                )
                resp.raise_for_status()
                data = resp.json()
            engines = data.get("engines")
            web_results = [
                {
                    "title": r.get("title"),
                    "url": r.get("url"),
                    "content": (r.get("content") or "")[:500],
                    "engine": r.get("engine"),
                    "category": r.get("category"),
                    "kind": "web",
                }
                for r in (data.get("results") or [])[:20]
            ]
        except Exception as exc:  # noqa: BLE001
            web_error = f"检索服务暂时不可用（{type(exc).__name__}）"
            if scope == "web":
                raise HTTPException(status_code=502, detail=web_error) from exc

    # 本地统一语料命中（engine=d509），覆盖服务/数据库/命令/工具/页面
    # 统一搜索使用更多条目：本地命中上限从 12 提升到 30
    local_hits = corpus_mod.search_corpus(q, limit=30) if scope in ("local", "all") else []
    local_results = [
        {
            "title": hit["title"] if hit["type"] != "database" else f"{hit['title']} · {hit['subtitle']}".strip(" ·"),
            "url": adapt_host(hit["url"], _client_host(request)),
            "content": hit["description"] or hit["subtitle"],
            "engine": "d509",
            "category": hit["type"],
            "kind": "local",
            "path": hit["path"],
        }
        for hit in local_hits
    ]
    local_results = await _rerank_local(q, knowledge_hits + local_results)

    results = local_results + web_results if scope == "all" else (local_results if scope == "local" else web_results)

    # 兼容旧字段：local 仍返回植物数据库命中
    local_dbs = search_databases(q)
    return {
        "query": q,
        "categories": categories,
        "scope": scope,
        "count": len(results),
        "results": results,
        "engines": engines,
        "error": web_error,
        "local": [
            {"id": d["id"], "name": d["name"], "cn": d.get("cn", ""), "url": d["url"], "category": d["category"]}
            for d in local_dbs[:16]
        ],
        "hot": corpus_mod.hot_keywords(),
    }


@app.get("/api/search/suggest")
@app.get("/v1/corpus/suggest")
async def api_search_suggest(
    request: Request,
    q: str = Query("", max_length=100),
    limit: int = Query(10, ge=1, le=20),
    _: dict = Depends(require_user),
) -> dict[str, Any]:
    """搜索建议（输入框联想）。"""
    data = await go_corpus_suggest(q, limit=limit)
    if data:
        return {
            "suggestions": adapt_host(data.get("suggestions") or [], _client_host(request)),
            "hot": data.get("hot") or [],
        }
    return {
        "suggestions": adapt_host(corpus_mod.suggest(q, limit=limit), _client_host(request)),
        "hot": corpus_mod.hot_keywords(),
    }


@app.get("/api/corpus")
@app.get("/v1/corpus")
async def api_corpus(
    request: Request,
    q: str = Query("", max_length=100),
    limit: int = Query(30, ge=1, le=100),
    _: dict = Depends(require_user),
) -> dict[str, Any]:
    """统一语料查询（命令面板 / 全局直达）。"""
    kw = q.strip()
    data = await go_corpus_query(kw, limit)
    if data is not None:
        items = adapt_host(data.get("items") or [], _client_host(request))
        return {"query": data.get("query", kw), "count": len(items), "items": items}
    if not kw:
        # 空查询：按类型配额均衡展示，避免某一类把面板洗掉
        buckets: dict[str, list[dict[str, Any]]] = {}
        for e in corpus_mod.corpus():
            cap = corpus_mod.TYPE_CAPS.get(e.type, 4)
            arr = buckets.setdefault(e.type, [])
            if len(arr) < cap:
                arr.append(
                    {
                        "type": e.type,
                        "id": e.id,
                        "title": e.title,
                        "subtitle": e.subtitle,
                        "path": e.path,
                        "url": e.url,
                    }
                )
        order = ["page", "service", "tool", "snapotter", "database", "command"]
        items: list[dict[str, Any]] = []
        for t in order:
            items.extend(buckets.get(t, []))
        items = adapt_host(items[:limit], _client_host(request))
        return {"query": "", "count": len(items), "items": items}
    items = adapt_host(corpus_mod.search_corpus(kw, limit=limit), _client_host(request))
    return {"query": kw, "count": len(items), "items": items}


# ------------------------------------------------------------------ SnapOtter 代理

#: SnapOtter 作业归属（只在内存里记近期的，重启后旧作业仅管理员可查）。
_SNAPOTTER_JOB_OWNERS: dict[str, str] = {}
_SNAPOTTER_JOB_OWNERS_MAX = 4096


def _remember_snapotter_owner(job_id: str, user: dict[str, Any]) -> None:
    if not job_id:
        return
    if len(_SNAPOTTER_JOB_OWNERS) >= _SNAPOTTER_JOB_OWNERS_MAX:
        _SNAPOTTER_JOB_OWNERS.pop(next(iter(_SNAPOTTER_JOB_OWNERS)), None)
    _SNAPOTTER_JOB_OWNERS[job_id] = str(user.get("sub") or "")


def _snapotter_job_allowed(job_id: str, user: dict[str, Any]) -> bool:
    if has_role(user, settings.admin_roles):
        return True
    owner = _SNAPOTTER_JOB_OWNERS.get(job_id)
    return bool(owner) and owner == str(user.get("sub") or "")


@app.get("/api/snapotter/status")
async def api_snapotter_status(_: dict = Depends(require_user)) -> dict[str, Any]:
    """SnapOtter 服务探活 + 工具总数。"""
    ok, detail = await snapotter_mod.probe()
    tools: list[dict[str, Any]] = []
    if ok:
        try:
            tools = await snapotter_mod.get_tool_catalog()
        except Exception:  # noqa: BLE001
            tools = []
    return {
        "configured": snapotter_mod.is_configured(),
        "up": ok,
        "detail": detail,
        "toolCount": len(tools),
        "baseUrl": snapotter_mod.SNAPOTTER_BASE,
    }


@app.get("/api/snapotter/tools")
async def api_snapotter_tools(_: dict = Depends(require_user)) -> dict[str, Any]:
    """工具目录（原生 REST 调用，不使用 iframe）。"""
    try:
        tools = await snapotter_mod.get_tool_catalog()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"SnapOtter 工具目录不可用（{type(exc).__name__}）") from exc
    return {"tools": tools, "count": len(tools)}


@app.post("/api/snapotter/run")
async def api_snapotter_run(
    section: str = Query(..., min_length=1, max_length=64),
    tool_id: str = Query(..., min_length=1, max_length=96),
    file: UploadFile = File(...),
    settings_json: str = Form("{}"),
    user: dict = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    """上传单个文件并提交 SnapOtter 处理任务。"""
    # 分块读取并在超限时立即中断：避免先把整个文件读进内存再检查大小
    content = await _read_upload_capped(file, snapotter_mod.MAX_UPLOAD)
    if not content:
        raise HTTPException(status_code=400, detail="上传文件为空")
    try:
        result = await snapotter_mod.submit_tool(
            section=section,
            tool_id=tool_id,
            filename=file.filename or "input.bin",
            content=content,
            settings_json=settings_json or "{}",
            content_type=file.content_type or "application/octet-stream",
        )
    except ValueError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"SnapOtter 处理失败（{type(exc).__name__}）") from exc
    _remember_snapotter_owner(str(result.get("jobId") or result.get("job_id") or ""), user)
    return result


@app.get("/api/snapotter/jobs/{job_id}")
async def api_snapotter_job(job_id: str, user: dict = Depends(require_user)) -> dict[str, Any]:
    """任务状态（门户轮询用，替代 SnapOtter 的 SSE）。"""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", job_id or ""):
        raise HTTPException(status_code=400, detail="作业 ID 非法")
    if not _snapotter_job_allowed(job_id, user):
        raise HTTPException(status_code=404, detail="作业不存在")
    try:
        return await snapotter_mod.job_status(job_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"任务状态查询失败（{type(exc).__name__}）") from exc


@app.get("/api/snapotter/pipelines")
async def api_snapotter_pipelines(_: dict = Depends(require_user)) -> dict[str, Any]:
    """流水线列表。"""
    try:
        return await snapotter_mod.list_pipelines()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"流水线查询失败（{type(exc).__name__}）") from exc


@app.get("/api/snapotter/download")
async def api_snapotter_download(url: str = Query(..., min_length=1), _: dict = Depends(require_user)):
    """代理下载 SnapOtter 处理结果（API Key 不下发到浏览器）。"""
    try:
        content, name = await snapotter_mod.download(url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"结果下载失败（{type(exc).__name__}）") from exc
    return Response(
        content=content,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


@app.get("/api/literature")
async def api_literature(
    q: str = Query(..., min_length=1, max_length=200),
    source: str = Query("pubmed"),
    _: dict = Depends(require_user),
) -> dict[str, Any]:
    """代理科研检索 API（PubMed / Europe PMC / Crossref / UniProt / NCBI Gene）。"""
    # q 必须做 URL 编码：直接 f-string 拼接会让 & / # / 空格等字符篡改上游
    # 查询串（例如 q="x&rows=999" 或注入额外参数）。改用 params 由 httpx 编码。
    sources = {
        "pubmed": ("/tools/pubmed/search", {"query": q, "retmax": 8}),
        "europepmc": ("/tools/europepmc/search", {"query": q, "page_size": 8}),
        "crossref": ("/tools/crossref/search", {"query": q, "rows": 8}),
        "uniprot": ("/tools/uniprot/search", {"query": q, "size": 8}),
        "gene": ("/tools/ncbi/gene", {"query": q, "retmax": 8}),
    }
    if source not in sources:
        raise HTTPException(status_code=400, detail="不支持的检索源")
    path, params = sources[source]
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get("http://lab-research-api:8000" + path, params=params)
            resp.raise_for_status()
            return resp.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"文献服务不可用: {type(exc).__name__}") from exc


# ------------------------------------------------------------------ 绘图（受控保存）

XML_FORBIDDEN = re.compile(r"<!DOCTYPE|<!ENTITY|<script|javascript:", re.IGNORECASE)


def _validate_drawing_xml(content: str) -> str:
    if len(content.encode()) > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="图形文件过大")
    if XML_FORBIDDEN.search(content):
        raise HTTPException(status_code=400, detail="图形内容包含不允许的构造")
    if "<svg" not in content and "<mxfile" not in content and "<mxGraphModel" not in content:
        raise HTTPException(status_code=400, detail="不是有效的 draw.io 图形内容")
    return content


@app.get("/api/drawings")
async def api_list_drawings(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    return {"drawings": db.list_drawings(user["sub"])}


@app.get("/api/drawings/{drawing_id}")
async def api_get_drawing(drawing_id: str, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    row = db.get_drawing(user["sub"], drawing_id)
    if not row:
        raise HTTPException(status_code=404, detail="图形不存在")
    return row


@app.post("/api/drawings")
async def api_save_drawing(
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    payload = await request.json()
    name = _safe_component(str(payload.get("name") or "diagram"), "diagram")
    content = _validate_drawing_xml(str(payload.get("content") or ""))
    row = db.save_drawing(user["sub"], name, content)
    return {"ok": True, **row}


@app.put("/api/drawings/{drawing_id}")
async def api_update_drawing(
    drawing_id: str,
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    payload = await request.json()
    name = _safe_component(str(payload.get("name") or "diagram"), "diagram")
    content = _validate_drawing_xml(str(payload.get("content") or ""))
    db.update_drawing(user["sub"], _safe_component(drawing_id, "d"), name, content)
    return {"ok": True}


@app.post("/api/drawings/{drawing_id}/rename")
async def api_rename_drawing(
    drawing_id: str,
    request: Request,
    user: dict = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    payload = await request.json()
    name = _safe_component(str(payload.get("name") or "diagram"), "diagram")
    db.rename_drawing(user["sub"], _safe_component(drawing_id, "d"), name)
    return {"ok": True, "name": name}


@app.get("/api/drawings/{drawing_id}/download")
async def api_download_drawing(drawing_id: str, user: dict = Depends(require_user)):
    from fastapi.responses import Response

    row = db.get_drawing(user["sub"], _safe_component(drawing_id, "d"))
    if not row:
        raise HTTPException(status_code=404, detail="图形不存在")
    return Response(
        content=row["content"],
        media_type="application/xml",
        headers={"Content-Disposition": f'attachment; filename="{row["name"]}.drawio"'},
    )


@app.delete("/api/drawings/{drawing_id}")
async def api_delete_drawing(
    drawing_id: str, user: dict[str, Any] = Depends(require_user), _: None = Depends(require_csrf)
) -> dict[str, Any]:
    db.delete_drawing(user["sub"], drawing_id)
    return {"ok": True}


@app.post("/api/drawings/{drawing_id}/export")
async def api_export_drawing(
    drawing_id: str,
    request: Request,
    user: dict[str, Any] = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    """把图形写入用户自己的实验室文件目录（受控路径 + 内容校验）。"""
    row = db.get_drawing(user["sub"], drawing_id)
    if not row:
        raise HTTPException(status_code=404, detail="图形不存在")
    payload = await request.json()
    content = _validate_drawing_xml(str(payload.get("content") or row["content"]))
    name = _safe_component(str(payload.get("name") or row["name"]), "diagram")
    if not name.endswith(".drawio"):
        name += ".drawio"
    target_dir = os.path.join(_ensure_user_dir(user), "drawio")
    os.makedirs(target_dir, mode=0o700, exist_ok=True)
    _grant_user_acl(target_dir)
    path = os.path.join(target_dir, name)
    real = os.path.realpath(path)
    if not real.startswith(os.path.realpath(target_dir) + os.sep):
        raise HTTPException(status_code=400, detail="非法路径")
    with open(real, "w", encoding="utf-8") as fh:
        fh.write(content)
    os.chmod(real, 0o640)
    return {"ok": True, "path": real, "note": "已写入个人目录，可在文件管理中查看"}


# ------------------------------------------------------------------ 管理端


@app.get("/api/admin/info")
async def api_admin_info(user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    import platform

    def run(cmd: list[str]) -> str:
        try:
            return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout.strip()
        except Exception:  # noqa: BLE001
            return ""

    disk = shutil.disk_usage("/srv/labdata") if os.path.isdir("/srv/labdata") else shutil.disk_usage("/")
    containers = []
    if os.path.exists("/var/run/docker.sock"):
        out = run(["docker", "ps", "--format", "{{.Names}}\t{{.Status}}\t{{.Image}}"])
        containers = [l for l in out.splitlines() if l.strip()]
    return {
        "host": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "hostname": platform.node(),
        },
        "disk": {
            "total": disk.total,
            "used": disk.used,
            "free": disk.free,
        },
        "containers": containers,
        "casdoor": {"issuer": settings.issuer, "clientId": settings.client_id},
        "roles": {"admin": settings.admin_roles, "teacher": settings.teacher_roles},
    }


@app.get("/api/admin/backups")
async def api_admin_backups(user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    """备份状态由宿主机备份脚本写入只读目录，容器不接触仓库与口令。"""
    status_path = "/srv/labgo/backup-status.json"
    try:
        with open(status_path, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return {"available": False, "detail": "尚未产生备份记录", "snapshots": []}
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"备份状态读取失败：{exc}") from exc
    data["available"] = True
    return data


@app.get("/api/admin/health")
async def api_admin_health(user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    """全量服务健康（探测由 Go 核心执行）。"""
    import asyncio

    services = load_catalog()
    results = await asyncio.gather(*[go_service_health(s.id) for s in services])
    return {
        "services": [
            {"id": s.id, "name": s.name, "category": s.category, "health": h} for s, h in zip(services, results)
        ]
    }


@app.exception_handler(HTTPException)
async def http_exc_handler(request: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
