// Package cli provides bounded, manifest-driven CLI invocation policy. The
// sandbox implementation is injected by the deployment; no shell is exposed.
package cli

import (
	"context"
	"errors"
	"strings"
)

type Capability struct {
	ID          string
	Binary      string   // immutable admin-installed absolute binary path
	Args        []string // fixed syntax, never from model generated arbitrary args
	Write       bool
	PersonalEnv []string
}
type Runner interface {
	Run(context.Context, string, []string, map[string]string, string) ([]byte, error)
}
type Secrets interface {
	Get(tenant, user, name string) (string, error)
}
type ACL interface {
	Can(context.Context, string, string, string, string) (bool, error)
}
type Service struct {
	Allowed map[string]Capability
	Runner  Runner
	Secrets Secrets
	Policy  ACL
}

func (s *Service) Call(ctx context.Context, tenant, user, capID, resource string, confirmed bool) ([]byte, error) {
	cap, ok := s.Allowed[capID]
	if !ok || cap.ID != capID {
		return nil, errors.New("CLI capability not registered")
	}
	if cap.Binary == "" || !strings.HasPrefix(cap.Binary, "/") || strings.Contains(cap.Binary, "..") || len(cap.Args) > 12 {
		return nil, errors.New("untrusted CLI binary/arguments")
	}
	if cap.Write && !confirmed {
		return nil, errors.New("explicit confirmation required")
	}
	action := "use_ai"
	if cap.Write {
		action = "send_external"
	}
	allowed, err := s.Policy.Can(ctx, tenant, user, resource, action)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, errors.New("permission denied")
	}
	env := map[string]string{}
	for _, name := range cap.PersonalEnv {
		secret, e := s.Secrets.Get(tenant, user, name)
		if e != nil {
			return nil, e
		}
		env[name] = secret
	}
	// Runner must use an isolated UID+HOME/network sandbox and a sanitized env,
	// and must never print credentials into a response.
	if s.Runner == nil {
		return nil, errors.New("sandbox runner is not installed")
	}
	return s.Runner.Run(ctx, cap.Binary, append([]string{}, cap.Args...), env, user)
}
