#!/usr/bin/env bash
# 构建并推送镜像。标签规则：
#   - commit 短 SHA：不可变，发布/回滚都指向它
#   - latest：只作方便，不作为发布依据
# 现网仍是 Nginx + Compose，镜像不自动部署，只作为可回滚的发布物。
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT/labspace"

REGISTRY="${CNB_DOCKER_REGISTRY:?缺少 CNB_DOCKER_REGISTRY，需开启 services: docker}"
SLUG="${CNB_REPO_SLUG_LOWERCASE:?缺少 CNB_REPO_SLUG_LOWERCASE}"
TAG="${CNB_COMMIT_SHORT:-$(git rev-parse --short HEAD)}"

build() {
  local name="$1" dockerfile="$2" context="$3"
  local image="$REGISTRY/$SLUG/$name"
  echo "== $name"
  docker build -f "$dockerfile" -t "$image:$TAG" -t "$image:latest" "$context"
  docker push "$image:$TAG"
  docker push "$image:latest"
  echo "   $image:$TAG"
  echo "$image:$TAG" >> "${IMAGES_FILE:-/tmp/labspace-images.txt}"
}

: > "${IMAGES_FILE:-/tmp/labspace-images.txt}"

echo "== 登录制品库"
docker login -u "${CNB_TOKEN_USER_NAME:-cnb}" -p "${CNB_TOKEN:?}" "$REGISTRY"

# 三个镜像与三套现网进程一一对应，Dockerfile 全部在仓库里（不额外写一份）
build frontend "$ROOT/labspace/deploy/images/frontend.Dockerfile" "$ROOT/labspace"
build backend  "$ROOT/labspace/backend/Dockerfile"                "$ROOT/labspace/backend"
build go-core  "$ROOT/labspace/go-core/Dockerfile"                "$ROOT/labspace/go-core"

echo "== 已推送："
cat "${IMAGES_FILE:-/tmp/labspace-images.txt}"
