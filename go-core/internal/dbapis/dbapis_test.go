package dbapis

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestCatalogueIntegrity(t *testing.T) {
	specs := All()
	if len(specs) != 32 {
		t.Fatalf("expected 32 adapters, got %d", len(specs))
	}
	seen := map[string]bool{}
	for _, s := range specs {
		if seen[s.Key] {
			t.Fatalf("duplicate key %q", s.Key)
		}
		seen[s.Key] = true
		if s.Name == "" || s.Homepage == "" || s.Summary == "" {
			t.Fatalf("incomplete spec %q", s.Key)
		}
		if s.Method == "" {
			s.Method = "GET"
		}
		if s.Method != "GET" && s.Method != "POST" {
			t.Fatalf("bad method %q for %q", s.Method, s.Key)
		}
	}
	// Every declared transform must have a Go implementation, and vice versa.
	for _, s := range specs {
		if s.Transform != "" {
			if _, ok := transforms[s.Transform]; !ok {
				t.Fatalf("spec %q references unimplemented transform %q", s.Key, s.Transform)
			}
		}
	}
	for name := range transforms {
		found := false
		for _, s := range specs {
			if s.Transform == name {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("transform %q has no spec (dead code)", name)
		}
	}
}

func TestRenderFillsEveryPlaceholder(t *testing.T) {
	// Regression for the Python generic-path bug: endpoints with extra
	// placeholders ({program}/{database}/{space}/{organism}) must render fully
	// instead of raising KeyError / leaving {q}-style tokens behind.
	cases := []struct {
		in     string
		params map[string]string
		want   []string
	}{
		{"https://x?PROGRAM={program}&DATABASE={database}&QUERY={q}&LIMIT={limit}",
			map[string]string{"program": "blastp", "database": "nr"},
			[]string{"AP1", "blastp", "nr", "5"}},
		{"https://x/find/{space}/{q}",
			map[string]string{"space": "ko"},
			[]string{"AP1", "ko"}},
		{"https://x?gene={q}&organism={organism}",
			map[string]string{"organism": "3702"},
			[]string{"AP1", "3702"}},
	}
	for _, tc := range cases {
		got := render(tc.in, "AP1", 5, tc.params)
		if strings.Contains(got, "{") || strings.Contains(got, "}") {
			t.Fatalf("unresolved placeholder: %s", got)
		}
		for _, want := range tc.want {
			if !strings.Contains(got, want) {
				t.Fatalf("render lost %q: %s", want, got)
			}
		}
	}
}

func TestDigAndFlatten(t *testing.T) {
	var v any
	_ = json.Unmarshal([]byte(`{"a":{"b":[{"name":"x"},{"name":"y"}]}}`), &v)
	if s(dig(v, "a.b.1.name")) != "y" {
		t.Fatal("dig failed")
	}
	if dig(v, "a.b.9.name") != nil {
		t.Fatal("dig out-of-range should be nil")
	}
	if got := flattenText(map[string]any{"name": "hello"}); got != "hello" {
		t.Fatalf("flatten dict: %q", got)
	}
	if got := flattenText([]any{"a", "b", "c", "d", "e"}); got != "a；b；c；d" {
		t.Fatalf("flatten list cap: %q", got)
	}
}

func TestRunQueryGenericAndTransform(t *testing.T) {
	// A single fake upstream answers every endpoint; we rewrite the spec
	// endpoints to point at it so the full adapter pipeline is exercised.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(r.URL.Path, "esearch"):
			_, _ = w.Write([]byte(`{"esearchresult":{"idlist":["101","102"]}}`))
		case strings.Contains(r.URL.Path, "esummary"):
			_, _ = w.Write([]byte(`{"result":{"101":{"name":"AP1","organism":{"scientificname":"Arabidopsis"}},"102":{"name":"FUL"}}}`))
		default:
			_, _ = w.Write([]byte(`{"entries":[{"name":"kinase","description":"a kinase","organism":"plant"}],"results":[],"response":{"docs":[]}}`))
		}
	}))
	defer srv.Close()

	// Generic adapter (ebi) uses results_path=entries + fields.
	t.Run("generic", func(t *testing.T) {
		c := New()
		spec, _ := Find("ebi")
		// Point the endpoint at the fake server for this call.
		orig := spec.Endpoint
		_ = orig
		res := runWithBase(t, c, "ebi", srv.URL, "kinase", 5, nil)
		if !res.OK || len(res.Items) == 0 {
			t.Fatalf("generic query failed: %+v err=%q", res, res.Error)
		}
		if res.Items[0].Fields[0].Label != "条目" || res.Items[0].Fields[0].Key != "kinase" {
			t.Fatalf("field mapping: %+v", res.Items[0])
		}
	})

	// NCBI gene transform: two upstream calls (esearch + esummary).
	t.Run("ncbi_gene", func(t *testing.T) {
		c := New()
		res := runWithBase(t, c, "ncbi", srv.URL, "AP1", 2, nil)
		if !res.OK || len(res.Items) != 2 {
			t.Fatalf("ncbi query failed: %+v", res)
		}
		if !strings.Contains(res.Items[0].Title, "AP1") || res.Items[0].Source != "NCBI Gene" {
			t.Fatalf("row: %+v", res.Items[0])
		}
	})
}

// runWithBase temporarily rewrites one spec's endpoint host so the test can
// exercise the real transform without reaching the public internet.
func runWithBase(t *testing.T, c *Client, key, base, q string, limit int, p map[string]string) QueryResult {
	t.Helper()
	spec, ok := Find(key)
	if !ok {
		t.Fatalf("no spec %q", key)
	}
	// Swap the whole catalog entry endpoint for this call.
	mu.Lock()
	old := cat.Specs[indexOf(key)].Endpoint
	cat.Specs[indexOf(key)].Endpoint = rewriteEndpoint(spec.Endpoint, base)
	mu.Unlock()
	defer func() {
		mu.Lock()
		cat.Specs[indexOf(key)].Endpoint = old
		mu.Unlock()
	}()
	// esearch/esummary are absolute NCBI URLs; redirect them via a tiny
	// RoundTripper so the transform's second hop also hits the fake server.
	origTransport := c.HTTP.Transport
	c.HTTP.Transport = &redirectTransport{base: base, wrapped: origTransport}
	defer func() { c.HTTP.Transport = origTransport }()
	return c.RunQuery(context.Background(), key, q, limit, p)
}

var mu sync.Mutex

func indexOf(key string) int {
	for i, s := range cat.Specs {
		if s.Key == key {
			return i
		}
	}
	return -1
}

func rewriteEndpoint(ep, base string) string {
	if i := strings.Index(ep, "://"); i >= 0 {
		rest := ep[i+3:]
		if j := strings.IndexByte(rest, '/'); j >= 0 {
			return base + rest[j:]
		}
	}
	return base
}

type redirectTransport struct {
	base    string
	wrapped http.RoundTripper
}

func (rt *redirectTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	clone.URL.Scheme = "http"
	clone.URL.Host = strings.TrimPrefix(rt.base, "http://")
	clone.Host = clone.URL.Host
	if rt.wrapped != nil {
		return rt.wrapped.RoundTrip(clone)
	}
	return http.DefaultTransport.RoundTrip(clone)
}

func TestNoAPIReasonAndSummary(t *testing.T) {
	if NoAPIReason("tair") == "" || !strings.Contains(NoAPIReason("tair"), "TAIR") {
		t.Fatal("missing TAIR reason")
	}
	if !strings.Contains(NoAPIReason("unknown-key"), "暂以网页") {
		t.Fatal("default reason missing")
	}
	SetDatabases([]Database{
		{ID: "ncbi", Name: "NCBI"}, {ID: "tair", Name: "TAIR"},
	})
	idx := APIIndex()
	if len(idx) != 2 || idx[0]["hasApi"] != true || idx[1]["hasApi"] != false {
		t.Fatalf("index: %+v", idx)
	}
	sum := APISummary()
	if sum["withApi"] != 32 {
		t.Fatalf("withApi=%v", sum["withApi"])
	}
}
