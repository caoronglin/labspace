#!/usr/bin/env bash
# LabSpace 加密增量备份（restic + zstd 压缩 + AES-256 加密 + 去重）
#
# 备份内容：
#   * PostgreSQL 逻辑备份（labspace / casdoor / cropgenome / snapotter）
#   * 教学与用户数据（/srv/lab、/srv/labdata/bioinfo-training）
#   * 项目源码与部署配置（/opt/labspace 等，排除依赖与缓存）
#   * 系统认证配置（/etc/labspace，0600 权限）
#
# 恢复演练见 docs/BACKUP.md。口令文件默认 /etc/labspace/backup.key（0600），
# 丢失口令将无法恢复，请离线保存一份。
set -euo pipefail

REPO="${LAB_BACKUP_REPO:-/srv/labbackup/restic}"
PASS_FILE="${LAB_BACKUP_PASS_FILE:-/etc/labspace/backup.key}"
STAGE_ROOT="${LAB_BACKUP_STAGE:-/srv/labbackup}"
STATUS_FILE="${LAB_BACKUP_STATUS_FILE:-/srv/labdata/labgo/backup-status.json}"
LOG_TAG="lab-backup"
# 备份默认只保留 3 天；后台展示同一条保留策略。
KEEP_WITHIN="${LAB_BACKUP_KEEP_WITHIN:-3d}"
KEEP_DAILY="${LAB_BACKUP_KEEP_DAILY:-3}"
SCOPE="${1:-${LAB_BACKUP_SCOPE:-full}}"

umask 077
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die() { log "ERROR: $*"; exit 1; }

# 后台只读取这份状态文件，避免容器获得 restic 口令或写仓库的权限。
write_status() {
  local outcome="$1"
  local snapshots="[]"
  if [ -r "$PASS_FILE" ] && [ -d "$REPO" ]; then
    snapshots="$(RESTIC_PASSWORD_FILE="$PASS_FILE" RESTIC_REPOSITORY="$REPO" restic snapshots --json 2>/dev/null || printf '[]')"
  fi
  SNAPSHOTS_JSON="$snapshots" python3 - "$outcome" "$REPO" "$KEEP_WITHIN" "$SCOPE" "$STATUS_FILE" <<'PY'
import json
import os
import shutil
import sys
from datetime import datetime, timezone

outcome, repo, keep_within, scope, path = sys.argv[1:6]
try:
    snaps = json.loads(os.environ.get("SNAPSHOTS_JSON") or "[]")
except json.JSONDecodeError:
    snaps = []
try:
    disk = shutil.disk_usage("/srv/labbackup")
    disk_info = {"total": disk.total, "used": disk.used, "free": disk.free, "mount": "/srv/labbackup"}
except OSError:
    disk_info = {}
items = []
for s in snaps:
    items.append({
        "id": s.get("short_id") or s.get("id"),
        "time": s.get("time"),
        "hostname": s.get("hostname"),
        "tags": s.get("tags") or [],
        "paths": s.get("paths") or [],
    })
items.sort(key=lambda x: x.get("time") or "", reverse=True)
data = {
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "outcome": outcome,
    "repo": repo,
    "scope": scope,
    "keep_within": keep_within,
    "disk": disk_info,
    "snapshots": items,
}
os.makedirs(os.path.dirname(path), exist_ok=True)
tmp = f"{path}.tmp.{os.getpid()}"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
os.chmod(tmp, 0o644)
os.replace(tmp, path)
PY
}

trap 'rc=$?; write_status "failed"; exit "$rc"' ERR

command -v restic >/dev/null || die "restic 未安装"
case "$SCOPE" in
  full|core) ;;
  *) die "未知备份范围：$SCOPE（可用：full / core）" ;;
esac
[ -r "$PASS_FILE" ] || die "缺少备份口令文件 $PASS_FILE"
export RESTIC_PASSWORD_FILE="$PASS_FILE"
export RESTIC_REPOSITORY="$REPO"
export XDG_CACHE_HOME="${LAB_BACKUP_CACHE:-/var/cache/lab-backup}"
mkdir -p "$XDG_CACHE_HOME"

# 定时任务与手动触发可能撞车，restic 的写操作互斥但失败得很吵；这里先排队。
exec 9>/run/lock/lab-backup.lock
flock -w 3600 9 || die "1 小时内未取得备份锁，中止（避免与在跑的任务互相踩）"
log "备份范围：$SCOPE"

if [ ! -f "$REPO/config" ]; then
  log "初始化 restic 仓库：$REPO"
  mkdir -p "$REPO"
  restic init
fi

STAGE="$(mktemp -d "$STAGE_ROOT/stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

dump_pg() {
  local container="$1" user="$2" db="$3" out="$4"
  if ! docker inspect "$container" >/dev/null 2>&1; then
    log "跳过数据库 $db：容器 $container 不存在"
    return 0
  fi
  if ! docker exec "$container" pg_dump -U "$user" -d "$db" -Fc >"$STAGE/$out" 2>"$STAGE/$out.err"; then
    log "WARN: $db 备份失败：$(tr '\n' ' ' <"$STAGE/$out.err")"
    rm -f "$STAGE/$out" "$STAGE/$out.err"
    return 1
  fi
  rm -f "$STAGE/$out.err"
  log "数据库已导出：$db ($(du -h "$STAGE/$out" | cut -f1))"
}

log "开始备份 → $REPO"
PG_FAIL=0
dump_pg lab-postgres postgres labspace labspace.dump || PG_FAIL=1
dump_pg lab-postgres postgres casdoor casdoor.dump || PG_FAIL=1
dump_pg lab-postgres postgres cropgenome cropgenome.dump || PG_FAIL=1
dump_pg lab-snapotter-postgres snapotter snapotter snapotter.dump || PG_FAIL=1

# Baserow 的 PostgreSQL 跑在容器内部，用容器内的 peer 认证做逻辑备份，
# 避免直接拷贝正在写入的 PGDATA 得到不一致快照。
if docker inspect lab-baserow >/dev/null 2>&1; then
  if docker exec -u postgres lab-baserow pg_dump -Fc baserow >"$STAGE/baserow.dump" 2>"$STAGE/baserow.dump.err"; then
    rm -f "$STAGE/baserow.dump.err"
    log "数据库已导出：baserow ($(du -h "$STAGE/baserow.dump" | cut -f1))"
  else
    log "WARN: baserow 备份失败：$(tr '\n' ' ' <"$STAGE/baserow.dump.err")"
    rm -f "$STAGE/baserow.dump" "$STAGE/baserow.dump.err"
    PG_FAIL=1
  fi
fi

if [ "$PG_FAIL" -ne 0 ]; then
  die "至少一个数据库导出失败，终止本次备份（避免静默缺失）"
fi

EXTRA_ARGS=(
  --exclude='node_modules'
  --exclude='.venv'
  --exclude='venv'
  --exclude='__pycache__'
  --exclude='*.pyc'
  --exclude='.pytest_cache'
  --exclude='.ruff_cache'
  --exclude='.mypy_cache'
  --exclude='.git'
  --exclude='*.log'
  --exclude='*.tmp'
  --exclude='/srv/labdata/baserow/postgres'
  --exclude-caches
  --one-file-system
)

if [ "$SCOPE" = "core" ]; then
  # 高频小范围：只覆盖真正会变的门户数据（文件源、知识库、数据库导出、ACL、口令配置）
  TAG=labspace-core
  TARGETS=(
    "$STAGE"
    /srv/lab
    /srv/labdata/labspace
    /etc/lab-go
    /etc/labspace
    /etc/systemd/system/lab-oidc-sync.service
    /etc/systemd/system/lab-backup.service
    /etc/systemd/system/lab-backup.timer
    /etc/systemd/system/lab-backup-core.timer
    /etc/nginx/sites-enabled/labspace.conf
  )
  RETENTION=( --keep-within "$KEEP_WITHIN" --keep-daily "$KEEP_DAILY" )
else
  TAG=labspace-daily
  TARGETS=(
    "$STAGE"
    /srv/lab
    /srv/labdata/bioinfo-training
    /srv/labdata/baserow
    /srv/labdata/jbrowse
    /srv/labdata/labops
    /srv/labdata/labgo
    /srv/labdata/plot
    /srv/labdata/snapotter
    /srv/labdata/cropgenome
    /opt/labspace
    /opt/bioinfo-training
    /opt/lab-core-stack
    /opt/lab-quantum
    /opt/lab-terminal
    /opt/lab-snapotter
    /opt/lab-docparse
    /opt/lab-oikb
    /opt/lab-research-api
    /opt/lab-search
    /etc/labspace
    /etc/lab-go
    /etc/systemd/system/lab-oidc-sync.service
    /etc/systemd/system/lab-backup.service
    /etc/systemd/system/lab-backup.timer
    /etc/nginx/sites-enabled/labspace.conf
  )
  RETENTION=( --keep-within "$KEEP_WITHIN" --keep-daily "$KEEP_DAILY" )
fi

restic backup "${EXTRA_ARGS[@]}" \
  --tag "$TAG" \
  --host "$(hostname -s)" \
  "${TARGETS[@]}"

# forget/prune 与 check 都要拿写锁；上一个进程被杀时留下的死锁会让整次任务
# 在白备份之后报错退出。restic unlock 只清理"主机名+PID 都已不存在"的锁，
# 因此清完再重试一次是安全的，不会踩到真正在跑的备份。
run_step() {
  local desc="$1"
  shift
  if "$@"; then
    return 0
  fi
  log "WARN: $desc 失败，清理失效锁后重试一次"
  restic unlock >/dev/null 2>&1 || true
  "$@" || die "$desc 重试后仍失败"
}

run_step "保留策略清理" restic forget --tag "$TAG" "${RETENTION[@]}" --prune

if [ "${LAB_BACKUP_CHECK:-1}" = "1" ]; then
  run_step "完整性抽检" restic check --read-data-subset="${LAB_BACKUP_CHECK_SUBSET:-2%}"
fi

log "备份完成（$SCOPE）：$(restic snapshots --tag "$TAG" --latest 1 --json | head -c 300)"
trap - ERR
write_status "ok"
