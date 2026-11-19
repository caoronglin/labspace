"""LaTeX 编译 sidecar。

只做一件事：收到源码 → 在临时目录里用 xelatex 编译 → 返回 PDF（base64）与日志。
- 不挂载任何门户数据卷，读不到账号、备份与用户文件；
- `-no-shell-escape` 禁止 \\write18，容器本身无外网出口；
- 单次编译超时 60s，临时目录随请求销毁；
- 请求里可以带 `files`（文件名 → base64），这些文件与 main.tex 写在**同一个
  临时目录**里，编译时一并可见（类文件 .cls / 样式 .sty / 图片就是这么进来的）。
"""
from __future__ import annotations

import base64
import binascii
import json
import os
import shutil
import subprocess
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 2 * 1024 * 1024
MAX_ASSETS = 20
MAX_ASSET_BYTES = 2 * 1024 * 1024
MAX_ASSETS_BYTES = 20 * 1024 * 1024
# 请求体上限：源码 2 MB + 素材 20 MB（base64 还要膨胀一点）
MAX_REQUEST = MAX_BODY + MAX_ASSETS_BYTES * 2
TIMEOUT = int(os.environ.get("LATEX_COMPILE_TIMEOUT", "60"))
PORT = int(os.environ.get("LATEX_WORKER_PORT", "8131"))
ENGINE = os.environ.get("LATEX_ENGINE", "xelatex")


def _decode_files(raw: object) -> dict[str, bytes]:
    """把请求里的 ``files``（文件名 → base64 文本）解成 {文件名: 字节}。

    只收平铺文件名（去掉路径成分）、限个数与限大小；不合规的直接丢弃，
    不让请求体里的路径把文件写到临时目录之外。
    """
    if not isinstance(raw, dict):
        return {}
    files: dict[str, bytes] = {}
    total = 0
    for name, blob in raw.items():
        if len(files) >= MAX_ASSETS:
            break
        if not isinstance(name, str) or not isinstance(blob, str):
            continue
        safe = os.path.basename(name.replace("\\", "/")).strip()
        if not safe or safe.startswith(".") or safe in files:
            continue
        try:
            data = base64.b64decode(blob, validate=True)
        except (ValueError, binascii.Error):
            continue
        if not data or len(data) > MAX_ASSET_BYTES or total + len(data) > MAX_ASSETS_BYTES:
            continue
        files[safe] = data
        total += len(data)
    return files


def _run(engine: str, workdir: str) -> tuple[bool, str, int]:
    env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": workdir,
        "TMPDIR": workdir,
        "TEXMFHOME": os.path.join(workdir, "texmf"),
        "TEXMFVAR": os.path.join(workdir, "texmf-var"),
        "TEXMFCACHE": os.path.join(workdir, "texmf-cache"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "SOURCE_DATE_EPOCH": "0",
        "FORCE_SOURCE_DATE": "1",
    }
    started = time.monotonic()
    try:
        proc = subprocess.run(
            [
                engine,
                "-no-shell-escape",
                "-interaction=nonstopmode",
                "-halt-on-error",
                "-file-line-error",
                "main.tex",
            ],
            cwd=workdir,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=TIMEOUT,
        )
        ms = int((time.monotonic() - started) * 1000)
        log = proc.stdout.decode("utf-8", "replace")[-24000:]
        return proc.returncode == 0, log, ms
    except subprocess.TimeoutExpired:
        return False, f"编译超时（>{TIMEOUT}s），请缩短内容或拆分章节", int((time.monotonic() - started) * 1000)
    except FileNotFoundError:
        return False, f"编译引擎 {engine} 未安装", 0


def compile_pdf(content: str, files: dict[str, bytes] | None = None) -> dict:
    if len(content.encode("utf-8")) > MAX_BODY:
        return {"ok": False, "log": "源码超过 2 MB 上限", "ms": 0, "pdf": ""}
    workdir = tempfile.mkdtemp(prefix="latex-", dir="/tmp")
    try:
        with open(os.path.join(workdir, "main.tex"), "w", encoding="utf-8") as fh:
            fh.write(content)
        # 素材与 main.tex 同目录：xelatex 按文件名就能找到它们
        for name, blob in (files or {}).items():
            with open(os.path.join(workdir, name), "wb") as fh:
                fh.write(blob)
        # 两遍编译以解析目录 / 交叉引用；第一遍失败就不再跑第二遍
        ok, log, ms = _run(ENGINE, workdir)
        if ok:
            ok2, log2, ms2 = _run(ENGINE, workdir)
            log, ms = log2 or log, ms + ms2
            ok = ok2
        pdf_path = os.path.join(workdir, "main.pdf")
        if not os.path.exists(pdf_path) or os.path.getsize(pdf_path) == 0:
            return {"ok": False, "log": log, "ms": ms, "pdf": ""}
        with open(pdf_path, "rb") as fh:
            data = base64.b64encode(fh.read()).decode("ascii")
        return {"ok": True, "log": log, "ms": ms, "pdf": data}
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "LabLatexWorker/1.0"

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._json(200, {"ok": True, "engine": ENGINE, "timeout": TIMEOUT})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/compile":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_REQUEST:
            self._json(413, {"error": "请求体过大或为空"})
            return
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, UnicodeDecodeError):
            self._json(400, {"error": "无法解析请求体"})
            return
        content = payload.get("content")
        if not isinstance(content, str) or not content.strip():
            self._json(400, {"error": "content 不能为空"})
            return
        result = compile_pdf(content, _decode_files(payload.get("files")))
        self._json(200, result)

    def log_message(self, format: str, *args) -> None:  # 避免把源码内容写进访问日志
        return


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()