#!/usr/bin/env python3
"""校验文档里的相对链接是否可达，并核对镜像 digest 与 compose 是否一致。

为什么需要它：根目录曾与 `docs/` 各存一份同名文档，两份各自漂移；合并成
`docs/` 单一真源后，如果没有人拦，链接会慢慢烂掉（改名、挪目录、删文件）。
这个脚本在 CI 与本地都能跑，坏链接直接非零退出。

用法：
    python3 ops/check-docs-links.py            # 校验
    python3 ops/check-docs-links.py --verbose  # 打印每个检查过的链接
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DOC_ROOTS = [REPO / "docs", REPO]
SKIP_DIRS = {"node_modules", ".git", "dist", ".venv", "linux-command", ".pi"}

# [text](target) 与 ![alt](target)；target 里可能有 "#anchor" 与 "<...>"
LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
# 这些协议不需要在仓库里找文件
EXTERNAL_PREFIXES = ("http://", "https://", "mailto:", "tel:", "#", "data:")


def md_files() -> list[Path]:
    out: list[Path] = []
    for root in DOC_ROOTS:
        if not root.exists():
            continue
        for p in root.glob("*.md"):
            if any(part in SKIP_DIRS for part in p.parts):
                continue
            out.append(p)
    return sorted(set(out))


def check_file(path: Path, verbose: bool) -> list[str]:
    problems: list[str] = []
    text = path.read_text(encoding="utf-8", errors="replace")
    for raw in LINK_RE.findall(text):
        target = raw.strip().strip("<>")
        if not target or target.startswith(EXTERNAL_PREFIXES):
            continue
        clean = target.split("#", 1)[0]
        if not clean:  # 纯锚点
            continue
        resolved = (path.parent / clean).resolve()
        if verbose:
            print(f"  {path.relative_to(REPO)} -> {clean}")
        if not resolved.exists():
            problems.append(f"{path.relative_to(REPO)}: 断链 {clean}")
    return problems


def check_digests() -> list[str]:
    """docs/IMAGES_LOCK.md 里列的 digest 必须真的出现在 compose.yaml 里。"""
    lock = REPO / "docs" / "IMAGES_LOCK.md"
    compose = REPO / "deploy" / "compose.yaml"
    if not lock.exists() or not compose.exists():
        return []
    compose_text = compose.read_text(encoding="utf-8")
    problems = []
    for digest in re.findall(r"sha256:[0-9a-f]{64}", lock.read_text(encoding="utf-8")):
        if digest not in compose_text:
            problems.append(f"docs/IMAGES_LOCK.md: digest {digest[:19]}… 未出现在 compose.yaml")
    return problems


def main() -> int:
    verbose = "--verbose" in sys.argv
    files = md_files()
    problems: list[str] = []
    for f in files:
        problems.extend(check_file(f, verbose))
    problems.extend(check_digests())

    if problems:
        print(f"发现 {len(problems)} 处问题：")
        for p in problems:
            print("  -", p)
        return 1
    print(f"OK：{len(files)} 份文档，相对链接与镜像 digest 均一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
