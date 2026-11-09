// Package dbapis is the Go port of backend/app/db_apis.py: 32 research
// database API adapters. The catalogue (endpoints, hints, NO_API reasons) is
// data, so it lives in specs.json and is embedded with go:embed — no external
// YAML/JSON library is needed and the metadata stays byte-for-byte identical
// to the Python source of truth.
package dbapis

import (
	_ "embed"
	"encoding/json"
	"sort"
	"strings"
)

//go:embed specs.json
var specsRaw []byte

// Field is one normalized result field (label + source key in the upstream JSON).
type Field struct {
	Label string `json:"label"`
	Key   string `json:"key"`
}

// Spec describes one adapter. Keep the JSON tags aligned with the Python
// ApiSpec.as_dict() contract consumed by the frontend.
type Spec struct {
	Key         string  `json:"key"`
	Name        string  `json:"name"`
	Kind        string  `json:"kind"`
	Homepage    string  `json:"homepage"`
	Summary     string  `json:"summary"`
	QueryHint   string  `json:"queryHint"`
	Endpoint    string  `json:"endpoint"`
	Method      string  `json:"method"`
	ResultsPath string  `json:"resultsPath"`
	Transform   string  `json:"transform"`
	Note        string  `json:"note"`
	Fields      []Field `json:"fields"`
}

// AsDict mirrors ApiSpec.as_dict(); Available is only set by the probe route.
func (s Spec) AsDict(available *bool) map[string]any {
	return map[string]any{
		"key": s.Key, "name": s.Name, "kind": s.Kind,
		"homepage": s.Homepage, "summary": s.Summary, "queryHint": s.QueryHint,
		"note": s.Note, "available": available,
	}
}

type catalogue struct {
	Specs      []Spec            `json:"specs"`
	NoAPINotes map[string]string `json:"noApiNotes"`
}

var cat = loadCatalogue()

func loadCatalogue() catalogue {
	var c catalogue
	if err := json.Unmarshal(specsRaw, &c); err != nil {
		panic("dbapis: embedded specs.json is invalid: " + err.Error())
	}
	return c
}

// All returns the 32 adapters (order preserved from the Python file).
func All() []Spec { return append([]Spec(nil), cat.Specs...) }

// Find looks up an adapter by key.
func Find(key string) (Spec, bool) {
	for _, s := range cat.Specs {
		if s.Key == key {
			return s, true
		}
	}
	return Spec{}, false
}

// Keys returns all adapter keys in insertion order.
func Keys() []string {
	out := make([]string, 0, len(cat.Specs))
	for _, s := range cat.Specs {
		out = append(out, s.Key)
	}
	return out
}

// NoAPIReason explains why a catalogued resource has no public API.
func NoAPIReason(key string) string {
	if r, ok := cat.NoAPINotes[key]; ok {
		return r
	}
	return "该资源未提供可匿名调用的公开检索 API，暂以网页链接方式访问。"
}

// Database is a minimal shape of the portal's PLANT_DATABASES entry. The full
// catalogue lives in the Python databases.py; the Go side only needs id/name
// for api_index/summary. Callers can inject the full list via SetDatabases.
type Database struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	CN       string `json:"cn"`
	Category string `json:"category"`
	URL      string `json:"url"`
}

var databases []Database

// SetDatabases injects the full resource directory (from the portal catalog
// export). It must be called before APIIndex/APISummary return meaningful data.
func SetDatabases(items []Database) {
	databases = append([]Database(nil), items...)
}

// APIIndex mirrors db_apis.api_index(): one entry per catalogued database.
func APIIndex() []map[string]any {
	out := []map[string]any{}
	for _, db := range databases {
		spec, ok := Find(db.ID)
		entry := map[string]any{
			"id": db.ID, "name": db.Name, "cn": db.CN,
			"category": db.Category, "url": db.URL,
			"hasApi": ok, "note": "",
		}
		if ok {
			entry["api"] = spec.AsDict(nil)
			entry["note"] = spec.Note
		} else {
			entry["api"] = nil
			entry["note"] = NoAPIReason(db.ID)
		}
		out = append(out, entry)
	}
	return out
}

// APISummary mirrors db_apis.api_summary().
func APISummary() map[string]any {
	keys := Keys()
	withAPI := len(keys)
	total := len(databases)
	if total < withAPI {
		total = withAPI
	}
	return map[string]any{
		"total": total, "withApi": withAPI,
		"withoutApi": total - withAPI, "keys": keys,
	}
}

// sortedKeys is used by the probe route for deterministic order.
func sortedKeys() []string {
	keys := Keys()
	sort.Strings(keys)
	return keys
}

// normalizeKey keeps lookup tolerant to case/space without weakening access
// control (it only maps onto the fixed 32-key catalogue).
func normalizeKey(key string) string {
	return strings.ToLower(strings.TrimSpace(key))
}
