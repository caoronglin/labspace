// Package colorlab is the Go rewrite of the lcpmgh/colors Shiny app: a
// curator of discrete scientific color palettes plus color parsing, opacity
// and perceptual matching helpers.
//
// The palette data ships embedded so the core has no runtime file dependency.
package colorlab

import (
	_ "embed"
	"encoding/csv"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

//go:embed data/palettes.csv
var palettesCSV []byte

// MaxColors mirrors the original app: previews never show more than 16.
const MaxColors = 16

var (
	hexRe      = regexp.MustCompile(`^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$`)
	hexTokenRe = regexp.MustCompile(`#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?`)
)

// Palette is one curated discrete palette.
type Palette struct {
	ID     int      `json:"id"`
	Source string   `json:"source"`
	Name   string   `json:"name"`
	Count  int      `json:"count"`
	Colors []string `json:"colors"`
}

// Swatch is one color with its RGB triple.
type Swatch struct {
	HEX string `json:"hex"`
	RGB string `json:"rgb"`
	R   int    `json:"r"`
	G   int    `json:"g"`
	B   int    `json:"b"`
}

// Service holds the loaded palette database.
type Service struct {
	palettes []Palette
	index    map[int]int
	sources  []SourceCount
}

// SourceCount is one data provenance entry.
type SourceCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// New parses the embedded CSV. It only fails when the embedded data itself is
// malformed, which would be a build-time bug rather than a runtime condition.
// normalizeSource turns the upstream R package labels ("Rpk{ggsci}") into
// plain source names for display and filtering.
func normalizeSource(raw string) string {
	s := strings.TrimSpace(raw)
	if strings.HasPrefix(s, "Rpk{") && strings.HasSuffix(s, "}") {
		return strings.TrimSuffix(strings.TrimPrefix(s, "Rpk{"), "}")
	}
	return s
}

func New() (*Service, error) {
	r := csv.NewReader(strings.NewReader(string(palettesCSV)))
	rows, err := r.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("parse palettes csv: %w", err)
	}
	if len(rows) < 2 {
		return nil, fmt.Errorf("palettes csv is empty")
	}
	s := &Service{index: map[int]int{}}
	seq := map[string]int{}
	for i, row := range rows[1:] {
		if len(row) < 5 {
			continue
		}
		id, err := strconv.Atoi(strings.TrimSpace(row[0]))
		if err != nil {
			return nil, fmt.Errorf("row %d: bad id %q", i+2, row[0])
		}
		colors := ParseColors(row[4])
		if len(colors) == 0 {
			continue
		}
		p := Palette{
			ID:     id,
			Source: normalizeSource(row[1]),
			Name:   strings.TrimSpace(row[2]),
			Colors: colors,
			Count:  len(colors),
		}
		s.index[p.ID] = len(s.palettes)
		s.palettes = append(s.palettes, p)
		seq[p.Source]++
	}
	for name, n := range seq {
		s.sources = append(s.sources, SourceCount{Name: name, Count: n})
	}
	sort.Slice(s.sources, func(i, j int) bool {
		if s.sources[i].Count != s.sources[j].Count {
			return s.sources[i].Count > s.sources[j].Count
		}
		return s.sources[i].Name < s.sources[j].Name
	})
	return s, nil
}

// Total returns the number of loaded palettes.
func (s *Service) Total() int { return len(s.palettes) }

// Sources returns the data provenance statistics.
func (s *Service) Sources() []SourceCount { return s.sources }

// Histogram returns palette counts grouped by their color count plus the
// largest palette size.
func (s *Service) Histogram() (map[int]int, int) {
	counts := map[int]int{}
	maxCount := 0
	for _, p := range s.palettes {
		counts[p.Count]++
		if p.Count > maxCount {
			maxCount = p.Count
		}
	}
	return counts, maxCount
}

// Find returns a palette by its numeric id.
func (s *Service) Find(id int) (Palette, bool) {
	i, ok := s.index[id]
	if !ok {
		return Palette{}, false
	}
	return s.palettes[i], true
}

// ListResult is one filtered page of palettes.
type ListResult struct {
	Items    []Palette `json:"items"`
	Total    int       `json:"total"`
	Page     int       `json:"page"`
	PageSize int       `json:"page_size"`
	Pages    int       `json:"pages"`
}

// ListFilter describes the library query.
type ListFilter struct {
	Query    string
	Source   string
	Count    int // exact count, 0 = any
	MinCount int // lower bound when Count is 0
	Sort     string
	Page     int
	PageSize int
}

// List filters, sorts and paginates the palette database.
func (s *Service) List(f ListFilter) ListResult {
	if f.Page < 1 {
		f.Page = 1
	}
	if f.PageSize < 1 || f.PageSize > 500 {
		f.PageSize = 20
	}
	query := strings.ToLower(strings.TrimSpace(f.Query))
	out := make([]Palette, 0, len(s.palettes))
	for _, p := range s.palettes {
		if f.Source != "" && p.Source != f.Source {
			continue
		}
		if f.Count > 0 && p.Count != f.Count {
			continue
		}
		if f.Count == 0 && f.MinCount > 0 && p.Count < f.MinCount {
			continue
		}
		if query != "" && !paletteMatches(p, query) {
			continue
		}
		out = append(out, p)
	}
	switch f.Sort {
	case "count":
		sort.SliceStable(out, func(i, j int) bool {
			if out[i].Count != out[j].Count {
				return out[i].Count > out[j].Count
			}
			return out[i].ID < out[j].ID
		})
	case "source":
		sort.SliceStable(out, func(i, j int) bool {
			if out[i].Source != out[j].Source {
				return out[i].Source < out[j].Source
			}
			return out[i].ID < out[j].ID
		})
	default:
		sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	}
	total := len(out)
	pages := int(math.Ceil(float64(total) / float64(f.PageSize)))
	if pages < 1 {
		pages = 1
	}
	if f.Page > pages {
		f.Page = pages
	}
	start := (f.Page - 1) * f.PageSize
	end := start + f.PageSize
	if start > total {
		start = total
	}
	if end > total {
		end = total
	}
	return ListResult{Items: out[start:end], Total: total, Page: f.Page, PageSize: f.PageSize, Pages: pages}
}

func paletteMatches(p Palette, query string) bool {
	if strings.Contains(strings.ToLower(p.Name), query) {
		return true
	}
	if strings.Contains(strings.ToLower(p.Source), query) {
		return true
	}
	for _, c := range p.Colors {
		if strings.Contains(strings.ToLower(c), query) {
			return true
		}
	}
	return false
}

// ParseColors extracts up to MaxColors unique colors from free-form text.
//
// Colors may be separated by commas (ASCII or full-width), semicolons,
// ideographic commas, spaces, or nothing at all (#AABBCC#DDEEFF), matching the
// tolerance of the original Shiny input.
func ParseColors(input string) []string {
	tokens := hexTokenRe.FindAllString(input, -1)
	out := make([]string, 0, len(tokens))
	seen := map[string]bool{}
	for _, t := range tokens {
		if !hexRe.MatchString(t) {
			continue
		}
		u := strings.ToUpper(t)
		if seen[u] {
			continue
		}
		seen[u] = true
		out = append(out, u)
		if len(out) >= MaxColors {
			break
		}
	}
	return out
}

// RGBOf converts a 6/8-digit hex color into its RGB triple.
func RGBOf(hex string) (r, g, b int, ok bool) {
	h := strings.TrimPrefix(strings.TrimSpace(hex), "#")
	if len(h) != 6 && len(h) != 8 {
		return 0, 0, 0, false
	}
	v, err := strconv.ParseUint(h[:6], 16, 32)
	if err != nil {
		return 0, 0, 0, false
	}
	return int(v>>16) & 0xff, int(v>>8) & 0xff, int(v) & 0xff, true
}

// RGBString renders the original "R/G/B" notation.
func RGBString(hex string) string {
	r, g, b, ok := RGBOf(hex)
	if !ok {
		return ""
	}
	return fmt.Sprintf("%d/%d/%d", r, g, b)
}

// Swatches expands colors with their RGB representations.
func Swatches(colors []string) []Swatch {
	out := make([]Swatch, 0, len(colors))
	for _, c := range colors {
		r, g, b, _ := RGBOf(c)
		out = append(out, Swatch{HEX: c, RGB: fmt.Sprintf("%d/%d/%d", r, g, b), R: r, G: g, B: b})
	}
	return out
}

// ApplyOpacity appends an alpha channel, keeping existing alpha colors as-is.
//
// tpp is the opacity percentage (0-100) exactly like the Shiny slider: the
// stored alpha is (100-tpp)*255/100.
func ApplyOpacity(colors []string, tpp int) []string {
	if tpp <= 0 {
		return append([]string{}, colors...)
	}
	if tpp > 100 {
		tpp = 100
	}
	alpha := int(math.Round(float64(100-tpp) * 255 / 100))
	suffix := fmt.Sprintf("%02X", alpha)
	out := make([]string, 0, len(colors))
	for _, c := range colors {
		if len(c) == 7 {
			out = append(out, strings.ToUpper(c)+suffix)
		} else {
			out = append(out, strings.ToUpper(c))
		}
	}
	return out
}

// --- CIE Lab conversion (D65) ---

type lab struct{ L, A, B float64 }

func hexToLab(hex string) (lab, bool) {
	r, g, b, ok := RGBOf(hex)
	if !ok {
		return lab{}, false
	}
	lin := func(v int) float64 {
		c := float64(v) / 255
		if c <= 0.04045 {
			return c / 12.92
		}
		return math.Pow((c+0.055)/1.055, 2.4)
	}
	rl, gl, bl := lin(r), lin(g), lin(b)
	x := rl*0.4124564 + gl*0.3575761 + bl*0.1804375
	y := rl*0.2126729 + gl*0.7151522 + bl*0.0721750
	z := rl*0.0193339 + gl*0.1191920 + bl*0.9503041
	// D65 reference white.
	xn, yn, zn := 0.95047, 1.0, 1.08883
	f := func(t float64) float64 {
		if t > 0.008856 {
			return math.Cbrt(t)
		}
		return 7.787*t + 16.0/116.0
	}
	fx, fy, fz := f(x/xn), f(y/yn), f(z/zn)
	return lab{L: 116*fy - 16, A: 500 * (fx - fy), B: 200 * (fy - fz)}, true
}

func deltaE(a, b lab) float64 {
	dl, da, db := a.L-b.L, a.A-b.A, a.B-b.B
	return math.Sqrt(dl*dl + da*da + db*db)
}

// Nearest is the palette color closest to one seed color.
type Nearest struct {
	Seed     string  `json:"seed"`
	Hex      string  `json:"hex"`
	Distance float64 `json:"distance"`
}

// MatchItem is one ranked palette suggestion.
type MatchItem struct {
	Palette
	Score   float64   `json:"score"`
	Average float64   `json:"average"`
	Nearest []Nearest `json:"nearest"`
}

// Match ranks palettes by perceptual proximity to the seed colors.
//
// For every seed we take the nearest palette color (CIE76 ΔE) and sum those
// distances; palettes too small to hold all seeds carry a small size penalty
// so that larger palettes win only when they are genuinely closer.
func (s *Service) Match(seed []string, limit int) []MatchItem {
	if limit < 1 || limit > 30 {
		limit = 6
	}
	if len(seed) == 0 {
		return nil
	}
	var seeds []lab
	for _, c := range seed {
		if l, ok := hexToLab(c); ok {
			seeds = append(seeds, l)
		}
	}
	if len(seeds) == 0 {
		return nil
	}
	items := make([]MatchItem, 0, len(s.palettes))
	for _, p := range s.palettes {
		var labs []lab
		for _, c := range p.Colors {
			if l, ok := hexToLab(c); ok {
				labs = append(labs, l)
			}
		}
		if len(labs) == 0 {
			continue
		}
		nearest := make([]Nearest, 0, len(seeds))
		score := 0.0
		for i, sl := range seeds {
			best := math.MaxFloat64
			bestHex := ""
			for j, pl := range labs {
				d := deltaE(sl, pl)
				if d < best {
					best = d
					bestHex = p.Colors[j]
				}
			}
			score += best
			nearest = append(nearest, Nearest{Seed: seed[i], Hex: bestHex, Distance: math.Round(best*10) / 10})
		}
		if p.Count < len(seeds) {
			score += float64(len(seeds)-p.Count) * 6
		}
		items = append(items, MatchItem{
			Palette: p,
			Score:   math.Round(score*10) / 10,
			Average: math.Round(score/float64(len(seeds))*10) / 10,
			Nearest: nearest,
		})
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Score != items[j].Score {
			return items[i].Score < items[j].Score
		}
		return items[i].ID < items[j].ID
	})
	if len(items) > limit {
		items = items[:limit]
	}
	return items
}
