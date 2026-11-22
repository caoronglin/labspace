#!/usr/bin/env python3
"""检查后端路由装饰器是否都正确绑定到函数。

背景：Phase 2 把 main.py 拆成 routers/ 时，ops/split_main_module.py 把函数体搬走
却把 ``@app.get(...)`` 装饰器留在原处，形成「孤儿装饰器链」——它不会报错，
而是静默地把下一个函数注册到错误的路径（例如 /api/services 被绑到 api_databases，
返回结构完全错位）。旧镜像侥幸没暴露，重建后直接让多个 e2e 用例失败。

本脚本扫描 backend/app 下所有 .py，要求每条 ``@app.xxx`` / ``@router.xxx``
装饰器链（允许中间空行/注释/其它装饰器）最终必须跟一个 ``def`` 或 ``async def``。
CI 可直接调用，发现孤儿链时退出码 1。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "backend" / "app"
DECORATOR = re.compile(r"^\s*@(?:app|router)\.(?:get|post|put|delete|patch|head|options)\(")
DEF = re.compile(r"^\s*(?:async\s+)?def\s+")


def decorator_end(lines: list[str], start: int) -> int:
    """返回装饰器结束行（支持跨行括号参数）。"""
    depth = 0
    for i in range(start, len(lines)):
        depth += lines[i].count("(") - lines[i].count(")")
        if depth <= 0:
            return i
    return len(lines) - 1


def check_file(path: Path) -> list[int]:
    lines = path.read_text(encoding="utf-8").splitlines()
    bad: list[int] = []
    i = 0
    while i < len(lines):
        if not DECORATOR.match(lines[i]):
            i += 1
            continue
        # 收集连续装饰器（中间允许空行 / 注释 / 其它装饰器；支持多行参数）
        j = decorator_end(lines, i)
        while True:
            k = j + 1
            while k < len(lines) and (not lines[k].strip() or lines[k].lstrip().startswith("#")):
                k += 1
            if k < len(lines) and DECORATOR.match(lines[k]):
                j = decorator_end(lines, k)
                continue
            break
        # 最后一个装饰器之后的下一个有效行必须是 def
        k = j + 1
        while k < len(lines) and (not lines[k].strip() or lines[k].lstrip().startswith("#")):
            k += 1
        if k >= len(lines) or not DEF.match(lines[k]):
            bad.append(i + 1)
            i = k
        else:
            i = k + 1
    return bad


def main() -> int:
    problems: list[tuple[str, int]] = []
    for path in sorted(ROOT.rglob("*.py")):
        for line in check_file(path):
            problems.append((str(path.relative_to(ROOT.parent.parent)), line))
    if problems:
        print("❌ 发现孤儿路由装饰器（装饰器链未绑定到函数）：", file=sys.stderr)
        for f, line in problems:
            print(f"  {f}:{line}", file=sys.stderr)
        return 1
    print("✓ 路由装饰器绑定检查通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
