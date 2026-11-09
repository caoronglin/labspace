package catalog

import (
	"encoding/json"
	"testing"
)

func TestHostAdaptationPreservesServicePort(t *testing.T) {
	s := Default()
	items := s.Catalog("198.51.100.71", false)
	var found bool
	for _, it := range items {
		if it.ID == "drawing-board" {
			found = true
			if it.URL != "http://198.51.100.71:8093/" {
				t.Fatalf("unexpected URL %s", it.URL)
			}
		}
	}
	if !found {
		t.Fatal("drawing-board missing")
	}
}

func TestAdminOnlyCatalogHidden(t *testing.T) {
	s := Default()
	for _, it := range s.Catalog("192.0.2.10", false) {
		if it.ID == "admin" {
			t.Fatal("admin service leaked")
		}
	}
}

func TestRelativeURLsStayRelative(t *testing.T) {
	if got := adaptHost("/files/", "198.51.100.71"); got != "/files/" {
		t.Fatal(got)
	}
}

// liveServiceIDs mirrors the services the deployed portal exposes through
// GET /api/services (verified on 2026-11-03 against 127.0.0.1:8088).
// The Go catalog must cover every one of them, otherwise the Go core would
// hide a service that students can actually open.
var liveServiceIDs = []string{
	"drawio", "linux-command",
	"literature-search", "docling", "searxng", "drawing-board", "jbrowse", "snapotter",
	"bioinfo-training",
}

func TestCatalogCoversEveryLiveService(t *testing.T) {
	s := Default()
	have := map[string]bool{}
	for _, it := range s.Catalog("192.0.2.10", true) {
		have[it.ID] = true
	}
	for _, id := range liveServiceIDs {
		if !have[id] {
			t.Fatalf("live service %q is not covered by the Go catalog", id)
		}
	}
}

func TestCatalogURLsAreUniquePerService(t *testing.T) {
	s := Default()
	seen := map[string]string{}
	for _, it := range s.Catalog("192.0.2.10", true) {
		if prev, dup := seen[it.URL]; dup {
			t.Fatalf("duplicate catalog URL %q used by %q and %q", it.URL, prev, it.ID)
		}
		seen[it.URL] = it.ID
	}
}

func TestHostAdaptationRejectsUntrustedNonIPHost(t *testing.T) {
	if got := adaptHost("http://192.0.2.10:8091/", "attacker.example"); got != "http://192.0.2.10:8091/" {
		t.Fatalf("untrusted host was applied: %s", got)
	}
}

// TestLiveListMatchesPortalContract keeps the Go catalog compatible with the
// Python route it replaces (10 services after devtools retired and bioinfo hubs merged;
// role gated entries hidden).
func TestLiveListMatchesPortalContract(t *testing.T) {
	s := Default()
	student := s.Live("192.0.2.10", []string{"lab-student", "bioinfo-student"})
	if len(student) != 10 {
		t.Fatalf("student service count = %d, want 10", len(student))
	}
	teacher := s.Live("192.0.2.10", []string{"lab-teacher"})
	if len(teacher) != 10 {
		t.Fatalf("teacher service count = %d, want 10", len(teacher))
	}
}

// TestLiveListAdaptsHostEverywhere guards the "enter from any IP" behaviour:
// every URL field has to follow the request host.
func TestLiveListAdaptsHostEverywhere(t *testing.T) {
	s := Default()
	for _, it := range s.Live("198.51.100.71", []string{"lab-admin"}) {
		for _, v := range []string{it.URL, it.EmbedURL, it.SSOURL} {
			if v == "" {
				continue
			}
			if contains(v, "http://192.0.2.10") {
				t.Fatalf("service %q still points at the LAN address: %s", it.ID, v)
			}
		}
	}
}

// TestExportIsValidJSON keeps the shared catalog document consumable.
func TestExportIsValidJSON(t *testing.T) {
	data, err := Export(Default())
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Version  int `json:"version"`
		Services []struct {
			ID string `json:"id"`
		} `json:"services"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Version != 2 {
		t.Fatalf("unexpected export version %d", doc.Version)
	}
	if len(doc.Services) != 10 {
		t.Fatalf("exported %d services, want 10", len(doc.Services))
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (haystack == needle || indexOf(haystack, needle) >= 0)
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
