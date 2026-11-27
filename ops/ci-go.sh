#!/usr/bin/env bash
# Go 核心：零外部依赖前提下 vet / test / build 全绿。
# GOPROXY=off 是硬约束——一旦有人加 require，这里立刻挂，而不是等上线才发现。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)/go-core"

export GOPROXY=off GOFLAGS=-mod=mod GOTOOLCHAIN=local CGO_ENABLED=1
export GOCACHE="${GOCACHE:-/tmp/gocache}"

echo "== go.mod 依赖检查"
if grep -qE '^require' go.mod; then
  echo "go.mod 出现 require，违反零依赖约束" >&2
  exit 1
fi

echo "== go vet"
go vet ./...

echo "== go test -race"
# 平台判「超时」的判据是**本阶段没有任何输出超过 10 分钟**，不是单条测试跑太久。
# `go test ./...` 的输出只在每个包跑完后才吐一行，静默窗口 = 最慢那个包的耗时；
# 某个测试一旦卡住不返回，日志就彻底静默，平台看到的只有「10 分钟无输出」，
# 而真正的罪魁祸首（哪个包、哪条用例）被这段静默吞掉了。
# 所以这里做两件事：
#   1. 逐包跑、每包先打一行包名，单包再补 -timeout 兜底，超时日志能直接定位到包；
#   2. 心跳每 30 秒报一次「当前在哪个包」。心跳只往日志追加、不读管道——
#      阻塞在管道写上的后台 echo 被 kill 后会原地挂住，上一版就是这么吊死的。
LIST=/tmp/go-test-list.txt
go list ./... >"$LIST"
CURRENT=/tmp/go-test-current
echo "共 $(grep -c . "$LIST") 个包，逐个跑（输出带包名，便于定位）"
: >"$CURRENT"

(
  while true; do
    sleep 30
    printf '…仍在运行 go test -race；当前包：%s\n' "$(cat "$CURRENT" 2>/dev/null || echo 准备中)"
  done
) &
HEARTBEAT=$!
trap 'kill "$HEARTBEAT" 2>/dev/null || true' EXIT

while read -r pkg; do
  [ -n "$pkg" ] || continue
  printf '%s' "$pkg" >"$CURRENT"
  echo "── $pkg"
  go test -race -timeout 600s "$pkg"
done <"$LIST"

kill "$HEARTBEAT" 2>/dev/null || true
wait "$HEARTBEAT" 2>/dev/null || true
echo "== go test -race 全部通过"

echo "== go build"
# 与 deploy 镜像（go-core/Dockerfile）同参数：CGO_ENABLED=0，产物必须静态可跑。
CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /tmp/labgo ./cmd/labgo
echo "== 产物：$(ls -l /tmp/labgo | awk '{print $5}') 字节"

# 冒烟：labgo 是常驻服务，没有 --help、不会自己退出。
# 直接跑它就是「前台起服务」，曾让整个 stage 卡到平台 10 分钟无输出被判超时。
# 这里只验「能起来 + 缺配置时 fail-closed 而不 panic」：起服务、等就绪、立刻收掉。
echo "== 启动冒烟（无环境变量，应 fail-closed）"
SMOKE_LOG=/tmp/labgo-smoke.log
LABGO_ADDR=127.0.0.1:0 /tmp/labgo >"$SMOKE_LOG" 2>&1 &
SMOKE_PID=$!
for _ in $(seq 1 50); do
  grep -q "fail-closed" "$SMOKE_LOG" && break
  kill -0 "$SMOKE_PID" 2>/dev/null || break
  sleep 0.2
done
kill "$SMOKE_PID" 2>/dev/null || true
wait "$SMOKE_PID" 2>/dev/null || true

if ! grep -q "fail-closed" "$SMOKE_LOG"; then
  echo "labgo 未按预期启动/fail-closed，日志：" >&2
  cat "$SMOKE_LOG" >&2
  exit 1
fi
cat "$SMOKE_LOG"
echo "== 冒烟通过：进程已退出，未占用端口"
