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
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG = Path("/etc/labspace/oidc-sync.json")
LISTEN = ("172.28.0.1", 8111)

QUANTUM_DIR = Path("/opt/lab-quantum")
QUANTUM_ENV = Path("/etc/lab-quantum/quantum.env")

# 服务 -> (compose 目录, compose 服务名, 端口, 回调路径, Casdoor client_id)
TARGETS = {
    "quantum": (QUANTUM_DIR, "quantum", 8080, "/files/api/auth/oidc/callback", "quantum"),
}


def load_config() -> dict:
    """读取配置。失败时抛带路径的明确错误——运维看日志就知道改哪个文件。"""
    try:
        raw = CONFIG.read_text(encoding="utf-8")
    except OSError as exc:
        raise RuntimeError(f"配置文件不可读 {CONFIG}: {exc}") from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"配置文件不是合法 JSON {CONFIG}: {exc}") from exc
    if not isinstance(data, dict):
        raise RuntimeError(f"配置文件顶层必须是对象 {CONFIG}")
    return data


def log(msg: str) -> None:
    print(f"[oidc-sync] {msg}", flush=True)


# --------------------------------------------------------------- 工具函数


#: 允许被本服务修改的目录（全部是运维配置位置）。
ALLOWED_WRITE_ROOTS = (Path("/opt"), Path("/etc"), Path("/srv"))


def guard_write(path: Path) -> Path:
    """确认要写的路径在允许根目录内，返回解析后的真实路径。

    本服务以 root 运行，一处疏忽就可能变成"以 root 写任意文件"。
    解析符号链接后再判断，避免通过 link 跳出允许范围。
    """
    target = path.resolve()
    for root in ALLOWED_WRITE_ROOTS:
        try:
            target.relative_to(root.resolve())
            return target
        except ValueError:
            continue
    raise PermissionError(f"拒绝写入 {path}（不在允许的运维目录内）")


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
        guard_write(path).write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
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
    guard_write(path).write_text(text, encoding="utf-8")
    return True


def casdoor_register(client_id: str, redirect_uris: list[str]) -> bool:
    """把回调地址登记进 Casdoor 应用的 redirect_uris（幂等）。"""
    # 值通过 psql 的 --set 传参（用 :'name' 取值，由 psql 做字面量转义），
    # 不再把 client_id 拼进 SQL 文本 —— 拼接转义迟早会漏一个引号。
    code = "SELECT redirect_uris FROM application WHERE client_id = :'client_id';"
    rc, out = run(
        [
            "docker", "exec", "-i", "lab-postgres", "psql", "-U", "casdoor", "-d", "casdoor",
            "-t", "-A", "--set", f"client_id={client_id}", "-c", code,
        ]
    )
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
    payload = json.dumps(merged)
    sql = "UPDATE application SET redirect_uris = :'uris' WHERE client_id = :'client_id';"
    rc, out = run(
        [
            "docker", "exec", "-i", "lab-postgres", "psql", "-U", "casdoor", "-d", "casdoor",
            "--set", f"client_id={client_id}", "--set", f"uris={payload}", "-c", sql,
        ]
    )
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
        if state.endswith(("|exited", "|dead")):
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


# ---------------------------------------------------------------- 后台任务
# 门户后端跑在容器里，看不到宿主机 systemd，所以「后台任务」必须由本服务
# 在宿主机上执行（与备份删除同一条令牌鉴权通道）。
# 白名单硬编码：绝不接受来自请求的任意 unit 名，否则等于开了一个
# "以 root 操作任意 systemd 单元"的口子。
MANAGED_UNITS = {
    "lab-daily-maintenance.timer",
    "lab-daily-maintenance.service",
    "lab-backup.timer",
    "lab-backup.service",
    "lab-backup-core.timer",
    "lab-backup-core.service",
    "lab-health.timer",
    "lab-health.service",
    "lab-oidc-sync.service",
    "lab-rag.service",
    "lab-sandbox.service",
    "labops-worker.service",
    "apptainer-primer.service",
}
# 允许「立即执行」的只有一次性任务；常驻服务不给一键重启，避免误踢线上服务。
TRIGGERABLE_UNITS = {
    "lab-daily-maintenance.service",
    "lab-backup.service",
    "lab-backup-core.service",
    "lab-health.service",
}


def unit_state(unit: str) -> dict:
    """读一个单元的 systemd 状态。失败也返回 dict，不抛异常（列表要能整体渲染）。"""
    code, out = run(
        ["systemctl", "show", unit, "--no-pager"],
        timeout=20,
    )
    info: dict[str, str] = {}
    if code == 0:
        for line in (out or "").splitlines():
            if "=" in line:
                k, _, v = line.partition("=")
                info[k] = v
    return info


def epoch_us_to_iso(value: object) -> str:
    """systemd 的 `list-timers --output=json` 用微秒时间戳，转成 ISO 8601 给前端。"""
    if value in (None, "", 0):
        return ""
    try:
        micros = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return str(value)
    try:
        return datetime.fromtimestamp(micros / 1_000_000, tz=UTC).astimezone().isoformat()
    except (OverflowError, OSError, ValueError):
        return ""


def timer_schedule() -> dict[str, dict]:
    """`systemctl list-timers --output=json` → {unit: {next,last,activates}}。"""
    code, out = run(
        ["systemctl", "list-timers", "--all", "--output=json", "--no-pager"], timeout=20
    )
    if code != 0:
        return {}
    try:
        rows = json.loads(out or "[]")
    except json.JSONDecodeError:
        return {}
    result: dict[str, dict] = {}
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        unit = str(row.get("unit") or "")
        if unit:
            result[unit] = {
                "next": epoch_us_to_iso(row.get("next")),
                "last": epoch_us_to_iso(row.get("last")),
                "activates": str(row.get("activates") or ""),
            }
    return result


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

    def _backup_forget(self, payload: dict) -> None:
        """删除一个 restic 快照。参数只接受十六进制 ID，其余一律拒绝。"""
        snapshot = str(payload.get("snapshot", "")).strip()
        if not re.fullmatch(r"[0-9a-fA-F]{8,64}", snapshot):
            self._reply(400, {"ok": False, "error": "快照 ID 必须是 8–64 位十六进制"})
            return
        script = SCRIPT_DIR / "backup-forget.sh"
        if not script.is_file():
            self._reply(500, {"ok": False, "error": "宿主机删除脚本不存在"})
            return
        try:
            code, out = run(["/bin/sh", str(script), snapshot], cwd=SCRIPT_DIR, timeout=900)
        except subprocess.TimeoutExpired:
            self._reply(504, {"ok": False, "error": "删除超时（restic prune 仍在后台）"})
            return
        if code != 0:
            detail = (out or "").strip().splitlines()[-1:] or ["未知错误"]
            log(f"backup forget failed: {detail[0]}")
            self._reply(500, {"ok": False, "error": detail[0]})
            return
        self._reply(200, {"ok": True, "snapshot": snapshot})

    def _tasks_list(self) -> None:
        """返回所有受管单元的状态。"""
        timers = timer_schedule()
        units = []
        for unit in sorted(MANAGED_UNITS):
            info = unit_state(unit)
            schedule = timers.get(unit, {})
            kind = "timer" if unit.endswith(".timer") else "service"
            # 区分「一次性任务」与「常驻服务」：只有服务才有 SubState=running
            if kind == "service" and info.get("ActiveState") == "inactive":
                kind = "oneshot"
            units.append(
                {
                    "unit": unit,
                    "kind": kind,
                    "active": info.get("ActiveState", "unknown"),
                    "result": info.get("Result", ""),
                    "sub": info.get("SubState", ""),
                    "enabled": info.get("UnitFileState", ""),
                    "last": schedule.get("last") or info.get("ExecMainExitTimestamp", ""),
                    "next": schedule.get("next", ""),
                    "activates": schedule.get("activates", ""),
                    "triggerable": unit in TRIGGERABLE_UNITS,
                }
            )
        self._reply(200, {"ok": True, "units": units})

    def _task_action(self, payload: dict, action: str, allowed: set[str]) -> None:
        """对白名单单元执行 start / reset-failed。"""
        unit = str(payload.get("unit", "")).strip()
        if unit not in allowed:
            self._reply(400, {"ok": False, "error": "该单元不允许此操作"})
            return
        args = ["systemctl", action]
        if action == "start":
            args.append("--no-block")
        args.append(unit)
        code, out = run(args, timeout=30)
        if code != 0:
            detail = (out or "").strip().splitlines()[-1:] or ["未知错误"]
            self._reply(500, {"ok": False, "error": detail[0]})
            return
        log(f"task {action}: {unit}")
        self._reply(200, {"ok": True, "unit": unit})

    def _task_logs(self, payload: dict) -> None:
        """某个单元最近的日志（默认 60 行，上限 200）。"""
        unit = str(payload.get("unit", "")).strip()
        if unit not in MANAGED_UNITS:
            self._reply(400, {"ok": False, "error": "未知的后台任务"})
            return
        try:
            lines = int(payload.get("lines", 60))
        except (TypeError, ValueError):
            lines = 60
        lines = max(10, min(lines, 200))
        code, out = run(
            ["journalctl", "-u", unit, "-n", str(lines), "--no-pager", "--output=short-iso"],
            timeout=25,
        )
        # journalctl 在没有日志时返回 0 + 空输出；非 0 且无输出才算失败
        if code != 0 and not (out or "").strip():
            self._reply(500, {"ok": False, "error": (out or "读取日志失败").strip()[:200]})
            return
        self._reply(200, {"ok": True, "unit": unit, "lines": (out or "").splitlines()})

    def do_POST(self) -> None:  # noqa: N802
        try:
            cfg = load_config()
        except Exception as exc:  # noqa: BLE001
            self._reply(500, {"ok": False, "error": f"配置读取失败: {exc}"})
            return
        token = self.headers.get("X-Ops-Token", "")
        accepted = {str(cfg.get("token") or "")}
        # 门户后端用 X-Lab-Service-Token 调 Go 核心；同一份令牌也用于本服务，
        # 避免为了"再抄一份运维令牌进容器"而多一处泄露面。
        accepted.add(os.environ.get("LABSPACE_SERVICE_TOKEN", ""))
        accepted.discard("")
        if not token or token not in accepted:
            self._reply(401, {"ok": False, "error": "令牌无效"})
            return
        # Content-Length 来自请求头，可能是脏值；解析失败按 0 处理，
        # 后面 json.loads 会给 400，而不是在这里抛 ValueError 变成 500。
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except (TypeError, ValueError):
            length = 0
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._reply(400, {"ok": False, "error": "请求体不是 JSON"})
            return

        # 备份删除走宿主机脚本：restic 仓库与口令只在本机 root 环境里，
        # 容器侧（门户后端 / Go 核心）都只有这一个转发入口。
        if self.path.rstrip("/") == "/ops/backup/forget":
            self._backup_forget(payload)
            return

        # 后台任务：列表 / 执行 / 重置失败状态（全部走白名单）
        if self.path.rstrip("/") == "/ops/tasks":
            self._tasks_list()
            return
        if self.path.rstrip("/") == "/ops/tasks/run":
            self._task_action(payload, "start", TRIGGERABLE_UNITS)
            return
        if self.path.rstrip("/") == "/ops/tasks/reset":
            self._task_action(payload, "reset-failed", MANAGED_UNITS)
            return
        if self.path.rstrip("/") == "/ops/tasks/logs":
            self._task_logs(payload)
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

    def log_message(self, format: str, *args) -> None:  # noqa: A002,A003
        log(format % args)


def main() -> None:
    cfg = load_config()
    host = cfg.get("listen_host", LISTEN[0])
    try:
        port = int(cfg.get("listen_port", LISTEN[1]))
    except (TypeError, ValueError):
        log(f"配置里的 listen_port 非法（{cfg.get('listen_port')!r}），回退默认 {LISTEN[1]}")
        port = LISTEN[1]
    server = ThreadingHTTPServer((host, port), Handler)
    log(f"监听 http://{host}:{port}（令牌鉴权）")
    server.serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
