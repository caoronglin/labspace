package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"labspace.local/go-core/internal/catalog"
	"labspace.local/go-core/internal/labfiles"
	"labspace.local/go-core/internal/websearch"
)

// backendHTTP fronts the portal backend for per-user search merges.
var backendHTTP = &http.Client{Timeout: 4 * time.Second}

// knowledgeHits asks the portal backend for knowledge entries this caller can
// see, and returns them already shaped as search hits.
//
// The corpus index lives here and is site-wide, while knowledge entries are
// private by default and their visibility rules are implemented in the backend.
// Forwarding the caller's own cookie (never the service token) keeps that single
// ACL decision authoritative instead of duplicating it in two languages.
func (s *Server) knowledgeHits(r *http.Request, query string, limit int) []map[string]any {
	base := strings.TrimRight(strings.TrimSpace(s.BackendBase), "/")
	if base == "" || strings.TrimSpace(query) == "" {
		return nil
	}
	cookie := strings.TrimSpace(r.Header.Get("Cookie"))
	if cookie == "" {
		return nil
	}
	endpoint := base + "/api/knowledge/search?q=" + url.QueryEscape(query) +
		"&limit=" + strconv.Itoa(limit)
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("Cookie", cookie)
	resp, err := backendHTTP.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var payload struct {
		Hits []map[string]any `json:"hits"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&payload); err != nil {
		return nil
	}
	return payload.Hits
}

// categoryAliases maps the category names the frontend may send onto the real
// SearXNG category names ("scholarly" is the historical alias of
// "scientific publications").
var categoryAliases = map[string]string{
	"scholarly":               "scientific publications",
	"scientific publications": "scientific publications",
	"paper":                   "scientific publications",
	"papers":                  "scientific publications",
	"publication":             "scientific publications",
	"publications":            "scientific publications",
	"web":                     "general",
	"general":                 "general",
	"science":                 "science",
	"video":                   "videos",
	"videos":                  "videos",
	"image":                   "images",
	"images":                  "images",
	"it":                      "it",
	"code":                    "it",
	"news":                    "news",
	"book":                    "books",
	"books":                   "books",
}

// normalizeCategories accepts a comma-separated list so one search can cover
// several SearXNG categories, which is what the portal's "全部" tab does.
func normalizeCategories(value string) string {
	raw := strings.ToLower(strings.TrimSpace(value))
	if raw == "" {
		return "general"
	}
	seen := map[string]bool{}
	out := []string{}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		alias, ok := categoryAliases[part]
		if !ok || seen[alias] {
			continue
		}
		seen[alias] = true
		out = append(out, alias)
	}
	if len(out) == 0 {
		return "general"
	}
	return strings.Join(out, ",")
}

// servePortalSearch implements the portal's unified search contract: local
// corpus hits (engine=d509) plus paged SearXNG web hits.
//
// It replaces the Python route GET /api/search.
func (s *Server) servePortalSearch(w http.ResponseWriter, r *http.Request, actor actor, q url.Values) {
	query := first(q, "q")
	categories := normalizeCategories(first(q, "categories"))
	scope := strings.ToLower(first(q, "scope"))
	if scope == "" {
		scope = "web"
	}
	if query == "" {
		deny(w, 400, "q is required")
		return
	}
	page := intParam(q, "page", 1)
	if page < 1 {
		page = 1
	}
	pageSize := intParam(q, "pageSize", websearch.DefaultPageSize)
	if pageSize < 1 {
		pageSize = websearch.DefaultPageSize
	}
	if pageSize > websearch.MaxPageSize {
		pageSize = websearch.MaxPageSize
	}

	webResults := []map[string]any{}
	var engines any
	var webError any
	webTotal := 0
	webHasMore := false

	if scope == "web" || scope == "all" {
		if s.WebSearch == nil {
			webError = "检索服务暂时不可用（ConnectError）"
		} else {
			res, err := s.WebSearch.SearchPage(r.Context(), query, categories, page, pageSize)
			if err != nil {
				webError = "检索服务暂时不可用（" + websearch.ErrorKind(err) + "）"
			} else {
				engines = res.Engines
				webTotal = res.Total
				webHasMore = res.HasMore
				for _, h := range res.Hits {
					webResults = append(webResults, map[string]any{
						"title":    h.Title,
						"url":      h.URL,
						"content":  h.Content,
						"engine":   h.Engine,
						"category": h.Category,
						"kind":     "web",
					})
				}
			}
		}
		if scope == "web" && webError != nil {
			deny(w, http.StatusBadGateway, webError.(string))
			return
		}
	}

	localResults := []map[string]any{}
	if s.Corpus != nil && (scope == "local" || scope == "all") {
		for _, hit := range s.Corpus.Search(query, 400, nil) {
			title := hit.Title
			if hit.Type == "database" {
				title = strings.Trim(strings.TrimSpace(hit.Title+" · "+hit.Subtitle), " ·")
			}
			content := hit.Description
			if content == "" {
				content = hit.Subtitle
			}
			localResults = append(localResults, map[string]any{
				"title":    title,
				"url":      catalog.AdaptText(hit.URL, r.Host),
				"content":  content,
				"engine":   "d509",
				"category": hit.Type,
				"kind":     "local",
				"path":     hit.Path,
			})
		}
	}

	// Files are local resources too: shared sources are visible by scope and
	// personal files are already restricted to the caller's own home.
	if s.Files != nil && (scope == "local" || scope == "all") {
		identity := actor.fileIdentity()
		kw := strings.ToLower(strings.TrimSpace(query))
		fileHits := 0
		for _, src := range labfiles.Sources() {
			for _, e := range s.Files.Visible(identity, src.ID) {
				if e.Path == "" || fileHits >= 60 {
					continue
				}
				if !strings.Contains(strings.ToLower(e.Name), kw) && !strings.Contains(strings.ToLower(e.Path), kw) {
					continue
				}
				localResults = append(localResults, map[string]any{
					"title":    e.Name,
					"url":      "/files?source=" + url.QueryEscape(src.ID) + "&q=" + url.QueryEscape(e.Name),
					"content":  src.Label + " · " + e.Path,
					"engine":   "d509",
					"category": "file",
					"kind":     "local",
					"path":     e.Path,
				})
				fileHits++
			}
		}
	}

	// Knowledge entries are the caller's own notes, so they rank first.
	if scope == "local" || scope == "all" {
		if hits := s.knowledgeHits(r, query, 8); len(hits) > 0 {
			localResults = append(hits, localResults...)
		}
	}

	// The plant database directory is a lightweight catalogue and returns a
	// fixed handful of entries; it is not part of the paged web results.
	dbDir := []map[string]any{}
	if s.Corpus != nil {
		for _, d := range s.Corpus.Databases(query, "", 16) {
			dbDir = append(dbDir, map[string]any{
				"id":       d.ID,
				"name":     d.Name,
				"cn":       d.CN,
				"url":      d.URL,
				"category": d.Category,
			})
		}
	}

	databases := []map[string]any{}
	databaseWarnings := []string{}
	if s.LifeDB != nil && (scope == "local" || scope == "all") {
		hits, warnings := s.LifeDB.Search(r.Context(), query, 4)
		databaseWarnings = warnings
		for _, h := range hits {
			databases = append(databases, map[string]any{
				"id":      h.ID,
				"title":   h.Title,
				"url":     h.URL,
				"snippet": h.Snippet,
				"source":  h.Source,
				"type":    h.Type,
			})
		}
	}

	hot := []string{}
	if s.Corpus != nil {
		hot = s.Corpus.Hot()
	}

	results := localResults
	if scope == "web" {
		results = webResults
	} else if scope == "all" {
		results = append(append([]map[string]any{}, localResults...), webResults...)
	}

	jsonResponse(w, 200, map[string]any{
		"query":            query,
		"categories":       categories,
		"scope":            scope,
		"page":             page,
		"pageSize":         pageSize,
		"count":            len(results),
		"results":          results,
		"engines":          engines,
		"error":            webError,
		"local":            dbDir,
		"localTotal":       len(localResults),
		"webTotal":         webTotal,
		"hasMore":          webHasMore,
		"databases":        databases,
		"databaseWarnings": databaseWarnings,
		"hot":              hot,
	})
}
