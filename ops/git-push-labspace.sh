#!/usr/bin/env bash
# 把本地 /opt/labspace 的工作树同步到 CNB 单仓多项目仓库的 labspace/ 子目录，
# 建分支 → 推送 → 创建 PR → （可选）合并。
#
# 背景：远端仓库 https://cnb.cool/math-nwafu/labspace 是单仓多项目，
# 本项目代码位于其 labspace/ 子目录；本地 /opt/labspace 就是该子目录的内容。
#
# 用法：
#   ops/git-push-labspace.sh <branch> "<PR 标题>" "<PR 正文>" [路径 ...]
#
#   路径参数可省略：省略时同步整个 labspace/ 子目录；
#   指定时只提交这些路径（相对 /opt/labspace），其余差异保留在工作区不提交。
#
# 环境变量：
#   SRC_DIR     源目录，默认 /opt/labspace
#   MONO_DIR    monorepo 克隆目录，默认 /opt/lab-monorepo
#   CNB_REPO    仓库标识，默认 math-nwafu/labspace
#   CNB_API     API 根，默认 https://api.cnb.cool
#   CNB_TOKEN_FILE  token 存储，默认 /root/.cnb/token
#   MERGE       1=建 PR 后自动合并，0=只建 PR，默认 1
#   MERGE_STYLE 合并方式：squash | merge | rebase | fast_forward，默认 squash
#
# 安全：token 只从 CNB_TOKEN_FILE 读取，不写入命令行参数、不落盘到仓库。
set -euo pipefail

SRC_DIR=${SRC_DIR:-/opt/labspace}
MONO_DIR=${MONO_DIR:-/opt/lab-monorepo}
CNB_REPO=${CNB_REPO:-math-nwafu/labspace}
CNB_API=${CNB_API:-https://api.cnb.cool}
CNB_TOKEN_FILE=${CNB_TOKEN_FILE:-/root/.cnb/token}
MERGE=${MERGE:-1}
MERGE_STYLE=${MERGE_STYLE:-squash}

if [ "$#" -lt 2 ]; then
  echo "用法: $0 <branch> \"<PR 标题>\" \"<PR 正文>\" [路径 ...]" >&2
  exit 2
fi

BRANCH=$1
TITLE=$2
BODY=${3:-}
shift 3 || true
PATHS=("$@")

[ -d "$MONO_DIR/.git" ] || { echo "monorepo 克隆不存在: $MONO_DIR" >&2; exit 1; }
[ -f "$CNB_TOKEN_FILE" ] || { echo "缺少 token 文件: $CNB_TOKEN_FILE" >&2; exit 1; }

TOKEN=$(python3 - "$CNB_TOKEN_FILE" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(d["auths"]["cnb.cool"]["access_token"])
PY
)

api() { # api METHOD PATH [BODY_JSON]
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -sS -X "$method" -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
      -H "Content-Type: application/json" --data "$body" "$CNB_API$path"
  else
    curl -sS -X "$method" -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" "$CNB_API$path"
  fi
}

echo "==> 同步 $SRC_DIR -> $MONO_DIR/labspace"
rsync -a \
  --exclude '.git/' --exclude 'node_modules/' --exclude '.venv/' --exclude 'dist/' \
  --exclude 'build/' --exclude '__pycache__/' --exclude '*.pyc' --exclude '.ruff_cache/' \
  --exclude '.pytest_cache/' --exclude '.pi/' --exclude '.qoder/' --exclude '*.tsbuildinfo' \
  --exclude '.env' --exclude '.env.*' --exclude '*.log' --exclude '*.sqlite' --exclude '*.sqlite3' \
  --exclude 'e2e/shots/' --exclude 'shots/' \
  "$SRC_DIR/" "$MONO_DIR/labspace/"

cd "$MONO_DIR"

BASE_BRANCH=${BASE_BRANCH:-main}
git fetch origin "$BASE_BRANCH" --quiet
git checkout -B "$BRANCH" "origin/$BASE_BRANCH" --quiet

if [ "${#PATHS[@]}" -gt 0 ]; then
  ADD_ARGS=()
  for p in "${PATHS[@]}"; do ADD_ARGS+=("labspace/$p"); done
  # 只登记改动与新增：本地树缺文件（例如只在远端存在的文档）不应被当成删除。
  # 真需要删文件时用 DELETIONS 环境变量显式列出。
  git add -- "${ADD_ARGS[@]}" || true
  if [ -n "${DELETIONS:-}" ]; then
    for d in $DELETIONS; do git rm -q --cached -- "labspace/$d" || true; done
  fi
else
  git add -- labspace/
  if [ -n "${DELETIONS:-}" ]; then
    for d in $DELETIONS; do git rm -q --cached -- "labspace/$d" || true; done
  fi
fi

if git diff --cached --quiet; then
  echo "==> 无可提交变更，跳过（分支 $BRANCH 不推送）"
  exit 0
fi

echo "==> 待提交变更："
git diff --cached --stat | tail -20

COMMIT_MSG="chore(labspace): $TITLE"
git commit -q -m "$COMMIT_MSG" -m "$BODY"

git push -q --force-with-lease origin "HEAD:refs/heads/$BRANCH"

echo "==> 创建 PR"
PR_BODY=$(python3 - "$TITLE" "$BODY" "$BRANCH" "$CNB_REPO" <<'PY'
import json, sys
title, body, head, repo = sys.argv[1:5]
print(json.dumps({"title": title, "body": body, "head": head, "base": "main", "head_repo": repo}))
PY
)
PR_JSON=$(api POST "/$CNB_REPO/-/pulls" "$PR_BODY")
PR_NUM=$(printf '%s' "$PR_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("number") or d.get("iid") or "")' 2>/dev/null || true)

if [ -z "$PR_NUM" ]; then
  echo "!! 创建 PR 失败：$PR_JSON" >&2
  exit 1
fi
echo "==> PR #$PR_NUM 已创建"

if [ "$MERGE" = "1" ]; then
  echo "==> 合并 PR #$PR_NUM（$MERGE_STYLE）"
  MERGE_JSON=$(api PUT "/$CNB_REPO/-/pulls/$PR_NUM/merge" \
    "$(python3 -c 'import json,sys; print(json.dumps({"merge_style": sys.argv[1], "commit_title": sys.argv[2]}))' "$MERGE_STYLE" "$TITLE")")
  echo "$MERGE_JSON" | head -c 400; echo
fi

echo "==> 完成：分支 $BRANCH，PR #$PR_NUM"
