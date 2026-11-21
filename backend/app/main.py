"""LabSpace 后端入口（FastAPI）。

职责边界：OIDC 会话、用户身份、服务目录与健康检查、收藏/最近访问、
受控的绘图文件保存，以及管理端只读系统信息。不承担第二套认证/文件系统/容器编排。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import time
import urllib.parse
from datetime import date
from typing import Any
from urllib.parse import urlsplit

import httpx
from starlette.concurrency import run_in_threadpool

from fastapi import (
    Body,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse

from . import (
    account_security as account_security,
)
from . import (
    audit as audit,
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
    literature_sources as literature_mod,
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
    semantic as semantic_mod,
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
from .catalog import adapt_host, load_catalog, visible_services
from .config import settings
from .databases import CATEGORIES, PLANT_DATABASES, search_databases
from .golink import corpus_query as go_corpus_query
from .golink import corpus_suggest as go_corpus_suggest
from .golink import portal_search as go_portal_search
from .golink import search_categories as go_search_categories
from .golink import service_health as go_service_health
from .searchconfig import SEARCH_CATEGORIES as _SEARCH_CATEGORIES
from .searchconfig import normalize_category
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
from .uploads import read_upload_capped as _read_upload_capped

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
        try:
            with open(data_path, encoding="utf-8") as fh:
                raw = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            # 索引文件损坏/读不到时退化成空索引：命令库只是辅助资料，
            # 不该让整个门户因为一个静态文件挂掉。
            log.warning("命令索引不可用（%s）：%s", data_path, exc)
            raw = {}
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
    try:
        with open(path, encoding="utf-8") as fh:
            md = fh.read()
    except OSError as exc:
        raise HTTPException(status_code=404, detail="未找到该命令的说明") from exc
    meta = _load_cmd_index().get(safe, {})
    return {"name": safe, "desc": meta.get("desc", ""), "markdown": md[:200000]}


# ------------------------------------------------------------------ PDF 翻译作业

TRANSLATE_DIR = os.getenv("LABSPACE_TRANSLATE_DIR", "/srv/labdata/translate")
def _env_int(name: str, default: int) -> int:
    """读整数型环境变量；配错时退回默认值并记警告。

    直接 int() 的话，一个写错的环境变量会让**整个模块 import 失败**，
    表现是后端容器起不来（而不是"这个功能用不了"）。
    """
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError:
        log.warning("%s 不是合法整数（%r），使用默认值 %d", name, raw, default)
        return default
    return value if value > 0 else default


TRANSLATE_MAX_BYTES = _env_int("LABSPACE_TRANSLATE_MAX_BYTES", 30 * 1024 * 1024)
TRANSLATE_TIMEOUT = _env_int("LABSPACE_TRANSLATE_TIMEOUT", 900)


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
    try:
        os.makedirs(TRANSLATE_META_DIR, exist_ok=True)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"无法准备作业归属目录：{exc}") from exc
    path = _translate_meta_path(job_id)
    try:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(
                {"owner": str(user.get("sub") or ""), "name": str(user.get("name") or "")},
                fh,
            )
        os.chmod(path, 0o644)
    except OSError as exc:
        # 归属信息写不进去就意味着作业会变成"无主"，后台无法按人过滤；
        # 这种情况下必须让请求失败，而不是排一个谁都能看的作业。
        raise HTTPException(status_code=500, detail=f"无法记录作业归属：{exc}") from exc


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
        try:
            pending = len([f for f in os.listdir(pdir) if f.endswith(".pdf")])
        except OSError as exc:
            log.debug("读取翻译队列失败: %s", exc)
            pending = 0
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
    # request.form() 的值类型是 str | UploadFile；只接受真正的上传对象，
    # 这样下面的 .read() 在类型检查与运行时都成立。
    if not isinstance(upload, UploadFile):
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
    try:
        os.makedirs(pdir, exist_ok=True)
        path, _, _ = _job_paths(job_id)
        with open(path, "wb") as fh:
            fh.write(data)
        # 工作进程容器以非 root 用户运行，需可读
        os.chmod(path, 0o644)
    except OSError as exc:
        # 写不进去就必须让请求失败：否则会出现"排队成功"但工作进程永远等不到文件。
        raise HTTPException(status_code=500, detail=f"无法写入翻译队列：{exc}") from exc
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
        try:
            with open(done_json, encoding="utf-8") as fh:
                loaded = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            # 元数据损坏：按"已完成但内容未知"处理，比报 500 更贴近实际。
            log.warning("翻译作业元数据不可用 %s: %s", done_json, exc)
            loaded = {"status": "done"}
        # json.load 的静态类型是 Any；显式收窄成 dict 后再写入布尔字段，
        # 既让类型检查说得清，也避免 JSON 顶层不是对象时直接崩。
        meta: dict[str, Any] = loaded if isinstance(loaded, dict) else {"status": "done"}
        meta["has_result"] = os.path.isfile(done_zip)
        return meta
    if os.path.isfile(pending_path):
        try:
            age = max(0.0, _t.time() - os.path.getmtime(pending_path))
        except OSError as exc:
            log.warning("读取翻译作业时间失败: %s", exc)
            age = 0.0
        # age 已是 float，用 round 直接得到整数秒（避免再套一层 int()）
        return {"status": "processing" if age > 5 else "queued", "age": round(age)}
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


def _host_allowed(host: str) -> bool:
    """入口主机是否在白名单内。

    只采信 ``LABSPACE_ALLOWED_HOSTS`` 里的主机名：门户坚持 IP + 端口直连，
    合法入口就那几个 IP / localhost，没必要把任意 Host 当成可拼接入站地址的输入。
    白名单为空（未配置）时退回“只认默认入口主机”，宁严不宽。
    """
    h = (host or "").lower().strip().strip(".")
    if not h:
        return False
    allowed = tuple(x.lower().strip() for x in settings.allowed_hosts) or (
        settings.default_entry_host.lower(),
    )
    return h in allowed


def _client_host(request: Request) -> str:
    """用户当前实际访问的主机名（不含端口）。

    用于“服务地址自适应”：从 192.0.2.10 进来就给出 192.0.2.10 的服务地址，
    从 Tailscale IP 进来就给出 Tailscale IP 的服务地址。

    只采信白名单内的主机：``X-Forwarded-Host`` / ``Host`` 是客户端可控的头，
    未经校验就拼进后续出站 URL 会变成 SSRF（比如伪造 ``169.254.169.254``）。
    非法值一律回落到默认入口主机。
    """
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    name = host.split(":")[0].strip()
    if _host_allowed(name):
        return name
    return settings.default_entry_host



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
    user = casdoor.normalize_user(merged)  # noqa: F841  (供会话签发使用)
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
    for svc, health in zip(services, results, strict=True):
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


# ------------------------------------------------------------------ 检索 / 文献代理

# 门户对外暴露的检索分类与别名统一放在 app/searchconfig.py，
# 与 Go 核心（LabGo）共用同一份数据，避免两端分类名漂移。
SEARCH_CATEGORIES: list[dict[str, str]] = _SEARCH_CATEGORIES

# 「论文」类别：与 SearXNG 的 "scientific publications" 并列，走文献源
# （OpenAlex → Semantic Scholar → Crossref 降级 + arXiv）。
# 分类名必须在 normalize_category 之前判断，因为 "papers" 会被别名表映射成
# "scientific publications"，映射后就分不出是不是用户要了文献源。
# 前端分类切换器用的是 searchconfig.py 里的「论文」键（scientific publications），
# 与 Go 侧共用；这里把它一并视为文献类别，避免"界面有论文、后端不认"的漂移。
LITERATURE_CATEGORY_TOKENS = {"papers", "literature", "scientific publications"}
LITERATURE_RESULT_LIMIT = 20


async def _search_literature(q: str, limit: int = LITERATURE_RESULT_LIMIT) -> tuple[list[dict[str, Any]], list[str]]:
    """统一搜索的「论文」类别。

    文献源失败只降级该类别（返回空条目 + degraded 标记），绝不让整个搜索 500。
    返回 (条目列表, 降级类别列表)。
    """
    try:
        result = await literature_mod.search(q, limit)
    except Exception as exc:  # noqa: BLE001 - 文献源挂掉不能拖垮整个搜索
        log.warning("文献源检索失败：%s", exc)
        return [], ["papers"]
    if not result.papers or result.source == "none":
        log.info("文献源未命中：%s", result.attempts)
        return [], ["papers"]
    items: list[dict[str, Any]] = []
    for paper in result.papers:
        snippet = (paper.abstract or "")[:500]
        items.append(
            {
                "title": paper.title,
                "url": paper.landing_url,
                "content": snippet,
                "snippet": snippet,
                "engine": "literature",
                "category": "papers",
                "kind": "paper",
                # 来源标记：前端据此区分 OpenAlex / Semantic Scholar / Crossref / arXiv
                "source": paper.source,
                "hitSource": paper.source,
                "doi": paper.doi,
                "authors": list(paper.authors),
                "year": paper.year,
                "venue": paper.venue,
                "citations": paper.citations,
                "pdfUrl": paper.pdf_url,
            }
        )
    return items, []


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
    papers / literature 额外走文献源（OpenAlex / S2 / Crossref / arXiv）
    """
    # 先记下原始分类名：normalize_category 会把 "papers" 映射成
    # "scientific publications"，映射后就没法判断用户是否点名了文献源。
    raw_categories = [c.strip().lower() for c in (categories or "").split(",") if c.strip()]
    wants_papers = any(c in LITERATURE_CATEGORY_TOKENS for c in raw_categories)
    categories = normalize_category(categories)
    scope = (scope or "web").lower()

    # 文献源是联网类别：scope=local（只看本地语料）时不混入。
    paper_items: list[dict[str, Any]] = []
    degraded: list[str] = []
    if wants_papers and scope in ("web", "all"):
        paper_items, degraded = await _search_literature(q)

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
            try:
                local_total = int(go_result.get("localTotal") or 0)
            except (TypeError, ValueError):
                # Go 核心返回了非数字：当作 0，不能让整个搜索因它 500。
                local_total = 0
            go_result["localTotal"] = local_total + len(knowledge_hits)
            go_result["count"] = len(merged)
        go_result["results"] = await _rerank_local(q, list(go_result.get("results") or []))
        if paper_items:
            go_result["results"] = list(go_result["results"]) + paper_items
            go_result["count"] = len(go_result["results"])
        go_result["degraded"] = degraded
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
    if paper_items:
        results = results + paper_items

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
        # 降级的检索类别（如文献源挂掉时的 "papers"），前端可提示“该分类暂不可用”
        "degraded": degraded,
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
        except Exception as exc:  # noqa: BLE001 - 目录拉取失败只影响工具计数
            log.debug("snapotter 工具目录不可用: %s", exc)
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
    try:
        os.makedirs(target_dir, mode=0o700, exist_ok=True)
        _grant_user_acl(target_dir)
        path = os.path.join(target_dir, name)
        real = os.path.realpath(path)
        if not real.startswith(os.path.realpath(target_dir) + os.sep):
            raise HTTPException(status_code=400, detail="非法路径")
        with open(real, "w", encoding="utf-8") as fh:
            fh.write(content)
        os.chmod(real, 0o640)
    except HTTPException:
        raise
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"无法写入个人目录：{exc}") from exc
    return {"ok": True, "path": real, "note": "已写入个人目录，可在文件管理中查看"}


# ------------------------------------------------------------------ 管理端


@app.get("/api/admin/info")
async def api_admin_info(user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    import platform

    def run(cmd: list[str]) -> str:
        try:
            return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout.strip()
        except Exception as exc:  # noqa: BLE001 - 管理端信息降级为空串
            log.debug("命令执行失败 %s: %s", cmd[:1], exc)
            return ""

    disk = shutil.disk_usage("/srv/labdata") if os.path.isdir("/srv/labdata") else shutil.disk_usage("/")
    containers = []
    if os.path.exists("/var/run/docker.sock"):
        out = run(["docker", "ps", "--format", "{{.Names}}\t{{.Status}}\t{{.Image}}"])
        containers = [line for line in out.splitlines() if line.strip()]
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


@app.get("/api/admin/backups/git")
async def api_admin_backup_git(user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    """异地归档（Git LFS）的状态。

    本地 restic 仓库在同一块盘上，盘坏了一起没；异地归档是第二条腿。
    这里只读状态文件，**不接触归档口令，也不触发推送**——
    推送由每日维护在宿主机执行（见 ops/backup-git-archive.sh），
    后端不持有 git-lfs 凭据。
    """
    status_path = "/srv/labgo/backup-git-status.json"
    try:
        with open(status_path, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return {"available": False, "detail": "尚未产生异地归档记录", "archives": []}
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"异地归档状态读取失败：{exc}") from exc
    data["available"] = True
    return data


@app.delete("/api/admin/backups/{snapshot}")
async def api_admin_backup_forget(
    snapshot: str, user: dict[str, Any] = Depends(require_admin)
) -> dict[str, Any]:
    """删除一个备份快照（管理员显式操作）。

    备份是最后一道恢复手段，因此这里坚持「一次一个、必须给出完整或前缀 ID」，
    不做「清空全部备份」的批量入口；真正的 restic 调用留在宿主机脚本里，
    后端只做参数转发与错误透传。
    """
    from .golink import backup_forget

    snap = (snapshot or "").strip()
    if not snap or not all(c in "0123456789abcdefABCDEF" for c in snap):
        raise HTTPException(status_code=400, detail="快照 ID 必须是十六进制")
    if not 8 <= len(snap) <= 64:
        raise HTTPException(status_code=400, detail="快照 ID 长度应为 8–64 位")
    ok, detail = await backup_forget(snap)
    if not ok:
        raise HTTPException(status_code=502, detail=f"删除备份失败：{detail}")
    return {"ok": True, "snapshot": snap}


@app.get("/api/admin/health")
async def api_admin_health(user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    """全量服务健康（探测由 Go 核心执行）。"""
    import asyncio

    services = load_catalog()
    results = await asyncio.gather(*[go_service_health(s.id) for s in services])
    return {
        "services": [
            {"id": s.id, "name": s.name, "category": s.category, "health": h} for s, h in zip(services, results, strict=True)
        ]
    }


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
        f"FROM labspace.account_audit WHERE {where} ORDER BY created_at DESC LIMIT %s",  # noqa: S608 - where 由固定子句拼成，值全走占位符
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
