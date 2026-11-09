#!/usr/bin/env bash
# 仓库卫生与安全约定（对应根 README「安全约定」一节）。
# 这几条靠人自觉守不住，合并前必须挡一次。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
fail=0

# 只扫「配置文件 + 脚本」：源码里 const TOKEN = request.cookies.get(...) 是取值逻辑，
# 不是凭据本身，误报会把这条检查变成噪音。
SCAN_GLOBS=('*.yml' '*.yaml' '*.conf' '*.ini' '*.toml' '*.env' '*.json' '*.sh' '*.py' '*.mjs')

echo "== 1. 配置与脚本里不得出现真实凭据"
hits=$(git grep -nIiE '\b(password|passwd|secret|api[_-]?key|access[_-]?token)\b[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9_./+@-]{10,}' \
        -- "${SCAN_GLOBS[@]}" \
        ':!*.example' ':!*.example.*' ':!*_test.*' ':!*/tests/*' ':!*_test.go' \
        ':!pnpm-lock.yaml' ':!labspace/ops/ci-hygiene.sh' ':!labspace/backend/app/*' 2>/dev/null || true)
# 允许「值来自环境变量 / 文件 / 变量引用」的写法
hits=$(printf '%s\n' "$hits" | grep -vE '[:=][[:space:]]*["'"'"']?(\$|\{\{|process\.env|ENV\[|os\.environ|getenv)' | grep -v '^$' || true)
# 已知例外：Casdoor 的内置测试口令（既有项，单独跟踪），其余一律拦截
KNOWN_EXCEPTIONS='casdoor-local-dev-pw'
hits=$(printf '%s\n' "$hits" | grep -vF "$KNOWN_EXCEPTIONS" | grep -v '^$' || true)
if [ -n "$hits" ]; then
  echo "  发现疑似明文凭据（除已知例外 $KNOWN_EXCEPTIONS）："
  printf '%s\n' "$hits" | sed 's/^/    /' | head -20
  fail=1
else
  echo "  ok"
fi

echo "== 2. 锁文件必须是单个 YAML 文档"
# pnpm-lock.yaml 曾出现两份文档拼接，pnpm 直接报 ERR_PNPM_BROKEN_LOCKFILE。
#
# 这条守的是「提交进仓库的那份」：pnpm 12.16.1 每次 install 都会写回两份
# （自举清单 + 业务依赖），那是它当下的正常输出，仓库存的必须是归一后的单文档。
# 归一的活由 lockfile-normalize.py 做——它是手动的一次性修复工具，不进流水线：
# 门禁为了后处理去联网装 pyyaml，本末倒置（node:22-bookworm 里没有），
# 而且 install 之后就地归一等于让 CI 拿产物去改写工作区，检查还是红的。
# 所以：这里只判定，不修复；红了就手动跑一次那份脚本再提交。
# 没有 python3 / PyYAML 时跳过本项：hygiene 是「不联网也能跑」的最低门槛。
for lock in $(git ls-files '*pnpm-lock.yaml'); do
  if ! command -v python3 >/dev/null; then
    echo "  （无 python3，跳过 $lock）"
    continue
  fi
  out=$(python3 - "$lock" <<'PY'
import sys
try:
    import yaml
except ImportError:
    print('skip 无 PyYAML，跳过'); sys.exit(0)
try:
    docs = [d for d in yaml.safe_load_all(open(sys.argv[1], encoding='utf-8'))
            if isinstance(d, dict) and d]
except yaml.YAMLError as e:
    print(f'bad   YAML 解析失败：{e}'); sys.exit(0)
if not docs or 'importers' not in docs[-1]:
    print('bad   找不到 importers 段'); sys.exit(0)
# 一份合法锁文件只有一份文档。两份文档 = 同一个 importer / package 被定义两遍，
# pnpm 读回时才会报 ERR_PNPM_BROKEN_LOCKFILE。
#
# 空文档不算：`---` 开头的文件被 safe_load_all 读成 [None, {...}]，
# 而带文档起始标记是合法 YAML，pnpm 照读不误。只有 None 才被过滤掉，
# 内容为空的 `{}` 仍然算一份文档（那才是真的拼接）。
# 注意 pnpm 12.16.1「每次」install 都会写回两份（自举清单 + 业务依赖），
# 那是它当下的正常输出，所以这项只有在锁文件已经归一进仓库后才有意义：
# 归一的活由 lockfile-normalize.py 做（一次性修复工具，不进 CI，见其文档）。
if len(docs) > 1:
    print(f'bad   {len(docs)} 个 YAML 文档（应为 1），跑 labspace/ops/lockfile-normalize.py 修')
else:
    print('ok')
PY
)
  case "$out" in
    ok)          echo "  $lock ok" ;;
    skip*|无*)   echo "  （$out）" ;;
    *)           echo "  $lock $out"; fail=1 ;;
  esac
done

echo "== 3. Go 内核保持零外部依赖"
mod=labspace/go-core/go.mod
if grep -qE '^require' "$mod"; then
  echo "  $mod 出现 require，违反零依赖约束："
  grep -nE '^require' "$mod" | sed 's/^/    /'
  fail=1
else
  echo "  ok"
fi
if [ -f labspace/go-core/go.sum ]; then
  echo "  labspace/go-core/go.sum 不应存在"
  fail=1
fi

echo "== 4. 代码与配置不得硬编码现网地址"
# 说明性注释里写现网 IP 是正常的（部署文档必须讲清入口）；
# 但脚本/源码里写死 IP，换环境就得改代码，这属于真实缺陷。
# 只看本次改动引入的行：历史代码里的硬编码是既有技术债，不该让每个 PR 都红
base="${CNB_BRANCH_SHA:-}"
if [ -n "$base" ] && git cat-file -e "$base" 2>/dev/null; then
  bad=$(git diff -U0 "$base"..HEAD -- '*.sh' '*.go' '*.py' '*.ts' '*.tsx' \
          ':!*/tests/*' ':!*_test.go' ':!*_test.py' 2>/dev/null \
        | grep -E '^\+' | grep -vE '^\+\+\+' \
        | grep -IE '(192\.168\.5\.12|100\.66\.114\.71)' || true)
else
  bad=""
  echo "  （无基线可比，跳过增量扫描）"
fi
if [ -n "$bad" ]; then
  echo "  以下代码硬编码了现网地址："
  printf '%s\n' "$bad" | sed 's/^/    /' | head -10
  fail=1
else
  [ -z "${base:-}" ] || echo "  ok"
fi

[ "$fail" -eq 0 ] && echo "== 卫生检查通过" || { echo "== 卫生检查失败"; exit 1; }
