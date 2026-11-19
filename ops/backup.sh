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
# 保留策略的对外展示值（写进状态文件给管理端看）；
# 实际策略按 scope 分开设定，见下方 RETENTION。
KEEP_WITHIN="${LAB_BACKUP_KEEP_WITHIN:-3d}"
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

# 暂存目录用**固定名字**，不能用 mktemp 随机名。
#
# 原因：restic 的 forget 策略是**按分组**生效的，分组键包含“备份路径列表”。
# 每次备份都用随机目录名（stage.XXXXXX）的话，每个快照的路径列表都不同，
# 于是每个快照自成一组，--keep-daily/--keep-weekly 全部失效——仓库只增不减。
# 固定路径让同一 scope 的快照落进同一组，保留策略才真正起作用。
STAGE="$STAGE_ROOT/stage"
mkdir -p "$STAGE"
# 只清内容，保留目录本身（路径要稳定）。
find "$STAGE" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
trap 'find "$STAGE" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true' EXIT

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
  # —— 安全：备份**绝不能**包含自己的解密口令与全套会话密钥。
  #    restic 仓库是 AES-256 加密的，但如果解密口令文件跟被加密的数据在同一个
  # 快照里，任何能读到仓库目录的主体（低权限账号、误挂载的共享目录、
  # 按文档同步到外部存储的异地副本）都能取出口令、解密全部快照，
  # 拿到所有用户的原始文件 + deploy/.env 里的会话签名密钥与服务令牌
  # → 等于「备份一份数据」变成「备份即全站沦陷」。
  #    口令只离线保存，密钥类文件一律排掉。
  #    用**精确路径**而不是 '**/*.env' 这类通配：用户数据目录里可能有
  #    名字带 .env/.key 的科研文件（真的存在），通配会把业务数据一起排掉。
  #    实测备份目标下需要排除的密钥文件只有这几个：
  --exclude='/etc/labspace/backup.key'        # restic 仓库解密口令
  --exclude='/etc/labspace/backup-git.env'    # 异地归档口令
  --exclude='/opt/labspace/deploy/.env'       # 会话签名密钥 / 服务令牌 / OIDC Secret
  --exclude='*/deploy/.env'
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
  # —— 减量：以下目录要么高频变动（备份价值低、还原时会被覆盖），
  #    要么可以重新生成（依赖、构建产物）。把它们排掉，仓库只留真正的资产。
  --exclude='*/node_modules'
  --exclude='*/.venv'
  --exclude='*/dist'
  --exclude='*/__pycache__'
  --exclude='/srv/lab/.trash'
  --exclude='/srv/labdata/qdrant'
  --exclude='/srv/labdata/labgo/trash'
  --exclude='/tmp'
  --exclude='/srv/labdata/baserow/postgres'
  # —— 减量（基因组）：公共参考序列的**派生索引**体积远大于原始数据
  #    （三个物种光索引就 25 GB+），而且都能重新生成：
  #    *.bt2   BWA 索引（bwa index 几秒重建）
  #    *.nib2  JB﻿rowse 2bit 索引（faidx / jbrowse index 可重建）
  #    *X15_*  上游发布的比对索引二进制（由同目录 FASTA 派生）
  #    原始 FASTA / GTF / 注释全部保留，还原后可以直接用。
  --exclude='*.bt2'
  --exclude='*.nib2'
  --exclude='*X15_*'
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
  # core 还要排掉公共参考基因组（47 GB，其中 25 GB 是可重建的索引）：
  # 它是**静态公开数据**，不属于"真正会变的门户数据"，由 daily 那条线兜底。
  EXTRA_ARGS+=( --exclude='/srv/lab/genomes' )
  # core：高频增量。保留窗口短（只留最近两天的核心快照 + 每小时一份），
  # 旧的核心快照交给 daily 那条线统一清理。
  RETENTION=(
    --keep-within "${LAB_BACKUP_CORE_KEEP_WITHIN:-2d}"
    --keep-daily "${LAB_BACKUP_CORE_KEEP_DAILY:-3}"
    --keep-hourly "${LAB_BACKUP_CORE_KEEP_HOURLY:-8}"
  )
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
  # daily：分层保留 —— 每天一份、每周一份、每月一份。
  # restic 本身是内容寻址去重的"增量备份"：相同块只存一次，
  # 所以每天全量扫描也不会让仓库线性膨胀；分层保留决定"保留哪些时间点"。
  RETENTION=(
    --keep-within "${LAB_BACKUP_DAILY_KEEP_WITHIN:-3d}"
    --keep-daily "${LAB_BACKUP_DAILY_KEEP_DAILY:-7}"
    --keep-weekly "${LAB_BACKUP_KEEP_WEEKLY:-4}"
    --keep-monthly "${LAB_BACKUP_KEEP_MONTHLY:-3}"
  )
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

# --group-by '' 很关键：restic 默认按「主机 + 路径列表 + 标签」分组，
# 只要路径列表变了一点（早期用随机暂存目录名时每次都变），
# 每个快照就自成一组，--keep-daily/--keep-weekly 全部失效，仓库只增不减。
# 置空分组后，保留策略对**本标签的全部快照**统一生效。
run_step "保留策略清理" restic forget --group-by '' --tag "$TAG" "${RETENTION[@]}" --prune

if [ "${LAB_BACKUP_CHECK:-1}" = "1" ]; then
  run_step "完整性抽检" restic check --read-data-subset="${LAB_BACKUP_CHECK_SUBSET:-2%}"
fi

log "备份完成（$SCOPE）：$(restic snapshots --tag "$TAG" --latest 1 --json | head -c 300)"
trap - ERR
write_status "ok"
