#!/usr/bin/env python3
"""把 main.py 里的一组顶层定义按名字搬进指定模块（AST 定位，不靠行号猜）。

为什么写工具而不是手工切：main.py 有 2000 行、80+ 个路由，手工切一次错一次，
而且切完没人敢再动。用 AST 拿到每个定义的**精确**起止行（含装饰器与前面的
注释），再把被搬走的代码里用到的名字映射回 main.py 原有的 import 语句，
自动生成新模块的 import 头。

用法:
    python3 ops/split_main_module.py <目标模块路径> <名字1> <名字2> ...
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

MAIN = Path("backend/app/main.py")


def top_level_defs(tree: ast.Module) -> dict[str, ast.stmt]:
    out: dict[str, ast.stmt] = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out[node.name] = node
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    out[t.id] = node
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            out[node.target.id] = node
    return out


def imported_names(tree: ast.Module) -> dict[str, str]:
    """main.py 里的名字 → 原始 import 语句文本（用于自动补 import）。"""
    mapping: dict[str, str] = {}
    for node in tree.body:
        if not isinstance(node, (ast.Import, ast.ImportFrom)):
            continue
        seg = ast.get_source_segment(MAIN.read_text(encoding="utf-8"), node) or ""
        for alias in node.names:
            local = alias.asname or alias.name
            mapping[local] = seg
    return mapping


def used_names(nodes: list[ast.stmt]) -> set[str]:
    names: set[str] = set()
    for n in nodes:
        for sub in ast.walk(n):
            if isinstance(sub, ast.Name):
                names.add(sub.id)
            elif isinstance(sub, ast.Attribute):
                cur = sub
                while isinstance(cur, ast.Attribute):
                    cur = cur.value
                if isinstance(cur, ast.Name):
                    names.add(cur.id)
    return names


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    target = Path(sys.argv[1])
    wanted = sys.argv[2:]

    src = MAIN.read_text(encoding="utf-8")
    lines = src.split("\n")
    tree = ast.parse(src)
    defs = top_level_defs(tree)
    imports = imported_names(tree)

    missing = [w for w in wanted if w not in defs]
    if missing:
        print(f"main.py 里找不到这些名字：{missing}")
        return 1

    spans = []
    for name in wanted:
        node = defs[name]
        # 装饰器行必须一起搬走：只从 def 开始切，会把 @app.get(...) 留在 main.py 里，
        # 它就会「挂」到下一个函数上（或直接语法错误）。这条是踩过两次的坑。
        decorators = [d.lineno for d in getattr(node, "decorator_list", [])]
        start = (min(decorators) if decorators else node.lineno) - 1
        # 把紧贴在上面的注释/空行一起带走（注释属于这段代码的解释）
        while start > 0 and (lines[start - 1].startswith("#") or lines[start - 1].strip() == ""):
            if lines[start - 1].strip() == "" and (start - 2 < 0 or lines[start - 2].strip() == ""):
                break
            start -= 1
        spans.append((start, node.end_lineno))

    spans.sort()
    # 合并重叠/相邻
    merged: list[list[int]] = []
    for a, b in spans:
        if merged and a <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])

    chunks = [lines[a:b] for a, b in merged]
    body = "\n\n".join("\n".join(c).replace("@app.", "@router.") for c in chunks)

    # 被搬走的代码用到了哪些 main.py 里的导入名
    moved_nodes = [defs[n] for n in wanted]
    needed = sorted(used_names(moved_nodes) & imports.keys())
    # 自身定义的名字不需要 import
    needed = [n for n in needed if n not in wanted]
    import_lines = sorted({
        # main.py 在 app/ 下，新模块在 app/routers/ 下：相对导入要多一层
        imports[n].replace("from .", "from ..", 1).replace("from .. import", "from .. import")
        for n in needed
    })

    header = "\n".join(import_lines)
    content = (
        f'"""{target.stem} 路由（由 ops/split_main_module.py 从 main.py 搬出）。"""\n'
        "from __future__ import annotations\n\n"
        f"{header}\n"
        "from fastapi import APIRouter\n\n"
        "router = APIRouter()\n\n\n"
        f"{body}\n"
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")

    # 从 main.py 删掉这些行
    keep = []
    drop = set()
    for a, b in merged:
        drop.update(range(a, b))
    for i, line in enumerate(lines):
        if i not in drop:
            keep.append(line)
    MAIN.write_text("\n".join(keep), encoding="utf-8")

    print(f"已搬出 {len(wanted)} 个定义到 {target}（{len(merged)} 段，{sum(b-a for a,b in merged)} 行）")
    print("自动导入：", ", ".join(needed) if needed else "（无）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
