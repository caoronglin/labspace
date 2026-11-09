// Package websearch queries the internal SearXNG instance.
//
// It mirrors the portal's unified search contract (local corpus + web results)
// so the Python portal route can be replaced by the Go core.
package websearch

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultPageSize is the portal default for one web result page.
	DefaultPageSize = 30
	// MaxPageSize bounds one portal page so a single response stays small.
	MaxPageSize = 100
	// maxPoolResults bounds the cached result pool per query.
	maxPoolResults = 600
	// maxUpstreamPages bounds how many SearXNG pages one query may fetch.
	maxUpstreamPages = 10
	// poolTTL keeps a query's upstream pages warm while the user pages through.
	poolTTL = 3 * time.Minute
	// maxPools bounds the number of cached queries.
	maxPools = 32
)

// Result is one web hit.
type Result struct {
	Title    string `json:"title"`
	URL      string `json:"url"`
	Content  string `json:"content"`
	Engine   string `json:"engine"`
	Category string `json:"category"`
	Kind     string `json:"kind"`
}

// PageResult is one portal page of web hits.
type PageResult struct {
	Hits     []Result
	Engines  []string
	Page     int
	PageSize int
	Total    int
	HasMore  bool
}

type pool struct {
	mu        sync.Mutex
	hits      []Result
	seen      map[string]bool
	engines   map[string]bool
	nextPage  int
	done      bool
	fetchedAt time.Time
}

// Client talks to SearXNG.
type Client struct {
	BaseURL string
	HTTP    *http.Client

	mu    sync.Mutex
	pools map[string]*pool
}

// New creates a client with the portal timeouts.
func New(baseURL string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		HTTP:    &http.Client{Timeout: 45 * time.Second},
		pools:   map[string]*pool{},
	}
}

// Search returns the first page of web hits and the engines that answered.
func (c *Client) Search(ctx context.Context, query, categories string, limit int) ([]Result, []string, error) {
	pageSize := limit
	if pageSize <= 0 {
		pageSize = DefaultPageSize
	}
	res, err := c.SearchPage(ctx, query, categories, 1, pageSize)
	if err != nil {
		return nil, nil, err
	}
	return res.Hits, res.Engines, nil
}

// SearchPage returns a portal-sized slice of web hits. SearXNG pages usually
// contain far more than twenty hits, so results are cached in a per-query pool
// and sliced locally; more upstream pages are fetched only when the requested
// portal page needs them.
func (c *Client) SearchPage(ctx context.Context, query, categories string, page, pageSize int) (PageResult, error) {
	if c == nil || c.BaseURL == "" {
		return PageResult{}, errors.New("SearXNG base URL must be administrator-configured")
	}
	if page < 1 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = DefaultPageSize
	}
	if pageSize > MaxPageSize {
		pageSize = MaxPageSize
	}

	key := query + "\x00" + categories
	p := c.pool(key)

	p.mu.Lock()
	defer p.mu.Unlock()

	start := (page - 1) * pageSize
	target := page * pageSize
	if target > maxPoolResults {
		target = maxPoolResults
	}
	for len(p.hits) < target && !p.done && p.nextPage <= maxUpstreamPages {
		hits, engines, err := c.fetch(ctx, query, categories, p.nextPage)
		if err != nil {
			if len(p.hits) == 0 {
				return PageResult{}, err
			}
			p.done = true
			break
		}
		if len(hits) == 0 {
			p.done = true
			break
		}
		for _, h := range hits {
			if h.URL == "" || p.seen[h.URL] {
				continue
			}
			p.seen[h.URL] = true
			p.hits = append(p.hits, h)
			if len(p.hits) >= maxPoolResults {
				p.done = true
				break
			}
		}
		for _, e := range engines {
			if e != "" {
				p.engines[e] = true
			}
		}
		p.nextPage++
	}

	if start > len(p.hits) {
		start = len(p.hits)
	}
	end := start + pageSize
	if end > len(p.hits) {
		end = len(p.hits)
	}
	hits := append([]Result(nil), p.hits[start:end]...)
	engines := make([]string, 0, len(p.engines))
	for e := range p.engines {
		engines = append(engines, e)
	}
	sort.Strings(engines)

	hasMore := end < len(p.hits) || (!p.done && p.nextPage <= maxUpstreamPages)
	return PageResult{
		Hits:     hits,
		Engines:  engines,
		Page:     page,
		PageSize: pageSize,
		Total:    len(p.hits),
		HasMore:  hasMore,
	}, nil
}

func (c *Client) pool(key string) *pool {
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.pools == nil {
		c.pools = map[string]*pool{}
	}
	if p, ok := c.pools[key]; ok {
		if time.Since(p.fetchedAt) <= poolTTL {
			return p
		}
		p.mu.Lock()
		p.hits = nil
		p.seen = map[string]bool{}
		p.engines = map[string]bool{}
		p.nextPage = 1
		p.done = false
		p.fetchedAt = now
		p.mu.Unlock()
		return p
	}
	if len(c.pools) >= maxPools {
		var oldestKey string
		var oldest time.Time
		for k, p := range c.pools {
			if oldestKey == "" || p.fetchedAt.Before(oldest) {
				oldestKey, oldest = k, p.fetchedAt
			}
		}
		if oldestKey != "" {
			delete(c.pools, oldestKey)
		}
	}
	p := &pool{seen: map[string]bool{}, engines: map[string]bool{}, nextPage: 1, fetchedAt: now}
	c.pools[key] = p
	return p
}

func (c *Client) fetch(ctx context.Context, query, categories string, pageno int) ([]Result, []string, error) {
	u, err := url.Parse(c.BaseURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, nil, errors.New("SearXNG base URL must be administrator-configured")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/search"
	v := u.Query()
	v.Set("format", "json")
	v.Set("q", query)
	if categories != "" {
		v.Set("categories", categories)
	}
	if pageno > 1 {
		v.Set("pageno", strconv.Itoa(pageno))
	}
	u.RawQuery = v.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, nil, err
	}
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 45 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, nil, errors.New("SearXNG returned non-200")
	}
	var body struct {
		Results []struct {
			Title    string `json:"title"`
			URL      string `json:"url"`
			Content  string `json:"content"`
			Engine   string `json:"engine"`
			Category string `json:"category"`
		} `json:"results"`
		Engines []string `json:"engines"`
	}
	if err = json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&body); err != nil {
		return nil, nil, err
	}
	out := make([]Result, 0, len(body.Results))
	for _, r := range body.Results {
		content := r.Content
		if len([]rune(content)) > 500 {
			content = string([]rune(content)[:500])
		}
		out = append(out, Result{
			Title:    r.Title,
			URL:      r.URL,
			Content:  content,
			Engine:   r.Engine,
			Category: r.Category,
			Kind:     "web",
		})
	}
	engines := body.Engines
	if engines == nil {
		engines = []string{}
	}
	return out, engines, nil
}

// ErrorKind maps a transport error to the portal's legacy exception name so the
// frontend message stays identical to the Python implementation.
func ErrorKind(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "context deadline exceeded"), strings.Contains(msg, "Client.Timeout"):
		return "TimeoutException"
	case strings.Contains(msg, "connection refused"):
		return "ConnectError"
	case strings.Contains(msg, "no such host"):
		return "ConnectError"
	default:
		return "HTTPError"
	}
}
