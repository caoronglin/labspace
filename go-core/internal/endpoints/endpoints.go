// Package endpoints resolves container placeholders inside service URLs.
//
// The Go core runs on the host and must not talk to the Docker socket, so
// container addresses are resolved by an external sync job that writes a small
// JSON document; the core only reads it.
package endpoints

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
)

// Map maps a placeholder name to a resolved address.
type Map map[string]string

// Load reads the endpoint document. A missing file yields an empty map.
func Load(path string) (Map, error) {
	m := Map{}
	if path == "" {
		return m, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return m, nil
		}
		return m, err
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return Map{}, err
	}
	return m, nil
}

var placeholder = regexp.MustCompile(`\$\{([a-zA-Z0-9_.-]+)\}`)

// Resolve replaces ${name} placeholders with the mapped address.
func (m Map) Resolve(raw string) string {
	if raw == "" || len(m) == 0 {
		return raw
	}
	return placeholder.ReplaceAllStringFunc(raw, func(match string) string {
		key := strings.TrimSuffix(strings.TrimPrefix(match, "${"), "}")
		if v, ok := m[key]; ok && v != "" {
			return v
		}
		return match
	})
}
