#!/usr/bin/env bash
# 把加密备份的"目录快照"推到 Git 分支（Git LFS 承载大文件）。
#
# 为什么是"两条腿走路"：
#   * restic 仓库留在 /srv/labbackup（本地快、可随机恢复、去重好），
#     但**同一块盘坏掉就一起没了**；
#   * 这里再把一份**加密后的归档**推到远端 Git 分支，
#     相当于异地副本：机房失火/主机报废也能从代码平台取回。
#
# 关键设计（都是踩过坑之后的取舍）：
#   1. **本地先加密再上传**：LFS 只是搬运工，平台侧看到的是密文；
#      用 restic 自己的仓库文件做载体没有意义（restic 需要随机读），
#      所以这里导出的是 `pg_dump` + 关键配置的 tar，再用 openssl AES-256 加密封装。
#   2. **绝不复用备份口令**：加密用独立的 `LAB_BACKUP_ARCHIVE_KEY`，
#      与 restic 的 `backup.key` 分开，任何一把泄露都不至于两边失守。
#   3. **每份归档都带 SHA-256 校验文件**，恢复前先验完整性。
#   4. **只保留最近 N 份**（默认 3），旧归档在同一个 commit 里删掉——
#      仓库不会因为每日推送而无限膨胀（LFS 对象由平台侧 GC）。
#   5. 推送失败**不影响本机备份**：本地 restic 已经成功，这里只是异地副本。
#
# 用法：
#   ops/backup-git-archive.sh            # 打一份归档并推送
#   ops/backup-git-archive.sh --restore <file.tar.gz.enc>   # 解密并展开
#
# 需要的环境变量（写进 /etc/labspace/backup-git.env，0600）：
#   LAB_BACKUP_GIT_REMOTE   远端地址（https://cnb.cool/...）
#   LAB_BACKUP_GIT_BRANCH   分支名，默认 backup/encrypted
#   LAB_BACKUP_ARCHIVE_KEY  归档加密口令（**独立于** restic 口令）
set -euo pipefail

LAB_ROOT=${LAB_ROOT:-/opt/labspace}
WORK=${LAB_BACKUP_GIT_WORK:-/var/lib/lab-backup-git}
ENV_FILE=${LAB_BACKUP_GIT_ENV:-/etc/labspace/backup-git.env}
KEEP=${LAB_BACKUP_ARCHIVE_KEEP:-3}
# 管理端（/admin/backups）读取这份状态：后端不接触 git 凭据与归档口令。
GIT_STATUS=${LAB_BACKUP_GIT_STATUS:-/srv/labdata/labgo/backup-git-status.json}
STAMP=$(date '+%Y%m%d-%H%M%S')

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

# 写状态：只放"看得见的事实"（时间、份数、大小、远端、最近结果），
# 绝不放归档口令或 git 凭据。脚本缺失时静默跳过，不影响备份本身。
write_status() {
  local outcome="$1" pushed="$2" detail="${3:-}"
  local script="$LAB_ROOT/ops/backup-git-status.py"
  [ -r "$script" ] || return 0
  python3 "$script" \
    --archive-dir "${WORK:-/var/lib/lab-backup-git}/archives" \
    --out "$GIT_STATUS" \
    --outcome "$outcome" --pushed "$pushed" --detail "$detail" \
    --keep "$KEEP" --branch "${BRANCH:-}" --remote "${LAB_BACKUP_GIT_REMOTE:-}" \
    >/dev/null 2>&1 || true
}


die() { log "ERROR: $*"; exit 1; }

if [ "${1:-}" = "--restore" ]; then
  [ "$#" -ge 2 ] || die "用法: $0 --restore <file.tar.gz.enc>"
  ARCHIVE=$2
  [ -r "$ARCHIVE" ] || die "归档不存在: $ARCHIVE"
  [ -r "$ENV_FILE" ] || die "缺少 $ENV_FILE"
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  [ -n "${LAB_BACKUP_ARCHIVE_KEY:-}" ] || die "LAB_BACKUP_ARCHIVE_KEY 未设置"
  # openssl 的 `-pass env:NAME` 只读**已导出**的环境变量；
  # source 一个文件并不会导出变量，所以这里必须显式 export。
  export LAB_BACKUP_ARCHIVE_KEY
  # 先验校验和（如果旁边有 .sha256）
  if [ -r "$ARCHIVE.sha256" ]; then
    ( cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256" ) || die "校验和不匹配，归档可能损坏"
  fi
  OUT=$(mktemp -d)
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
    -pass env:LAB_BACKUP_ARCHIVE_KEY -in "$ARCHIVE" | tar -xzf - -C "$OUT"
  log "已解密展开到 $OUT"
  ls -la "$OUT" | head -20
  exit 0
fi

[ -r "$ENV_FILE" ] || die "缺少 $ENV_FILE（远端地址与归档口令）"
# shellcheck disable=SC1090
. "$ENV_FILE"
[ -n "${LAB_BACKUP_GIT_REMOTE:-}" ] || die "LAB_BACKUP_GIT_REMOTE 未设置"
[ -n "${LAB_BACKUP_ARCHIVE_KEY:-}" ] || die "LAB_BACKUP_ARCHIVE_KEY 未设置"
export LAB_BACKUP_ARCHIVE_KEY
BRANCH=${LAB_BACKUP_GIT_BRANCH:-backup/encrypted}

command -v git >/dev/null || die "缺少 git"
git lfs version >/dev/null 2>&1 || die "缺少 git-lfs（apt-get install git-lfs）"

export GIT_LFS_SKIP_SMUDGE=1  # 克隆时不要把所有历史归档都拉下来

# ---- 1. 准备归档内容 --------------------------------------------------------
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/pg" "$STAGE/etc"

log "导出数据库（pg_dump -Fc）"
for spec in "labspace:postgres:labspace" "casdoor:postgres:casdoor"; do
  IFS=: read -r db user dbname <<<"$spec"
  if docker ps --format '{{.Names}}' | grep -qx lab-postgres; then
    if docker exec lab-postgres pg_dump -U "$user" -d "$dbname" -Fc >"$STAGE/pg/$db.dump" 2>/dev/null; then
      log "  ✓ $db ($(du -h "$STAGE/pg/$db.dump" | cut -f1))"
    else
      log "  ! $db 导出失败"
      rm -f "$STAGE/pg/$db.dump"
    fi
  fi
done

log "打包关键配置"
tar -czf "$STAGE/etc/configs.tar.gz" \
  -C / etc/labspace etc/lab-go etc/systemd/system/lab-daily-maintenance.timer \
  etc/systemd/system/lab-backup.service etc/nginx/sites-enabled/labspace.conf \
  opt/labspace/deploy/apptainer 2>/dev/null || log "  ! 部分配置缺失（已跳过）"

# 元信息：恢复时要先知道"这份归档是什么时候、什么版本"的
cat >"$STAGE/MANIFEST.txt" <<EOF
LabSpace 加密备份归档
生成时间: $(date -Iseconds)
主机: $(hostname -s)
内核: $(uname -r)
内容:
  pg/labspace.dump     门户库（pg_dump -Fc）
  pg/casdoor.dump      认证库（pg_dump -Fc）
  etc/configs.tar.gz   关键配置（/etc/labspace、/etc/lab-go、nginx、systemd、apptainer 清单）
加密: openssl AES-256-CBC + PBKDF2(600000)
恢复: ops/backup-git-archive.sh --restore <本文件>
EOF

# ---- 2. 加密 + 校验 ---------------------------------------------------------
ARCHIVE="labspace-backup-$STAMP.tar.gz.enc"
log "加密封装 → $ARCHIVE"
tar -czf - -C "$STAGE" . | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 \
  -salt -pass env:LAB_BACKUP_ARCHIVE_KEY -out "/tmp/$ARCHIVE"
( cd /tmp && sha256sum "$ARCHIVE" >"$ARCHIVE.sha256" )
log "  大小 $(du -h "/tmp/$ARCHIVE" | cut -f1)"

# ---- 3. 推到 Git 分支 -------------------------------------------------------
mkdir -p "$WORK"
if [ ! -d "$WORK/.git" ]; then
  log "初始化工作副本 $WORK"
  git clone --depth 1 --branch "$BRANCH" "$LAB_BACKUP_GIT_REMOTE" "$WORK" 2>/dev/null || {
    # 分支还不存在：克隆默认分支后新建孤儿分支，避免把主分支历史带进来
    git clone --depth 1 "$LAB_BACKUP_GIT_REMOTE" "$WORK" 2>/dev/null || die "克隆失败：$LAB_BACKUP_GIT_REMOTE"
    ( cd "$WORK" && git checkout --orphan "$BRANCH" && git rm -rq --cached . 2>/dev/null; rm -rf ./* 2>/dev/null )

  }
fi
cd "$WORK"
git lfs install --local >/dev/null 2>&1 || true
git lfs track "*.tar.gz.enc" >/dev/null 2>&1 || true

mkdir -p archives
mv "/tmp/$ARCHIVE" "/tmp/$ARCHIVE.sha256" archives/

# 保留策略：只留最近 KEEP 份（旧的从工作树删掉，commit 里一并删除）
log "清理旧归档（保留 $KEEP 份）"
# 用 find -printf 而不是 ls：归档名虽然由本脚本生成，但工作副本可能被手工动过，
# ls 遇到空格/换行会拆错名字，进而删错文件（备份目录里删错等于丢数据）。
find archives -maxdepth 1 -name '*.tar.gz.enc' -printf '%T@\t%p\n' 2>/dev/null \
  | sort -rn | tail -n +$((KEEP + 1)) | cut -f2- | while IFS= read -r old; do
    log "  删除 $(basename "$old")"
    rm -f -- "$old" "$old.sha256"
  done

cat >README.md <<EOF
# LabSpace 加密备份归档

本分支存放 LabSpace 每日备份的**加密归档**，作为本地 restic 仓库的异地副本。

- 归档为 openssl AES-256-CBC（PBKDF2 600000 轮）密文，**没有口令无法解开**；
- 口令存放在主机 \`/etc/labspace/backup-git.env\` 的 \`LAB_BACKUP_ARCHIVE_KEY\`，
  与 restic 的 \`backup.key\` **相互独立**；请离线各存一份；
- 每个归档旁有 \`.sha256\`，恢复前先校验；
- 只保留最近 $KEEP 份，旧归档在后续提交中删除。

恢复：

\`\`\`bash
git lfs pull
ops/backup-git-archive.sh --restore archives/labspace-backup-XXXX.tar.gz.enc
\`\`\`
EOF

git add -A
if git diff --cached --quiet; then
  log "无变化，跳过推送"
  write_status ok 2 "内容与上一份一致，未产生新提交"
  exit 0
fi
git -c user.name="labspace-backup" -c user.email="backup@labspace.local" \
  commit -q -m "backup: $STAMP（保留最近 $KEEP 份）"
if git push -q origin "HEAD:$BRANCH" 2>/dev/null; then
  log "已推送到 $BRANCH"
  write_status ok 1 ""
else
  log "推送失败（本地归档仍在 $WORK/archives，网络恢复后重试即可）"
  write_status failed 0 "推送失败：本地归档已生成，等待下次重试"
  exit 1
fi
