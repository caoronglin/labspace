package knowledge

import (
	"context"
	"testing"
)

type rule struct{ deny map[string]bool }

func (p *rule) Can(_ context.Context, t, u, r, a string) (bool, error) {
	return t == "lab" && u == "u" && r == "a" && !p.deny[a], nil
}
func TestIngestAndRevocation(t *testing.T) {
	ctx := context.Background()
	p := &rule{deny: map[string]bool{}}
	s := Service{Index: NewMemoryIndex(), Policy: p}
	n, e := s.Ingest(ctx, "lab", "u", "a", "gene maize bzip")
	if e != nil || n != 1 {
		t.Fatal(n, e)
	}
	hits, e := s.Search(ctx, "lab", "u", "maize", 10)
	if e != nil || len(hits) != 1 {
		t.Fatal(hits, e)
	}
	p.deny["read"] = true
	hits, e = s.Search(ctx, "lab", "u", "maize", 10)
	if e != nil || len(hits) != 0 {
		t.Fatal("revoked result leaked")
	}
	_, e = s.Ingest(ctx, "other", "u", "a", "secret")
	if e == nil {
		t.Fatal("cross-tenant ingest accepted")
	}
}
