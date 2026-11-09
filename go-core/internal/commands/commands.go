// Package commands loads the Linux command index used by the command palette.
package commands

import (
	"encoding/json"
	"os"
	"sort"

	"labspace.local/go-core/internal/corpus"
)

// Load reads the command index JSON (map of command name -> entry).
//
// The entries are sorted by name: Go randomises map iteration order, the
// Python implementation keeps the (alphabetical) order of the JSON file.
func Load(path string) ([]corpus.Command, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var idx map[string]corpus.Command
	if err := json.Unmarshal(raw, &idx); err != nil {
		return nil, err
	}
	out := make([]corpus.Command, 0, len(idx))
	for name, c := range idx {
		if c.Name == "" {
			c.Name = name
		}
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}
