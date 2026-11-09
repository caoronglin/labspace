#!/usr/bin/env python3
"""一次性代码沙箱：每次执行拉起独立容器，结束后立即删除。

只监听回环地址，由 Agent 网关（宿主机进程）调用。安全边界：
- 无网络（--network none）、只读根文件系统、去 capabilities、no-new-privileges
- 内存 256MB、CPU 0.5 核、PID 128、超时上限 60s；输出截断
- 非 root 用户运行；容器 --rm，超时则 docker rm -f
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("LAB_SANDBOX_TOKEN", "").strip()
HOST = os.environ.get("LAB_SANDBOX_ADDR", "127.0.0.1")
PORT = int(os.environ.get("LAB_SANDBOX_PORT", "8130"))
MAX_CODE = 64 * 1024
MAX_OUTPUT = 20_000
MAX_TIMEOUT = 60
DEFAULT_TIMEOUT = 20
SLOTS = threading.BoundedSemaphore(2)
STATUS_FILE = os.environ.get("LAB_SANDBOX_STATUS", "/srv/labdata/labgo/sandbox-status.json")
STATE = {"runs": 0, "last_run": ""}


def _write_status() -> None:
    payload = {
        "ok": True,
        "engine": "docker-ephemeral",
        "runs": STATE["runs"],
        "lastRun": STATE["last_run"],
        "updatedAt": int(time.time()),
    }
    try:
        tmp = STATUS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)
        os.replace(tmp, STATUS_FILE)
    except OSError:
        pass


def _heartbeat() -> None:
    while True:
        _write_status()
        time.sleep(20)

LANGUAGES = {
    "python": ("python:3.11-slim", ["python", "-I", "-"]),
    "bash": ("python:3.11-slim", ["sh", "-s"]),
}


def _run(lang: str, code: str, timeout: int) -> dict:
    image, cmd = LANGUAGES[lang]
    name = f"lab-sbx-{uuid.uuid4().hex[:12]}"
    argv = [
        "docker", "run", "--rm", "--name", name,
        "--network", "none", "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
        "--memory", "256m", "--memory-swap", "256m",
        "--cpus", "0.5", "--pids-limit", "128",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--user", "65534:65534", "-i", image, *cmd,
    ]
    started = time.monotonic()
    try:
        proc = subprocess.run(
            argv, input=code.encode(), capture_output=True, timeout=timeout + 5
        )
        out = proc.stdout.decode("utf-8", "replace")[:MAX_OUTPUT]
        err = proc.stderr.decode("utf-8", "replace")[:MAX_OUTPUT]
        return {
            "ok": proc.returncode == 0,
            "exitCode": proc.returncode,
            "stdout": out,
            "stderr": err,
            "elapsedMs": int((time.monotonic() - started) * 1000),
            "destroyed": True,
        }
    except subprocess.TimeoutExpired:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=20)
        return {
            "ok": False,
            "exitCode": -1,
            "stdout": "",
            "stderr": f"执行超时（>{timeout}s），容器已销毁",
            "elapsedMs": int((time.monotonic() - started) * 1000),
            "destroyed": True,
        }
    except FileNotFoundError:
        return {"ok": False, "exitCode": -1, "stdout": "", "stderr": "宿主机缺少 docker 命令", "destroyed": True}


class Handler(BaseHTTPRequestHandler):
    server_version = "lab-sandbox/1.0"

    def log_message(self, *_args):  # 不记录请求体
        return

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "sandbox": "docker-ephemeral"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/run":
            self._send(404, {"error": "not found"})
            return
        if TOKEN and self.headers.get("X-Lab-Sandbox-Token", "") != TOKEN:
            self._send(403, {"error": "forbidden"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._send(400, {"error": "bad length"})
            return
        if length <= 0 or length > MAX_CODE + 1024:
            self._send(400, {"error": "请求体为空或过大"})
            return
        try:
            payload = json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError):
            self._send(400, {"error": "JSON 解析失败"})
            return
        lang = str(payload.get("language") or "python").lower()
        code = str(payload.get("code") or "")
        if lang not in LANGUAGES:
            self._send(400, {"error": f"不支持的语言：{lang}（可选 python / bash）"})
            return
        if not code.strip():
            self._send(400, {"error": "code 不能为空"})
            return
        if len(code.encode()) > MAX_CODE:
            self._send(400, {"error": f"代码超过 {MAX_CODE // 1024}KB"})
            return
        try:
            timeout = int(payload.get("timeout") or DEFAULT_TIMEOUT)
        except (TypeError, ValueError):
            timeout = DEFAULT_TIMEOUT
        timeout = max(1, min(timeout, MAX_TIMEOUT))
        if not SLOTS.acquire(timeout=10):
            self._send(429, {"error": "沙箱繁忙，请稍后重试"})
            return
        try:
            result = _run(lang, code, timeout)
            STATE["runs"] += 1
            STATE["last_run"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            _write_status()
            self._send(200, result)
        finally:
            SLOTS.release()


if __name__ == "__main__":
    _write_status()
    threading.Thread(target=_heartbeat, daemon=True).start()
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()