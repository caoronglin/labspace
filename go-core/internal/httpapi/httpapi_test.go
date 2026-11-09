package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"labspace.local/go-core/internal/catalog"
	"labspace.local/go-core/internal/guard"
	"labspace.local/go-core/internal/knowledge"
	"labspace.local/go-core/internal/platform"
	"labspace.local/go-core/internal/policy"
	"labspace.local/go-core/internal/registry"
	"labspace.local/go-core/internal/search"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func TestHTTPPermissions(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	v, _ := guard.New(key)
	p := policy.New()
	for _, r := range []policy.Resource{{Tenant: "lab", ID: "file"}, {Tenant: "lab", ID: "kb"}} {
		if e := p.Register(r); e != nil {
			t.Fatal(e)
		}
	}
	for _, a := range []string{"read", "index", "use_ai"} {
		_ = p.AddRule(policy.Rule{Tenant: "lab", Resource: "kb", SubjectType: "user", Subject: "alice", Action: a, Effect: "allow"})
	}
	app := &Server{Verify: v, KB: &knowledge.Service{Policy: p, Index: knowledge.NewMemoryIndex()}, Registry: registry.New(), Platform: platform.Default()}
	call := func(method, uri, user string, admin bool, body []byte) *httptest.ResponseRecorder {
		nonce := "nonce_" + strconv.FormatInt(time.Now().UnixNano(), 10)
		a := guard.Actor{UserID: user, TenantID: "lab", Admin: admin}
		ts := strconv.FormatInt(time.Now().Unix(), 10)
		req := httptest.NewRequest(method, uri, bytes.NewReader(body))
		req.Header.Set("X-Labgo-User", a.UserID)
		req.Header.Set("X-Labgo-Tenant", a.TenantID)
		ad := "0"
		if admin {
			ad = "1"
		}
		req.Header.Set("X-Labgo-Admin", ad)
		req.Header.Set("X-Labgo-Time", ts)
		req.Header.Set("X-Labgo-Nonce", nonce)
		req.Header.Set("X-Labgo-Signature", guard.Sign(key, method, uri, a, ts, nonce, body))
		w := httptest.NewRecorder()
		app.ServeHTTP(w, req)
		return w
	}
	r := call("POST", "/v1/knowledge/ingest", "alice", false, []byte(`{"resource_id":"kb","text":"maize bzip gene"}`))
	if r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	r = call("GET", "/v1/knowledge/search?q=maize", "alice", false, nil)
	if r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	var result map[string]json.RawMessage
	_ = json.Unmarshal(r.Body.Bytes(), &result)
	if !bytes.Contains(result["hits"], []byte("bzip")) {
		t.Fatal("expected allowed KB hit")
	}
	r = call("GET", "/v1/knowledge/search?q=maize", "bob", false, nil)
	if r.Code != 200 || bytes.Contains(r.Body.Bytes(), []byte("bzip")) {
		t.Fatal("RAG leak", r.Code, r.Body.String())
	}
	r = call("PUT", "/v1/admin/catalog", "alice", false, []byte(`{}`))
	if r.Code != 403 {
		t.Fatal("non-admin mutation", r.Code)
	}
	r = call("GET", "/v1/admin/catalog", "alice", true, nil)
	if r.Code != 200 {
		t.Fatal("admin blocked", r.Code)
	}
	// File bytes are only served through the permission-checked file routes,
	// which stay unavailable while no lab file registry is configured.
	r = call("GET", "/v1/files/f_missing/download", "alice", true, nil)
	if r.Code != 503 {
		t.Fatal("unexpected download route", r.Code)
	}
}
func TestCannotSpoofActor(t *testing.T) {
	v, _ := guard.New([]byte("0123456789abcdef0123456789abcdef"))
	s := &Server{Verify: v}
	req := httptest.NewRequest("GET", "/v1/admin/catalog", nil)
	req.Header.Set("X-Labgo-User", "admin")
	req.Header.Set("X-Labgo-Admin", "1")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	if w.Code != 401 {
		t.Fatal("unsigned actor accepted", w.Code)
	}
}

var _ = context.Background

func TestPlatformManifestAndRouteMap(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	v, _ := guard.New(key)
	app := &Server{Verify: v, Platform: platform.Default()}
	call := func(uri, user string, admin bool) *httptest.ResponseRecorder {
		nonce := "nonce_" + strconv.FormatInt(time.Now().UnixNano(), 10)
		a := guard.Actor{UserID: user, TenantID: "lab", Admin: admin}
		ts := strconv.FormatInt(time.Now().Unix(), 10)
		req := httptest.NewRequest("GET", uri, nil)
		req.Header.Set("X-Labgo-User", a.UserID)
		req.Header.Set("X-Labgo-Tenant", a.TenantID)
		ad := "0"
		if admin {
			ad = "1"
		}
		req.Header.Set("X-Labgo-Admin", ad)
		req.Header.Set("X-Labgo-Time", ts)
		req.Header.Set("X-Labgo-Nonce", nonce)
		req.Header.Set("X-Labgo-Signature", guard.Sign(key, "GET", uri, a, ts, nonce, nil))
		w := httptest.NewRecorder()
		app.ServeHTTP(w, req)
		return w
	}
	user := call("/v1/platform/manifest", "alice", false)
	if user.Code != 200 || bytes.Contains(user.Body.Bytes(), []byte("pi-admin")) {
		t.Fatalf("user manifest: %d %s", user.Code, user.Body.String())
	}
	admin := call("/v1/platform/manifest", "admin", true)
	if admin.Code != 200 || !bytes.Contains(admin.Body.Bytes(), []byte("pi-admin")) {
		t.Fatalf("admin manifest: %d %s", admin.Code, admin.Body.String())
	}
	denied := call("/v1/platform/routes", "alice", false)
	if denied.Code != 403 {
		t.Fatalf("route map should be admin-only: %d", denied.Code)
	}
	allowed := call("/v1/platform/routes", "admin", true)
	if allowed.Code != 200 || !bytes.Contains(allowed.Body.Bytes(), []byte("bioinfo-training")) {
		t.Fatalf("route map missing bioinfo: %d %s", allowed.Code, allowed.Body.String())
	}
}

type testSearchProvider struct{}

func (testSearchProvider) Name() string { return "test" }
func (testSearchProvider) Search(_ context.Context, q string, _ int) ([]search.Result, error) {
	return []search.Result{{Title: q, URL: "https://example.invalid"}}, nil
}

func TestCatalogAndSearchEndpoints(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	v, _ := guard.New(key)
	app := &Server{Verify: v, Catalog: catalog.Default(), Search: &search.Service{Providers: []search.Provider{testSearchProvider{}}}}
	call := func(uri string) *httptest.ResponseRecorder {
		nonce := "nonce_" + strconv.FormatInt(time.Now().UnixNano(), 10)
		a := guard.Actor{UserID: "u", TenantID: "lab"}
		ts := strconv.FormatInt(time.Now().Unix(), 10)
		req := httptest.NewRequest("GET", uri, nil)
		req.Host = "198.51.100.71"
		req.Header.Set("X-Labgo-User", a.UserID)
		req.Header.Set("X-Labgo-Tenant", a.TenantID)
		req.Header.Set("X-Labgo-Admin", "0")
		req.Header.Set("X-Labgo-Time", ts)
		req.Header.Set("X-Labgo-Nonce", nonce)
		req.Header.Set("X-Labgo-Signature", guard.Sign(key, "GET", uri, a, ts, nonce, nil))
		w := httptest.NewRecorder()
		app.ServeHTTP(w, req)
		return w
	}
	c := call("/v1/catalog")
	if c.Code != 200 || !bytes.Contains(c.Body.Bytes(), []byte(`"url":"/genomes"`)) ||
		!bytes.Contains(c.Body.Bytes(), []byte("198.51.100.71:8093")) {
		t.Fatalf("catalog: %d %s", c.Code, c.Body.String())
	}
	s := call("/v1/search?q=maize")
	if s.Code != 200 || !bytes.Contains(s.Body.Bytes(), []byte("maize")) {
		t.Fatalf("search: %d %s", s.Code, s.Body.String())
	}
}
