#!/usr/bin/env bash
# cropgenome-toolkit 前端：装依赖 + 类型检查 + 构建 + 契约一致性。
#
# 为什么单开一条而不并进 ci-frontend.sh：
#   cropgenome-toolkit/frontend 有自己的 pnpm-workspace.yaml 与锁文件，
#   是**独立的依赖树**。塞进 labspace 的 workspace 会绕开那份锁文件，
#   于是本地能过、CI 装到别的版本——正是 ci-frontend.sh 那段注释在防的事。
#
# 这一条要守的边界（前两条 tsc/vite 会守，第三条只有契约门禁守）：
#   1. 类型自洽：tsc -b；
#   2. 能构建：vite build；
#   3. 类型声明**和真后端一致**：tests/conformance.test.ts。
#      tsc 只信声明，声明写错了它一样绿——db.supported_modes「后端不回」
#      那种谎话就是这么过的。所以必须有一步拿声明去撞契约夹具。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)/cropgenome-toolkit/frontend"

# 依赖装进本目录的 node_modules（这份 package.json 自带 pnpm-lock.yaml）。
# --ignore-scripts：CI 里不需要 esbuild 的 postinstall 去改缓存目录，
# 打补丁式脚本只会让「装依赖」变成网络抽奖。
# 这份 pnpm-workspace.yaml 只有 allowBuilds、没有 packages 字段，
# pnpm 9+ 会直接报 `packages field missing or empty` —— 必须 --ignore-workspace，
# 否则这条 stage 死在装依赖这一步（本地已复现，不是理论问题）。
pnpm install --ignore-workspace --ignore-scripts --no-frozen-lockfile 2>&1 | tail -5

TSC=node_modules/.bin/tsc
VITE=node_modules/.bin/vite
for bin in "$TSC" "$VITE"; do
  [ -x "$bin" ] || { echo "缺 $bin：依赖没装全，先看 pnpm install 的输出" >&2; exit 1; }
done

echo "== 契约一致性（types/api.ts ↔ contract/shapes.json）"
bash tests/run-conformance.sh | tail -3

echo "== tsc -b"
"$TSC" -b

echo "== vite build"
"$VITE" build 2>&1 | tail -3

echo "== 纯函数单测"
node_modules/.bin/tsx tests/utils.test.ts | tail -2

echo "== 契约 stub 联调（devtools/contract-server.mjs ↔ tests/contract.test.ts）"
bash tests/run-contract.sh | tail -3
