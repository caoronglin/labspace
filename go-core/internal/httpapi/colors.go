package httpapi

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"labspace.local/go-core/internal/colorlab"
)

// serveColors routes the color-lab endpoints: the Go rewrite of the
// lcpmgh/colors Shiny app.
func (s *Server) serveColors(w http.ResponseWriter, r *http.Request, body []byte, q url.Values) {
	if s.Colors == nil {
		deny(w, 503, "color lab unavailable")
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/v1/colors")
	switch {
	case path == "/meta" && r.Method == http.MethodGet:
		counts, maxCount := s.Colors.Histogram()
		jsonResponse(w, 200, map[string]any{
			"total":      s.Colors.Total(),
			"sources":    s.Colors.Sources(),
			"counts":     counts,
			"max_colors": colorlab.MaxColors,
			"max_count":  maxCount,
		})

	case path == "/palettes" && r.Method == http.MethodGet:
		f := colorlab.ListFilter{
			Query:    q.Get("q"),
			Source:   q.Get("source"),
			MinCount: atoiDefault(q.Get("min_count"), 0),
			Sort:     q.Get("sort"),
			Page:     atoiDefault(q.Get("page"), 1),
			PageSize: atoiDefault(q.Get("page_size"), 20),
		}
		if v := q.Get("count"); v != "" && v != "all" {
			if n, err := strconv.Atoi(v); err == nil {
				f.Count = n
			}
		}
		jsonResponse(w, 200, s.Colors.List(f))

	case strings.HasPrefix(path, "/palettes/") && r.Method == http.MethodGet:
		id, err := strconv.Atoi(strings.TrimPrefix(path, "/palettes/"))
		if err != nil {
			deny(w, 400, "invalid palette id")
			return
		}
		p, ok := s.Colors.Find(id)
		if !ok {
			deny(w, 404, "palette not found")
			return
		}
		tpp := atoiDefault(q.Get("opacity"), 0)
		shown := colorlab.ApplyOpacity(p.Colors, tpp)
		jsonResponse(w, 200, map[string]any{
			"palette":  p,
			"colors":   shown,
			"swatches": colorlab.Swatches(shown),
		})

	case path == "/parse" && r.Method == http.MethodPost:
		var in struct {
			Colors  string `json:"colors"`
			Opacity int    `json:"opacity"`
		}
		if json.Unmarshal(body, &in) != nil {
			deny(w, 400, "invalid JSON")
			return
		}
		parsed := colorlab.ParseColors(in.Colors)
		shown := colorlab.ApplyOpacity(parsed, in.Opacity)
		jsonResponse(w, 200, map[string]any{
			"input":    in.Colors,
			"colors":   shown,
			"swatches": colorlab.Swatches(shown),
			"count":    len(shown),
			"truncated": len(parsed) >= colorlab.MaxColors &&
				len(colorlab.ParseColors(in.Colors+" ")) >= colorlab.MaxColors,
		})

	case path == "/match" && r.Method == http.MethodGet:
		seedRaw := q.Get("colors")
		if seedRaw == "" {
			seedRaw = q.Get("seed")
		}
		seed := colorlab.ParseColors(seedRaw)
		limit := atoiDefault(q.Get("limit"), 6)
		jsonResponse(w, 200, map[string]any{
			"seeds": seed,
			"items": s.Colors.Match(seed, limit),
		})

	default:
		deny(w, 404, "route not found")
	}
}

func atoiDefault(raw string, def int) int {
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	return n
}
