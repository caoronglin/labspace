"""Global debug / preview channel for the D509 portal.

Kept as a standalone router so the portal entrypoint only needs two lines of
wiring. All output is derived and redacted: no secrets, cookies, tokens, file
contents or PII ever leave this module. Preview never returns source bytes.
"""
from __future__ import annotations

import os
import platform
import time
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from .config import settings
from .golink import _get as go_get
from .preview_inline import MAX_INPUT, PreviewError, render
from .security import require_csrf, require_superadmin

router = APIRouter(prefix="/api/debug", tags=["global-debug"])

_STARTED = time.monotonic()


def _capabilities() -> dict[str, bool]:
    """Feature flags only. Never expose the configured values themselves."""
    return {
        "session_secret": bool(settings.session_secret),
        "database_dsn": bool(settings.db_dsn),
        "health_probes": settings.enable_health,
        "service_token": bool(settings.service_token),
        "portal_oidc": bool(settings.session_secret),
        "agent_gateway": bool(settings.agent_gateway),
        "labgo_core": bool(settings.labgo_base),
    }


@router.get("/status")
async def debug_status(user: dict[str, Any] = Depends(require_superadmin)) -> dict[str, Any]:
    """Aggregate a redacted runtime snapshot for the global debug panel.

    Deliberately does NOT open a database connection or probe every upstream:
    a diagnostics request must never be able to make an outage worse. Service
    health is aggregated in the browser from the existing /api/services/health.
    """
    started = time.monotonic()
    go = await go_get("/healthz")
    latency_ms = int((time.monotonic() - started) * 1000)
    return {
        "backend": {
            "service": "labspace-backend",
            "version": "2026.11.24",
            "python": platform.python_version(),
            "platform": platform.platform(),
            "uptime_seconds": int(time.monotonic() - _STARTED),
            "pid": os.getpid(),
        },
        "session": {
            "authenticated": True,
            "roles": user.get("roles", []),
            "is_admin": bool(set(user.get("roles", [])) & set(settings.admin_roles)),
        },
        "go_core": {
            "reachable": go is not None,
            "latency_ms": latency_ms,
            "status": (go or {}).get("status", "unreachable"),
        },
        "capabilities": _capabilities(),
        "limits": {"max_inline_preview_bytes": MAX_INPUT},
        "server_time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


@router.post("/preview")
async def debug_preview(
    file: UploadFile = File(...),
    _: dict[str, Any] = Depends(require_superadmin),
    __: None = Depends(require_csrf),
) -> JSONResponse:
    """Server-side cross-check of a locally-selected file.

    The browser renders previews locally (``src/debug/previewEngine.ts``); this
    endpoint is opt-in and only used to cross-check the derived result against
    the Go core's ``internal/preview`` contract. Bytes are discarded after the
    request, and only bounded derived metadata is returned.
    """
    name = (file.filename or "unnamed").rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    raw = await file.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise HTTPException(status_code=413, detail="文件超过 8MiB 内联预览上限")
    try:
        result = render(name, raw)
    except PreviewError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    return JSONResponse(
        {"name": name, "size": len(raw), "result": result},
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )
