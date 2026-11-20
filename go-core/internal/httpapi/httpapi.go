// Package httpapi exposes a signed internal API. It is an incremental bridge
// behind an existing Casdoor/CSRF gateway, not a public authentication server.
package httpapi

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"labspace.local/go-core/internal/catalog"
	"labspace.local/go-core/internal/colorlab"
	"labspace.local/go-core/internal/corpus"
	"labspace.local/go-core/internal/dbapis"
	"labspace.local/go-core/internal/embed"
	"labspace.local/go-core/internal/endpoints"
	"labspace.local/go-core/internal/fileaudit"
	"labspace.local/go-core/internal/guard"
	"labspace.local/go-core/internal/health"
	"labspace.local/go-core/internal/imagegen"
	"labspace.local/go-core/internal/integrationmap"
	"labspace.local/go-core/internal/knowledge"
	"labspace.local/go-core/internal/labfiles"
	"labspace.local/go-core/internal/lifedb"
	"labspace.local/go-core/internal/platform"
	"labspace.local/go-core/internal/plot"
	"labspace.local/go-core/internal/portal"
	"labspace.local/go-core/internal/registry"
	"labspace.local/go-core/internal/search"
	"labspace.local/go-core/internal/session"
	"labspace.local/go-core/internal/snapotter"
	"labspace.local/go-core/internal/vault"
	"labspace.local/go-core/internal/websearch"
	"labspace.local/go-core/internal/workbench"
)

type Server struct {
	// Verify authenticates trusted service-to-service calls (HMAC signature).
	Verify *guard.Verifier
	// Session authenticates browser calls with the portal session cookie.
	Session *session.Verifier
	KB      *knowledge.Service
	Images  *imagegen.Service
	// Files is the live lab file registry (the /srv/lab tree).
	Files *labfiles.Registry
	// FileAudit records preview/download activity for the admin panel.
	FileAudit *fileaudit.Store
	LifeDB    *lifedb.Searcher
	// Registry is the mutable service catalog used by the admin API.
	Registry *registry.Catalog
	Platform *platform.Registry
	Catalog  *catalog.Service
	Search   *search.Service
	Vault    *vault.Vault
	// Health probes live services and caches results for a short TTL.
	Health *health.Prober
	// Embed inspects X-Frame-Options / CSP frame-ancestors of third-party services.
	Embed *embed.Prober
	// Corpus is the portal-wide searchable index (command palette, global search).
	Corpus *corpus.Index
	// WebSearch queries the internal SearXNG instance.
	WebSearch *websearch.Client
	// Colors is the scientific palette database (Go rewrite of lcpmgh/colors).
	Colors *colorlab.Service
	// DBAPIs serves the 32 research database adapters (specs.go data driven).
	DBAPIs *dbapis.Handler
	// SnapOtter proxies the SnapOtter REST API (API key stays server side).
	SnapOtter *snapotter.Handler
	// Workbench serves the 16 personal-workbench endpoints (PostgreSQL via pgwire).
	Workbench *workbench.Handler
	// Plot renders publication charts through the allow-listed Python worker.
	Plot *plot.Handler
	// Portal serves per-user favorites and recent visits (PostgreSQL via pgwire).
	Portal *portal.Handler
	// ServiceToken accepts the internal service token (read-only public data).
	ServiceToken string
	// BackendBase is the portal backend origin, used for per-user merges that
	// only the backend can decide (knowledge entry visibility).
	BackendBase string
	// Endpoints resolves container placeholders inside probe URLs.
	Endpoints endpoints.Map
}

func jsonResponse(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func deny(w http.ResponseWriter, code int, reason string) {
	jsonResponse(w, code, map[string]string{"error": reason})
}

// actor is the authenticated caller of one request.
type actor struct {
	UserID   string
	TenantID string
	Email    string
	Roles    []string
	Admin    bool
	Teacher  bool
}

// authError carries the HTTP status for a failed authentication step.
type authError struct {
	code   int
	reason string
}

func (e *authError) Error() string { return e.reason }

// authenticate accepts either a trusted service signature (HMAC) or a portal
// session cookie (HS256 JWT) plus the double-submit CSRF rule.
func (s *Server) authenticate(r *http.Request, body []byte) (actor, *authError) {
	// An explicit user bearer wins over the shared service token: agent calls
	// carry both headers, and user-scoped routes (plot/workbench) must run as
	// the caller instead of the generic "service" actor.
	if h := r.Header.Get("Authorization"); len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		if s.Session == nil {
			return actor{}, &authError{code: 503, reason: "internal security dependencies unavailable"}
		}
		a, err := s.Session.FromRequest(r)
		if err != nil {
			return actor{}, &authError{code: 401, reason: "unauthenticated"}
		}
		if err := s.Session.CheckCSRF(r); err != nil {
			return actor{}, &authError{code: 403, reason: "csrf verification failed"}
		}
		return actor{UserID: a.UserID, TenantID: a.Tenant, Email: a.Email, Roles: a.Roles, Admin: a.Admin, Teacher: a.Teacher}, nil
	}
	if r.Header.Get("X-Labgo-Signature") != "" {
		if s.Verify == nil {
			return actor{}, &authError{code: 503, reason: "internal security dependencies unavailable"}
		}
		a, err := s.Verify.Check(r, body)
		if err != nil {
			return actor{}, &authError{code: 401, reason: "unauthenticated"}
		}
		return actor{UserID: a.UserID, TenantID: a.TenantID, Admin: a.Admin}, nil
	}
	// The internal service token represents the portal's own trusted read-only
	// calls (pi plugins), exactly like the Python route it replaces.
	if tok := strings.TrimSpace(r.Header.Get("X-Lab-Service-Token")); tok != "" && s.ServiceToken != "" {
		if subtle.ConstantTimeCompare([]byte(tok), []byte(s.ServiceToken)) == 1 {
			return actor{UserID: "service", TenantID: "lab", Email: "", Roles: []string{"service"}}, nil
		}
		return actor{}, &authError{code: 401, reason: "unauthenticated"}
	}
	if s.Session == nil {
		// No session verifier configured: fail closed without leaking configuration.
		return actor{}, &authError{code: 401, reason: "unauthenticated"}
	}
	a, err := s.Session.FromRequest(r)
	if err != nil {
		return actor{}, &authError{code: 401, reason: "unauthenticated"}
	}
	if err := s.Session.CheckCSRF(r); err != nil {
		return actor{}, &authError{code: 403, reason: "csrf verification failed"}
	}
	return actor{UserID: a.UserID, TenantID: a.Tenant, Email: a.Email, Roles: a.Roles, Admin: a.Admin, Teacher: a.Teacher}, nil
}

func (a actor) fileIdentity() labfiles.Identity {
	return labfiles.Identity{UserID: a.UserID, Email: a.Email, Roles: a.Roles, Admin: a.Admin, Teacher: a.Teacher}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/healthz" && r.Method == "GET" {
		jsonResponse(w, 200, map[string]string{"status": "alive"})
		return
	}
	// Multipart uploads (SnapOtter /run) can be up to 200MB; guard.ReadBounded
	// is for the small JSON/HMAC-signed control plane. For the upload route the
	// raw body is streamed to the upstream service and the handler enforces its
	// own limit, while session + CSRF authentication below is still applied.
	var b []byte
	streamingUpload := (strings.HasPrefix(r.URL.Path, "/v1/snapotter/run") ||
		strings.HasPrefix(r.URL.Path, "/v1/files/upload")) && r.Method == http.MethodPost
	if !streamingUpload {
		var err error
		b, err = guard.ReadBounded(r)
		if err != nil {
			deny(w, 413, "request too large")
			return
		}
		// guard.ReadBounded consumes r.Body for HMAC verification. Downstream
		// handlers still expect to read the JSON body from the request, so put
		// the buffered bytes back. For streaming uploads the original body is
		// left untouched (and b stays nil).
		r.Body = io.NopCloser(bytes.NewReader(b))
	}
	// The service catalog is public: role gated entries stay hidden for
	// callers without a session, exactly like the Python route it replaces.
	if strings.HasPrefix(r.URL.Path, "/v1/services") {
		s.serveServices(w, r, r.URL.Query())
		return
	}
	actor, aerr := s.authenticate(r, b)
	if aerr != nil {
		deny(w, aerr.code, aerr.reason)
		return
	}
	ctx := r.Context()
	q := r.URL.Query()
	if strings.HasPrefix(r.URL.Path, "/v1/colors") {
		s.serveColors(w, r, b, q)
		return
	}
	if r.URL.Path == "/v1/admin/provision" ||
		r.URL.Path == "/v1/admin/deprovision" ||
		r.URL.Path == "/v1/admin/file-access" ||
		r.URL.Path == "/v1/admin/file-access-preview" ||
		r.URL.Path == "/v1/admin/file-groups" ||
		strings.HasPrefix(r.URL.Path, "/v1/admin/file-access/") ||
		strings.HasPrefix(r.URL.Path, "/v1/admin/file-groups/") ||
		strings.HasPrefix(r.URL.Path, "/v1/admin/personal-access/") {
		s.serveAdmin(w, r, actor)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v1/files") {
		s.serveFiles(w, r, actor, q)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v1/workbench") {
		// The workbench is per-user state: the internal service token has no
		// owner, so it must never reach these routes even when the handler is
		// wired — refuse before touching storage (aligns with the Python route).
		if actor.UserID == "" || actor.UserID == "service" {
			deny(w, 403, "workbench requires a user identity")
			return
		}
		if s.Workbench == nil {
			deny(w, 503, "workbench backend unavailable")
			return
		}
		s.Workbench.Serve(w, r, actor.UserID)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v1/plot") {
		// Plot jobs are per-user state, same rule as the workbench.
		if actor.UserID == "" || actor.UserID == "service" {
			deny(w, 403, "plot jobs require a user identity")
			return
		}
		if s.Plot == nil {
			deny(w, 503, "plot backend unavailable")
			return
		}
		s.Plot.Serve(w, r, actor.UserID)
		return
	}
	if r.URL.Path == "/v1/favorites" || strings.HasPrefix(r.URL.Path, "/v1/favorites/") ||
		r.URL.Path == "/v1/recent" || strings.HasPrefix(r.URL.Path, "/v1/recent/") {
		// Favorites/recent are per-user state, so the owner-less service token
		// must be refused just like the workbench routes.
		if actor.UserID == "" || actor.UserID == "service" {
			deny(w, 403, "favorites/recent require a user identity")
			return
		}
		if s.Portal == nil {
			deny(w, 503, "portal storage unavailable")
			return
		}
		s.Portal.Serve(w, r, actor.UserID)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v1/snapotter") {
		if s.SnapOtter == nil {
			deny(w, 503, "snapotter backend unavailable")
			return
		}
		s.SnapOtter.Serve(w, r, actor.UserID)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v1/databases") {
		if s.DBAPIs == nil {
			deny(w, 503, "database API backend unavailable")
			return
		}
		s.DBAPIs.Serve(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v1/corpus") {
		s.serveCorpus(w, r, q)
		return
	}
	if r.URL.Path == "/v1/portal/search" && r.Method == "GET" {
		s.servePortalSearch(w, r, actor, q)
		return
	}
	if r.URL.Path == "/v1/portal/search/categories" && r.Method == "GET" {
		categories := []corpus.Category{}
		if s.Corpus != nil {
			categories = s.Corpus.Categories()
		}
		jsonResponse(w, 200, map[string]any{"categories": categories, "default": "general"})
		return
	}
	switch {
	case r.URL.Path == "/v1/catalog" && r.Method == "GET":
		if s.Catalog == nil {
			deny(w, 503, "catalog unavailable")
			return
		}
		jsonResponse(w, 200, map[string]any{"items": s.Catalog.Catalog(r.Host, actor.Admin)})
	case r.URL.Path == "/v1/search" && r.Method == "GET":
		if s.Search == nil {
			deny(w, 503, "search providers unavailable")
			return
		}
		rows, warnings, e := s.Search.Search(ctx, q.Get("q"))
		if e != nil {
			deny(w, 400, "invalid search query")
			return
		}
		jsonResponse(w, 200, map[string]any{"results": rows, "warnings": warnings})
	case r.URL.Path == "/v1/platform/manifest" && r.Method == "GET":
		if s.Platform == nil {
			deny(w, 503, "platform manifest unavailable")
			return
		}
		jsonResponse(w, 200, map[string]any{"modules": s.Platform.ForActor(actor.Admin)})
	case r.URL.Path == "/v1/platform/routes" && r.Method == "GET":
		if !actor.Admin {
			deny(w, 403, "admin required")
			return
		}
		jsonResponse(w, 200, map[string]any{"routes": integrationmap.All()})
	case r.URL.Path == "/v1/knowledge/ingest" && r.Method == "POST":
		if s.KB == nil {
			deny(w, 503, "knowledge backend unavailable")
			return
		}
		var item struct {
			ResourceID string `json:"resource_id"`
			Text       string `json:"text"`
		}
		if json.Unmarshal(b, &item) != nil {
			deny(w, 400, "invalid JSON")
			return
		}
		n, e := s.KB.Ingest(ctx, actor.TenantID, actor.UserID, item.ResourceID, item.Text)
		if e != nil {
			deny(w, 403, "ingest rejected")
			return
		}
		jsonResponse(w, 200, map[string]int{"chunks": n})
	case r.URL.Path == "/v1/knowledge/search" && r.Method == "GET":
		if s.KB == nil {
			deny(w, 503, "knowledge backend unavailable")
			return
		}
		limit := 10
		if q.Has("limit") {
			if n, err := strconv.Atoi(q.Get("limit")); err != nil {
				deny(w, 400, "invalid limit")
				return
			} else {
				limit = n
			}
		}
		hits, e := s.KB.Search(ctx, actor.TenantID, actor.UserID, q.Get("q"), limit)
		if e != nil {
			deny(w, 400, "search rejected")
			return
		}
		jsonResponse(w, 200, map[string]any{"hits": hits})
	case r.URL.Path == "/v1/images/generate" && r.Method == "POST":
		if s.Images == nil {
			deny(w, 503, "image provider not configured")
			return
		}
		var item struct {
			FolderID       string `json:"folder_id"`
			Prompt         string `json:"prompt"`
			Model          string `json:"model"`
			Provider       string `json:"provider"`
			IdempotencyKey string `json:"idempotency_key"`
		}
		if json.Unmarshal(b, &item) != nil {
			deny(w, 400, "invalid JSON")
			return
		}
		receipt, e := s.Images.Generate(ctx, imagegen.Request{TenantID: actor.TenantID, UserID: actor.UserID, FolderID: item.FolderID, Prompt: item.Prompt, Model: item.Model, Provider: item.Provider, IdempotencyKey: item.IdempotencyKey})
		if e != nil {
			deny(w, 403, "generation rejected")
			return
		}
		jsonResponse(w, 200, receipt)
	case r.URL.Path == "/v1/admin/catalog" && r.Method == "GET":
		if !actor.Admin {
			deny(w, 403, "admin required")
			return
		}
		if s.Registry == nil {
			deny(w, 503, "catalog unavailable")
			return
		}
		jsonResponse(w, 200, s.Registry.Snapshot())
	case r.URL.Path == "/v1/admin/catalog" && r.Method == "PUT":
		if !actor.Admin {
			deny(w, 403, "admin required")
			return
		}
		if s.Registry == nil {
			deny(w, 503, "catalog unavailable")
			return
		}
		var payload struct {
			ExpectedRevision uint64        `json:"expected_revision"`
			Item             registry.Item `json:"item"`
		}
		if json.Unmarshal(b, &payload) != nil {
			deny(w, 400, "invalid JSON")
			return
		}
		result, e := s.Registry.Upsert(true, payload.ExpectedRevision, payload.Item)
		if e != nil {
			deny(w, 409, "invalid catalog update/revision conflict")
			return
		}
		jsonResponse(w, 200, result)
	case r.URL.Path == "/v1/secrets" && r.Method == "POST":
		if s.Vault == nil {
			deny(w, 503, "personal vault not configured")
			return
		}
		var item struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		}
		if json.Unmarshal(b, &item) != nil {
			deny(w, 400, "invalid JSON")
			return
		}
		if e := s.Vault.Save(actor.TenantID, actor.UserID, item.Name, item.Value); e != nil {
			deny(w, 400, "invalid secret name or value")
			return
		}
		jsonResponse(w, 200, map[string]bool{"ok": true})
	case r.URL.Path == "/v1/secrets" && r.Method == "DELETE":
		if s.Vault == nil {
			deny(w, 503, "personal vault not configured")
			return
		}
		var item struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(b, &item) != nil || item.Name == "" {
			deny(w, 400, "invalid JSON")
			return
		}
		s.Vault.Delete(actor.TenantID, actor.UserID, item.Name)
		jsonResponse(w, 200, map[string]bool{"ok": true})
	case r.URL.Path == "/v1/secrets" && r.Method == "GET":
		if s.Vault == nil {
			deny(w, 503, "personal vault not configured")
			return
		}
		jsonResponse(w, 200, map[string]any{"names": s.Vault.Names(actor.TenantID, actor.UserID)})
	default:
		deny(w, 404, "route not found")
	}
}

// SignRequestForDocs is only a type assertion guard for the API contract; the
// signing implementation belongs to guard.Sign and the trusted gateway.
var _ = bytes.NewReader
var _ = strings.TrimSpace
var _ = fmt.Sprint
