// Package registry is an admin-only versioned catalog projection for Pi's
// native model/MCP/skills resources. It is not an alternate model runtime.
package registry

import (
	"errors"
	"sort"
	"strings"
	"sync"
)

type Item struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"` // model, mcp, skill, cli
	Label     string `json:"label"`
	NativeRef string `json:"native_ref"`
	Enabled   bool   `json:"enabled"`
}
type Snapshot struct {
	Revision uint64 `json:"revision"`
	Items    []Item `json:"items"`
}
type Catalog struct {
	mu       sync.RWMutex
	revision uint64
	items    map[string]Item
}

func New() *Catalog { return &Catalog{items: map[string]Item{}} }
func (c *Catalog) Snapshot() Snapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	items := []Item{}
	for _, x := range c.items {
		items = append(items, x)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Kind+":"+items[i].ID < items[j].Kind+":"+items[j].ID })
	return Snapshot{Revision: c.revision, Items: items}
}
func (c *Catalog) Upsert(isAdmin bool, expected uint64, item Item) (Snapshot, error) {
	if !isAdmin {
		return Snapshot{}, errors.New("admin required")
	}
	if item.ID == "" || strings.ContainsAny(item.ID, "/\\\x00") || len(item.ID) > 96 || item.Label == "" || item.NativeRef == "" {
		return Snapshot{}, errors.New("invalid catalog item")
	}
	switch item.Kind {
	case "model", "mcp", "skill", "cli":
	default:
		return Snapshot{}, errors.New("invalid item kind")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.revision != expected {
		return Snapshot{}, errors.New("catalog revision conflict")
	}
	c.items[item.Kind+":"+item.ID] = item
	c.revision++
	items := make([]Item, 0, len(c.items))
	for _, x := range c.items {
		items = append(items, x)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Kind+":"+items[i].ID < items[j].Kind+":"+items[j].ID })
	return Snapshot{Revision: c.revision, Items: items}, nil
}
