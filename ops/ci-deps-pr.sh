#!/usr/bin/env bash
# 月度依赖更新：改锁文件 → 跑门禁 → 开 PR（不直接推 main）。
#
# 只在 CNB 流水线里跑（需要 CNB_TOKEN 才能建分支/开 PR）。本地手动跑会
# 跳过推送与 PR，只留下工作区改动，方便人看一眼。
#
# 设计取舍：
#   * 永远不直接 push main：依赖升级必须过一个可审查的 PR。
#   * 门禁失败就不开 PR —— 让主干保持绿色，失败信息留在流水线日志里。
#   * 分支名带年月，重复跑同月会复用同一分支（force-with-lease 覆盖）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="labspace"
BRANCH="auto/deps-$(date +%Y-%m)"
API="https://api.cnb.cool"
REPO_SLUG="${CNB_REPO_SLUG:-math-nwafu/labspace}"
TOKEN="${CNB_TOKEN:-}"

log() { printf '[deps-pr] %s\n' "$*"; }

cd "$REPO_ROOT"

log "1/4 更新依赖"
bash "$PROJECT_DIR/ops/deps-update.sh"

if git diff --quiet && git diff --cached --quiet; then
  log "依赖无变化，结束"
  exit 0
fi

log "2/4 跑门禁"
for gate in ci-toolchain ci-hygiene ci-python ci-frontend ci-go; do
  log "  -> $gate"
  bash "$PROJECT_DIR/ops/$gate.sh" || {
    log "门禁 $gate 失败：不开 PR。请人工查看日志后再决定是否升级。"
    exit 1
  }
done

if [ -z "$TOKEN" ]; then
  log "3/4 跳过推送：未提供 CNB_TOKEN（本地运行模式）"
  git status --short
  exit 0
fi

log "3/4 推送到 $BRANCH"
git checkout -B "$BRANCH"
git add -A -- "$PROJECT_DIR"
git -c user.name="lab-deps-bot" -c user.email="deps@lab.local" \
  commit -m "chore(deps): 月度依赖刷新 $(date +%Y-%m)" -m "由 ops/deps-update.sh 自动生成，已通过 ci-toolchain / ci-hygiene / ci-python / ci-frontend / ci-go。"

REMOTE="https://cnb:${TOKEN}@cnb.cool/${REPO_SLUG}.git"
git push --force-with-lease "$REMOTE" "HEAD:refs/heads/$BRANCH"

log "4/4 创建/更新 PR"
BODY=$(python3 - "$BRANCH" "$REPO_SLUG" <<'PY'
import json, sys
branch, repo = sys.argv[1:3]
print(json.dumps({
    "title": f"chore(deps): 月度依赖刷新 {branch.rsplit('-', 1)[-1]}",
    "body": "自动化依赖更新：pnpm 锁文件 + pyproject/requirements 同步。\n\n门禁已在流水线内全部通过。请重点看 pnpm-lock 的版本跃迁是否可接受。",
    "head": branch,
    "base": "main",
    "head_repo": repo,
}))
PY
)
curl -sS -X POST "$API/$REPO_SLUG/-/pulls" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json" -H "Content-Type: application/json" \
  --data "$BODY" >/dev/null || log "PR 可能已存在（同分支重复运行），请在网页确认"

log "完成：$BRANCH"