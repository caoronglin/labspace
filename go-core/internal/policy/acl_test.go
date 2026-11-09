package policy

import (
	"context"
	"testing"
)

func TestACL(t *testing.T) {
	ctx := context.Background()
	a := New()
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(a.Register(Resource{Tenant: "lab", ID: "root"}))
	must(a.Register(Resource{Tenant: "lab", ID: "file", Parent: "root"}))
	must(a.Register(Resource{Tenant: "other", ID: "root"}))
	must(a.AddRule(Rule{Tenant: "lab", Resource: "root", SubjectType: "group", Subject: "visitors", Action: "preview", Effect: "allow"}))
	a.SetGroups("lab", "u", []string{"visitors"})
	ok, _ := a.Can(ctx, "lab", "u", "file", "preview")
	if !ok {
		t.Fatal("expected inherited preview")
	}
	for _, act := range []string{"download", "read", "write"} {
		ok, _ = a.Can(ctx, "lab", "u", "file", act)
		if ok {
			t.Fatal("unexpected", act)
		}
	}
	ok, _ = a.Can(ctx, "other", "u", "root", "preview")
	if ok {
		t.Fatal("cross tenant")
	}
	must(a.AddRule(Rule{Tenant: "lab", Resource: "file", SubjectType: "user", Subject: "u", Action: "preview", Effect: "deny"}))
	ok, _ = a.Can(ctx, "lab", "u", "file", "preview")
	if ok {
		t.Fatal("deny must win")
	}
	a.ClearRules("lab", "file")
	ok, _ = a.Can(ctx, "lab", "u", "file", "preview")
	if !ok {
		t.Fatal("should regain preview")
	}
}
