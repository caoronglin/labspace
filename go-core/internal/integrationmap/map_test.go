package integrationmap

import "testing"

func TestAllOriginalSubsystemsMapped(t *testing.T) {
	ids := map[string]bool{}
	for _, b := range All() {
		ids[b.ID] = true
	}
	for _, id := range []string{"portal-auth", "portal-catalog", "portal-search", "plant-db", "literature", "personal-workbench", "agent", "files", "knowledge", "translation", "image-tools", "bioinfo", "terminal", "genome", "drawio", "downloads", "wecom", "ops"} {
		if !ids[id] {
			t.Fatalf("missing %s", id)
		}
	}
}
