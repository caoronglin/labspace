package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"labspace.local/go-core/internal/catalog"
	"labspace.local/go-core/internal/endpoints"
	"labspace.local/go-core/internal/health"
)

func newServiceServer() *Server {
	return &Server{
		Catalog:   catalog.Default(),
		Health:    health.New(time.Second),
		Endpoints: endpoints.Map{"docling": "172.28.0.5"},
	}
}

func TestServicesArePublicAndListTheLiveCatalog(t *testing.T) {
	s := newServiceServer()
	req := httptest.NewRequest(http.MethodGet, "/v1/services", nil)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
	var doc struct {
		Services []struct {
			ID   string `json:"id"`
			URL  string `json:"url"`
			Icon string `json:"icon"`
		} `json:"services"`
		Count int `json:"count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Count != len(doc.Services) {
		t.Fatalf("count %d does not match %d entries", doc.Count, len(doc.Services))
	}
	// Anonymous callers must not see role gated services.
	for _, it := range doc.Services {
		if it.ID == "terminal" {
			t.Fatal("terminal leaked to anonymous caller")
		}
		if it.URL == "" || it.Icon == "" {
			t.Fatalf("incomplete service entry %q", it.ID)
		}
	}
}

func TestServiceHealthEndpointReportsUnknownService(t *testing.T) {
	s := newServiceServer()
	req := httptest.NewRequest(http.MethodGet, "/v1/services/nope/health", nil)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != 404 {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestServiceHealthEndpointResolvesContainerPlaceholder(t *testing.T) {
	s := newServiceServer()
	it, ok := s.Catalog.Find("docling")
	if !ok {
		t.Fatal("docling missing from catalog")
	}
	target := health.Target{
		URL:  s.Endpoints.Resolve(it.Health.URL),
		Kind: health.Kind(it.Health.Kind),
	}
	if target.URL != "http://172.28.0.5:5001/health" {
		t.Fatalf("placeholder not resolved: %s", target.URL)
	}
}

func TestBulkHealthKeepsServiceShape(t *testing.T) {
	s := newServiceServer()
	req := httptest.NewRequest(http.MethodGet, "/v1/services/health", nil)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
	var doc struct {
		Services []map[string]any `json:"services"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Services) == 0 {
		t.Fatal("no services returned")
	}
	entry := doc.Services[0]
	for _, key := range []string{"id", "name", "url", "icon", "health"} {
		if _, ok := entry[key]; !ok {
			t.Fatalf("missing key %q in health entry", key)
		}
	}
	healthEntry, _ := entry["health"].(map[string]any)
	if _, ok := healthEntry["status"]; !ok {
		t.Fatal("health entry without status")
	}
}
