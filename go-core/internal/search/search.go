package search

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

type Result struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
	Source  string `json:"source"`
}
type Provider interface {
	Name() string
	Search(context.Context, string, int) ([]Result, error)
}
type Service struct {
	Providers   []Provider
	MaxResults  int
	PerProvider int
}

func (s *Service) Search(ctx context.Context, q string) ([]Result, []string, error) {
	q = strings.TrimSpace(q)
	if q == "" || len([]rune(q)) > 500 {
		return nil, nil, errors.New("query is empty or too long")
	}
	max := s.MaxResults
	if max < 1 || max > 100 {
		max = 50
	}
	per := s.PerProvider
	if per < 1 || per > 50 {
		per = 20
	}
	out := []Result{}
	warnings := []string{}
	seen := map[string]bool{}
	for _, p := range s.Providers {
		if p == nil {
			continue
		}
		rows, e := p.Search(ctx, q, per)
		if e != nil {
			warnings = append(warnings, p.Name()+": unavailable")
			continue
		}
		for _, r := range rows {
			key := r.URL
			if key == "" {
				key = r.Source + "\x00" + r.Title
			}
			if seen[key] {
				continue
			}
			seen[key] = true
			if r.Source == "" {
				r.Source = p.Name()
			}
			out = append(out, r)
			if len(out) >= max {
				break
			}
		}
		if len(out) >= max {
			break
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Type != out[j].Type {
			return out[i].Type < out[j].Type
		}
		return out[i].Title < out[j].Title
	})
	return out, warnings, nil
}

type SearXNG struct {
	BaseURL string
	Client  *http.Client
}

func (p SearXNG) Name() string { return "searxng" }
func (p SearXNG) Search(ctx context.Context, q string, limit int) ([]Result, error) {
	u, e := url.Parse(p.BaseURL)
	if e != nil || u.Scheme != "http" && u.Scheme != "https" || u.Host == "" {
		return nil, errors.New("SearXNG base URL must be administrator-configured")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/search"
	v := u.Query()
	v.Set("format", "json")
	v.Set("q", q)
	u.RawQuery = v.Encode()
	req, e := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if e != nil {
		return nil, e
	}
	c := p.Client
	if c == nil {
		c = &http.Client{Timeout: 8 * time.Second}
	}
	resp, e := c.Do(req)
	if e != nil {
		return nil, e
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, errors.New("SearXNG returned non-200")
	}
	var body struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
			Engine  string `json:"engine"`
		} `json:"results"`
	}
	if e = json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&body); e != nil {
		return nil, e
	}
	out := []Result{}
	for _, x := range body.Results {
		out = append(out, Result{Type: "web", Title: x.Title, URL: x.URL, Snippet: x.Content, Source: x.Engine})
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}
