// Package snapotter reads the SnapOtter tool catalogue.
//
// SnapOtter exposes no stable "list tools" endpoint; the authoritative source
// is its OpenAPI document where every POST /api/v1/tools/{section}/{toolId}
// is one executable tool. The document is a 600 KB YAML file, so instead of
// embedding a YAML parser (the Go core keeps zero external dependencies) this
// package scans the well-known shape of that document.
package snapotter

import (
	"regexp"
	"strings"

	"labspace.local/go-core/internal/corpus"
)

var (
	pathRe     = regexp.MustCompile(`^  /api/v1/tools/([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+):\s*$`)
	pathKeyRe  = regexp.MustCompile(`^  /[^:]*:\s*$`)
	summaryRe  = regexp.MustCompile(`^      summary: (.*)$`)
	descRe     = regexp.MustCompile(`^      description: (.*)$`)
	propKeyRe  = regexp.MustCompile(`^(\s+)([A-Za-z0-9._-]+):\s*$`)
	propDescRe = regexp.MustCompile(`^(\s+)description: (.*)$`)
)

// ParseOpenAPI extracts the tool catalogue from an OpenAPI YAML document.
func ParseOpenAPI(raw string) []corpus.Tool {
	tools := []corpus.Tool{}
	lines := strings.Split(raw, "\n")
	inTool := false
	section, toolID := "", ""
	name, description, accept := "", "", ""
	propKey := ""
	propIndent := -1
	skipIndent := -1

	flush := func() {
		if !inTool {
			return
		}
		if name == "" {
			name = toolID
		}
		tools = append(tools, corpus.Tool{
			Section:     section,
			ID:          toolID,
			Name:        name,
			Description: description,
			Accept:      accept,
		})
		inTool = false
		name, description, accept = "", "", ""
		propKey, propIndent = "", -1
	}

	for _, line := range lines {
		if skipIndent >= 0 {
			indent := len(line) - len(strings.TrimLeft(line, " "))
			if strings.TrimSpace(line) == "" || indent > skipIndent {
				continue
			}
			skipIndent = -1
		}
		if m := pathRe.FindStringSubmatch(line); m != nil {
			flush()
			section, toolID = m[1], m[2]
			inTool = true
			continue
		}
		if pathKeyRe.MatchString(line) {
			// Any other path key (for example
			// /api/v1/tools/image/strip-metadata/inspect with three segments)
			// ends the current tool block. Without this the summary of the
			// following block would overwrite the previous tool's title.
			flush()
			continue
		}
		if !inTool {
			continue
		}
		if m := summaryRe.FindStringSubmatch(line); m != nil {
			value := strings.TrimSpace(m[1])
			if isBlockScalar(value) {
				skipIndent = indentOf(line)
				continue
			}
			name = cleanScalar(value)
			continue
		}
		if m := descRe.FindStringSubmatch(line); m != nil {
			value := strings.TrimSpace(m[1])
			if isBlockScalar(value) {
				skipIndent = indentOf(line)
				continue
			}
			description = cleanScalar(value)
			continue
		}
		// Property level keys ("file:", "settings:", ...) carry the accepted
		// file hint of the tool.
		if m := propKeyRe.FindStringSubmatch(line); m != nil {
			propKey = m[2]
			propIndent = len(m[1])
			continue
		}
		if m := propDescRe.FindStringSubmatch(line); m != nil {
			if propKey == "file" && len(m[1]) == propIndent+2 {
				accept = strings.TrimSpace(m[2])
			}
			continue
		}
	}
	flush()
	return tools
}

func indentOf(line string) int {
	return len(line) - len(strings.TrimLeft(line, " "))
}

func isBlockScalar(v string) bool {
	switch v {
	case "|", "|-", ">", ">-", "|+", ">+":
		return true
	}
	return false
}

// cleanScalar removes the surrounding quotes of a YAML scalar. The Python
// implementation parses the document with PyYAML, which drops the quotes of
// values such as `summary: "AAC to FLAC"`.
func cleanScalar(v string) string {
	v = strings.TrimSpace(v)
	if len(v) >= 2 {
		first, last := v[0], v[len(v)-1]
		if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
			inner := v[1 : len(v)-1]
			if first == '"' {
				inner = strings.ReplaceAll(inner, `\"`, `"`)
				inner = strings.ReplaceAll(inner, `\\`, `\`)
			}
			return inner
		}
	}
	return v
}
