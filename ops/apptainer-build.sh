#!/usr/bin/env bash
# 把本地 Docker 镜像构建成 Apptainer SIF（以后容器管理的统一入口）。
#
# 为什么用 docker-daemon:// 而不是 docker://<registry>：
#   1. 本机对 Docker Hub / GHCR 的拉取经常被重置，走 registry 会频繁失败；
#      本地 daemon 里已有的镜像不需要网络，构建稳定可重复。
#   2. 镜像本身仍由 compose 的 `docker compose build/pull` 维护（版本钉死），
#      Apptainer 只负责"把已验证的镜像固化成不可变 SIF"。
#
# 用法：
#   ops/apptainer-build.sh <name> [image:tag]
#   ops/apptainer-build.sh --all          # 按 deploy/apptainer/services.conf 全量构建
#
# 输出：$SIF_DIR/<name>.sif
set -euo pipefail

LAB_ROOT=${LAB_ROOT:-/opt/labspace}
SIF_DIR=${SIF_DIR:-/srv/labdata/apptainer}
MANIFEST=${MANIFEST:-$LAB_ROOT/deploy/apptainer/services.conf}

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

command -v apptainer >/dev/null || die "apptainer 未安装（见 docs/APPTAINER.md）"
command -v mksquashfs >/dev/null || die "缺少 squashfs-tools：apt-get install -y squashfs-tools"
command -v docker >/dev/null || die "docker 不可用（构建源是本地 daemon）"

mkdir -p "$SIF_DIR"

# 从 manifest 读一条服务的镜像名：每行 `name image:tag`
image_of() {
  local name=$1
  [ -f "$MANIFEST" ] || return 1
  awk -v n="$name" '$1==n {print $2; exit}' "$MANIFEST"
}

build_one() {
  local name=$1 image=${2:-}
  [ -n "$image" ] || image=$(image_of "$name") || true
  [ -n "$image" ] || die "不知道 $name 用哪个镜像（可在命令行第 2 参数指定，或写进 $MANIFEST）"

  docker image inspect "$image" >/dev/null 2>&1 || die "本地没有镜像 $image（先 docker compose pull/build）"

  local out="$SIF_DIR/$name.sif"
  log "构建 $name ← docker-daemon://$image"
  # --force 覆盖旧 SIF：SIF 是不可变文件，重建必须显式覆盖
  if apptainer build --force "$out" "docker-daemon://$image" >/tmp/apptainer-build-$name.log 2>&1; then
    log "  完成 $(du -h "$out" | cut -f1)  $out"
  else
    tail -20 /tmp/apptainer-build-$name.log >&2
    die "构建失败：$name（完整日志 /tmp/apptainer-build-$name.log）"
  fi
  # 记录来源镜像，便于审计"这个 SIF 是从哪个镜像来的"
  printf '%s\t%s\t%s\n' "$name" "$image" "$(date -Iseconds)" > "$SIF_DIR/$name.image"
}

if [ "${1:-}" = "--all" ]; then
  [ -f "$MANIFEST" ] || die "缺少清单 $MANIFEST"
  while read -r name image; do
    case "$name" in ''|\#*) continue ;; esac
    build_one "$name" "$image"
  done < "$MANIFEST"
  exit 0
fi

[ "$#" -ge 1 ] || die "用法: $0 <name> [image:tag] | --all"
build_one "$1" "${2:-}"
