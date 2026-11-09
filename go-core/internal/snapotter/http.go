package snapotter

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Handler serves the /v1/snapotter/* routes. Authentication is enforced by
// httpapi.Server before forwarding. The SnapOtter API key never leaves this
// process (it lives in Client.cfg).
type Handler struct{ Client *Client }

func (h *Handler) Serve(w http.ResponseWriter, r *http.Request, _ string) {
	if h == nil || h.Client == nil {
		writeErr(w, 503, "SnapOtter 未配置")
		return
	}
	p := strings.TrimPrefix(r.URL.Path, "/v1/snapotter")
	q := r.URL.Query()
	ctx := r.Context()

	switch {
	case p == "/status" && r.Method == http.MethodGet:
		ok, detail := h.Client.Probe(ctx)
		tools := h.Client.Snapshot()
		writeJSON(w, 200, map[string]any{
			"configured": h.Client.Configured(), "up": ok, "detail": detail,
			"toolCount": len(tools), "baseUrl": h.Client.BaseURL(),
		})

	case p == "/tools" && r.Method == http.MethodGet:
		tools, err := h.Client.Catalog(ctx)
		if err != nil {
			writeErr(w, 502, fmt.Sprintf("SnapOtter 工具目录不可用（%s）", err))
			return
		}
		writeJSON(w, 200, map[string]any{"tools": tools, "count": len(tools)})

	case p == "/run" && r.Method == http.MethodPost:
		section, toolID := q.Get("section"), q.Get("tool_id")
		if section == "" || toolID == "" {
			writeErr(w, 400, "缺少 section / tool_id")
			return
		}
		if err := r.ParseMultipartForm(h.Client.cfg.MaxUpload + 1<<20); err != nil {
			writeErr(w, 400, "上传文件解析失败")
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			writeErr(w, 400, "缺少上传文件")
			return
		}
		defer file.Close()
		content, err := io.ReadAll(io.LimitReader(file, h.Client.cfg.MaxUpload+1))
		if err != nil || int64(len(content)) > h.Client.cfg.MaxUpload {
			writeErr(w, 413, "文件超过上限")
			return
		}
		if len(content) == 0 {
			writeErr(w, 400, "上传文件为空")
			return
		}
		settings := r.FormValue("settings")
		ct := header.Header.Get("Content-Type")
		result, err := h.Client.Submit(ctx, SubmitOptions{
			Section: section, ToolID: toolID, Filename: header.Filename,
			ContentType: ct, Settings: settings, Size: int64(len(content)),
			Open: func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(content)), nil },
		})
		if err != nil {
			writeErr(w, 502, fmt.Sprintf("SnapOtter 处理失败（%s）", err))
			return
		}
		writeJSON(w, 200, result)

	case strings.HasPrefix(p, "/jobs/") && r.Method == http.MethodGet:
		result, err := h.Client.JobStatus(ctx, strings.TrimPrefix(p, "/jobs/"))
		if err != nil {
			writeErr(w, 502, fmt.Sprintf("任务状态查询失败（%s）", err))
			return
		}
		writeJSON(w, 200, result)

	case p == "/pipelines" && r.Method == http.MethodGet:
		writeJSON(w, 200, h.Client.Pipelines(ctx))

	case p == "/download" && r.Method == http.MethodGet:
		content, name, typ, err := h.Client.Download(ctx, q.Get("url"))
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		if typ == "" {
			typ = "application/octet-stream"
		}
		w.Header().Set("Content-Type", typ)
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, name))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(200)
		_, _ = w.Write(content)

	default:
		writeErr(w, 404, "unknown snapotter route")
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func writeErr(w http.ResponseWriter, code int, reason string) {
	writeJSON(w, code, map[string]string{"error": reason})
}
