# IMAGES_LOCK.md — 镜像与版本

| 组件 | 镜像 | 版本 | Digest / 说明 |
| --- | --- | --- | --- |
| LabSpace 后端 | `lab/labspace-backend:1.0.0` | 本地构建 | FROM `openwebui/open-webui:0.12.2-slim` |
| Casdoor | `casbin/casdoor:latest` | 拉取于 2026-10-25 | 见 `docker image inspect casbin/casdoor:latest --format '{{index .RepoDigests 0}}'` |
| draw.io | `jgraph/drawio:latest` | 拉取于 2026-10-25 | 同上命令查看 |
| IT-Tools | `corentinth/it-tools:latest` | 拉取于 2026-10-25 | 同上命令查看 |
| 前端 | npm: react 19.3.1 / antd 6.6.7 / vite 8.3.5 / react-router-dom 7.18.4 / @tanstack/react-query 5.104.5 | 见 package.json | 锁文件 package-lock.json |
| Linux Command | 源码静态构建 v1.22.0 | github.com/jaywcjlove/linux-command | 构建产物 43MB |

固定 digest 的方式：

```bash
# 取出 digest
docker image inspect <image> --format '{{index .RepoDigests 0}}'
# 在 compose 中使用
image: <repo>@sha256:<digest>
```

> 说明：本机到 Docker Hub 的镜像源带宽约 0.3–0.6 MB/s，Casdoor/官方仓库镜像在 `docker.1panel.live`
> 被白名单拦截时使用了 `casbin/casdoor`、`corentinth/it-tools` 等官方仓库路径拉取；生产建议固定 digest。
