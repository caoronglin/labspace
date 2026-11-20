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
import re
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
def _env_int(name: str, default: int) -> int:
    """读整型环境变量，写错了用默认值。

    直接 `int(os.environ.get(...))` 会让一个手误（例如 `LATEX_COMPILE_TIMEOUT=60s`）
    在 import 阶段抛异常，容器反复重启，日志里只有一行 ValueError。
    """
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip())
    except ValueError:
        return default


TIMEOUT = _env_int("LATEX_COMPILE_TIMEOUT", 60)
PORT = _env_int("LATEX_WORKER_PORT", 8131)
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


#: `\\documentclass[opts]{name}` —— 只取类名，用来判断类文件在不在。
_CLASS_RE = re.compile(r"\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}")
#: `\\include{name}` / `\\input{name}` —— 子文件缺了会报 "No file name.tex"。
_CHILD_RE = re.compile(r"\\(?:include|input)\s*\{([^}]+)\}")


def _strip_comments(text: str) -> str:
    """去掉整行的 `%` 注释，避免注释里的 documentclass 被当成真需求。"""
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("%"))


def _has_tex_file(workdir: str, name: str, suffix: str) -> bool:
    """类文件/子文件是否存在：先看临时目录（随请求上传的素材），再问 kpsewhich。"""
    local = os.path.join(workdir, name if name.endswith(suffix) else name + suffix)
    if os.path.exists(local):
        return True
    if os.path.exists(os.path.join(workdir, name)):
        return True
    try:
        proc = subprocess.run(
            ["kpsewhich", name if name.endswith(suffix) else name + suffix],
            cwd=workdir,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        # kpsewhich 不可用时不要误报：让 xelatex 自己去报错。
        return True
    return bool(proc.stdout.strip())


def _missing_dependencies(content: str, workdir: str) -> list[str]:
    """编译前就能确定缺失的类文件与子文件，返回中文说明列表。

    为什么要提前查：缺 `.cls` 时 xelatex 会停在 `Enter file name:` 交互提示符上，
    日志里只有一行 ``File `x.cls' not found``。用户看到的是"编译失败"，
    完全不知道下一步该做什么。这里一次把缺的东西列全，并直接说怎么补。
    """
    body = _strip_comments(content)
    missing: list[str] = []
    for name in dict.fromkeys(m.strip() for m in _CLASS_RE.findall(body)):
        # 只认"名字"：带路径成分或宏的写法交给 xelatex 自己报错，
        # 否则这里会把用户写的 ../ 拼进临时目录去探文件（没有意义也不安全）。
        if not name or "\\" in name or "#" in name or "/" in name or ".." in name:
            continue
        if not _has_tex_file(workdir, name, ".cls"):
            missing.append(f"缺少文档类 {name}.cls")
    for name in dict.fromkeys(m.strip() for m in _CHILD_RE.findall(body)):
        if not name or "\\" in name or "#" in name or " " in name or "/" in name or ".." in name:
            continue
        if not _has_tex_file(workdir, name, ".tex"):
            missing.append(f"缺少被 \\include/\\input 引入的子文件 {name}.tex")
    return missing


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
        # 先做一次"缺什么"预检：缺类文件时 xelatex 会停在交互提示符，
        # 日志只有一行 "File `x.cls' not found"，用户根本不知道该传什么。
        missing = _missing_dependencies(content, workdir)
        if missing:
            hint = "把缺的文件用右侧「素材」上传后重试（素材会与 main.tex 放在同一目录）。"
            return {
                "ok": False,
                "log": "编译前检查未通过：\n- " + "\n- ".join(missing) + "\n\n" + hint,
                "ms": 0,
                "pdf": "",
            }
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


#: 监听地址。必须绑 0.0.0.0：这个 sidecar 与门户后端是两个容器，
#: 按 compose 服务名互访；绑回环会让 `http://latex-compile:8131` 直接连不上。
#: 容器端口**不发布到宿主**（compose 里没有 ports 映射），也 drop 了全部 capability，
#: 因此这里不存在"对外暴露编译服务"的问题。
BIND_ADDR = os.environ.get("LATEX_WORKER_BIND", "0.0.0.0")  # nosec B104 -- 容器内网专用，见上


def main() -> None:
    server = ThreadingHTTPServer((BIND_ADDR, PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
