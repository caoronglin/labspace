#!/usr/bin/env python3
"""按访问入口主机自适应切换第三方服务的 OIDC 配置（宿主机侧）。

背景
----
门户支持两个入口：内网 ``192.0.2.10`` 与 Tailscale ``198.51.100.71``。
门户自身、Casdoor issuer 已经按请求 Host 自适应，但 Quantum（FileBrowser）
的 OIDC 配置是"静态"的：来自 ``config.yaml`` 的 ``auth.oidc.issuerUrl``
（``${FILEBROWSER_OIDC_ISSUER_URL}`` 注入）。远程用户若通过 Tailscale
进入门户，免密登录会被指向不可达的 ``192.0.2.10:8090``。

本服务提供 ``POST /sync``：把目标服务的 OIDC issuer / 回调地址切到
指定主机，必要时重建容器并等待健康；再把对应的回调地址登记进 Casdoor
的 ``application.redirect_uris``。

只监听 docker 网桥地址 ``172.28.0.1``，并要求 ``X-Ops-Token``。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CONFIG = Path("/etc/labspace/oidc-sync.json")
LISTEN = ("172.28.0.1", 8111)

QUANTUM_DIR = Path("/opt/lab-quantum")
QUANTUM_ENV = Path("/etc/lab-quantum/quantum.env")

# 服务 -> (compose 目录, compose 服务名, 端口, 回调路径, Casdoor client_id)
TARGETS = {
    "quantum": (QUANTUM_DIR, "quantum", 8080, "/files/api/auth/oidc/callback", "quantum"),
}


def load_config() -> dict:
    return json.loads(CONFIG.read_text(encoding="utf-8"))


def log(msg: str) -> None:
    print(f"[oidc-sync] {msg}", flush=True)


# --------------------------------------------------------------- 工具函数


def run(cmd: list[str], cwd: Path | None = None, timeout: int = 240) -> tuple[int, str]:
    proc = subprocess.run(
        cmd, cwd=str(cwd) if cwd else None, capture_output=True, text=True, timeout=timeout
    )
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def upsert_env(path: Path, updates: dict[str, str]) -> bool:
    """更新 .env 中的键值，返回是否有变化。"""
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    lines = text.splitlines()
    changed = False
    seen = set()
    out: list[str] = []
    for line in lines:
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if m and m.group(1) in updates:
            key = m.group(1)
            seen.add(key)
            value = updates[key]
            if line != f"{key}={value}":
                changed = True
            out.append(f"{key}={value}")
        else:
            out.append(line)
    for key, value in updates.items():
        if key not in seen:
            changed = True
            out.append(f"{key}={value}")
    if changed:
        path.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
    return changed


def upsert_yaml(path: Path, key_path: str, value: str) -> bool:
    """把形如 ``auth.oidc.issuerUrl`` 的键改成新值（保持缩进）。"""
    text = path.read_text(encoding="utf-8")
    pattern = re.compile(rf"^(\s*){re.escape(key_path.split('.')[-1])}:\s*(.*)$", re.M)
    m = pattern.search(text)
    if not m:
        return False
    old = m.group(2).strip().strip('"').strip("'")
    if old == value:
        return False
    text = text[: m.start()] + f'{m.group(1)}{key_path.split(".")[-1]}: "{value}"' + text[m.end():]
    path.write_text(text, encoding="utf-8")
    return True


def casdoor_register(client_id: str, redirect_uris: list[str]) -> bool:
    """把回调地址登记进 Casdoor 应用的 redirect_uris（幂等）。"""
    code = (
        "SELECT redirect_uris FROM application WHERE client_id = %s;" % ("'" + client_id.replace("'", "") + "'")
    )
    rc, out = run(["docker", "exec", "-i", "lab-postgres", "psql", "-U", "casdoor", "-d", "casdoor", "-t", "-A", "-c", code])
    if rc != 0:
        log(f"读取 Casdoor redirect_uris 失败: {out.strip()[:200]}")
        return False
    raw = out.strip().splitlines()[-1] if out.strip() else ""
    try:
        current = json.loads(raw) if raw else []
    except json.JSONDecodeError:
        current = []
    merged = list(current)
    for uri in redirect_uris:
        if uri not in merged:
            merged.append(uri)
    if merged == current:
        return False
    payload = json.dumps(merged).replace("'", "''")
    sql = f"UPDATE application SET redirect_uris = '{payload}' WHERE client_id = '{client_id}';"
    rc, out = run(["docker", "exec", "-i", "lab-postgres", "psql", "-U", "casdoor", "-d", "casdoor", "-c", sql])
    if rc != 0:
        log(f"写入 Casdoor redirect_uris 失败: {out.strip()[:200]}")
        return False
    log(f"Casdoor {client_id} redirect_uris -> {merged}")
    return True


def wait_healthy(container: str, timeout: int = 180) -> bool:
    """等待容器 healthy（容器定义了 healthcheck 时必须等到 healthy）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        rc, out = run(
            ["docker", "inspect", "-f", "{{.State.Health.Status}}|{{.State.Status}}", container]
        )
        state = out.strip()
        if state.startswith("healthy|"):
            return True
        if state.endswith("|exited") or state.endswith("|dead"):
            log(f"{container} 已退出: {state}")
            return False
        time.sleep(2)
    log(f"{container} 未在 {timeout}s 内达到 healthy")
    return False


def sync_service(service: str, host: str) -> dict:
    """把指定服务的 OIDC 配置切到 host，返回结果。"""
    if service not in TARGETS:
        return {"ok": False, "error": f"未知服务: {service}"}
    compose_dir, compose_service, port, callback_path, client_id = TARGETS[service]
    issuer = f"http://{host}:8090"
    redirect_uri = f"http://{host}:{port}{callback_path}"

    # Quantum 的 issuer 唯一真值是 env 文件（config.yaml 里是 ${...} 占位符）
    changed = upsert_env(QUANTUM_ENV, {"FILEBROWSER_OIDC_ISSUER_URL": issuer})
    cfg = QUANTUM_DIR / "config.yaml"
    if cfg.exists():
        text = cfg.read_text(encoding="utf-8")
        m = re.search(r'^\s*issuerUrl:\s*(.*)$', text, re.M)
        if m and m.group(1).strip().strip('"').startswith("http"):
            # 历史上被写成字面量时同步改回（占位符更易维护）
            changed = upsert_yaml(cfg, "auth.oidc.issuerUrl", issuer) or changed

    if changed:
        log(f"{service}: 配置已更新 → {issuer} / {redirect_uri}，重建容器")
        rc, out = run(["docker", "compose", "up", "-d", compose_service], cwd=compose_dir)
        if rc != 0:
            return {"ok": False, "error": f"容器重建失败: {out.strip()[:300]}"}
        if not wait_healthy("lab-quantum"):
            return {"ok": False, "error": "容器重建后未在超时内就绪"}

    casdoor_register(client_id, [redirect_uri])
    return {
        "ok": True,
        "changed": changed,
        "host": host,
        "issuer": issuer,
        "redirectUri": redirect_uri,
        "target": f"http://{host}:{port}",
        "loginUrl": f"http://{host}:{port}/files/api/auth/oidc/login",
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "lab-oidc-sync/1.0"

    def _reply(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") in ("/health", ""):
            self._reply(200, {"ok": True, "service": "lab-oidc-sync"})
        else:
            self._reply(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        try:
            cfg = load_config()
        except Exception as exc:  # noqa: BLE001
            self._reply(500, {"ok": False, "error": f"配置读取失败: {exc}"})
            return
        token = self.headers.get("X-Ops-Token", "")
        if token != cfg.get("token"):
            self._reply(401, {"ok": False, "error": "令牌无效"})
            return
        length = int(self.headers.get("Content-Length", "0") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._reply(400, {"ok": False, "error": "请求体不是 JSON"})
            return
        service = str(payload.get("service", ""))
        host = str(payload.get("host", "")).split(":")[0]
        if not host:
            self._reply(400, {"ok": False, "error": "缺少 host"})
            return
        try:
            if service == "all":
                results = []
                changed = False
                for name in TARGETS:
                    item = sync_service(name, host)
                    results.append(item)
                    changed = changed or bool(item.get("changed"))
                result = {
                    "ok": all(r.get("ok") for r in results),
                    "service": "all",
                    "changed": changed,
                    "results": results,
                }
                if result["ok"]:
                    result["loginUrl"] = results[0].get("loginUrl", "")
            else:
                result = sync_service(service, host)
        except Exception as exc:  # noqa: BLE001
            self._reply(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})
            return
        self._reply(200 if result.get("ok") else 500, result)

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        log(fmt % args)


def main() -> None:
    cfg = load_config()
    host = cfg.get("listen_host", LISTEN[0])
    port = int(cfg.get("listen_port", LISTEN[1]))
    server = ThreadingHTTPServer((host, port), Handler)
    log(f"监听 http://{host}:{port}（令牌鉴权）")
    server.serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
