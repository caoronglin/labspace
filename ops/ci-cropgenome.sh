#!/usr/bin/env bash
# cropgenome-toolkit 后端：独立 Go 模块，GOPROXY=off 下 vet / test / build 全绿。
#
# 单独一条 stage，不并进 ci-go.sh：labspace/go-core 的硬约束是「零外部依赖」，
# 而这里 vendor 了 lib/pq。两者混在一个 go.mod 里，那条约束就没法写了。
#
# 关于 PostgreSQL：internal/jobs 的 Claim/Complete/租约语义只有真库能证
# （FOR UPDATE SKIP LOCKED、租约过期重领、ON CONFLICT 幂等）。所以这条脚本
# 自己装一个 PG 再跑 -race。装不上不静默过关——默认直接失败，
# 要显式跳过必须设 CROP_CI_ALLOW_NO_PG=1，那时会打印一行大字说明跳过了什么。
#
# 真 DIAMOND/BLAST+ 端到端仍不在这里：runner 上没有比对工具，
# 那条路在 cropgenome-toolkit/tests/run_fixture_pipeline.sh。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)/cropgenome-toolkit/backend"

export GOPROXY=off GOFLAGS=-mod=vendor GOTOOLCHAIN=local
export GOCACHE="${GOCACHE:-/tmp/gocache}"
export CGO_ENABLED=1

echo "== 依赖检查：vendor 必须齐全（GOPROXY=off 下缺一个就编不过）"
if [ ! -f vendor/modules.txt ]; then
  echo "vendor/modules.txt 缺失：离线环境无法解析依赖" >&2
  exit 1
fi

echo "== go vet"
go vet ./...

# 契约门禁（不需要 PG，放在 PG 拉起之前）：backend/contract_test.go 用反射把
# 真实 DTO 的 json tag 钉在 cropgenome-toolkit/contract/shapes.json 上，
# 并核对 openapi.yaml 的每个 path 都真能被 router 分发。
# 失败信息会直接说「哪个字段、Go 怎么发、夹具怎么写」，不需要再翻代码。
echo "== 契约门禁（前端形状 / 路由覆盖）"
# 注：TestLiveResponsesCarryFixtureFields 需要 CROP_TEST_DSN，会在这条脚本
# 拉起 PG 之后随 `go test ./...` 一起跑；它 skip 时不算通过（见下面的 skip 白名单）。
go test -count=1 -run 'TestFixtureSchemasAreRegistered|TestJSONShapesMatchFixtures|TestOpenAPIPathsAreRouted' -v . 2>&1 \
  | grep -Ev '^=== RUN' | sed 's/^/  /' 

# ---------------------------------------------------------------- PostgreSQL
PG_PORT=5433
PG_DB=cropgenome_ci
start_pg() {
  if ! command -v initdb >/dev/null; then
    echo "== 安装 PostgreSQL（internal/jobs 的并发语义需要真库）"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends postgresql
  fi
  local bindir
  bindir="$(dirname "$(command -v initdb || ls /usr/lib/postgresql/*/bin/initdb | head -1)")"
  export PATH="$bindir:$PATH"
  local data=/tmp/cropgenome-pg
  rm -rf "$data" && mkdir -p "$data" && chown -R postgres:postgres "$data"
  su postgres -c "initdb -D $data -A trust -U postgres" >/dev/null
  # fsync=off：这是一次性测试库，掉电语义不是被测对象
  chmod 700 "$data"   # initdb 要求 0700/0750，0755 会被拒
  su postgres -c "pg_ctl -D $data -o '-p $PG_PORT -c fsync=off -c listen_addresses=127.0.0.1' -l /tmp/cropgenome-pg.log start" >/dev/null
  for _ in $(seq 1 40); do
    pg_isready -h 127.0.0.1 -p $PG_PORT -q && break
    sleep 0.5
  done
  psql -h 127.0.0.1 -p $PG_PORT -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
    -c "drop database if exists $PG_DB" \
    -c "create database $PG_DB"
}

# 端口被占就换一个：这台机器上可能已经有人在跑 PG，抢 5433 会把
# 「装不上」和「跑不动」混成同一种失败。
pick_port() {
  for p in 5433 5434 5435 15433; do
    if ! (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null; then PG_PORT=$p; return 0; fi
    exec 3<&- 2>/dev/null || true
  done
  return 1
}
pick_port || { echo "5433-5435/15433 都被占用，找不到可用的 PG 端口" >&2; exit 1; }

if start_pg; then
  export CROP_TEST_DSN="postgres://postgres@127.0.0.1:$PG_PORT/$PG_DB?sslmode=disable"
  # 先跑迁移：契约门禁的 TestLiveResponsesCarryFixtureFields 要真查 annotations，
  # 空库会让它 404（它装的是「handler 真的把字段发出来了」，不是「库通不通」）。
  echo "== 迁移（SQL 空库，让活体契约用例有表可查）"
  CROP_DSN="$CROP_TEST_DSN" go run ./cmd/cropgenome migrate 2>&1 | sed 's/^/  /'

  echo "== go test -race（含 internal/jobs 的真实 PG 并发用例）"
  go test ./... -race -count=1
  # 这些用例在没 DSN 时会 skip；skip 不等于通过，这里把它们单独点名跑一遍确认不是空的
  echo "== 确认 PG 用例真的跑了（不是 skip）"
  # 两个包的下划线用例：jobs 的并发/租约，以及根包的契约活体检查。
  # 用 \`./ \` 跑根包：契约门禁在 backend/ 根目录，不在内部包里。
  pg_out="$(
    go test ./internal/jobs -race -count=1 -v -run 'PG' 2>&1
    go test ./ -race -count=1 -v -run 'TestLiveResponses' 2>&1
  )"
  printf '%s\n' "$pg_out" | grep -E '^(--- )(PASS|FAIL|SKIP)|^ok' | sort | sed 's/^/  /'
  # 设了 DSN 还 skip 通常是配置错误。但当某个用例在「当前实现下不可能通过」时，
  # 直接判死只会逼人删掉它，而删掉会让它要钉的需求一起消失。这类用例留名放行，
  # 由用例自己的注释写清理由；一旦它转 PASS，这里会提醒把名字摘掉。
  #
  # 现在是空的：曾在这条名单上的 TestPGTwoProcessesOneIdentityOverlap 换成了
  # TestPGLeaseTokenCannotBeSharedByTwoProcesses（lease_token 落位后它真能过了）。
  PG_EXPECTED_SKIP=''
  # 逐条比对，别写成「grep -v 白名单」：那种写法的退出码只反映「这一行有没有被
  # 过滤掉」，用例名和整行文本不可能完全相等，于是每一行都算「输出过」，门禁就
  # 一直是开的。这里把 SKIP 行解析成名字列表，再逐个查名单。
  unexpected=""
  while read -r name; do
    [ -n "$name" ] || continue
    case " $PG_EXPECTED_SKIP " in
      *" $name "*) ;;
      *) unexpected="$unexpected $name" ;;
    esac
  done <<<"$(printf '%s\n' "$pg_out" | sed -n 's/^[[:space:]]*--- SKIP: \([^ ]*\).*/\1/p')"

  if [ -n "$unexpected" ]; then
    echo "PG 用例被 skip 了，但 CROP_TEST_DSN 已设置，这是配置错误：" >&2
    echo "  $unexpected" >&2
    echo "确属「当前实现下不可能通过」的用例，才登记进 PG_EXPECTED_SKIP 并在用例里写清理由。" >&2
    exit 1
  fi
  for name in $PG_EXPECTED_SKIP; do
    if printf '%s\n' "$pg_out" | grep -q -- "--- SKIP: $name"; then
      echo "  （已知 Skip：$name —— 理由见用例注释）"
    elif printf '%s\n' "$pg_out" | grep -q -- "--- PASS: $name"; then
      echo "  $name 已不再 Skip，请把它从 PG_EXPECTED_SKIP 里删掉"
    fi
  done
else
  if [ "${CROP_CI_ALLOW_NO_PG:-0}" != "1" ]; then
    echo "没能拉起 PostgreSQL：internal/jobs 的并发语义本轮没有被验证。" >&2
    echo "要么修好环境，要么显式设 CROP_CI_ALLOW_NO_PG=1 接受「并发未验证」这个事实。" >&2
    exit 1
  fi
  echo "!!! 未验证：没有 PostgreSQL，internal/jobs 的 SKIP LOCKED / 租约用例全部跳过"
  echo "!!! 本轮过了也不算签字（CROP_CI_ALLOW_NO_PG=1）"
  go test ./... -count=1
fi

echo "== go build"
go build -trimpath -o /tmp/cropgenome ./cmd/cropgenome
echo "== 产物：$(ls -l /tmp/cropgenome | awk '{print $5}') 字节"

echo "== 用法冒烟（无子命令时应打印 usage 并退出，不能 panic）"
out=$(/tmp/cropgenome 2>&1 || true)
case "$out" in
  *"usage: cropgenome"*) echo "  ok" ;;
  *) echo "  无子命令时没有打印 usage：" >&2; printf '%s\n' "$out" | head -5 >&2; exit 1 ;;
esac
