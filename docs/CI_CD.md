# CI/CD 流程

本仓库的流水线定义在 `.cnb.yml`，在 CNB 平台（云原生构建）上运行。
本地等价入口是 `labspace/ops/ci-local.sh`，两者执行的是同一批脚本。

**这个 PR 只做 CI/CD，不动 Go 内核源码。** 主干 `labspace/go-core` 的编译破损已由 PR #17
收敛（合并 #4/#5 的两套实现只留一套），本分支 rebase 到那之后的 `main`，
源码与 `main` 一致，不重复修。

## 一、分三类事件，各自边界清楚

| 事件 | 触发 | 做什么 | 产出 |
|---|---|---|---|
| `pull_request` | PR 创建/更新 | 全量校验 | 无（只给合并门禁一个结论） |
| `push`（main） | 合入主干 | 全量校验 → 打包 → 镜像 → 构建清单 | 镜像（按 commit SHA 打标）、Release 附清单 |
| `tag_deploy.production` | 页面上点「部署」 | 前置校验 → 生成发布清单 | 清单附到 Release，**不碰现网** |
| `crontab`（周一 03:00） | 定时 | 全量校验 | 依赖漂移 / 上游 API 变更早发现 |

**为什么 PR 不产出**：PR 的配置来自源分支、`CNB_TOKEN` 权限受限。在 PR 里推镜像等于把制品
的信任链交给提交者。产出只在主干发生，镜像 tag 就是 commit 短 SHA，回滚时能对回提交。

**为什么发布不自动**：现网是宿主机 Nginx + Docker Compose + systemd。
从构建容器远程改它需要把宿主机凭据放进 CI 变量，风险远大于收益。
所以发布是「点按钮 → 跑校验 → 生成照做即可的清单」，写操作由有权限的人执行。

## 二、四项校验

| 检查 | 脚本 | 挡住什么 |
|---|---|---|
| 仓库卫生与安全约定 | `labspace/ops/ci-hygiene.sh` | 明文凭据入库、锁文件被写成两份 YAML 文档、Go 内核出现 `require`、脚本里硬编码现网 IP |
| Python 后端 | `labspace/ops/ci-python.sh` | `pytest tests -q`（实测 64 passed） |
| 前端 | `labspace/ops/ci-frontend.sh` | `tsc -b` 类型错误、`vite build` 失败；同时把 pnpm 写成两份文档的锁文件归并回一份 |
| Go 核心 | `labspace/ops/ci-go.sh` | `GOPROXY=off` 下的 `vet` / `test -race` / `build`；出现 `require` 直接失败；`build` 用与镜像一致的 `CGO_ENABLED=0` |

`ci-toolchain.sh` 负责装 Go 1.23 与 gcc（`-race` 需要 C 工具链），pnpm 版本由 `.cnb.yml` 的
`env.PNPM_VERSION` 固定。

### Go 阶段的超时判据（踩过一次）

平台判超时看的是**本阶段没有输出超过 10 分钟**，不是某条测试跑了太久。
`go test ./...` 的输出是「一个包跑完才吐一行」，所以静默窗口等于最慢那个包的耗时；
真有一包卡住不返回时，日志彻底静默，平台只会报「10 分钟无输出」，
罪魁祸首（哪个包、哪条用例）也被这段静默吞掉。

`ci-go.sh` 因此改成：先 `go list ./...`，再**逐包**跑，每个包打一行 `── <包名>`，
后台心跳把「当前在哪个包」一并写出来，单包补 `-timeout 600s` 兜底。
心跳只写文件、不往管道里写——`kill` 一个阻塞在管道写上的后台 `echo` 会原地挂住，
上一版就是这样把脚本吊死了。

## 三、CD 的三个产出

1. `cd-package.sh` → `labspace/dist/frontend`（前端静态产物）+ `labspace/dist/VERSION`
2. `cd-images.sh` → 三个镜像，一个镜像对一套现网进程：
   `frontend`（Nginx + 静态产物）、`backend`（FastAPI）、`go-core`（labgo）
3. `cd-manifest.sh` → 构建清单（提交、镜像 tag、校验结论、回滚方式），挂到 Release 上

发布侧的 `cd-preflight.sh` 校验环境参数、发布物与提交是否同源、回滚文档是否存在、
新增明文凭据与健康探针；`cd-deploy-plan.sh` 生成发布/验收/回滚清单。

## 四、本地跑同一套检查

```bash
bash labspace/ops/ci-local.sh          # 全跑
bash labspace/ops/ci-local.sh hygiene  # 只跑某一项
```

脚本全部是「从仓库根目录、用标准 POSIX 工具」实现的，没有平台专属依赖，
所以本地与 CI 的结论一致——否则这条门禁就只是装饰。

## 五、实测结论（Go 1.23.4 / gcc 12.2.0 / pnpm 12.16.1 上真跑）

| 检查 | 结论 |
|---|---|
| `ci-hygiene.sh` | 通过（凭据 / 锁文件单文档 / 零依赖 / 现网 IP 四项） |
| `ci-go.sh` | `go vet` 干净；`go test -race ./...` 24 个包全 ok；`go build ./cmd/labgo` 通过 |
| `ci-frontend.sh` | `tsc -b` 通过；`vite build` ✓；`vendor-charts` 1.01 MB 仍是独立块（首屏不拉） |
| `ci-python.sh` | 64 passed（容器里 `node:22-bookworm` 无 venv/pip，脚本自己补，见下） |

`-race` 需要 gcc，Debian 基础镜像默认没有——`ci-toolchain.sh` 里装，不要删。

## 六、当前边界（别当成已完成）

- 发布清单**不自动执行**：`cd-deploy-plan.sh` 是生成器，不是部署器。
- 32 个科研适配器只有离线契约与转译测试，没在内网逐个实机探活。
- Go 核心尚未接进 Nginx 的 `/api/*`，切换前需要跑一轮影子流量对账。
- **依赖是否被静默改动，仍靠评审看 diff**。`ci-frontend.sh` 原本想用
  `--frozen-lockfile`，但 pnpm 12.16.1 实测：`pnpm install --lockfile-only` 会把
  `labspace/pnpm-lock.yaml` 从 757 行重写成一万多行（`packages:` 与 `snapshots:`
  整段重排），且**回写时是单个合法文档**，`ci-hygiene.sh` 的「单一文档」检查挡不住这种
  重写。所以现在：`--lockfile-only` 只做校验、不提交产物，`lockfile-normalize.py`
  只归并多文档、不负责消除重排。真正的 `--frozen-lockfile` 需要先接受一次整段重排的锁文件。

## 七、维护者备忘

- 加一项新检查 = 在 `labspace/ops/` 加脚本 + 在 `.cnb.yml` 的 `x-stage-*` 里加一条锚点。
  锚点被 PR / push / 定时三处引用，没有第二份定义。
- 改 `.cnb.yml` 前先查平台文档（`/zh/build/grammar.md`）：字段名、事件名、
  内置任务参数都以文档为准。
- 失败诊断：`cnb pulls get-ci-logs`；耗时分析：`cnb pulls get-ci-timing`。
