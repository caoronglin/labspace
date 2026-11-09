package main

import (
	"context"
	"encoding/json"
	"fmt"
	"labspace.local/go-core/internal/knowledge"
	"labspace.local/go-core/internal/policy"
)

// A synthetic red-team demonstration: unguarded direct index access versus
// the authorized service. Never run this against real user documents.
func main() {
	ctx := context.Background()
	acl := policy.New()
	_ = acl.Register(policy.Resource{Tenant: "lab", ID: "private"})
	_ = acl.AddRule(policy.Rule{Tenant: "lab", Resource: "private", SubjectType: "user", Subject: "alice", Action: "read", Effect: "allow"})
	_ = acl.AddRule(policy.Rule{Tenant: "lab", Resource: "private", SubjectType: "user", Subject: "alice", Action: "index", Effect: "allow"})
	_ = acl.AddRule(policy.Rule{Tenant: "lab", Resource: "private", SubjectType: "user", Subject: "alice", Action: "use_ai", Effect: "allow"})
	idx := knowledge.NewMemoryIndex()
	s := knowledge.Service{Index: idx, Policy: acl}
	_, err := s.Ingest(ctx, "lab", "alice", "private", "TEST_SYNTHETIC_SECRET_READONLY")
	if err != nil {
		panic(err)
	}
	raw, _ := idx.Candidates(ctx, "lab", "SYNTHETIC_SECRET", 10)
	secured, _ := s.Search(ctx, "lab", "bob", "SYNTHETIC_SECRET", 10)
	owner, _ := s.Search(ctx, "lab", "alice", "SYNTHETIC_SECRET", 10)
	result := map[string]any{"experiment": "synthetic_unprotected_index_ablation", "unguarded_candidates": len(raw), "unauthorized_user_results": len(secured), "authorized_user_results": len(owner), "mitigated": len(raw) > 0 && len(secured) == 0 && len(owner) > 0}
	b, _ := json.MarshalIndent(result, "", "  ")
	fmt.Println(string(b))
}
