#!/usr/bin/env bash
# 依赖刷新（月度自动更新的执行体，也可本地手动跑）。
#
# 设计取舍：
#   * 只刷新**已声明版本范围内的补丁/小版本**，不做跨大版本跃迁——大版本
#     升级需要人读 changelog，自动 PR 里做不了判断。
#   * 前端用 pnpm，后端用 pyproject.toml 作为唯一真源，再同步 requirements*.txt。
#   * 任何一步失败都立刻退出：宁可这月不提 PR，也不要半更新的锁文件。
#
# 用法：ops/deps-update.sh [--check]
#   --check  只报告过期依赖，不改文件（供人工巡检）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

log() { printf '[deps] %s\n' "$*"; }

cd "$ROOT"

log "前端：检查过期依赖"
pnpm outdated || true

if [ "$CHECK_ONLY" = "1" ]; then
  log "后端：检查过期依赖"
  ( cd backend && python3 -m pip index versions fastapi 2>/dev/null | head -3 ) || true
  log "--check 模式：不改文件"
  exit 0
fi

log "前端：按 package.json 的 semver 范围更新并写锁文件"
# --no-save 会跳过 package.json 写回；这里要保留精确 pin 风格，所以用
# "update" 只动 lockfile 中范围内的解析结果，package.json 交给人工改。
pnpm update --recursive

log "后端：同步 pyproject.toml → requirements*.txt"
if [ -x /usr/local/bin/lab-pyproject-sync ]; then
  /usr/local/bin/lab-pyproject-sync
else
  log "跳过：未找到 /usr/local/bin/lab-pyproject-sync（非部署机上的预期情况）"
fi

log "变更概览"
git -C "$ROOT" status --short || true