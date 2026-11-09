package endpoints

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveReplacesPlaceholders(t *testing.T) {
	m := Map{"docling": "172.28.0.5", "research-api": "172.28.0.6"}
	got := m.Resolve("http://${research-api}:8000/health")
	if got != "http://172.28.0.6:8000/health" {
		t.Fatalf("unexpected %s", got)
	}
}

func TestResolveKeepsUnknownPlaceholder(t *testing.T) {
	m := Map{"docling": "172.28.0.5"}
	got := m.Resolve("http://${missing}:5000/health")
	if got != "http://${missing}:5000/health" {
		t.Fatalf("unexpected %s", got)
	}
}

func TestLoadMissingFileIsEmpty(t *testing.T) {
	m, err := Load(filepath.Join(t.TempDir(), "absent.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(m) != 0 {
		t.Fatalf("expected empty map, got %v", m)
	}
}

func TestLoadReadsDocument(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "endpoints.json")
	if err := os.WriteFile(path, []byte(`{"docling":"172.28.0.5"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	m, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if m["docling"] != "172.28.0.5" {
		t.Fatalf("unexpected map %v", m)
	}
}
