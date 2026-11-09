package dbapis

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const userAgent = "D509LabSpace/1.0 (+internal research portal)"

// Client performs upstream research API calls. HTTP is injectable so tests can
// point every adapter at a local httptest server.
type Client struct {
	HTTP   *http.Client
	client *http.Client
}

func New() *Client {
	c := &http.Client{Timeout: 30 * time.Second}
	return &Client{HTTP: c, client: c}
}

func (c *Client) http() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	if c.client == nil {
		c.client = &http.Client{Timeout: 30 * time.Second}
	}
	return c.client
}

// get fetches JSON (or raw text) with a limited retry for slow upstream hosts.
func (c *Client) get(ctx context.Context, rawURL string, timeoutSec float64, retries int) ([]byte, string, int, error) {
	var lastErr error
	for attempt := 0; attempt <= retries; attempt++ {
		attemptCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSec*float64(time.Second)))
		req, err := http.NewRequestWithContext(attemptCtx, http.MethodGet, rawURL, nil)
		if err != nil {
			cancel()
			return nil, "", 0, err
		}
		req.Header.Set("User-Agent", userAgent)
		req.Header.Set("Accept", "application/json, text/plain, */*")
		resp, err := c.http().Do(req)
		if err != nil {
			cancel()
			lastErr = err
			if attempt < retries {
				select {
				case <-ctx.Done():
					return nil, "", 0, ctx.Err()
				case <-time.After(1500 * time.Millisecond):
				}
				continue
			}
			return nil, "", 0, err
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		ctype := resp.Header.Get("Content-Type")
		resp.Body.Close()
		cancel()
		if err != nil {
			return nil, ctype, resp.StatusCode, err
		}
		return body, ctype, resp.StatusCode, nil
	}
	return nil, "", 0, lastErr
}

// getJSON enforces the JSON content check from Python _get_json so a upstream
// maintenance HTML page produces a readable error rather than a parse panic.
func (c *Client) getJSON(ctx context.Context, rawURL string, timeoutSec float64, retries int) (any, error) {
	body, ctype, code, err := c.get(ctx, rawURL, timeoutSec, retries)
	if err != nil {
		return nil, err
	}
	if code >= 400 {
		return nil, fmt.Errorf("上游返回 HTTP %d", code)
	}
	trimmed := strings.TrimSpace(string(body))
	looksJSON := strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[")
	if !strings.Contains(strings.ToLower(ctype), "json") && !looksJSON {
		preview := trimmed
		if len([]rune(preview)) > 80 {
			preview = string([]rune(preview)[:80])
		}
		return nil, fmt.Errorf("上游返回了非 JSON 内容（服务维护、限流或被网关拦截），HTTP %d，响应前 80 字符：%s", code, preview)
	}
	var v any
	if err := json.Unmarshal(body, &v); err != nil {
		return nil, fmt.Errorf("解析上游 JSON 失败：%w", err)
	}
	return v, nil
}

func (c *Client) post(ctx context.Context, rawURL string, payload any, timeoutSec float64) (any, error) {
	var buf strings.Builder
	if err := json.NewEncoder(&buf).Encode(payload); err != nil {
		return nil, err
	}
	attemptCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSec*float64(time.Second)))
	defer cancel()
	req, err := http.NewRequestWithContext(attemptCtx, http.MethodPost, rawURL, strings.NewReader(buf.String()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := c.http().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("上游返回 HTTP %d", resp.StatusCode)
	}
	var v any
	if err := json.Unmarshal(body, &v); err != nil {
		return nil, fmt.Errorf("解析上游 JSON 失败：%w", err)
	}
	return v, nil
}

func quote(s string) string { return url.QueryEscape(s) }

// render applies {q}/{limit}/{program}/{database}/{space}/{organism}
// placeholders. Unlike the Python generic branch, EVERY placeholder known to
// the spec is filled here (fixes a latent KeyError when a spec with extra
// placeholders lands in the generic path).
func render(endpoint, q string, limit int, params map[string]string) string {
	r := strings.NewReplacer(
		"{q}", quote(q),
		"{limit}", fmt.Sprint(limit),
		"{program}", param(params, "program", "blastn"),
		"{database}", param(params, "database", "refseq_plant"),
		"{space}", param(params, "space", "genes"),
		"{organism}", param(params, "organism", "3702"),
	)
	return r.Replace(endpoint)
}

func param(params map[string]string, key, def string) string {
	if v, ok := params[key]; ok && v != "" {
		return quote(v)
	}
	return def
}

// QueryResult is the normalized run_query response.
type QueryResult struct {
	OK        bool           `json:"ok"`
	Items     []Row          `json:"items"`
	API       map[string]any `json:"api"`
	Total     int            `json:"total,omitempty"`
	Error     string         `json:"error,omitempty"`
	ElapsedMs int64          `json:"elapsedMs,omitempty"`
}

// RunQuery executes one adapter query.
func (c *Client) RunQuery(ctx context.Context, key, query string, limit int, params map[string]string) QueryResult {
	started := time.Now()
	spec, ok := Find(key)
	if !ok {
		return QueryResult{OK: false, Items: []Row{}, Error: "该数据库没有可用的公开 API"}
	}
	q := strings.TrimSpace(query)
	if q == "" {
		return QueryResult{OK: false, Items: []Row{}, Error: "请输入检索关键词", API: spec.AsDict(nil)}
	}
	if limit < 1 {
		limit = 5
	}
	if limit > 20 {
		limit = 20
	}
	if params == nil {
		params = map[string]string{}
	}
	var (
		items []Row
		err   error
	)
	if spec.Transform != "" {
		items, err = c.runTransform(ctx, spec, q, limit, params)
	} else {
		items, err = c.runGeneric(ctx, spec, q, limit, params)
	}
	elapsed := time.Since(started).Milliseconds()
	if err != nil {
		return QueryResult{
			OK: false, Items: []Row{}, API: spec.AsDict(nil),
			Error: "查询失败：" + friendlyError(err), ElapsedMs: elapsed,
		}
	}
	return QueryResult{OK: true, Items: items, API: spec.AsDict(nil), Total: len(items), ElapsedMs: elapsed}
}

func (c *Client) runGeneric(ctx context.Context, spec Spec, q string, limit int, params map[string]string) ([]Row, error) {
	u := render(spec.Endpoint, q, limit, params)
	timeout := timeoutFor(u, 20)
	payload, err := c.getJSON(ctx, u, timeout, 1)
	if err != nil {
		return nil, err
	}
	raw := asList(dig(payload, spec.ResultsPath))
	out := make([]Row, 0, limit)
	for _, item := range raw {
		if len(out) >= limit {
			break
		}
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		fields := []Field{}
		for _, fd := range spec.Fields {
			fields = append(fields, f(fd.Label, str(m[fd.Key])))
		}
		title := ""
		for _, fd := range spec.Fields {
			if v := str(m[fd.Key]); v != "" {
				title = v
				break
			}
		}
		if title == "" {
			title = fd0Key(spec.Fields)
		}
		link := str(m["url"])
		if link == "" {
			link = spec.Homepage
		}
		out = append(out, row(title, "", link, spec.Name, fields))
	}
	return out, nil
}

func fd0Key(fields []Field) string {
	if len(fields) > 0 {
		return fields[0].Key
	}
	return ""
}

func friendlyError(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	switch {
	case errors.Is(err, context.DeadlineExceeded), strings.Contains(msg, "Client.Timeout"):
		return "上游响应超时（本机房到该站点的链路较慢），请稍后重试"
	case strings.Contains(msg, "connection refused"), strings.Contains(msg, "no such host"):
		return "无法连接上游服务，请稍后重试或改用网页访问"
	case strings.Contains(msg, "非 JSON"):
		return "上游返回了非 JSON 内容（服务维护、限流或网关拦截），请稍后重试或改用网页访问"
	default:
		if len([]rune(msg)) > 160 {
			msg = string([]rune(msg)[:160])
		}
		return msg
	}
}
