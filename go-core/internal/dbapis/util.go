package dbapis

import (
	"fmt"
	"strconv"
	"strings"
)

// Row is the normalized result shape returned to the frontend.
type Row struct {
	Title    string  `json:"title"`
	Subtitle string  `json:"subtitle"`
	URL      string  `json:"url"`
	Source   string  `json:"source"`
	Fields   []Field `json:"fields"`
}

func row(title, subtitle, url, source string, fields []Field) Row {
	if title == "" {
		title = "（无标题）"
	}
	clean := make([]Field, 0, len(fields))
	for _, f := range fields {
		if f.Label != "" && f.Key != "" && f.Key != "None" {
			clean = append(clean, f)
		}
	}
	return Row{Title: title, Subtitle: subtitle, URL: url, Source: source, Fields: clean}
}

func f(label, value string) Field { return Field{Label: label, Key: value} }

// dig walks a JSON value by a dotted path ("a.b.0.c"), mirroring Python _dig.
func dig(v any, path string) any {
	if path == "" {
		return v
	}
	cur := v
	for _, part := range strings.Split(path, ".") {
		switch x := cur.(type) {
		case []any:
			i, err := strconv.Atoi(part)
			if err != nil || i < 0 || i >= len(x) {
				return nil
			}
			cur = x[i]
		case map[string]any:
			cur = x[part]
		default:
			return nil
		}
	}
	return cur
}

func asList(v any) []any {
	if v == nil {
		return []any{}
	}
	if x, ok := v.([]any); ok {
		return x
	}
	return []any{v}
}

// flattenText converts arbitrary JSON scalars/objects to a display string,
// mirroring Python _flatten_text (including the value/name/title/description
// preference for dicts and a 4-element cap for lists).
func flattenText(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	case []any:
		parts := []string{}
		for i, item := range x {
			if i >= 4 {
				break
			}
			if s := flattenText(item); s != "" {
				parts = append(parts, s)
			}
		}
		return strings.Join(parts, "；")
	case map[string]any:
		for _, k := range []string{"value", "name", "title", "description"} {
			if val, ok := x[k]; ok {
				return flattenText(val)
			}
		}
		return ""
	default:
		return fmt.Sprint(x)
	}
}

func str(v any) string {
	if v == nil {
		return ""
	}
	return flattenText(v)
}

// slowHosts get a longer timeout, mirroring Python _SLOW_HOSTS.
var slowHosts = []string{"ebi.ac.uk", "ncbi.nlm.nih.gov", "rest.uniprot.org", "pantherdb.org"}

func timeoutFor(url string, base float64) float64 {
	for _, h := range slowHosts {
		if strings.Contains(url, h) {
			return 35.0
		}
	}
	return base
}
