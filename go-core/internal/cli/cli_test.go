package cli

import (
	"context"
	"errors"
	"testing"
)

type runner struct {
	calls int
	env   map[string]string
	user  string
}

func (r *runner) Run(_ context.Context, _ string, _ []string, e map[string]string, u string) ([]byte, error) {
	r.calls++
	r.env = e
	r.user = u
	return []byte(`{"ok":true}`), nil
}

type secrets struct{}

func (secrets) Get(t, u, n string) (string, error) {
	if t == "lab" && u == "alice" && n == "SCIVERSE_API_TOKEN" {
		return "alice-token", nil
	}
	return "", errors.New("no credential")
}

type acl struct{}

func (acl) Can(_ context.Context, t, u, r, a string) (bool, error) {
	return t == "lab" && u == "alice" && r == "item" && (a == "use_ai" || a == "send_external"), nil
}
func TestCLI(t *testing.T) {
	r := &runner{}
	s := Service{Runner: r, Secrets: secrets{}, Policy: acl{}, Allowed: map[string]Capability{"sciverse.read": {ID: "sciverse.read", Binary: "/usr/local/bin/sciverse", Args: []string{"--version"}, PersonalEnv: []string{"SCIVERSE_API_TOKEN"}}, "zhihu.write": {ID: "zhihu.write", Binary: "/opt/cli/zhihu-cli", Args: []string{"--version"}, Write: true}}}
	if _, e := s.Call(context.Background(), "lab", "alice", "anything", "item", true); e == nil {
		t.Fatal("arbitrary CLI allowed")
	}
	if _, e := s.Call(context.Background(), "lab", "alice", "zhihu.write", "item", false); e == nil {
		t.Fatal("write without confirmation")
	}
	if _, e := s.Call(context.Background(), "lab", "bob", "sciverse.read", "item", true); e == nil {
		t.Fatal("cross-user")
	}
	if _, e := s.Call(context.Background(), "lab", "alice", "sciverse.read", "item", false); e != nil {
		t.Fatal(e)
	}
	if r.calls != 1 || r.env["SCIVERSE_API_TOKEN"] != "alice-token" || r.user != "alice" {
		t.Fatal("missing isolated personal credential")
	}
}
