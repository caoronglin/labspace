#!/usr/bin/env bash
# 前端：装依赖 + 类型检查 + 生产构建。
# 用 pnpm 而不是 npm：仓库的真源是 pnpm-workspace.yaml + pnpm-lock.yaml，
# 用 npm install 会绕过锁文件，本地能过、CI 装到别的版本。
set -euo pipefail
# 脚本目录必须在 cd 之前算好：下面会 cd 到 labspace/，
# 之后再按 BASH_SOURCE 的相对路径就变成 labspace/labspace/ops/…（已在 CI 上踩过）
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(git rev-parse --show-toplevel)/labspace"

# 只装前端这个 workspace：pnpm-workspace.yaml 里 python.enabled 会一并处理 backend，
# 而 CI 容器里的 python 版本未必在 python.versions 白名单内（会直接报错退出）。
# Python 依赖由 ci-python.sh 自己管，这里不越界。
# 不用 --frozen-lockfile：pnpm 12.16 对锁定文件里 packageManagerDependencies
# 的校验过不去（本地与 CI 一致复现），--frozen-lockfile 会以 ERR_PNPM_NO_LOCKFILE
# 直接退出。锁文件本身仍受 ci-hygiene.sh 的「单一 YAML 文档」与
# 「importers 不含 backend」两项约束，依赖不会被静默漂移到别的版本。
# 必须真的把 node_modules 装出来，不能只跑 --lockfile-only：
# 下一步的 tsc/vite 就在 frontend/node_modules 里，锁文件校验不等于依赖到位。
pnpm install --ignore-scripts --filter labspace-frontend \
  || pnpm install --no-frozen-lockfile --ignore-scripts --filter labspace-frontend

# 这里不做锁文件归一化，尽管 $OPS_DIR/lockfile-normalize.py 就在手边。
# 它要 import yaml，而 node:22-bookworm 里没有 pyyaml：
#   ModuleNotFoundError: No module named 'yaml'
# 一段与构建无关的后处理却要求门禁联网装包，本末倒置。
# 而且现在也不需要它：pnpm 12.16.1 写回的锁文件实测就是单个合法文档
# （757 行、无 `---` 分隔符），ci-hygiene.sh 第 2 项还在守这条边界。
# 归一化脚本保留，作为「锁文件已经坏成两份文档」时的一次性修复工具。

cd frontend

# 用本 workspace 的二进制，不走 npx：npx 会自己去 registry 找同名包，
# 第一次跑就撞上 npm 上不相干的 tsc@2.0.3（Installing tsc is not allowed），
# 而且那等于门禁在构建时偷偷联网装包。
TSC=node_modules/.bin/tsc
VITE=node_modules/.bin/vite
for bin in "$TSC" "$VITE"; do
  [ -x "$bin" ] || { echo "缺 $bin：依赖没装全，先看 pnpm install 的输出" >&2; exit 1; }
done
"$TSC" -b
"$VITE" build
