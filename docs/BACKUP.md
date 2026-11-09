# 加密增量备份

LabSpace 使用 [restic](https://restic.net/) 做加密、去重、压缩的增量备份。

## 组成

| 项目 | 路径 |
| --- | --- |
| 备份仓库 | `/srv/labbackup/restic`（可用 `LAB_BACKUP_REPO` 覆盖） |
| 仓库口令 | `/etc/labspace/backup.key`（`0600 root:root`） |
| 备份脚本 | `/opt/labspace/ops/backup.sh` |
| 定时器 | `lab-backup.timer`，每日 03:20（随机延迟 ≤10 分钟）；`lab-backup-core.timer` 每日 02/08/14/20:15 |
| 状态文件 | `/srv/labdata/labgo/backup-status.json`（后台只读展示） |
| 缓存 | `/var/cache/lab-backup` |

备份内容：PostgreSQL 逻辑备份（labspace / casdoor / cropgenome / snapotter / baserow）、
`/srv/lab` 教学与用户文件、`/srv/labdata/bioinfo-training`、`/srv/labdata/baserow`
（媒体与配置，PGDATA 已由逻辑备份替代）、`/srv/labdata/jbrowse`、`/srv/labdata/labops`、
`/srv/labdata/labgo`、`/srv/labdata/plot`、`/srv/labdata/snapotter`、`/srv/labdata/cropgenome`、
项目源码与部署配置、`/etc/labspace`。依赖目录（`node_modules`、`.venv`、缓存）不进入备份。

## 常用操作

```bash
export RESTIC_PASSWORD_FILE=/etc/labspace/backup.key
export RESTIC_REPOSITORY=/srv/labbackup/restic
export XDG_CACHE_HOME=/var/cache/lab-backup

# 查看快照
restic snapshots

# 立即执行一次备份
systemctl start lab-backup.service
journalctl -u lab-backup.service -f

# 完整性校验（每次备份自动抽检 2%）
restic check

# 恢复单个文件到临时目录
restic restore latest --target /tmp/restore --include '/srv/lab/users/student01/example.txt'

# 恢复整个快照
restic restore latest --target /tmp/restore
```

数据库 dump 位于快照内的 `srv/labbackup/stage.*/`：

```bash
pg_restore -U postgres -d labspace --clean --if-exists labspace.dump
```

Baserow 使用容器内置 PostgreSQL，恢复时先停容器，再用容器内 `pg_restore`：

```bash
docker stop lab-baserow
docker run --rm -i --entrypoint pg_restore -u postgres \
  -v /srv/labdata/baserow:/baserow/data \
  -v /path/to/restore:/restore baserow/baserow:2.4.1 \
  --clean --if-exists -d baserow /restore/baserow.dump
docker start lab-baserow
```

JBrowse 静态数据与配置在 `/srv/labdata/jbrowse`，恢复后确认 nginx 的
`/jbrowse/` 指向该目录；流水线脚本与输出在 `/srv/labdata/labops`，绘图成品在
`/srv/labdata/plot`。

## 恢复演练（每次备份后建议抽检）

```bash
# 取出最新快照里的文档与 Baserow dump 到临时目录
restic restore latest --target /tmp/lab-restore --include '/opt/labspace/docs/BACKUP.md'
restic restore latest --target /tmp/lab-restore --include '/srv/labbackup/stage.*/baserow.dump'
test -s /tmp/lab-restore/opt/labspace/docs/BACKUP.md && echo docs-ok
# 校验数据库 dump 可读（不导入）
pg_restore -l /tmp/lab-restore/srv/labbackup/stage.*/baserow.dump | head
rm -rf /tmp/lab-restore
```

## 保留策略

`--keep-within 3d --keep-daily 3`，随后自动 `prune`；即默认只保留最近 3 天。
备份状态写入 `/srv/labdata/labgo/backup-status.json`，管理后台“备份与恢复”可直接查看磁盘余量与快照列表。
首次备份约 2.7 GiB（压缩比约 2.3×），后续为增量。

## 安全要求

1. **口令必须离线另存**：`/etc/labspace/backup.key` 丢失后仓库不可恢复。
2. **异地副本**：当前仓库与源数据在同一块磁盘上，只能防误删/误改，不能防磁盘故障。
   建议定期把仓库同步到外部存储，或把 `LAB_BACKUP_REPO` 指向挂载的异地目录。
3. 仓库与口令不要提交到代码仓库。
