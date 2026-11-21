# IMAGES_LOCK.md — 镜像与版本

| 组件 | 镜像 | 锁定 digest | 说明 |
| --- | --- | --- | --- |
| LabSpace 后端 | `lab/labspace-backend:1.0.0` | 本地构建 | FROM `openwebui/open-webui:0.12.2-slim` |
| Casdoor | `casbin/casdoor` | `sha256:d8fd4f387026e1ffdf887b924c1c74ad5c15e8d3be54fb739b57b2037073a51f` | 已在 `deploy/compose.yaml` 里锁 digest（`image: casbin/casdoor@sha256:d8fd4f387026e1ffdf887b924c1c74ad5c15e8d3be54fb739b57b2037073a51f`） |
| draw.io | `jgraph/drawio` | `sha256:3e3281733f69416b2b632adad05c9c07d434ebb775e01070d55e9f3247cebe31` | 已在 `deploy/compose.yaml` 里锁 digest（`image: jgraph/drawio@sha256:3e3281733f69416b2b632adad05c9c07d434ebb775e01070d55e9f3247cebe31`） |
| Qdrant | `qdrant/qdrant` | `sha256:d277592721d2e3b73f9b797b53cf05e6a5bb2134f6d13fdbda4ca51782afbcac` | 已在 `deploy/compose.yaml` 里锁 digest（`image: qdrant/qdrant@sha256:d277592721d2e3b73f9b797b53cf05e6a5bb2134f6d13fdbda4ca51782afbcac`） |
| Stirling PDF | `stirlingtools/stirling-pdf` | `sha256:ed7b1775c6706b5e5ea24fa6155f078eff1027bd35a17d21834e4407036025e6` | 已在 `deploy/compose.yaml` 里锁 digest（`image: stirlingtools/stirling-pdf@sha256:ed7b1775c6706b5e5ea24fa6155f078eff1027bd35a17d21834e4407036025e6`） |
| PDF Math Translate | `awwaawwa/pdfmathtranslate-next` | `sha256:d7ff3755f8ae93a7d42a655ce228722990dbdddd5eaff7ea86ee8a3fb80bf453` | 已在 `deploy/compose.yaml` 里锁 digest（`image: awwaawwa/pdfmathtranslate-next@sha256:d7ff3755f8ae93a7d42a655ce228722990dbdddd5eaff7ea86ee8a3fb80bf453`） |
| 前端 | npm: react 19.3.1 / antd 6.6.7 / vite 8.3.5 / react-router-dom 7.18.4 / @tanstack/react-query 5.104.5 | 见 package.json | 锁文件 package-lock.json |
| Linux Command | 源码静态构建 v1.22.0 | github.com/jaywcjlove/linux-command | 构建产物 43MB |

> 第三方镜像一律在 `deploy/compose.yaml` 里用 `image: <repo>@sha256:<digest>` 固定；
> `:latest` 只出现在「取 digest」的命令里 —— 否则昨天的备份和今天的重建不是同一个东西。
> IT-Tools 已不在 `deploy/compose.yaml` 里（服务下线），不再列入版本清单。

固定/更新 digest 的方式：

```bash
# 取出 digest
docker image inspect <image> --format '{{index .RepoDigests 0}}'
# 在 compose 中使用
image: <repo>@sha256:<digest>
```

> 说明：本机到 Docker Hub 的镜像源带宽约 0.3–0.6 MB/s，Casdoor/官方仓库镜像在 `docker.1panel.live`
> 被白名单拦截时使用了 `casbin/casdoor`、`corentinth/it-tools` 等官方仓库路径拉取；生产建议固定 digest。
