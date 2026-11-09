// Package corpus builds the portal-wide searchable index.
//
// It replaces the Python module backend/app/corpus.py: services come from the
// Go catalog, databases and pages come from the shared JSON data file,
// Linux commands come from the command index and SnapOtter tools come from
// the SnapOtter OpenAPI document.
package corpus

import (
	"encoding/json"
	"errors"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

// Entry is one searchable item of the unified corpus.
type Entry struct {
	Type        string  `json:"type"`
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	Subtitle    string  `json:"subtitle"`
	Description string  `json:"description"`
	URL         string  `json:"url"`
	Path        string  `json:"path"`
	Keywords    string  `json:"keywords"`
	Weight      float64 `json:"weight"`
}

// Database is one entry of the plant/biomedical database directory.
type Database struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	CN       string   `json:"cn"`
	Desc     string   `json:"desc"`
	URL      string   `json:"url"`
	Category string   `json:"category"`
	Tags     []string `json:"tags"`
	Featured bool     `json:"featured,omitempty"`
	Biomed   bool     `json:"biomed,omitempty"`
}

// Page is one portal page reachable from the command palette.
type Page struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Keywords string `json:"keywords"`
}

// Category is one search category exposed by the portal.
type Category struct {
	Value string `json:"value"`
	Label string `json:"label"`
	Hint  string `json:"hint"`
}

// Data is the shared static corpus data (exported by ops/export-corpus-data.py).
type Data struct {
	Version          int               `json:"version"`
	Databases        []Database        `json:"databases"`
	Pages            []Page            `json:"pages"`
	SectionCN        map[string]string `json:"section_cn"`
	ToolAliases      map[string]string `json:"tool_aliases"`
	HotKeywords      []string          `json:"hot_keywords"`
	SearchCategories []Category        `json:"search_categories"`
}

// Categories returns the portal search categories.
func (ix *Index) Categories() []Category {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	if ix.data == nil {
		return nil
	}
	return ix.data.SearchCategories
}

// LoadData reads the shared corpus data file.
func LoadData(path string) (*Data, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var d Data
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, err
	}
	return &d, nil
}

// Service is the minimal service description the corpus needs.
type Service struct {
	ID          string
	Name        string
	Description string
	URL         string
	Tags        []string
	Enabled     bool
}

// Command is one Linux command entry.
type Command struct {
	Name string `json:"n"`
	Path string `json:"p"`
	Desc string `json:"d"`
}

// Tool is one SnapOtter file-processing tool.
type Tool struct {
	Section     string
	ID          string
	Name        string
	Description string
	Accept      string
}

// Key returns the corpus key of a SnapOtter tool.
func (t Tool) Key() string { return t.Section + "/" + t.ID }

// TypeCaps limits how many entries one type may contribute to a result set.
var TypeCaps = map[string]int{
	"snapotter": 4,
	"command":   5,
	"database":  10,
	"service":   5,
	"tool":      4,
	"page":      4,
}

// Order is the display order used by the empty-query corpus panel.
var Order = []string{"page", "service", "tool", "snapotter", "database", "command"}

// Index holds the built corpus and answers search queries.
type Index struct {
	mu      sync.RWMutex
	entries []Entry
	data    *Data
	builtAt time.Time
}

// New creates an empty index bound to the shared data.
func New(data *Data) *Index {
	if data == nil {
		data = &Data{}
	}
	return &Index{data: data}
}

// Data returns the shared static data.
func (ix *Index) Data() *Data {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return ix.data
}

// Build rebuilds the corpus from the given sources.
func (ix *Index) Build(services []Service, commands []Command, tools []Tool) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	d := ix.data
	entries := make([]Entry, 0, 1024)

	// The Python implementation sorts the SnapOtter tool catalogue by
	// (section, id); keep the same order so both corpora stay comparable.
	sortedTools := append([]Tool(nil), tools...)
	sort.SliceStable(sortedTools, func(i, j int) bool {
		if sortedTools[i].Section != sortedTools[j].Section {
			return sortedTools[i].Section < sortedTools[j].Section
		}
		return sortedTools[i].ID < sortedTools[j].ID
	})
	tools = sortedTools

	for _, svc := range services {
		if !svc.Enabled {
			continue
		}
		// 站内页面直接索引到页面本身，避免搜索结果先落到服务详情页
		path := "/services/" + svc.ID
		if strings.HasPrefix(svc.URL, "/") {
			path = svc.URL
		}
		entries = append(entries, Entry{
			Type:        "service",
			ID:          svc.ID,
			Title:       svc.Name,
			Subtitle:    svc.Description,
			Description: svc.Description,
			URL:         svc.URL,
			Path:        path,
			Keywords:    strings.Join(svc.Tags, " "),
			Weight:      1.4,
		})
	}

	for _, db := range d.Databases {
		keywords := strings.Join(append(append([]string{}, db.Tags...), db.CN, db.Category), " ")
		weight := 1.0
		if db.Featured {
			weight = 1.25
		} else if db.Biomed {
			weight = 0.92
		}
		entries = append(entries, Entry{
			Type:        "database",
			ID:          db.ID,
			Title:       db.Name,
			Subtitle:    db.CN,
			Description: db.Desc,
			URL:         db.URL,
			Path:        "/databases?q=" + db.Name,
			Keywords:    keywords,
			Weight:      weight,
		})
	}

	for _, page := range d.Pages {
		entries = append(entries, Entry{
			Type:        "page",
			ID:          page.ID,
			Title:       page.Name,
			Subtitle:    "门户页面",
			Description: page.Keywords,
			Path:        page.ID,
			Keywords:    page.Keywords,
			Weight:      1.1,
		})
	}

	for _, cmd := range commands {
		if cmd.Name == "" {
			continue
		}
		desc := cmd.Desc
		sub := desc
		if len([]rune(sub)) > 60 {
			sub = string([]rune(sub)[:60])
		}
		full := desc
		if len([]rune(full)) > 200 {
			full = string([]rune(full)[:200])
		}
		entries = append(entries, Entry{
			Type:        "command",
			ID:          cmd.Name,
			Title:       cmd.Name,
			Subtitle:    sub,
			Description: full,
			Path:        "/commands?cmd=" + cmd.Name,
			Keywords:    desc,
			Weight:      0.9,
		})
	}

	for _, t := range tools {
		key := t.Key()
		alias := d.ToolAliases[key]
		desc := t.Description
		if len([]rune(desc)) > 200 {
			desc = string([]rune(desc)[:200])
		}
		section := t.Section
		if cn, ok := d.SectionCN[section]; ok && cn != "" {
			section = cn
		}
		entries = append(entries, Entry{
			Type:        "snapotter",
			ID:          key,
			Title:       t.Name,
			Subtitle:    section,
			Description: desc,
			Path:        "/snapotter?section=" + t.Section + "&tool=" + t.ID,
			Keywords:    alias + " " + t.Accept,
			Weight:      0.95,
		})
	}

	ix.entries = entries
	ix.builtAt = time.Now()
}

// Size returns the number of indexed entries.
func (ix *Index) Size() int {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return len(ix.entries)
}

// BuiltAt returns the build timestamp.
func (ix *Index) BuiltAt() time.Time {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return ix.builtAt
}

// ---------------------------------------------------------------- normalisation

func normalize(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

func tokens(s string) []string {
	out := []string{}
	cur := strings.Builder{}
	flush := func() {
		if cur.Len() > 0 {
			out = append(out, strings.ToLower(cur.String()))
			cur.Reset()
		}
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			cur.WriteRune(r)
		case r >= 0x4e00 && r <= 0x9fff:
			flush()
			out = append(out, string(r))
		default:
			flush()
		}
	}
	flush()
	return out
}

func score(e Entry, kw string, kwTokens []string) float64 {
	title := normalize(e.Title)
	subtitle := normalize(e.Subtitle)
	keywords := normalize(e.Keywords)
	desc := normalize(e.Description)

	if len(kwTokens) == 0 {
		return e.Weight
	}
	for _, tok := range kwTokens {
		if !strings.Contains(title, tok) && !strings.Contains(subtitle, tok) &&
			!strings.Contains(keywords, tok) && !strings.Contains(desc, tok) {
			return 0
		}
	}
	s := e.Weight
	switch {
	case title == kw:
		s += 6
	case strings.HasPrefix(title, kw):
		s += 4.5
	case strings.Contains(title, kw):
		s += 3.2
	}
	if strings.Contains(subtitle, kw) {
		s += 1.4
	}
	if strings.Contains(keywords, kw) {
		s += 1.8
	}
	if strings.Contains(desc, kw) {
		s += 0.6
	}
	for _, tok := range kwTokens {
		if len([]rune(tok)) > 1 && strings.Contains(title, tok) {
			s += 1.1
		}
	}
	return s
}

// ---------------------------------------------------------------------- search

type scored struct {
	s     float64
	entry Entry
}

// Search returns corpus entries ranked by relevance.
func (ix *Index) Search(query string, limit int, types []string) []Entry {
	kw := normalize(query)
	if kw == "" {
		return nil
	}
	if limit <= 0 {
		limit = 20
	}
	kwTokens := tokens(query)
	var filter map[string]bool
	if len(types) > 0 {
		filter = map[string]bool{}
		for _, t := range types {
			filter[t] = true
		}
	}

	ix.mu.RLock()
	list := make([]scored, 0, 64)
	for _, e := range ix.entries {
		if filter != nil && !filter[e.Type] {
			continue
		}
		if s := score(e, kw, kwTokens); s > 0 {
			list = append(list, scored{s: s, entry: e})
		}
	}
	ix.mu.RUnlock()

	sort.SliceStable(list, func(i, j int) bool {
		if list[i].s != list[j].s {
			return list[i].s > list[j].s
		}
		return list[i].entry.Title < list[j].entry.Title
	})

	picked := []Entry{}
	used := map[string]int{}
	overflow := []scored{}
	for _, sc := range list {
		cap, ok := TypeCaps[sc.entry.Type]
		cnt := used[sc.entry.Type]
		if ok && cnt >= cap {
			overflow = append(overflow, sc)
			continue
		}
		used[sc.entry.Type] = cnt + 1
		picked = append(picked, sc.entry)
		if len(picked) >= limit {
			break
		}
	}
	if len(picked) < limit {
		for _, sc := range overflow {
			picked = append(picked, sc.entry)
			if len(picked) >= limit {
				break
			}
		}
	}
	return picked
}

// Suggest returns title suggestions for the search box.
func (ix *Index) Suggest(query string, limit int) []string {
	if limit <= 0 {
		limit = 10
	}
	kw := normalize(query)
	out := []string{}
	if kw == "" {
		ix.mu.RLock()
		defer ix.mu.RUnlock()
		for _, db := range ix.data.Databases {
			if db.Featured && db.Name != "" {
				out = append(out, db.Name)
				if len(out) >= limit {
					break
				}
			}
		}
		return out
	}
	seen := map[string]bool{}
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	for _, e := range ix.entries {
		lower := strings.ToLower(e.Title)
		if seen[lower] {
			continue
		}
		hay := strings.ToLower(e.Title + " " + e.Subtitle + " " + e.Keywords)
		if kw != "" && !strings.Contains(hay, kw) {
			continue
		}
		seen[lower] = true
		out = append(out, e.Title)
		if len(out) >= limit {
			break
		}
	}
	return out
}

// Hot returns the hot keywords shown for an empty query.
func (ix *Index) Hot() []string {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	out := make([]string, len(ix.data.HotKeywords))
	copy(out, ix.data.HotKeywords)
	return out
}

// Buckets returns the empty-query corpus panel (type-balanced).
func (ix *Index) Buckets(limit int) []Entry {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	buckets := map[string][]Entry{}
	for _, e := range ix.entries {
		cap, ok := TypeCaps[e.Type]
		if !ok {
			cap = 4
		}
		arr := buckets[e.Type]
		if len(arr) < cap {
			buckets[e.Type] = append(arr, e)
		}
	}
	out := []Entry{}
	for _, t := range Order {
		out = append(out, buckets[t]...)
	}
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

// Databases searches the local database directory.
func (ix *Index) Databases(keyword, category string, limit int) []Database {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	kw := normalize(keyword)
	items := []Database{}
	for _, d := range ix.data.Databases {
		if category != "" && category != "全部" && d.Category != category {
			continue
		}
		if kw != "" {
			parts := append([]string{d.Name, d.CN, d.Desc, d.Category}, d.Tags...)
			hay := strings.ToLower(strings.Join(parts, " "))
			if !strings.Contains(hay, kw) {
				continue
			}
		}
		items = append(items, d)
	}
	sort.SliceStable(items, func(i, j int) bool {
		ri, rj := dbRank(items[i], kw), dbRank(items[j], kw)
		if ri != rj {
			return ri < rj
		}
		return items[i].Name < items[j].Name
	})
	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}
	return items
}

func dbRank(d Database, kw string) int {
	n := strings.ToLower(d.Name)
	if kw == "" {
		if d.Featured {
			return -1
		}
		return 3
	}
	switch {
	case n == kw:
		return 0
	case strings.HasPrefix(n, kw):
		return 1
	case strings.Contains(n, kw):
		return 2
	default:
		return 3
	}
}

// ErrNoData is returned when the shared corpus data file cannot be used.
var ErrNoData = errors.New("corpus data unavailable")
