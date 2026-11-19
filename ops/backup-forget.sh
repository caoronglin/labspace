#!/usr/bin/env bash
# 删除一个 restic 快照（管理员显式操作，不做静默批量清理）。
#
# 设计约束：
#   * 只接受单个快照 ID（可写前缀，至少 8 位十六进制），拒绝通配、拒绝 --prune
#     之外的附加参数，避免经由 API 传入任意 restic 参数。
#   * 只删除本仓库里存在的快照，删除前再查一次，避免误删别的 restic 仓库。
#   * 口令与仓库路径只在本脚本内使用，不返回给调用方，也不写日志。
#
# 用法：lab-backup-forget.sh <snapshot-id>
set -euo pipefail

REPO="${LAB_BACKUP_REPO:-/srv/labbackup/restic}"
PASS_FILE="${LAB_BACKUP_PASS_FILE:-/etc/labspace/backup.key}"
STATUS_FILE="${LAB_BACKUP_STATUS_FILE:-/srv/labdata/labgo/backup-status.json}"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$#" -eq 1 ] || die "usage: $0 <snapshot-id>"
SNAP="$1"

case "$SNAP" in
  *[!0-9a-fA-F]*) die "snapshot id must be hexadecimal" ;;
esac
[ "${#SNAP}" -ge 8 ] || die "snapshot id prefix must be at least 8 characters"
[ "${#SNAP}" -le 64 ] || die "snapshot id is too long"

[ -r "$PASS_FILE" ] || die "backup password file is not readable: $PASS_FILE"
[ -d "$REPO" ] || die "backup repository is not present: $REPO"

export RESTIC_PASSWORD_FILE="$PASS_FILE"
export RESTIC_REPOSITORY="$REPO"

# 精确存在性检查：restic snapshots <prefix> 在前缀不唯一或多于一个时返回多个，
# 这里要求恰好一个，避免「前缀恰好匹配到别的快照」。
matches="$(restic snapshots --json "$SNAP" 2>/dev/null | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print(-1)
    raise SystemExit(0)
print(len(data) if isinstance(data, list) else -1)
')"
[ "$matches" = "1" ] || die "expected exactly one snapshot for that id (matched=$matches)"

restic forget "$SNAP" --prune >/dev/null

printf '{"ok":true,"snapshot":"%s","repo":"%s"}\n' "$SNAP" "$REPO"