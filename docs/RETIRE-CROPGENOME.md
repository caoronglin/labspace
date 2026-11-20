# 下架 CropGenome（rust-bio 序列服务）

2026-11-20。本文是这次下架的**唯一权威记录**：为什么下、动了哪些东西、怎么退回去。

## 一、为什么下架

1. **rust-bio 生态停更**：worker（`seq-worker`）钉在 rust-bio 4.2.2 / rustc 1.87.0，
   上游已不再发版，安全修复拿不到。留在现网等于把一个不再维护的解析器挂在门户上。
2. **二进制没有源码**：`/usr/local/bin/cropgenome` 是当年的 rust 产物，源码目录已不在本机，
   想升级只能凭记忆重写——这不是能长期维护的形态。
3. **功能重复**：序列层面的需求（CDS 提取、酶切、ORF、比对、进化树、质粒图谱等）已经由
   门户内置生信工具承接（Biopython + scikit-bio，后端 `/api/biotools/*`，页面 `/bio-tools`）。
   两个入口同时存在只会让人问「我该在哪儿做」。
4. 数据集 manifest 一直是 `not_provisioned`，实际可用的只有 API 契约——投入与产出不匹配。

## 二、做了哪些事

| 层面 | 动作 |
|---|---|
| systemd | 停用并删除 `cropgenome-api.service` / `cropgenome-worker.service`（`disable --now`） |
| 文件 | 删除 `/usr/local/bin/cropgenome`、`/opt/cropgenome`（内含 `bin/seq-worker`）、`/srv/labdata/cropgenome/web` |
| nginx | 删除 `location /cropgenome/api/`、`/cropgenome/`、`/cropgenome/assets/` 三段（仓库副本 `deploy/nginx/labspace.conf` 与线上 `/etc/nginx/sites-enabled/labspace.conf`），原地留注释；`nginx -t && reload` |
| go-core | 服务目录 `jbrowse` 条目文案：`Engine` → `JBrowse 2 + Biopython / scikit-bio`，`Guide` 说明序列分析由门户内置生信工具完成；删除 `/cropgenome/*` 的 OIDC 反代（`internal/httpapi/cropgenome.go`、`Server.CropGenome` 字段与前缀分发、`cmd/labgo` 的 `cropGenomeProxy()` 与 `CROPGENOME_*` 环境变量读取） |
| 前端 | `frontend/src/services/api.ts` 的 19 处 `/cropgenome/api/v1/*` 改调 `/api/biotools/*` |
| ops | 删除 `ci-cropgenome.sh`、`ci-cropgenome-frontend.sh`、`ci-rust.sh`、`deploy-cropgenome.sh`；`ci-local.sh` 的 stage 清单同步 |
| 保留 | **数据库 `cropgenome`（lab-postgres，未 drop）**、历史 CHANGELOG 记录、`docs/SECURITY-AUDIT-2026-11-05.md` 审计存档 |

数据库有意不动：`ops/backup.sh` 仍在按原样 dump 它，下架服务不等于删数据；要彻底清掉是
另一件需要单独决策的事（`drop database cropgenome`）。

## 三、回滚方式

1. 归档在 `/srv/labbackup/archives/retired-code/cropgenome-<日期>/`：二进制
   （`cropgenome`、`seq-worker`）、两个 unit 文件、被删的 nginx 片段、被删的 ops 脚本。
2. `install -m 0755 cropgenome /usr/local/bin/cropgenome`，`mkdir -p /opt/cropgenome/bin` 并放回
   `seq-worker`；前端产物从归档或前端仓库按 `base=/cropgenome/` 重新构建到
   `/srv/labdata/cropgenome/web`。
3. `cp cropgenome-*.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now cropgenome-api cropgenome-worker`。
4. 把归档里的 `/cropgenome/` 三段 location 贴回 nginx 站点配置，`nginx -t && systemctl reload nginx`。
5. go-core 与前端：**回滚不是只恢复二进制**——`go-core/internal/httpapi/cropgenome.go` 与
   `httpapi.go` 里的 `/cropgenome/` 前缀分发已删除，`cmd/labgo/main.go` 的 `cropGenomeProxy()`
   与 `CROPGENOME_*` 环境变量读取也一并移除。必须 `git revert` 本次下架提交后重建 `labgo`
   （`go build -o go-core/bin/labgo ./cmd/labgo`），再恢复前端 `api.ts` 的调用路径。
   两边成对恢复，只恢复一边会 404/502。

数据库从未被删，回滚不需要恢复数据；若已手工 drop，用 `ops/backup.sh` 的归档
（`lab-backup-core` 快照）里的 `cropgenome.dump` 还原。
