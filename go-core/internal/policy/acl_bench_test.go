package policy

import (
	"context"
	"testing"
)

func BenchmarkACL(b *testing.B) {
	p := New()
	_ = p.Register(Resource{Tenant: "lab", ID: "folder"})
	_ = p.Register(Resource{Tenant: "lab", ID: "seq", Parent: "folder"})
	_ = p.AddRule(Rule{Tenant: "lab", Resource: "folder", SubjectType: "user", Subject: "alice", Action: "preview", Effect: "allow"})
	ctx := context.Background()
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		if ok, _ := p.Can(ctx, "lab", "alice", "seq", "preview"); !ok {
			b.Fatal("no permission")
		}
	}
}
