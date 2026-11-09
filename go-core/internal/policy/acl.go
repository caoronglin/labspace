// Package policy offers a strict, deny-by-default tenant-scoped ACL reference.
// It is test/reference storage; production uses the transactionally stored
// PostgreSQL permissions with exactly the same interface.
package policy

import (
	"context"
	"errors"
	"sync"
)

type Rule struct {
	Tenant      string `json:"tenant"`
	Resource    string `json:"resource"`
	SubjectType string `json:"subject_type"` // user, group, everyone
	Subject     string `json:"subject"`
	Action      string `json:"action"`
	Effect      string `json:"effect"` // allow or deny
}

type Resource struct{ Tenant, ID, Parent string }
type ACL struct {
	mu        sync.RWMutex
	resources map[string]Resource
	rules     []Rule
	groups    map[string][]string
}

func New() *ACL                    { return &ACL{resources: make(map[string]Resource), groups: make(map[string][]string)} }
func key(tenant, id string) string { return tenant + "\x00" + id }
func (a *ACL) Register(r Resource) error {
	if r.Tenant == "" || r.ID == "" || r.ID == r.Parent {
		return errors.New("invalid resource")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if r.Parent != "" {
		if _, ok := a.resources[key(r.Tenant, r.Parent)]; !ok {
			return errors.New("unknown parent")
		}
	}
	a.resources[key(r.Tenant, r.ID)] = r
	return nil
}
func (a *ACL) SetGroups(tenant, user string, groups []string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.groups[key(tenant, user)] = append([]string(nil), groups...)
}
func (a *ACL) AddRule(r Rule) error {
	if r.Tenant == "" || r.Resource == "" || r.Action == "" || !(r.Effect == "allow" || r.Effect == "deny") {
		return errors.New("invalid ACL rule")
	}
	if r.SubjectType != "everyone" && r.Subject == "" {
		return errors.New("missing subject")
	}
	if r.SubjectType != "everyone" && r.SubjectType != "user" && r.SubjectType != "group" {
		return errors.New("unknown subject type")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, ok := a.resources[key(r.Tenant, r.Resource)]; !ok {
		return errors.New("unknown resource")
	}
	a.rules = append(a.rules, r)
	return nil
}
func (a *ACL) ClearRules(tenant, resource string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	res := a.rules[:0]
	for _, r := range a.rules {
		if r.Tenant != tenant || r.Resource != resource {
			res = append(res, r)
		}
	}
	a.rules = res
}
func (a *ACL) Can(_ context.Context, tenant, user, resource, action string) (bool, error) {
	if tenant == "" || user == "" || resource == "" || action == "" {
		return false, nil
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	if _, ok := a.resources[key(tenant, resource)]; !ok {
		return false, nil
	}
	groups := a.groups[key(tenant, user)]
	// Explicit deny always dominates allow at any ancestor.
	allowed := false
	cur := resource
	visited := make(map[string]bool)
	for cur != "" {
		if visited[cur] {
			return false, errors.New("resource cycle")
		}
		visited[cur] = true
		r, ok := a.resources[key(tenant, cur)]
		if !ok {
			return false, errors.New("missing ancestor")
		}
		for _, rule := range a.rules {
			if rule.Tenant != tenant || rule.Resource != cur || rule.Action != action {
				continue
			}
			matched := rule.SubjectType == "everyone" || (rule.SubjectType == "user" && rule.Subject == user)
			if rule.SubjectType == "group" {
				for _, g := range groups {
					if g == rule.Subject {
						matched = true
						break
					}
				}
			}
			if matched {
				if rule.Effect == "deny" {
					return false, nil
				}
				allowed = true
			}
		}
		cur = r.Parent
	}
	return allowed, nil
}
