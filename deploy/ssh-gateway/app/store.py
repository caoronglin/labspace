"""SSH 网关持久化：连接、主机密钥与审计，全部按门户 user_id 隔离。"""

# pyright: reportMissingImports=false
from __future__ import annotations

import json
from typing import Any
from uuid import UUID

import asyncpg


class Store:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._pool: asyncpg.Pool | None = None

    async def open(self) -> None:
        self._pool = await asyncpg.create_pool(
            self._dsn, min_size=2, max_size=10, command_timeout=15
        )
        if self._pool is None:
            raise RuntimeError("SSH 网关数据库池创建失败")
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                CREATE SCHEMA IF NOT EXISTS ssh_gateway;
                CREATE TABLE IF NOT EXISTS ssh_gateway.connections (
                    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id text NOT NULL,
                    name text NOT NULL,
                    host text NOT NULL,
                    port integer NOT NULL,
                    username text NOT NULL,
                    auth_type text NOT NULL CHECK (auth_type IN ('password', 'private_key')),
                    secret_ciphertext bytea NOT NULL,
                    created_at timestamptz NOT NULL DEFAULT now(),
                    updated_at timestamptz NOT NULL DEFAULT now(),
                    UNIQUE (user_id, name)
                );
                CREATE TABLE IF NOT EXISTS ssh_gateway.host_keys (
                    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id text NOT NULL,
                    host text NOT NULL,
                    port integer NOT NULL,
                    key_type text NOT NULL,
                    fingerprint text NOT NULL,
                    public_key text NOT NULL,
                    confirmed_at timestamptz NOT NULL DEFAULT now(),
                    UNIQUE (user_id, host, port, key_type)
                );
                CREATE TABLE IF NOT EXISTS ssh_gateway.audit (
                    id bigserial PRIMARY KEY,
                    user_id text NOT NULL,
                    action text NOT NULL,
                    target text NOT NULL DEFAULT '',
                    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
                    created_at timestamptz NOT NULL DEFAULT now()
                );
                CREATE INDEX IF NOT EXISTS connections_user_idx ON ssh_gateway.connections (user_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS audit_user_time_idx ON ssh_gateway.audit (user_id, created_at DESC);
                """
            )

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    @property
    def pool(self) -> asyncpg.Pool:
        if self._pool is None:
            raise RuntimeError("SSH 网关数据库池尚未初始化")
        return self._pool

    async def list_connections(self, user_id: str) -> list[dict[str, Any]]:
        rows = await self.pool.fetch(
            "SELECT id, name, host, port, username, auth_type, created_at, updated_at "
            "FROM ssh_gateway.connections WHERE user_id=$1 ORDER BY created_at DESC",
            user_id,
        )
        return [dict(row) for row in rows]

    async def create_connection(
        self,
        user_id: str,
        *,
        name: str,
        host: str,
        port: int,
        username: str,
        auth_type: str,
        secret_ciphertext: bytes,
    ) -> dict[str, Any]:
        row = await self.pool.fetchrow(
            "INSERT INTO ssh_gateway.connections "
            "(user_id, name, host, port, username, auth_type, secret_ciphertext) "
            "VALUES ($1,$2,$3,$4,$5,$6,$7) "
            "ON CONFLICT (user_id, name) DO UPDATE SET "
            "host=EXCLUDED.host, port=EXCLUDED.port, username=EXCLUDED.username, "
            "auth_type=EXCLUDED.auth_type, secret_ciphertext=EXCLUDED.secret_ciphertext, updated_at=now() "
            "RETURNING id, name, host, port, username, auth_type, secret_ciphertext, created_at, updated_at",
            user_id,
            name,
            host,
            port,
            username,
            auth_type,
            secret_ciphertext,
        )
        return dict(row) if row is not None else {}

    async def get_connection(self, user_id: str, connection_id: str) -> dict[str, Any] | None:
        try:
            UUID(connection_id)
        except ValueError, AttributeError:
            return None
        row = await self.pool.fetchrow(
            "SELECT id, name, host, port, username, auth_type, secret_ciphertext, created_at, updated_at "
            "FROM ssh_gateway.connections WHERE user_id=$1 AND id=$2::uuid",
            user_id,
            connection_id,
        )
        return dict(row) if row is not None else None

    async def delete_connection(self, user_id: str, connection_id: str) -> bool:
        try:
            UUID(connection_id)
        except ValueError, AttributeError:
            return False
        # pi-lens-ignore: python-sql-injection -- 静态 DELETE + $1/$2 独立参数，无字符串拼接。
        result = await self.pool.execute(
            "DELETE FROM ssh_gateway.connections WHERE user_id=$1 AND id=$2::uuid",
            user_id,
            connection_id,
        )
        return result.endswith(" 1")

    async def get_host_key(
        self, user_id: str, host: str, port: int, key_type: str
    ) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            "SELECT key_type, fingerprint, public_key FROM ssh_gateway.host_keys "
            "WHERE user_id=$1 AND host=$2 AND port=$3 AND key_type=$4",
            user_id,
            host,
            port,
            key_type,
        )
        return dict(row) if row is not None else None

    async def save_host_key(
        self,
        user_id: str,
        host: str,
        port: int,
        key_type: str,
        fingerprint: str,
        public_key: str,
    ) -> None:
        # pi-lens-ignore: python-sql-injection -- 静态 INSERT/UPSERT + $1..$6 独立参数，无字符串拼接。
        await self.pool.execute(
            "INSERT INTO ssh_gateway.host_keys (user_id, host, port, key_type, fingerprint, public_key) "
            "VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, host, port, key_type) DO UPDATE SET "
            "fingerprint=EXCLUDED.fingerprint, public_key=EXCLUDED.public_key, confirmed_at=now()",
            user_id,
            host,
            port,
            key_type,
            fingerprint,
            public_key,
        )

    async def audit(
        self, user_id: str, action: str, target: str = "", detail: dict[str, Any] | None = None
    ) -> None:
        # pi-lens-ignore: python-sql-injection -- 静态 INSERT + $1..$4 独立参数，detail 使用 $4::jsonb。
        await self.pool.execute(
            "INSERT INTO ssh_gateway.audit (user_id, action, target, detail) VALUES ($1,$2,$3,$4::jsonb)",
            user_id,
            action,
            target,
            json.dumps(detail or {}, ensure_ascii=False),
        )

    async def list_audit(self, user_id: str, limit: int = 50) -> list[dict[str, Any]]:
        rows = await self.pool.fetch(
            "SELECT id, action, target, detail, created_at FROM ssh_gateway.audit "
            "WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2",
            user_id,
            limit,
        )
        out: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            if isinstance(item.get("detail"), str):
                try:
                    item["detail"] = json.loads(item["detail"])
                except json.JSONDecodeError:
                    item["detail"] = {}
            out.append(item)
        return out
