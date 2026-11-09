package httpapi

import (
	"net/http"
	"strconv"
	"strings"

	"labspace.local/go-core/internal/corpus"
)

// serveCorpus answers the unified corpus queries (command palette, global
// search suggestions, database directory). It replaces the Python module
// backend/app/corpus.py.
func (s *Server) serveCorpus(w http.ResponseWriter, r *http.Request, q map[string][]string) {
	if s.Corpus == nil {
		deny(w, 503, "corpus unavailable")
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/v1/corpus")
	switch {
	case path == "" || path == "/":
		kw := first(q, "q")
		limit := intParam(q, "limit", 30)
		if kw == "" {
			items := s.Corpus.Buckets(limit)
			jsonResponse(w, 200, map[string]any{"query": "", "count": len(items), "items": items})
			return
		}
		items := s.Corpus.Search(kw, limit, nil)
		jsonResponse(w, 200, map[string]any{"query": kw, "count": len(items), "items": items})

	case path == "/search":
		kw := first(q, "q")
		limit := intParam(q, "limit", 20)
		types := q["type"]
		items := s.Corpus.Search(kw, limit, types)
		jsonResponse(w, 200, map[string]any{"query": kw, "count": len(items), "items": items})

	case path == "/suggest":
		kw := first(q, "q")
		limit := intParam(q, "limit", 10)
		jsonResponse(w, 200, map[string]any{
			"suggestions": s.Corpus.Suggest(kw, limit),
			"hot":         s.Corpus.Hot(),
		})

	case path == "/hot":
		jsonResponse(w, 200, map[string]any{"hot": s.Corpus.Hot()})

	case path == "/databases":
		limit := intParam(q, "limit", 300)
		rows := s.Corpus.Databases(first(q, "q"), first(q, "category"), limit)
		jsonResponse(w, 200, map[string]any{"count": len(rows), "databases": rows})

	default:
		deny(w, 404, "not found")
	}
}

func first(q map[string][]string, key string) string {
	if v, ok := q[key]; ok && len(v) > 0 {
		return strings.TrimSpace(v[0])
	}
	return ""
}

func intParam(q map[string][]string, key string, def int) int {
	raw := first(q, key)
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	return n
}

// corpusEntries is a small helper used by the unified search endpoint.
func corpusEntries(entries []corpus.Entry) []map[string]any {
	out := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		out = append(out, map[string]any{
			"type":        e.Type,
			"id":          e.ID,
			"title":       e.Title,
			"subtitle":    e.Subtitle,
			"description": e.Description,
			"url":         e.URL,
			"path":        e.Path,
		})
	}
	return out
}
