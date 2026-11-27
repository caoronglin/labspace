"""AsyncSSH 会话与 SFTP 管理。单 worker 运行，WebSocket 状态保留在进程内。"""

# pyright: reportMissingImports=false
from __future__ import annotations

import asyncio
import logging
import secrets
import time
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any

import asyncssh
from fastapi import HTTPException

from .config import Settings
from .security import Target, decrypt_secret, validate_target
from .store import Store

log = logging.getLogger("ssh-gateway")


class HostKeyRequired(HTTPException):
    def __init__(self, *, host: str, port: int, key_type: str, fingerprint: str) -> None:
        super().__init__(
            status_code=409,
            detail={
                "code": "host_key_required",
                "message": "首次连接需要确认服务器主机指纹",
                "host": host,
                "port": port,
                "keyType": key_type,
                "fingerprint": fingerprint,
            },
        )


@dataclass
class Session:
    id: str
    user_id: str
    connection_id: str
    name: str
    target: Target
    username: str
    connection: Any
    process: Any
    created_at: float = field(default_factory=time.time)
    last_active: float = field(default_factory=time.time)
    websocket_attached: bool = False
    sftp: Any = None
    sftp_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "connectionId": self.connection_id,
            "name": self.name,
            "host": self.target.host,
            "port": self.target.port,
            "username": self.username,
            "createdAt": self.created_at,
            "lastActiveAt": self.last_active,
            "websocketAttached": self.websocket_attached,
        }


class Manager:
    def __init__(self, settings: Settings, store: Store) -> None:
        self.settings = settings
        self.store = store
        self._sessions: dict[str, Session] = {}
        self._attempts: dict[str, list[float]] = {}
        self._lock = asyncio.Lock()
        self._reaper: asyncio.Task[None] | None = None

    async def start(self) -> None:
        self._reaper = asyncio.create_task(self._reap_idle(), name="ssh-idle-reaper")

    async def shutdown(self) -> None:
        if self._reaper is not None:
            self._reaper.cancel()
        sessions = list(self._sessions.values())
        self._sessions.clear()
        await asyncio.gather(
            *(self._close(session) for session in sessions),
            return_exceptions=True,
        )

    async def _close(self, session: Session) -> None:
        for obj in (session.process, session.connection):
            with suppress(Exception):
                obj.close()
        with suppress(Exception):
            await session.connection.wait_closed()

    @staticmethod
    async def _close_connection(connection: Any) -> None:
        with suppress(Exception):
            connection.close()
        with suppress(Exception):
            await connection.wait_closed()

    async def _reap_idle(self) -> None:
        while True:
            await asyncio.sleep(60)
            cutoff = time.time() - self.settings.idle_timeout_seconds
            async with self._lock:
                expired = [s for s in self._sessions.values() if s.last_active < cutoff]
                for session in expired:
                    self._sessions.pop(session.id, None)
            for session in expired:
                await self._close(session)
                try:
                    await self.store.audit(
                        session.user_id,
                        "session.idle_close",
                        session.id,
                        {"host": session.target.host},
                    )
                except Exception as exc:  # noqa: BLE001 - 审计失败不能终止空闲回收
                    log.warning(
                        "idle close audit failed for %s: %s", session.id, type(exc).__name__
                    )

    async def list_sessions(self, user_id: str) -> list[dict[str, Any]]:
        async with self._lock:
            return [s.public() for s in self._sessions.values() if s.user_id == user_id]

    def get(self, user_id: str, session_id: str) -> Session:
        session = self._sessions.get(session_id)
        if session is None or session.user_id != user_id:
            raise HTTPException(status_code=404, detail="SSH 会话不存在")
        session.last_active = time.time()
        return session

    async def _check_connect_rate(self, user_id: str) -> None:
        now = time.time()
        cutoff = now - 60
        async with self._lock:
            recent = [at for at in self._attempts.get(user_id, []) if at >= cutoff]
            if len(recent) >= self.settings.connect_rate_per_minute:
                raise HTTPException(status_code=429, detail="SSH 连接过于频繁，请一分钟后再试")
            recent.append(now)
            self._attempts[user_id] = recent

    async def create(
        self,
        user_id: str,
        connection: dict[str, Any],
        cols: int,
        rows: int,
    ) -> Session:
        await self._check_connect_rate(user_id)
        port = connection["port"]
        if not isinstance(port, int):
            raise HTTPException(status_code=500, detail="SSH 连接端口配置无效")
        target = await validate_target(self.settings, str(connection["host"]), port)
        async with self._lock:
            own = sum(1 for s in self._sessions.values() if s.user_id == user_id)
            if own >= self.settings.max_sessions_per_user:
                raise HTTPException(status_code=429, detail="已达到个人 SSH 会话上限")
            if len(self._sessions) >= self.settings.max_sessions_global:
                raise HTTPException(status_code=429, detail="已达到全局 SSH 会话上限")

        try:
            server_key = await asyncio.wait_for(
                asyncssh.get_server_host_key(target.addresses[0], target.port),
                timeout=self.settings.connect_timeout_seconds,
            )
        except (asyncssh.Error, OSError, TimeoutError) as exc:
            raise HTTPException(status_code=502, detail="无法获取 SSH 服务器主机密钥") from exc
        if server_key is None:
            raise HTTPException(status_code=502, detail="SSH 服务器未返回主机密钥")
        key_type = server_key.get_algorithm()
        fingerprint = server_key.get_fingerprint()
        stored = await self.store.get_host_key(user_id, target.host, target.port, key_type)
        if stored is None:
            raise HostKeyRequired(
                host=target.host,
                port=target.port,
                key_type=key_type,
                fingerprint=fingerprint,
            )
        if stored["fingerprint"] != fingerprint:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "host_key_changed",
                    "message": "服务器主机指纹已变化，连接已拒绝。请联系管理员确认。",
                    "expected": stored["fingerprint"],
                    "actual": fingerprint,
                },
            )

        secret = decrypt_secret(self.settings, connection["secret_ciphertext"])
        auth: dict[str, Any] = {}
        if connection["auth_type"] == "password":
            auth["password"] = str(secret.get("password") or "")
        else:
            try:
                auth["client_keys"] = [
                    asyncssh.import_private_key(
                        str(secret.get("private_key") or ""),
                        passphrase=str(secret.get("passphrase") or "") or None,
                    )
                ]
            except (ValueError, asyncssh.KeyImportError) as exc:
                raise HTTPException(status_code=400, detail="SSH 私钥格式无效") from exc

        host_pattern = target.host if target.port == 22 else f"[{target.host}]:{target.port}"
        known_hosts = f"{host_pattern} {stored['public_key']}\n".encode("ascii")
        ssh: Any = None
        try:
            ssh = await asyncssh.connect(
                target.addresses[0],
                target.port,
                username=str(connection["username"]),
                host_key_alias=target.host,
                known_hosts=known_hosts,
                connect_timeout=self.settings.connect_timeout_seconds,
                keepalive_interval=30,
                **auth,
            )
            process = await ssh.create_process(
                term_type="xterm-256color",
                term_size=(max(10, min(rows, 200)), max(20, min(cols, 500))),
                encoding=None,
            )
        except asyncssh.HostKeyNotVerifiable as exc:
            if ssh is not None:
                await self._close_connection(ssh)
            raise HTTPException(status_code=409, detail="SSH 主机指纹校验失败") from exc
        except asyncssh.PermissionDenied as exc:
            if ssh is not None:
                await self._close_connection(ssh)
            raise HTTPException(
                status_code=401,
                detail="SSH 认证失败，请检查用户名、口令或私钥",
            ) from exc
        except (asyncssh.Error, OSError, TimeoutError) as exc:
            if ssh is not None:
                await self._close_connection(ssh)
            log.warning(
                "SSH connect failed for %s:%s: %s",
                target.host,
                target.port,
                type(exc).__name__,
            )
            raise HTTPException(
                status_code=502,
                detail="SSH 连接失败，请检查网络、端口和目标白名单",
            ) from exc

        session = Session(
            id=secrets.token_urlsafe(18),
            user_id=user_id,
            connection_id=str(connection["id"]),
            name=str(connection["name"]),
            target=target,
            username=str(connection["username"]),
            connection=ssh,
            process=process,
        )
        async with self._lock:
            own = sum(1 for s in self._sessions.values() if s.user_id == user_id)
            if (
                own >= self.settings.max_sessions_per_user
                or len(self._sessions) >= self.settings.max_sessions_global
            ):
                await self._close(session)
                raise HTTPException(status_code=429, detail="SSH 会话配额已满")
            self._sessions[session.id] = session
        await self.store.audit(
            user_id,
            "session.start",
            session.id,
            {"host": target.host, "username": session.username},
        )
        return session

    async def confirm_host_key(
        self,
        user_id: str,
        host: str,
        port: int,
        key_type: str,
        fingerprint: str,
    ) -> None:
        await self._check_connect_rate(user_id)
        target = await validate_target(self.settings, host, port)
        try:
            key = await asyncio.wait_for(
                asyncssh.get_server_host_key(target.addresses[0], target.port),
                timeout=self.settings.connect_timeout_seconds,
            )
        except (asyncssh.Error, OSError, TimeoutError) as exc:
            raise HTTPException(status_code=502, detail="无法获取 SSH 服务器主机密钥") from exc
        if key is None or key.get_algorithm() != key_type or key.get_fingerprint() != fingerprint:
            raise HTTPException(
                status_code=409,
                detail="服务器主机密钥已变化，请重新发起连接",
            )
        public_key = key.export_public_key("openssh").decode("ascii")
        await self.store.save_host_key(
            user_id,
            target.host,
            target.port,
            key_type,
            fingerprint,
            public_key,
        )
        await self.store.audit(
            user_id,
            "host_key.confirm",
            f"{target.host}:{target.port}",
            {"fingerprint": fingerprint},
        )

    async def stop_session(self, user_id: str, session_id: str) -> None:
        session = self.get(user_id, session_id)
        async with self._lock:
            self._sessions.pop(session.id, None)
        await self._close(session)
        await self.store.audit(user_id, "session.stop", session.id, {"host": session.target.host})

    async def sftp(self, session: Session) -> Any:
        if session.sftp is None:
            async with session.sftp_lock:
                if session.sftp is None:
                    try:
                        session.sftp = await session.connection.start_sftp_client()
                    except asyncssh.Error as exc:
                        raise HTTPException(status_code=502, detail="SFTP 子系统不可用") from exc
        return session.sftp
