package dbapis

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

// Handler serves the /v1/databases/* routes. Authentication is enforced by
// httpapi.Server before forwarding (user or internal service token).
type Handler struct {
	Client *Client
	Prober *Prober
}

func (h *Handler) Serve(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Client == nil {
		writeErr(w, 503, "database API backend unavailable")
		return
	}
	p := strings.TrimPrefix(r.URL.Path, "/v1/databases")
	q := r.URL.Query()
	ctx := r.Context()

	switch {
	case p == "" || p == "/" || p == "/index":
		writeJSON(w, 200, map[string]any{
			"total": len(databases), "matched": len(APIIndex()),
			"categories": []string{}, "items": APIIndex(),
		})

	case p == "/apis":
		entries := APIIndex()
		if h.Prober != nil {
			statuses := h.Prober.ProbeAll(ctx, h.Client)
			for _, entry := range entries {
				if entry["hasApi"] == true {
					id, _ := entry["id"].(string)
					st := statuses[id]
					api := entry["api"].(map[string]any)
					api["available"] = st.OK
					api["statusDetail"] = st.Detail
				}
			}
		}
		summary := APISummary()
		summary["items"] = entries
		writeJSON(w, 200, summary)

	case p == "/query" && r.Method == http.MethodPost:
		var body struct {
			Key    string            `json:"key"`
			Query  string            `json:"query"`
			Limit  int               `json:"limit"`
			Params map[string]string `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, 400, "invalid JSON")
			return
		}
		writeJSON(w, 200, h.Client.RunQuery(ctx, body.Key, body.Query, body.Limit, body.Params))

	case p == "/query" && r.Method == http.MethodGet:
		limit, _ := strconv.Atoi(q.Get("limit"))
		writeJSON(w, 200, h.Client.RunQuery(ctx, q.Get("key"), q.Get("query"), limit, nil))

	case p == "/probe":
		key := q.Get("key")
		ok, detail := false, "未探测"
		if h.Prober != nil {
			ok, detail = h.Prober.Probe(ctx, h.Client, key)
		}
		var api any
		if spec, found := Find(key); found {
			api = spec.AsDict(&ok)
		}
		writeJSON(w, 200, map[string]any{"id": key, "ok": ok, "detail": detail, "api": api})

	default:
		writeErr(w, 404, "unknown database route")
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
