#!/usr/bin/env python3
"""把 pnpm 写出的锁文件归一成仓库约定的形态。

背景（两个原因都不是洁癖）：

1. 有的 pnpm 版本会把自举清单与业务依赖写成两个 YAML 文档，它自己读回时
   报 ERR_PNPM_BROKEN_LOCKFILE（"expected a single document in the stream"）；
2. 两份文档里 importers/packages/snapshots 各有一份，评审看不出依赖到底
   是哪个版本——合成一份才有 diff 可读。

现状：pnpm 12.16.1 写回的锁文件实测已是单个合法文档，所以 `ci-frontend.sh`
不再调用本脚本（门禁不该为了后处理去联网装依赖）。它保留为
「锁文件坏成两份文档」时的一次性修复工具，手动跑。

用法：python3 lockfile-normalize.py <pnpm-lock.yaml>

刻意不依赖 PyYAML：要做的只是「留一份文档」，不需要解析 YAML。
（曾经用 yaml.safe_load + dump 重写整份文件，结果在 node:22-bookworm 里
因缺 pyyaml 直接 ModuleNotFoundError，而且会把 pnpm 的排序整段打散。）
"""
import sys

SEP = '---'


def normalize(path):
    raw = open(path, encoding='utf-8').read()
    # 行首 `---` 才是文档分隔符；块标量的内容都有缩进，不会命中
    docs = [d for d in raw.split('\n' + SEP + '\n') if d.strip()]
    if len(docs) <= 1:
        # 已经是单文档：原样不动，不要制造假的 diff
        print(f'{path}: 已是单文档，未改动')
        return
    # 取最后一份：既是业务依赖的完整视图，也是 pnpm 最新写出的那份
    doc = docs[-1].lstrip()
    if 'importers:' not in doc:
        raise SystemExit(f'{path}: 不是可识别的 pnpm 锁文件')
    merged = doc if doc.startswith(SEP) else SEP + '\n' + doc
    if not merged.endswith('\n'):
        merged += '\n'
    open(path, 'w', encoding='utf-8').write(merged)
    print(f'{path}: 已归并为单文档（原 {len(docs)} 份）')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('用法: lockfile-normalize.py <pnpm-lock.yaml>')
    normalize(sys.argv[1])
