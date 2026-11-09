package dbapis

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

type probeEntry struct {
	at     time.Time
	ok     bool
	detail string
}

// Prober caches per-adapter liveness for 5 minutes, mirroring Python probe().
type Prober struct {
	mu    sync.Mutex
	cache map[string]probeEntry
	now   func() time.Time
}

func NewProber() *Prober {
	return &Prober{cache: map[string]probeEntry{}, now: time.Now}
}

// Probe checks one adapter. Network failures never panic the caller.
func (p *Prober) Probe(ctx context.Context, c *Client, key string) (bool, string) {
	spec, ok := Find(key)
	if !ok {
		return false, "无公开 API"
	}
	p.mu.Lock()
	if e, hit := p.cache[key]; hit && p.now().Sub(e.at) < 5*time.Minute {
		p.mu.Unlock()
		return e.ok, e.detail
	}
	p.mu.Unlock()

	var (
		u      string
		method = http.MethodGet
		body   any
	)
	switch spec.Transform {
	case "blast_submit":
		u = "https://blast.ncbi.nlm.nih.gov/Blast.cgi?CMD=Info"
	case "kegg":
		u = "https://rest.kegg.jp/info/kegg"
	case "rcsb":
		u = "https://search.rcsb.org/rcsbsearch/v2/query"
		method, body = http.MethodPost, map[string]any{
			"query":           map[string]any{"type": "terminal", "service": "full_text", "parameters": map[string]any{"value": "plant"}},
			"return_type":     "entry",
			"request_options": map[string]any{"paginate": map[string]any{"start": 0, "rows": 1}},
		}
	case "ols", "ols_chebi":
		u = "https://www.ebi.ac.uk/ols4/api/ontologies"
	case "pubchem":
		u = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/aspirin/property/MolecularFormula/JSON"
	case "hgnc":
		u = "https://rest.genenames.org/fetch/symbol/BRCA1"
	case "openfda":
		u = "https://api.fda.gov/drug/label.json?search=openfda.generic_name:aspirin&limit=1"
	case "opentargets":
		u, method, body = spec.Endpoint, http.MethodPost,
			map[string]any{"query": `query { search(queryString: "aspirin", page: {index: 0, size: 1}) { hits { id name } } }`}
	case "panther":
		u = render(spec.Endpoint, "AP1", 1, map[string]string{"organism": "3702"})
	default:
		u = render(spec.Endpoint, "test", 1, nil)
	}

	okResult, detail := p.fetch(ctx, c, method, u, body)
	p.mu.Lock()
	p.cache[key] = probeEntry{at: p.now(), ok: okResult, detail: detail}
	p.mu.Unlock()
	return okResult, detail
}

func (p *Prober) fetch(ctx context.Context, c *Client, method, u string, body any) (bool, string) {
	var (
		status int
		err    error
	)
	if method == http.MethodPost {
		var v any
		v, err = c.post(ctx, u, body, 10)
		if err == nil {
			_ = v
			return true, "HTTP 200"
		}
	} else {
		var respBody []byte
		respBody, _, status, err = c.get(ctx, u, timeoutFor(u, 15), 1)
		_ = respBody
	}
	if err != nil {
		return false, friendlyErrorKind(err)
	}
	if status == 0 {
		status = 200
	}
	return status < 400, fmt.Sprintf("HTTP %d", status)
}

func friendlyErrorKind(err error) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "deadline"), strings.Contains(msg, "Timeout"):
		return "TimeoutException"
	case strings.Contains(msg, "refused"), strings.Contains(msg, "no such host"):
		return "ConnectError"
	default:
		return "HTTPError"
	}
}

// ProbeAll probes every adapter concurrently (Python uses asyncio.gather).
func (p *Prober) ProbeAll(ctx context.Context, c *Client) map[string]struct {
	OK     bool
	Detail string
} {
	keys := Keys()
	type result struct {
		key    string
		ok     bool
		detail string
	}
	ch := make(chan result, len(keys))
	var wg sync.WaitGroup
	for _, k := range keys {
		wg.Add(1)
		go func(key string) {
			defer wg.Done()
			ok, detail := p.Probe(ctx, c, key)
			ch <- result{key, ok, detail}
		}(k)
	}
	wg.Wait()
	close(ch)
	out := map[string]struct {
		OK     bool
		Detail string
	}{}
	for r := range ch {
		out[r.key] = struct {
			OK     bool
			Detail string
		}{r.ok, r.detail}
	}
	return out
}
