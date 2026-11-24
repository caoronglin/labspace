#!/usr/bin/env bash
# LabSpace 每日维护（凌晨 5 点，中国时间）
#
# 顺序是刻意安排的：**先备份、再清理、最后更新重启**。
#   1. 前置检查（磁盘、关键服务）——磁盘不够就别做后面的事。
#   2. 备份：跑一次 core 快照（失败不阻断，但要记进日报）。
#   3. 清理（GC）：
#      * Docker：悬空镜像、停止的容器、构建缓存；
#      * 数据库：Postgres VACUUM ANALYZE（真正的 GC）、日志轮转；
#      * 主机：journal 保留 7 天、/tmp 过期文件、Go/pip/npm 缓存；
#      * 备份仓库：按保留策略 forget --prune。
#   4. 更新与重启：拉取新镜像/代码，**只重建变化的容器**，随后重启 Go 核心。
#   5. 健康检查：门户、文件核心、后端、AgentScope 都要通。
#
# 失败原则：任何一步失败都**保留现有服务继续跑**（不 docker compose down），
# 出问题只记日志，第二天同一时间再试。
set -uo pipefail

LAB_ROOT="${LAB_ROOT:-/opt/labspace}"
DEPLOY_DIR="${LAB_DEPLOY_DIR:-$LAB_ROOT/deploy}"
LOG_DIR="${LAB_MAINT_LOG_DIR:-/var/log}"
REPORT="${LAB_MAINT_REPORT:-/var/log/lab-daily-maintenance.log}"
KEEP_JOURNAL="${LAB_MAINT_JOURNAL_KEEP:-7d}"
KEEP_TMP_DAYS="${LAB_MAINT_TMP_KEEP:-3}"
export DEBIAN_FRONTEND=noninteractive

mkdir -p "$LOG_DIR"
exec >>"$REPORT" 2>&1

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
run() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    log "  ✓ $desc"
    return 0
  fi
  log "  ✗ $desc（失败，继续后续步骤）"
  return 1
}

FAILED=0
log "================ 每日维护开始 ================"

# ---------------------------------------------------------------- 1. 前置检查
log "[1/5] 前置检查"
ROOT_FREE="$(df -Pk / | awk 'NR==2 {print $4}')"
ROOT_USED_PCT="$(df -Pk / | awk 'NR==2 {print $5}' | tr -d '%')"
log "  根分区可用 ${ROOT_FREE}K（已用 ${ROOT_USED_PCT}%）"
if [ "${ROOT_FREE:-0}" -lt 2097152 ]; then
  log "  ! 根分区可用不足 2G，跳过更新与重启（先清理）"
  SKIP_UPDATE=1
else
  SKIP_UPDATE=0
fi
if ! docker info >/dev/null 2>&1; then
  log "  ! Docker 不可用，跳过容器相关步骤"
  SKIP_DOCKER=1
else
  SKIP_DOCKER=0
fi

# ---------------------------------------------------------------- 2. 备份
log "[2/5] 备份（core 增量）"
if [ "${SKIP_DOCKER}" = "0" ]; then
  if systemctl start lab-backup-core.service; then
    log "  ✓ 备份完成"
  else
    log "  ✗ 备份失败（不影响后续清理）"
    FAILED=$((FAILED + 1))
  fi
else
  log "  - 跳过（Docker 不可用）"
fi

# 异地副本：把加密归档推到 Git 分支（本地 restic 之外的"第二条腿"）。
# 失败不回滚本地备份，只记日志——本地 restic 已经成功了。
log "[2.5/5] 异地归档（Git LFS）"
if [ -x "$LAB_ROOT/ops/backup-git-archive.sh" ] && [ -r /etc/labspace/backup-git.env ]; then
  if "$LAB_ROOT/ops/backup-git-archive.sh" >>"$REPORT" 2>&1; then
    log "  ✓ 已推送加密归档"
  else
    log "  ! 归档推送失败（本地备份仍在，网络恢复后下次会补）"
  fi
else
  log "  - 跳过（未配置 /etc/labspace/backup-git.env）"
fi

# ---------------------------------------------------------------- 3. 清理
log "[3/5] 清理"

if [ "${SKIP_DOCKER}" = "0" ]; then
  # Docker GC：只删**没有容器在用**的悬空镜像与停止容器。
  run "清理悬空镜像" docker image prune -f
  run "清理停止的容器" docker container prune -f
  run "清理构建缓存" docker builder prune -f
  # 网络与卷：默认不动（可能被别的 compose 项目引用）。
  run "清理过期网络" docker network prune -f --filter "until=72h"
fi

# Postgres：统计信息与膨胀回收（数据库的 GC）。
for db in labspace casdoor; do
  if docker ps --format '{{.Names}}' | grep -qx "lab-postgres"; then
    run "VACUUM ANALYZE $db" docker exec lab-postgres psql -U postgres -d "$db" -c "VACUUM (ANALYZE)"
  fi
done

# 备份仓库：按保留策略裁剪（与 backup.sh 同一套策略）。
if [ -x "$LAB_ROOT/ops/backup-forget.sh" ] || [ -f /etc/labspace/backup.key ]; then
  if [ -r /etc/labspace/backup.key ] && [ -d /srv/labbackup/restic ]; then
    export RESTIC_PASSWORD_FILE=/etc/labspace/backup.key RESTIC_REPOSITORY=/srv/labbackup/restic
    run "备份仓库保留策略裁剪" restic forget --group-by '' --tag labspace-core \
      --keep-within 2d --keep-daily 3 --keep-hourly 8 --prune
    run "备份仓库保留策略裁剪(daily)" restic forget --group-by '' --tag labspace-daily \
      --keep-within 3d --keep-daily 7 --keep-weekly 4 --keep-monthly 3 --prune
  else
    log "  - 跳过备份裁剪（口令或仓库不可用）"
  fi
fi

# 主机层面
run "回收 journal（保留 ${KEEP_JOURNAL}）" journalctl --vacuum-time="$KEEP_JOURNAL"
if [ -d /tmp ]; then
  run "清理 /tmp 过期文件" find /tmp -xdev -mindepth 1 -mtime "+$KEEP_TMP_DAYS" -delete
fi
if command -v go >/dev/null 2>&1; then
  run "清理 Go 构建缓存" go clean -cache
fi
if command -v pip >/dev/null 2>&1; then
  run "清理 pip 缓存" pip cache purge
fi
if command -v npm >/dev/null 2>&1; then
  run "清理 npm 缓存" npm cache clean --force
fi
run "清理孤立文件（无属主）" find /srv/labdata/labgo -xdev -nouser -type f -mtime +30 -delete

# 每日论文订阅：把"订阅意图"落成当天的论文（每人每主题一条）。
# 论文抓取要打外网文献源，可能较慢；失败不影响备份与清理。
log "[3.5/5] 每日论文订阅"
if python3 -c "import sys; sys.exit(0 if __import__('os').path.exists('/opt/labspace/backend/app/dailypapers.py') else 1)" 2>/dev/null; then
  if docker ps --format '{{.Names}}' | grep -qx lab-labspace-backend; then
    if docker exec lab-labspace-backend python -c "
import asyncio, sys
sys.path.insert(0, '/srv/app')
from app import dailypapers
print(asyncio.run(dailypapers.run_subs()))
" >>"$REPORT" 2>&1; then
      log "  ✓ 订阅抓取完成"
    else
      log "  ! 订阅抓取失败（下次维护会重试）"
    fi
  else
    log "  - 跳过后端未运行"
  fi
else
  log "  - 跳过（未部署每日论文模块）"
fi

# ---------------------------------------------------------------- 4. 更新与重启
log "[4/5] 更新与重启"
if [ "${SKIP_UPDATE}" = "1" ]; then
  log "  - 跳过（磁盘不足）"
elif [ "${SKIP_DOCKER}" = "1" ]; then
  log "  - 跳过容器更新（Docker 不可用）"
  # 仍可重启 Go 核心（它是宿主机进程）
  run "重启文件核心" systemctl restart labgo
else
  cd "$DEPLOY_DIR" || { log "  ! 找不到部署目录"; exit 1; }
  # 拉取新镜像：拉不到不是致命错误（离线镜像也能跑）。
  if docker compose pull --quiet >/dev/null 2>&1; then
    log "  ✓ 镜像已更新"
  else
    log "  - 镜像拉取失败，沿用本地镜像"
  fi
  # 只重建变化的容器，不整体 down。
  if docker compose up -d --remove-orphans >/dev/null 2>&1; then
    log "  ✓ 容器已按新镜像重建"
  else
    log "  ✗ 容器重建失败，保持现有容器继续服务"
    FAILED=$((FAILED + 1))
  fi
  # Go 核心是宿主机进程：重启以加载新代码/新配置。
  run "重启文件核心" systemctl restart labgo
  # 前端是静态目录：构建产物由 CI 推送，这里只确认 dist 存在。
  if [ -f "$LAB_ROOT/frontend/dist/index.html" ]; then
    log "  ✓ 前端产物就位"
  else
    log "  ! 前端产物缺失（frontend/dist/index.html）"
    FAILED=$((FAILED + 1))
  fi
fi

# ---------------------------------------------------------------- 5. 健康检查
log "[5/5] 健康检查"
sleep 10
check_http() {
  local name="$1" url="$2"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url" || echo 000)"
  if [ "$code" = "200" ] || [ "$code" = "302" ]; then
    log "  ✓ $name ($code)"
  else
    log "  ✗ $name ($code)"
    FAILED=$((FAILED + 1))
  fi
}
check_http "门户" "http://127.0.0.1/"
check_http "后端健康" "http://127.0.0.1:8088/api/health"
check_http "AgentScope" "http://127.0.0.1:8103/healthz"
if systemctl is-active --quiet labgo; then
  log "  ✓ 文件核心 (active)"
else
  log "  ✗ 文件核心未运行"
  FAILED=$((FAILED + 1))
fi

# —— 基础组件 —— 门户之外、用户日常会用的那批服务。
#    以前这里只查门户三个端点，draw.io / 文档解析 / 生信实训 / primer
#    挂了要等到用户来报障才发现。维护窗口的意义就是"没人在用的时候修好"。
log "  ── 基础组件 ──"
check_http "draw.io" "http://127.0.0.1:8082/"
check_http "命令速查" "http://127.0.0.1:8086/"
check_http "Tika 解析" "http://127.0.0.1:9998/"
# docling 的 5001 只开在 Docker 网络里、没映射到宿主机，宿主机 curl 不到。
# 要查应用层健康只能进容器里查（容器在跑 ≠ 应用在服务）。
if docker exec lab-docling curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:5001/health 2>/dev/null; then
  log "  ✓ 文档解析(docling) (health 200)"
else
  log "  ✗ 文档解析(docling) health 不可达"
  FAILED=$((FAILED + 1))
fi

# —— 生信实训平台 —— 后端 8100 / 门户 8102，两个都要在。
log "  ── 生信实训平台 ──"
check_http "生信后端" "http://127.0.0.1:8100/api/v1/health"
check_http "生信门户" "http://127.0.0.1:8102/"

# —— primer3（Apptainer）——
#    迁到 Apptainer 后它的健康不再是"Docker 容器在跑"，而是
#    systemd 单元 active + 端口可达 + SIF 文件存在。少查任何一项都会漏。
log "  ── primer3 (Apptainer) ──"
if systemctl is-active --quiet apptainer-primer; then
  log "  ✓ apptainer-primer (active)"
else
  log "  ✗ apptainer-primer 未运行"
  FAILED=$((FAILED + 1))
fi
check_http "primer(:18097)" "http://127.0.0.1:18097/"
SIF_FILE="${LAB_PRIMER_SIF:-/srv/labdata/apptainer/primer.sif}"
if [ -s "$SIF_FILE" ]; then
  log "  ✓ primer SIF ($SIF_FILE)"
else
  log "  ✗ primer SIF 缺失或为空：$SIF_FILE"
  FAILED=$((FAILED + 1))
fi

# —— 容器层 —— 基础组件的容器挂了，上面几个 URL 也会连着报错，
#    这里单独列出来，日志里一眼能看出是容器问题还是应用问题。
log "  ── 容器 ──"
for c in lab-labspace-backend lab-postgres lab-qdrant lab-agentscope lab-docling lab-tika lab-drawio lab-pdf2zh; do
  if docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null | grep -q true; then
    log "  ✓ $c"
  else
    log "  ✗ $c 未运行"
    FAILED=$((FAILED + 1))
  fi
done

if [ "$FAILED" -eq 0 ]; then
  log "================ 每日维护完成：无异常 ================"
else
  log "================ 每日维护完成：${FAILED} 项异常 ================"
fi
exit 0
