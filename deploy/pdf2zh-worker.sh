#!/bin/sh
# =====================================================================
#  PDFMathTranslate 工作进程：串行消费 /jobs/pending 里的 PDF，产出译文压缩包
#  由 LabSpace 后端投递任务并轮询结果（后端不挂 Docker Socket，不直接 exec）
#  资源限制由 compose 施加：2GB 内存 / 1 核 CPU / 256 进程
# =====================================================================
set -eu

PENDING=/jobs/pending
DONE=/jobs/done
SERVICES="${PDF2ZH_SERVICES:-openaicompatible}"
LANG_IN="${PDF2ZH_LANG_IN:-en}"
LANG_OUT="${PDF2ZH_LANG_OUT:-zh}"
MT_ARGS=""
if [ "$SERVICES" = "openaicompatible" ]; then
  if [ -z "${PDF2ZH_MT_BASE:-}" ] || [ -z "${LABSPACE_INTERNAL_MT_TOKEN:-}" ]; then
    echo "openaicompatible 模式缺少 PDF2ZH_MT_BASE 或 LABSPACE_INTERNAL_MT_TOKEN" >&2
  else
    MT_ARGS="--openaicompatible --openai-compatible-model ${PDF2ZH_MT_MODEL:-hy-mt2} --openai-compatible-base-url $PDF2ZH_MT_BASE --openai-compatible-api-key $LABSPACE_INTERNAL_MT_TOKEN --openai-compatible-timeout ${PDF2ZH_MT_TIMEOUT:-120} --openai-compatible-temperature 0 --no-auto-extract-glossary"
  fi
fi

mkdir -p "$PENDING" "$DONE"
echo "worker 启动：services=$SERVICES $LANG_IN->$LANG_OUT"
while true; do
  for f in "$PENDING"/*.pdf; do
    [ -e "$f" ] || continue
    id=$(basename "$f" .pdf)
    echo "{\"status\":\"processing\",\"id\":\"$id\"}" > "$DONE/$id.json.tmp" 2>/dev/null || true
    mv "$DONE/$id.json.tmp" "$DONE/$id.json" 2>/dev/null || true
    rm -rf "$DONE/$id.out" "$DONE/$id.zip"
    # pdf2zh 的 --output 实际创建目录，随后由我们打包为 zip
    pdf2zh "$f" \
         --output "$DONE/$id.out" \
         --enabled-services "$SERVICES" \
         --lang-in "$LANG_IN" --lang-out "$LANG_OUT" \
         --ui-lang zh --qps 2 $MT_ARGS > "$DONE/$id.log" 2>&1
    rc=$?
    if [ $rc -eq 0 ] && [ -d "$DONE/$id.out" ]; then
      (cd "$DONE/$id.out" && python3 -m zipfile -c "$DONE/$id.zip" . >/dev/null 2>&1) || true
    fi
    # CLI 可能以 0 退出但内部失败，必须校验产物
    if [ $rc -eq 0 ] && [ -s "$DONE/$id.zip" ]; then
      echo "{\"status\":\"done\",\"id\":\"$id\",\"result\":\"$id.zip\"}" > "$DONE/$id.json.tmp"
      rm -f "$f"; rm -rf "$DONE/$id.out"
    else
      echo "{\"status\":\"failed\",\"id\":\"$id\",\"error\":\"translate failed (rc=$rc), see $id.log\"}" > "$DONE/$id.json.tmp"
      # 失败时保留源文件便于排查
    fi
    mv "$DONE/$id.json.tmp" "$DONE/$id.json"
  done
  date +%s > /jobs/worker.heartbeat
  sleep 3
done
