"""LabSpace 自研 SSH/SFTP 网关。

身份由门户 Nginx auth_request 校验后注入 X-User-ID；本服务只监听回环。
单 worker 保留 WebSocket 会话状态，数据库按 user_id 隔离连接、主机密钥与审计。
"""

# pyright: reportMissingImports=false
from __future__ import annotations

import asyncio
import logging
import secrets
import stat
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from pathlib import PurePosixPath
from typing import Annotated, Any
from urllib.parse import quote

import asyncssh
from fastapi import (
    Depends,
    FastAPI,
    File,
    HTTPException,
    Query,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from .config import settings
from .manager import Manager
from .security import (
    current_user_id,
    encrypt_secret,
    normalize_remote_path,
    validate_target,
)
from .store import Store

logging.basicConfig(level=logging.getLogger("ssh-gateway").getEffectiveLevel())
log = logging.getLogger("ssh-gateway")
store = Store(settings.db_dsn)
manager = Manager(settings, store)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    await store.open()
    await manager.start()
    try:
        yield
    finally:
        await manager.shutdown()
        await store.close()


app = FastAPI(
    title="LabSpace SSH Gateway",
    version="2026.11.24",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)


@app.get("/healthz", include_in_schema=False)
async def healthz() -> dict[str, object]:
    return {
        "ok": True,
        "service": "ssh-gateway",
        "version": "2026.11.24",
        "sessions": len(manager._sessions),
    }


class ConnectionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    host: str = Field(min_length=1, max_length=253)
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(min_length=1, max_length=128)
    auth_type: str = Field(pattern="^(password|private_key)$")
    password: str = Field(default="", max_length=1024)
    private_key: str = Field(default="", max_length=64 * 1024)
    passphrase: str = Field(default="", max_length=1024)


class HostKeyConfirm(BaseModel):
    host: str = Field(min_length=1, max_length=253)
    port: int = Field(default=22, ge=1, le=65535)
    key_type: str = Field(min_length=1, max_length=80)
    fingerprint: str = Field(min_length=8, max_length=256)


class SessionCreate(BaseModel):
    connection_id: str = Field(min_length=1, max_length=64)
    cols: int = Field(default=120, ge=20, le=500)
    rows: int = Field(default=30, ge=10, le=200)


class MkdirBody(BaseModel):
    path: str = Field(min_length=1, max_length=4096)


class RenameBody(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    new_path: str = Field(min_length=1, max_length=4096)


def _connection_public(row: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in row.items() if key != "secret_ciphertext"}


@app.get("/api/connections")
async def connections(user_id: str = Depends(current_user_id)) -> dict[str, object]:
    return {"connections": await store.list_connections(user_id)}


@app.post("/api/connections", status_code=201)
async def create_connection(
    body: ConnectionCreate,
    user_id: str = Depends(current_user_id),
) -> dict[str, object]:
    await validate_target(settings, body.host, body.port)
    if body.auth_type == "password":
        if not body.password:
            raise HTTPException(status_code=400, detail="请输入 SSH 口令")
        secret = {"password": body.password}
    else:
        if not body.private_key.strip():
            raise HTTPException(status_code=400, detail="请输入 SSH 私钥")
        try:
            asyncssh.import_private_key(
                body.private_key.strip(),
                passphrase=body.passphrase or None,
            )
        except (ValueError, asyncssh.KeyImportError) as exc:
            raise HTTPException(status_code=400, detail="SSH 私钥格式无效") from exc
        secret = {"private_key": body.private_key.strip(), "passphrase": body.passphrase}
    row = await store.create_connection(
        user_id,
        name=body.name.strip(),
        host=body.host.strip(),
        port=body.port,
        username=body.username.strip(),
        auth_type=body.auth_type,
        secret_ciphertext=encrypt_secret(settings, secret),
    )
    await store.audit(
        user_id,
        "connection.save",
        str(row["id"]),
        {"host": body.host, "username": body.username},
    )
    return {"connection": _connection_public(row)}


@app.delete("/api/connections/{connection_id}")
async def delete_connection(
    connection_id: str,
    user_id: str = Depends(current_user_id),
) -> dict[str, object]:
    deleted = await store.delete_connection(user_id, connection_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="SSH 连接不存在")
    await store.audit(user_id, "connection.delete", connection_id)
    return {"ok": True}


@app.post("/api/host-keys/confirm")
async def confirm_host_key(
    body: HostKeyConfirm,
    user_id: str = Depends(current_user_id),
) -> dict[str, object]:
    await manager.confirm_host_key(user_id, body.host, body.port, body.key_type, body.fingerprint)
    return {"ok": True}


@app.get("/api/sessions")
async def sessions(user_id: str = Depends(current_user_id)) -> dict[str, object]:
    return {
        "sessions": await manager.list_sessions(user_id),
        "limits": {
            "perUser": settings.max_sessions_per_user,
            "global": settings.max_sessions_global,
        },
    }


@app.post("/api/sessions", status_code=201)
async def create_session(
    body: SessionCreate,
    user_id: str = Depends(current_user_id),
) -> dict[str, object]:
    connection = await store.get_connection(user_id, body.connection_id)
    if connection is None:
        raise HTTPException(status_code=404, detail="SSH 连接不存在")
    session = await manager.create(user_id, connection, body.cols, body.rows)
    return {"session": session.public()}


@app.delete("/api/sessions/{session_id}")
async def stop_session(
    session_id: str,
    user_id: str = Depends(current_user_id),
) -> dict[str, object]:
    await manager.stop_session(user_id, session_id)
    return {"ok": True}


@app.websocket("/ws/sessions/{session_id}")
async def terminal_socket(websocket: WebSocket, session_id: str) -> None:
    user_id = (websocket.headers.get("x-user-id") or "").strip()
    if not user_id:
        await websocket.close(code=4401, reason="未登录")
        return
    try:
        session = manager.get(user_id, session_id)
    except HTTPException:
        await websocket.close(code=4404, reason="会话不存在")
        return
    if session.websocket_attached:
        await websocket.close(code=4409, reason="终端已被其他窗口占用")
        return
    session.websocket_attached = True
    await websocket.accept()
    await websocket.send_json({"type": "ready", "sessionId": session.id})

    async def pump_output() -> None:
        while True:
            data = await session.process.stdout.read(4096)
            if not data:
                await websocket.send_json({"type": "exit"})
                return
            if isinstance(data, bytes):
                data = data.decode("utf-8", "replace")
            await websocket.send_json({"type": "output", "data": data})

    async def pump_input() -> None:
        while True:
            message = await websocket.receive_json()
            if not isinstance(message, dict):
                await websocket.send_json({"type": "error", "message": "终端消息格式无效"})
                continue
            kind = message.get("type")
            if kind == "input":
                data = str(message.get("data") or "")
                if len(data) > 64 * 1024:
                    await websocket.send_json({"type": "error", "message": "单次输入过大"})
                    continue
                session.process.stdin.write(data.encode("utf-8"))
                session.last_active = time.time()
            elif kind == "resize":
                cols = max(20, min(_safe_int(message.get("cols"), 120), 500))
                rows = max(10, min(_safe_int(message.get("rows"), 30), 200))
                session.process.set_terminal_size(cols, rows)
                session.last_active = time.time()
            elif kind == "ping":
                await websocket.send_json({"type": "pong"})

    output_task = asyncio.create_task(pump_output())
    input_task = asyncio.create_task(pump_input())
    try:
        done, _ = await asyncio.wait({output_task, input_task}, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    except WebSocketDisconnect:
        pass
    except (asyncssh.Error, OSError) as exc:
        log.warning("terminal session %s ended: %s", session_id, type(exc).__name__)
    finally:
        session.websocket_attached = False
        for task in (output_task, input_task):
            task.cancel()
        await asyncio.gather(output_task, input_task, return_exceptions=True)
        await store.audit(user_id, "terminal.detach", session_id)


async def _sftp_for(user_id: str, session_id: str) -> tuple[Any, Any]:
    session = manager.get(user_id, session_id)
    return session, await manager.sftp(session)


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except TypeError, ValueError:
        return default


def _attrs_public(item: Any, parent: str) -> dict[str, Any]:
    raw_name = getattr(item, "filename", "") or ""
    name = raw_name.decode("utf-8", "replace") if isinstance(raw_name, bytes) else str(raw_name)
    attrs = getattr(item, "attrs", item)
    mode = _safe_int(getattr(attrs, "permissions", 0))
    file_type = _safe_int(getattr(attrs, "type", 0))
    path = str(PurePosixPath(parent) / name) if name else parent
    if file_type == 2 or stat.S_ISDIR(mode):
        kind = "dir"
    elif file_type == 3 or stat.S_ISLNK(mode):
        kind = "link"
    else:
        kind = "file"
    return {
        "name": name,
        "path": path,
        "type": kind,
        "size": _safe_int(getattr(attrs, "size", 0)),
        "mtime": _safe_int(getattr(attrs, "mtime", 0)),
        "mode": mode,
    }


@app.get("/api/sessions/{session_id}/files")
async def list_files(
    session_id: str,
    path: str = Query(default="."),
    user_id: str = Depends(current_user_id),
) -> dict[str, object]:
    _, sftp = await _sftp_for(user_id, session_id)
    remote = normalize_remote_path(path)
    try:
        remote = await sftp.normalize(remote)
        names = await sftp.readdir(remote)
    except asyncssh.SFTPError as exc:
        raise HTTPException(
            status_code=404,
            detail=f"无法读取远程目录：{getattr(exc, 'reason', 'SFTP 错误')}",
        ) from exc
    entries = [_attrs_public(item, remote) for item in names]
    entries.sort(key=lambda item: (item["type"] != "dir", item["name"].lower()))
    return {"path": remote, "entries": entries}


@app.get("/api/sessions/{session_id}/files/content")
async def preview_file(
    session_id: str,
    path: str = Query(...),
    user_id: str = Depends(current_user_id),
) -> dict[str, object]:
    _, sftp = await _sftp_for(user_id, session_id)
    remote = normalize_remote_path(path)
    try:
        async with sftp.open(remote, "rb") as handle:
            data = await handle.read(settings.max_preview_bytes + 1)
    except asyncssh.SFTPError as exc:
        raise HTTPException(status_code=404, detail="无法读取远程文件") from exc
    truncated = len(data) > settings.max_preview_bytes
    return {
        "path": remote,
        "text": data[: settings.max_preview_bytes].decode("utf-8", "replace"),
        "truncated": truncated,
    }


@app.get("/api/sessions/{session_id}/files/download")
async def download_file(
    session_id: str,
    path: str = Query(...),
    user_id: str = Depends(current_user_id),
) -> StreamingResponse:
    session, sftp = await _sftp_for(user_id, session_id)
    remote = normalize_remote_path(path)
    try:
        attrs = await sftp.stat(remote)
        if _safe_int(getattr(attrs, "size", 0)) > 100 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="文件超过 100 MB 下载上限")
        handle = await sftp.open(remote, "rb")
    except asyncssh.SFTPError as exc:
        raise HTTPException(status_code=404, detail="无法下载远程文件") from exc

    async def chunks() -> AsyncIterator[bytes]:
        total = 0
        try:
            while True:
                data = await handle.read(64 * 1024)
                if not data:
                    break
                total += len(data)
                if total > 100 * 1024 * 1024:
                    raise HTTPException(status_code=413, detail="文件超过 100 MB 下载上限")
                yield data
        finally:
            handle.close()

    filename = PurePosixPath(remote).name or "download"
    await store.audit(
        user_id,
        "file.download",
        session.id,
        {"path": remote, "size": _safe_int(getattr(attrs, "size", 0))},
    )
    return StreamingResponse(
        chunks(),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


@app.post("/api/sessions/{session_id}/files/upload")
async def upload_file(
    session_id: str,
    file: Annotated[UploadFile, File()],
    path: str = Query(default="."),
    user_id: str = Depends(current_user_id),
) -> dict[str, object]:
    session, sftp = await _sftp_for(user_id, session_id)
    directory = normalize_remote_path(path)
    filename = PurePosixPath((file.filename or "upload").replace("\\", "/")).name
    if not filename or filename in {".", ".."}:
        raise HTTPException(status_code=400, detail="上传文件名无效")
    remote = str(PurePosixPath(directory) / filename)
    temp_remote = str(PurePosixPath(directory) / f".{filename}.upload-{secrets.token_hex(6)}")
    total = 0
    try:
        async with sftp.open(temp_remote, "wb") as handle:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > settings.max_upload_bytes:
                    raise HTTPException(status_code=413, detail="上传文件超过大小上限")
                await handle.write(chunk)
        await sftp.rename(temp_remote, remote)
    except HTTPException:
        with suppress(Exception):
            await sftp.remove(temp_remote)
        raise
    except asyncssh.SFTPError as exc:
        with suppress(Exception):
            await sftp.remove(temp_remote)
        raise HTTPException(status_code=400, detail="远程写入失败") from exc
    await store.audit(user_id, "file.upload", session.id, {"path": remote, "size": total})
    return {"ok": True, "path": remote, "size": total}


@app.post("/api/sessions/{session_id}/files/mkdir")
async def mkdir(
    session_id: str,
    body: MkdirBody,
    user_id: str = Depends(current_user_id),
) -> dict[str, object]:
    session, sftp = await _sftp_for(user_id, session_id)
    remote = normalize_remote_path(body.path)
    try:
        await sftp.mkdir(remote)
    except asyncssh.SFTPError as exc:
        raise HTTPException(status_code=400, detail="无法创建远程目录") from exc
    await store.audit(user_id, "file.mkdir", session.id, {"path": remote})
    return {"ok": True}


@app.post("/api/sessions/{session_id}/files/rename")
async def rename_file(
    session_id: str,
    body: RenameBody,
    user_id: str = Depends(current_user_id),
) -> dict[str, object]:
    session, sftp = await _sftp_for(user_id, session_id)
    remote = normalize_remote_path(body.path)
    new_remote = normalize_remote_path(body.new_path)
    try:
        await sftp.rename(remote, new_remote)
    except asyncssh.SFTPError as exc:
        raise HTTPException(status_code=400, detail="无法重命名远程文件") from exc
    await store.audit(user_id, "file.rename", session.id, {"path": remote, "newPath": new_remote})
    return {"ok": True}


@app.delete("/api/sessions/{session_id}/files")
async def delete_file(
    session_id: str,
    path: str = Query(...),
    user_id: str = Depends(current_user_id),
) -> dict[str, object]:
    session, sftp = await _sftp_for(user_id, session_id)
    remote = normalize_remote_path(path)
    if remote in {"/", ".", ".."}:
        raise HTTPException(status_code=400, detail="不能删除根目录")
    try:
        attrs = await sftp.lstat(remote)
        mode = _safe_int(getattr(attrs, "permissions", 0))
        if stat.S_ISDIR(mode):
            await sftp.rmdir(remote)
        else:
            await sftp.remove(remote)
    except asyncssh.SFTPError as exc:
        raise HTTPException(status_code=400, detail="无法删除远程文件") from exc
    await store.audit(user_id, "file.delete", session.id, {"path": remote})
    return {"ok": True}


@app.get("/api/audit")
async def audit(user_id: str = Depends(current_user_id)) -> dict[str, object]:
    return {"entries": await store.list_audit(user_id)}


@app.exception_handler(asyncssh.Error)
async def _asyncssh_error(_: Request, exc: asyncssh.Error) -> JSONResponse:
    log.warning("SSH gateway upstream error: %s", type(exc).__name__)
    return JSONResponse(status_code=502, content={"detail": "SSH/SFTP 上游操作失败"})
