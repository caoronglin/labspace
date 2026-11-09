package vault

import (
	"bytes"
	"strings"
	"testing"
)

func TestVaultIsolation(t *testing.T) {
	v, e := New(bytes.Repeat([]byte{11}, 32))
	if e != nil {
		t.Fatal(e)
	}
	if e = v.Save("lab", "alice", "SCIVERSE_API_TOKEN", "secret-A"); e != nil {
		t.Fatal(e)
	}
	value, e := v.Get("lab", "alice", "SCIVERSE_API_TOKEN")
	if e != nil || value != "secret-A" {
		t.Fatal(value, e)
	}
	if _, e = v.Get("lab", "bob", "SCIVERSE_API_TOKEN"); e == nil {
		t.Fatal("cross-user access")
	}
	if _, e = v.Get("other", "alice", "SCIVERSE_API_TOKEN"); e == nil {
		t.Fatal("cross-tenant access")
	}
	if e = v.Save("lab", "alice", "name;rm -rf /", "x"); e == nil {
		t.Fatal("invalid key accepted")
	}
	for _, name := range v.Names("lab", "alice") {
		if strings.Contains(name, "secret-A") {
			t.Fatal("secret exposed in list")
		}
	}
	v.Delete("lab", "alice", "SCIVERSE_API_TOKEN")
	if _, e = v.Get("lab", "alice", "SCIVERSE_API_TOKEN"); e == nil {
		t.Fatal("deleted secret returned")
	}
}
