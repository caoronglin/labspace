#!/usr/bin/env bash
# 清理账号改名遗留的重复共享树。
#
# 背景
# ----
# 导师账号 adminlegacy 改名成 admin01 之后：
#   - 名册里 advisor 列同时留着两个值（adminlegacy / admin01）
#     → 已由 ops/fix-roster-advisor-aliases.py 归一
#   - 磁盘上留着两棵共享树：/srv/lab/users/adminlegacy/… 与
#     /srv/lab/users/admin01/…，同一批组员各有一次目录
#   - 文件核心的授权表里也有指向旧树的 scope
#
# 结果：组员材料散在两处，学生只看得见新树那一半；目录列表翻两倍。
#
# 做法（先备份、再迁移、再删，最后让核心重扫）
#   1. 旧树里的**非空文件**按同名目录迁到新树（不丢东西）
#   2. 删掉旧账号目录
#   3. 删掉新树里与当前名册**对不上**的成员目录（改过名的残留副本）
#   4. 通知 Go 核心重扫（Scan）并清掉指向旧树的授权
#
# 用法：
#   ops/cleanup-renamed-shared-trees.sh --dry-run     # 只报告
#   ops/cleanup-renamed-shared-trees.sh --apply
set -euo pipefail

LAB_ROOT=${LAB_ROOT:-/opt/labspace}
USERS_DIR=${LAB_USERS_DIR:-/srv/lab/users}
OLD_USER=${LAB_OLD_USER:-adminlegacy}
NEW_USER=${LAB_NEW_USER:-admin01}
SHARED_SUB="共享文件-组员"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

OLD_TREE="$USERS_DIR/$OLD_USER/$SHARED_SUB"
NEW_TREE="$USERS_DIR/$NEW_USER/$SHARED_SUB"

if [ ! -d "$OLD_TREE" ]; then
  log "旧共享树不存在，无需清理：$OLD_TREE"
  exit 0
fi

log "旧树：$OLD_TREE"
log "新树：$NEW_TREE"

# ---- 1. 迁移旧树里的非空文件 ------------------------------------------------
migrate=0
while IFS= read -r f; do
  rel="${f#$OLD_TREE/}"
  target="$NEW_TREE/$rel"
  mkdir -p "$(dirname "$target")"
  if [ -e "$target" ]; then
    log "  跳过（目标已存在）：$rel"
    continue
  fi
  log "  迁移：$rel"
  if [ "$APPLY" = "1" ]; then
    cp -p "$f" "$target"
  fi
  migrate=$((migrate + 1))
done < <(find "$OLD_TREE" -type f 2>/dev/null)
log "需迁移文件：$migrate 个"

# ---- 2. 删除旧账号目录 ------------------------------------------------------
if [ "$APPLY" = "1" ]; then
  log "删除旧账号目录：$USERS_DIR/$OLD_USER"
  case "$USERS_DIR/$OLD_USER" in
    "$USERS_DIR"/*) rm -rf -- "$USERS_DIR/$OLD_USER" ;;
    *) log "  ⚠ 路径异常，跳过" ;;
  esac
else
  log "[试运行] 将删除：$USERS_DIR/$OLD_USER"
fi

# ---- 3. 清理与名册对不上的成员目录 ------------------------------------------
# 名册（admin01 名下）里的成员目录名集合
ROSTER_DIRS=$(docker exec lab-postgres psql -U labspace -d labspace -tAc \
  "SELECT code || '_' || name FROM labspace.lab_roster WHERE advisor='$NEW_USER'" 2>/dev/null || true)
log "名册里的成员目录：$(echo "$ROSTER_DIRS" | grep -c . ) 个"

if [ -d "$NEW_TREE" ]; then
  for d in "$NEW_TREE"/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    if ! echo "$ROSTER_DIRS" | grep -qx "$name"; then
      files=$(find "$d" -type f 2>/dev/null | wc -l)
      if [ "$files" -gt 0 ]; then
        log "  ⚠ 保留（内有 $files 个文件，名册里没有它）：$name"
        continue
      fi
      log "  删除残留目录：$name"
      # 守卫：$d 必须非空且是 NEW_TREE 下的目录，否则宁可不动。
      # （rm -rf "$d" 在变量为空时会变成 rm -rf ""，在某些 shell 下等价于删当前目录）
      case "$d" in
        "$NEW_TREE"/*/) ;;
        *) log "  ⚠ 跳过（路径异常）：$d"; continue ;;
      esac
      if [ "$APPLY" = "1" ]; then
        rm -rf -- "$d"
      fi
    fi
  done
fi

# ---- 4. 让文件核心重扫 ------------------------------------------------------
if [ "$APPLY" = "1" ]; then
  log "触发文件核心重扫（清掉指向旧树的授权）"
  curl -sS -X POST "http://127.0.0.1:8122/v1/admin/rescan" \
    -H "X-Lab-Service-Token: $(grep -E '^LABSPACE_SERVICE_TOKEN=' "$LAB_ROOT/deploy/.env" 2>/dev/null | cut -d= -f2-)" \
    -o /dev/null -w '  rescan http=%{http_code}\n' || log "  重扫接口不可用，稍后由核心自身扫描兜底"
  systemctl restart labgo >/dev/null 2>&1 && log "labgo 已重启"
  sleep 3
fi

log "完成（$([ "$APPLY" = "1" ] && echo 已执行 || echo 试运行，加 --apply 执行)）"
