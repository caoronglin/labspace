package registry

import "testing"

func TestAdminAndVersion(t *testing.T) {
	c := New()
	m := Item{Kind: "model", ID: "m", Label: "Model", NativeRef: "pi:provider/model", Enabled: true}
	if _, err := c.Upsert(false, 0, m); err == nil {
		t.Fatal("non-admin mutate")
	}
	s, e := c.Upsert(true, 0, m)
	if e != nil || s.Revision != 1 {
		t.Fatal(s, e)
	}
	if _, e = c.Upsert(true, 0, m); e == nil {
		t.Fatal("revision mismatch")
	}
	if got := c.Snapshot(); len(got.Items) != 1 || got.Items[0].NativeRef != "pi:provider/model" {
		t.Fatal(got)
	}
}
