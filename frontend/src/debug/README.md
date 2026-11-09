# 全局 Debug 与 Preview

全站可用（含 `/login`、`/start`）：右下角悬浮按钮、`⌘⇧D` / `Ctrl⇧D`、命令面板
「打开全局 Debug」/「预览本地文件」。面板挂在 `main.tsx` 的 `BrowserRouter` 内、
`AppLayout` 之外，因此不受布局路由限制。

## 四个视图

| 视图 | 数据来源 | 采样方式 |
|---|---|---|
| 概览 | `GET /api/debug/status` | 打开面板时一次，之后仅手动刷新 |
| 服务健康 | 现有 `GET /api/services/health` | 同上，复用已有探测结果，不额外扇出 |
| 运行时 | `src/debug/runtime.ts` | 纯内存环形缓冲（200 条）+ 浏览器能力快照 |
| Preview | `src/debug/previewEngine.ts` | 本地解析，默认零网络请求 |

诊断不能让故障更严重：不轮询、不并发打全部上游、不开新数据库连接。

## Preview 的安全边界

三处实现共享同一份契约：Go `internal/preview`、Python `app/preview_inline.py`、
本目录 `previewEngine.ts`。

- **只返回派生结果**，绝不回显原始字节；`image-metadata` 只读 PNG/JPEG/GIF 头部尺寸，
  PDF / BAM / BigWig 只回 `requires-worker` 提示。
- 硬上限：输入 8 MiB、解压后 24 MiB、20 行/记录、2048 字符、Office 256 条目。
  ZIP 先校验中央目录声明的**解压总量**再读成员，拦 zip bomb。
- Office 只抽取 `<w:t>/<a:t>/<v>` 文本，不执行宏、不解析外部实体、不渲染 HTML/SVG。
- 默认通道是**浏览器本地**；「服务端对证」是显式开关，`POST /api/debug/preview`
  只在请求生命周期内持有字节，返回同样有界的结果。

前端为此自己解析 ZIP 中央目录（不引第三方依赖），因此 `vendor-*` 体积不受影响。

## 脱敏

`/api/debug/status` 的能力开关**只返回布尔值**，不返回配置值、DSN、密钥或连接串。
运行时事件记录里 URL 只留 pathname（查询串可能带 token），不记录请求头、Cookie、
响应体；`token/key/secret/code` 之类的参数值、`Bearer` 令牌一律替换为 `<redacted>`。

## 新增后端文件

- `app/preview_inline.py`：纯标准库的有界派生渲染，可脱离 FastAPI 单测。
- `app/debug_api.py`：`APIRouter(prefix="/api/debug")`，`require_user` + `require_csrf`。
- `app/main.py`：仅两行接线（import + `include_router`），不动任何既有逻辑。

## 验证

```bash
# 前端：类型检查 + 构建 + 17 条引擎契约
cd labspace/frontend
npx tsc -b && npx vite build
node --test src/debug/__tests__/previewEngine.test.mjs

# 后端：64 条（原有 50 + 新增 14）
cd labspace/backend && python3 -m pytest tests -q

# 或一键
bash labspace/ops/verify_global_debug.sh
```
