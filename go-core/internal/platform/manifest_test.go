package platform

import "testing"

func TestDefaultManifestCoversOriginalD509Domains(t *testing.T) {
	r := Default()
	if err := r.Validate(); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, f := range r.All() {
		seen[f.ID] = true
	}
	required := []string{"identity-casdoor", "service-catalog", "sso", "global-search", "plant-databases", "literature", "research-api-mcp", "linux-commands", "favorites-recent", "drawings", "announcements", "workbench", "pi-agent", "files-acl", "file-preview", "download-center", "knowledge-rag", "image-generation", "lab-translate", "snapotter-tools", "bioinfo-training", "bioinfo-terminal", "jbrowse", "blast", "drawio", "searxng", "document-parsers", "backup-health", "wecom-selective"}
	for _, id := range required {
		if !seen[id] {
			t.Fatalf("missing feature %s", id)
		}
	}
}
func TestAdminOnlyFeaturesHiddenFromUsers(t *testing.T) {
	r := Default()
	for _, f := range r.ForActor(false) {
		if f.AdminOnly {
			t.Fatalf("admin feature leaked: %s", f.ID)
		}
	}
	found := false
	for _, f := range r.ForActor(true) {
		if f.ID == "pi-admin" {
			found = true
		}
	}
	if !found {
		t.Fatal("admin catalog missing")
	}
}
