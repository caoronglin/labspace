from __future__ import annotations

import asyncio
import hmac
import os
import stat
import tempfile
import unittest
from collections.abc import AsyncIterator
from dataclasses import replace
from pathlib import Path
from typing import Any
from unittest.mock import patch

os.environ.setdefault("SSH_GATEWAY_DB_DSN", "postgresql://test:test@127.0.0.1/test")
os.environ.setdefault("SSH_GATEWAY_SECRET_KEY", "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=")

import asyncssh
from asyncssh.sftp import FXF_CREAT, FXF_TRUNC, FXF_WRITE
from cryptography.fernet import Fernet
from fastapi import HTTPException

from app.config import Settings
from app.manager import HostKeyRequired, Manager
from app.security import decrypt_secret, encrypt_secret, validate_target
from app.store import Store

TEST_PASSWORD = os.urandom(16).hex()


class MemoryStore(Store):
    def __init__(self) -> None:
        self.keys: dict[tuple[str, str, int, str], dict[str, str]] = {}
        self.audits: list[tuple[str, str, str]] = []

    async def get_host_key(
        self,
        user_id: str,
        host: str,
        port: int,
        key_type: str,
    ) -> dict[str, str] | None:
        return self.keys.get((user_id, host, port, key_type))

    async def save_host_key(
        self,
        user_id: str,
        host: str,
        port: int,
        key_type: str,
        fingerprint: str,
        public_key: str,
    ) -> None:
        self.keys[(user_id, host, port, key_type)] = {
            "fingerprint": fingerprint,
            "public_key": public_key,
        }

    async def audit(
        self,
        user_id: str,
        action: str,
        target: str = "",
        detail: dict[str, Any] | None = None,
    ) -> None:
        self.audits.append((user_id, action, target))


async def echo_session(stdin: Any, stdout: Any, stderr: Any) -> None:
    while True:
        data = await stdin.read(4096)
        if not data:
            stdout.write_eof()
            return
        stdout.write(data)
        await stdout.drain()


class TestSSHServer(asyncssh.SSHServer):
    def begin_auth(self, username: str) -> bool:
        return True

    def password_auth_supported(self) -> bool:
        return True

    def validate_password(self, username: str, password: str) -> bool:
        return username == "tester" and hmac.compare_digest(password, TEST_PASSWORD)


class LocalSFTPServer(asyncssh.SFTPServer):
    def __init__(self, channel: Any, root: Path) -> None:
        super().__init__(channel)
        self.root = root

    def _local(self, path: bytes) -> Path:
        decoded = os.fsdecode(path)
        root = str(self.root)
        if decoded == root or decoded.startswith(root + "/"):
            return Path(decoded)
        return self.root / decoded.lstrip("/")

    def map_path(self, path: bytes) -> bytes:
        return os.fsencode(self._local(path))

    @staticmethod
    def attrs(path: Path) -> asyncssh.SFTPAttrs:
        info = path.stat()
        return asyncssh.SFTPAttrs(
            size=info.st_size,
            uid=info.st_uid,
            gid=info.st_gid,
            permissions=stat.S_IMODE(info.st_mode),
            atime=int(info.st_atime),
            mtime=int(info.st_mtime),
        )

    async def scandir(self, path: bytes) -> AsyncIterator[asyncssh.SFTPName]:
        for item in self._local(path).iterdir():
            yield asyncssh.SFTPName(os.fsencode(item.name), attrs=self.attrs(item))

    def stat(self, path: bytes) -> asyncssh.SFTPAttrs:
        return self.attrs(self._local(path))

    def lstat(self, path: bytes) -> asyncssh.SFTPAttrs:
        return self.attrs(self._local(path))

    def open(self, path: bytes, pflags: int, attrs: asyncssh.SFTPAttrs) -> Any:
        mode = "wb" if pflags & (FXF_WRITE | FXF_CREAT | FXF_TRUNC) else "rb"
        return open(self._local(path), mode)

    def mkdir(self, path: bytes, attrs: asyncssh.SFTPAttrs) -> None:
        self._local(path).mkdir()

    def remove(self, path: bytes) -> None:
        self._local(path).unlink()

    def rmdir(self, path: bytes) -> None:
        self._local(path).rmdir()

    def rename(self, oldpath: bytes, newpath: bytes) -> None:
        self._local(oldpath).rename(self._local(newpath))

    def realpath(self, path: bytes) -> bytes:
        return self.map_path(path)


class GatewayIntegrationTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "hello.txt").write_text("hello ssh", encoding="utf-8")
        self.host_key = asyncssh.generate_private_key("ssh-ed25519")
        self.server = await asyncssh.create_server(
            TestSSHServer,
            "127.0.0.1",
            0,
            server_host_keys=[self.host_key],
            session_factory=echo_session,
            sftp_factory=lambda channel: LocalSFTPServer(channel, self.root),
        )
        self.port = self.server.sockets[0].getsockname()[1]
        self.settings = Settings(
            db_dsn="unused",
            secret_key=Fernet.generate_key().decode(),
            allowed_hosts=("127.0.0.1",),
            allowed_cidrs=("127.0.0.0/8",),
            allowed_ports=(self.port,),
        )
        self.store = MemoryStore()
        self.manager = Manager(self.settings, self.store)

    async def asyncTearDown(self) -> None:
        await self.manager.shutdown()
        self.server.close()
        await self.server.wait_closed()
        self.tmp.cleanup()

    def connection(self) -> dict[str, Any]:
        return {
            "id": "conn-1",
            "name": "local-test",
            "host": "127.0.0.1",
            "port": self.port,
            "username": "tester",
            "auth_type": "password",
            "secret_ciphertext": encrypt_secret(self.settings, {"password": TEST_PASSWORD}),
        }

    async def test_host_key_confirmation_terminal_and_sftp(self) -> None:
        with self.assertRaises(HostKeyRequired):
            await self.manager.create("user-a", self.connection(), 120, 30)

        key = await asyncssh.get_server_host_key("127.0.0.1", self.port)
        if key is None:
            self.fail("test SSH server did not return a host key")
        await self.manager.confirm_host_key(
            "user-a",
            "127.0.0.1",
            self.port,
            key.get_algorithm(),
            key.get_fingerprint(),
        )
        session = await self.manager.create("user-a", self.connection(), 120, 30)
        session.process.stdin.write(b"echo READY_SSH\n")
        await session.process.stdin.drain()
        output = await asyncio.wait_for(session.process.stdout.readuntil(b"READY_SSH\r\n"), 5)
        self.assertIn(b"READY_SSH", output)

        sftp = await self.manager.sftp(session)
        names = await sftp.readdir(".")
        self.assertEqual([item.filename for item in names], ["hello.txt"])
        async with sftp.open("hello.txt", "rb") as handle:
            self.assertEqual(await handle.read(), b"hello ssh")
        await sftp.mkdir("analysis")
        async with sftp.open("analysis/result.txt", "wb") as handle:
            await handle.write(b"done")
        await sftp.rename("analysis/result.txt", "analysis/final.txt")
        self.assertEqual((self.root / "analysis" / "final.txt").read_bytes(), b"done")
        await sftp.remove("analysis/final.txt")
        await sftp.rmdir("analysis")

        with self.assertRaises(HTTPException) as denied:
            self.manager.get("user-b", session.id)
        self.assertEqual(denied.exception.status_code, 404)
        self.assertTrue(any(action == "session.start" for _, action, _ in self.store.audits))

    async def test_public_target_rejected_and_secret_roundtrip(self) -> None:
        with self.assertRaises(HTTPException) as denied:
            await validate_target(self.settings, "8.8.8.8", self.port)
        self.assertEqual(denied.exception.status_code, 403)
        ciphertext = encrypt_secret(self.settings, {"password": "top-secret"})
        self.assertNotIn(b"top-secret", ciphertext)
        self.assertEqual(decrypt_secret(self.settings, ciphertext), {"password": "top-secret"})

    async def test_connect_rate_limit(self) -> None:
        limited = Manager(replace(self.settings, connect_rate_per_minute=1), self.store)
        with self.assertRaises(HostKeyRequired):
            await limited.create("rate-user", self.connection(), 120, 30)
        with self.assertRaises(HTTPException) as denied:
            await limited.create("rate-user", self.connection(), 120, 30)
        self.assertEqual(denied.exception.status_code, 429)
        await limited.shutdown()

    async def test_mixed_dns_addresses_rejected(self) -> None:
        infos = [
            (2, 1, 6, "", ("127.0.0.1", self.port)),
            (2, 1, 6, "", ("8.8.8.8", self.port)),
        ]
        with patch("app.security.socket.getaddrinfo", return_value=infos):
            with self.assertRaises(HTTPException) as denied:
                await validate_target(self.settings, "mixed.example", self.port)
        self.assertEqual(denied.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
