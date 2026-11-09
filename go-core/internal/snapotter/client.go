// Package snapotter is the Go port of backend/app/snapotter.py. It proxies the
// SnapOtter REST API so the browser never sees the SnapOtter API key, and
// parses the tool catalogue from the service OpenAPI document (see openapi.go).
//
// Security notes:
//   - ResolveDownload only accepts same-origin paths or an allow-listed host,
//     so an upstream reply can never turn this proxy into an SSRF gadget.
//   - Content-Disposition filenames are sanitized before being echoed back.
package snapotter

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"labspace.local/go-core/internal/corpus"
)

// DefaultBaseURL is the in-cluster SnapOtter address.
const DefaultBaseURL = "http://lab-snapotter:1349"

// DefaultMaxUpload is the per-request upload ceiling (200 MiB).
const DefaultMaxUpload = 200 << 20

// Config wires the proxy.
type Config struct {
	// BaseURL is SNAPPOTTER_BASE_URL.
	BaseURL string
	// APIKey is SNAPPOTTER_API_KEY; it never leaves the server.
	APIKey string
	// Timeout applies to long-running processing calls.
	Timeout time.Duration
	// MaxUpload is the upload ceiling in bytes.
	MaxUpload int64
	// Now is injected by tests.
	Now func() time.Time
}

// Client talks to the SnapOtter REST API and caches the tool catalogue.
type Client struct {
	cfg  Config
	http *http.Client

	mu       sync.RWMutex
	tools    []corpus.Tool
	fetched  time.Time
	snapshot []corpus.Tool
	ttl      time.Duration
}

// New builds a SnapOtter client.
func New(cfg Config) *Client {
	if cfg.BaseURL == "" {
		cfg.BaseURL = DefaultBaseURL
	}
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	if cfg.Timeout <= 0 {
		cfg.Timeout = 120 * time.Second
	}
	if cfg.MaxUpload <= 0 {
		cfg.MaxUpload = DefaultMaxUpload
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Client{
		cfg: cfg,
		http: &http.Client{
			Transport: &http.Transport{
				MaxIdleConns:        32,
				MaxIdleConnsPerHost: 8,
				IdleConnTimeout:     90 * time.Second,
			},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		ttl: 10 * time.Minute,
	}
}

// Configured reports whether a base URL is set.
func (c *Client) Configured() bool { return c.cfg.BaseURL != "" }

// BaseURL is exposed for the status endpoint.
func (c *Client) BaseURL() string { return c.cfg.BaseURL }

// MaxUpload is the configured upload ceiling.
func (c *Client) MaxUpload() int64 { return c.cfg.MaxUpload }

func (c *Client) api() string { return c.cfg.BaseURL + "/api/v1" }

func (c *Client) headers() map[string]string {
	if c.cfg.APIKey == "" {
		return nil
	}
	return map[string]string{"Authorization": "Bearer " + c.cfg.APIKey}
}

// Probe checks SnapOtter liveness.
func (c *Client) Probe(ctx context.Context) (bool, string) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.api()+"/health", nil)
	if err != nil {
		return false, "RequestError"
	}
	for k, v := range c.headers() {
		req.Header.Set(k, v)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return false, errName(err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return resp.StatusCode < 500, fmt.Sprintf("HTTP %d", resp.StatusCode)
}

// Catalog returns the tool catalogue, refreshing it when the TTL expires.
func (c *Client) Catalog(ctx context.Context) ([]corpus.Tool, error) {
	c.mu.RLock()
	if len(c.tools) > 0 && c.cfg.Now().Sub(c.fetched) < c.ttl {
		out := c.tools
		c.mu.RUnlock()
		return out, nil
	}
	c.mu.RUnlock()

	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.api()+"/openapi.yaml", nil)
	if err != nil {
		return c.stale(), err
	}
	for k, v := range c.headers() {
		req.Header.Set(k, v)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		if stale := c.stale(); stale != nil {
			return stale, nil
		}
		return nil, fmt.Errorf("openapi.yaml 获取失败: %s", errName(err))
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		if stale := c.stale(); stale != nil {
			return stale, nil
		}
		return nil, fmt.Errorf("openapi.yaml 获取失败: HTTP %d", resp.StatusCode)
	}
	// A 600 KB YAML document; 8 MB is a generous ceiling that still bounds a
	// hostile reply.
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		if stale := c.stale(); stale != nil {
			return stale, nil
		}
		return nil, err
	}
	tools := ParseOpenAPI(string(raw))
	c.mu.Lock()
	c.tools = tools
	c.snapshot = tools
	c.fetched = c.cfg.Now()
	c.mu.Unlock()
	return tools, nil
}

func (c *Client) stale() []corpus.Tool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.tools
}

// Snapshot returns the last catalogue without any network call.
func (c *Client) Snapshot() []corpus.Tool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]corpus.Tool, len(c.snapshot))
	copy(out, c.snapshot)
	return out
}

// Tool describes one submitted job result.
type JobResult map[string]any

// SubmitResult is the normalised answer of a tool submission.
type SubmitResult struct {
	Status int
	Body   json.RawMessage
}

// SubmitOptions is one tool invocation.
type SubmitOptions struct {
	Section     string
	ToolID      string
	Filename    string
	ContentType string
	Settings    string
	// Open streams the body (multipart-encoded lazily) instead of buffering.
	Open func() (io.ReadCloser, error)
	Size int64
}

// Submit POSTs a multipart job to SnapOtter, streaming the file body.
func (c *Client) Submit(ctx context.Context, opt SubmitOptions) (json.RawMessage, error) {
	if opt.Size > c.cfg.MaxUpload {
		return nil, &UploadTooLargeError{Limit: c.cfg.MaxUpload, Got: opt.Size}
	}
	if opt.Settings == "" {
		opt.Settings = "{}"
	}
	if opt.Filename == "" {
		opt.Filename = "input.bin"
	}
	if opt.ContentType == "" {
		opt.ContentType = "application/octet-stream"
	}
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	go func() {
		err := func() error {
			if err := mw.WriteField("settings", opt.Settings); err != nil {
				return err
			}
			h := make(textproto.MIMEHeader)
			h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, escapeQuotes(opt.Filename)))
			h.Set("Content-Type", opt.ContentType)
			part, err := mw.CreatePart(h)
			if err != nil {
				return err
			}
			body, err := opt.Open()
			if err != nil {
				return err
			}
			defer func() { _ = body.Close() }()
			// Bounded copy: never trust the declared size.
			if _, err = io.CopyN(part, body, c.cfg.MaxUpload+1); err != nil && !errors.Is(err, io.EOF) {
				return err
			}
			return mw.Close()
		}()
		_ = pw.CloseWithError(err)
	}()

	link := fmt.Sprintf("%s/tools/%s/%s", c.api(), url.PathEscape(opt.Section), url.PathEscape(opt.ToolID))
	ctx, cancel := context.WithTimeout(ctx, c.cfg.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, link, pr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	for k, v := range c.headers() {
		req.Header.Set(k, v)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	payload, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, truncate(string(payload), 300))
	}
	if !json.Valid(payload) {
		return json.RawMessage(`{}`), nil
	}
	return json.RawMessage(payload), nil
}

// SubmitFile submits a fully buffered payload. The streaming path (Submit with
// Open) is preferred for large uploads; this is the plain-text helper the
// HTTP handler uses when the body already fits in memory.
func (c *Client) SubmitFile(ctx context.Context, section, toolID, filename, contentType, settings string, content []byte) (json.RawMessage, error) {
	return c.Submit(ctx, SubmitOptions{
		Section:     section,
		ToolID:      toolID,
		Filename:    filename,
		ContentType: contentType,
		Settings:    settings,
		Size:        int64(len(content)),
		Open:        func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(content)), nil },
	})
}

// JobStatus polls one job.
func (c *Client) JobStatus(ctx context.Context, jobID string) (map[string]any, error) {
	var out map[string]any
	status, err := c.getJSON(ctx, "/jobs/"+url.PathEscape(jobID), 20*time.Second, &out)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		return map[string]any{"jobId": jobID, "status": "unknown"}, nil
	}
	if status >= 400 {
		return nil, fmt.Errorf("HTTP %d", status)
	}
	return out, nil
}

// Pipelines lists saved pipelines; an upstream error degrades to an empty list
// so the UI can still render.
func (c *Client) Pipelines(ctx context.Context) map[string]any {
	var out map[string]any
	status, err := c.getJSON(ctx, "/pipeline/list", 20*time.Second, &out)
	if err != nil || status >= 400 {
		return map[string]any{"pipelines": []any{}}
	}
	return out
}

// LegacyTools queries the non-standard /tools list endpoint (kept as a fallback
// for older SnapOtter builds).
func (c *Client) LegacyTools(ctx context.Context) map[string]any {
	var out map[string]any
	for _, path := range []string{"/tools", "/tools/list"} {
		status, err := c.getJSON(ctx, path, 20*time.Second, &out)
		if err == nil && status == 200 {
			return out
		}
	}
	return map[string]any{"tools": []any{}}
}

// getJSON performs a GET and decodes the body only for 2xx answers, so a 404
// body ("404 page not found") never fails to unmarshal into a map.
func (c *Client) getJSON(ctx context.Context, path string, timeout time.Duration, out any) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.api()+path, nil)
	if err != nil {
		return 0, err
	}
	for k, v := range c.headers() {
		req.Header.Set(k, v)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return resp.StatusCode, err
	}
	if out == nil || resp.StatusCode < 200 || resp.StatusCode > 299 {
		return resp.StatusCode, nil
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(out); err != nil {
		return resp.StatusCode, err
	}
	return resp.StatusCode, nil
}

// UploadTooLargeError reports a rejected upload.
type UploadTooLargeError struct {
	Limit int64
	Got   int64
}

func (e *UploadTooLargeError) Error() string {
	return fmt.Sprintf("文件超过上限 %d MB", e.Limit>>20)
}

// ---- download proxy -------------------------------------------------------

// allowedDownloadHosts are the only hosts the portal will proxy results from.
// Anything else is an SSRF attempt (the Python allow-list missed its own
// configured host, so a real deployment on another hostname broke).
var allowedDownloadHosts = map[string]bool{
	"localhost":     true,
	"127.0.0.1":     true,
	"::1":           true,
	"snapotter":     true,
	"lab-snapotter": true,
}

var schemeRe = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]*://`)

// ResolveDownload normalises a SnapOtter download URL into a same-origin path.
//
// Rules: a path is accepted as-is (it is joined to the configured base), an
// absolute URL is accepted only when its host is allow-listed, every other URL
// is rejected so the portal cannot be turned into an open proxy.
func ResolveDownload(raw, baseURL string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("下载地址为空")
	}
	if !schemeRe.MatchString(raw) {
		// Relative form (possibly protocol-relative: //host/path).
		if strings.HasPrefix(raw, "//") {
			return "", errors.New("下载地址不属于 SnapOtter 服务")
		}
		return normalizePath(raw), nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", errors.New("下载地址无法解析")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", errors.New("下载地址协议不被允许")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return "", errors.New("下载地址缺少主机")
	}
	if !allowedDownloadHosts[host] && host != ownHost(baseURL) {
		return "", errors.New("下载地址不属于 SnapOtter 服务")
	}
	path := normalizePath(u.EscapedPath())
	if u.RawQuery != "" {
		path += "?" + u.RawQuery
	}
	return path, nil
}

func ownHost(baseURL string) string {
	u, err := url.Parse(baseURL)
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

func normalizePath(p string) string {
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	if strings.HasPrefix(p, "/api/v1") {
		return p
	}
	if strings.HasPrefix(p, "/api/") {
		return "/api/v1" + strings.TrimPrefix(p, "/api")
	}
	return "/api/v1" + p
}

// Download fetches a processed result through the portal.
func (c *Client) Download(ctx context.Context, raw string) ([]byte, string, string, error) {
	path, err := ResolveDownload(raw, c.cfg.BaseURL)
	if err != nil {
		return nil, "", "", err
	}
	ctx, cancel := context.WithTimeout(ctx, c.cfg.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.cfg.BaseURL+path, nil)
	if err != nil {
		return nil, "", "", err
	}
	for k, v := range c.headers() {
		req.Header.Set(k, v)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, "", "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		return nil, "", "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<30))
	if err != nil {
		return nil, "", "", err
	}
	name := "snapotter-result.bin"
	if disp := resp.Header.Get("Content-Disposition"); strings.Contains(disp, "filename=") {
		part := disp[strings.Index(disp, "filename=")+len("filename="):]
		part = strings.Trim(part, `"'; `)
		if i := strings.IndexByte(part, ';'); i >= 0 {
			part = part[:i]
		}
		if cleaned := SanitizeFilename(part); cleaned != "" {
			name = cleaned
		}
	}
	return body, name, resp.Header.Get("Content-Type"), nil
}

// SanitizeFilename strips path separators and control characters from a
// server-provided filename (header injection / traversal guard).
func SanitizeFilename(name string) string {
	name = strings.TrimSpace(name)
	name = strings.ReplaceAll(name, "\\", "_")
	name = strings.ReplaceAll(name, "/", "_")
	var b strings.Builder
	for _, r := range name {
		if r < 0x20 || r == 0x7f || r == '"' {
			continue
		}
		b.WriteRune(r)
	}
	out := strings.TrimSpace(b.String())
	out = strings.Trim(out, ".")
	if len(out) > 120 {
		out = out[:120]
	}
	return out
}

func escapeQuotes(s string) string {
	return strings.NewReplacer("\\", "\\\\", `"`, "\\\"").Replace(s)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func errName(err error) string {
	var ne interface{ Timeout() bool }
	if errors.As(err, &ne) && ne.Timeout() {
		return "TimeoutError"
	}
	return "ConnectError"
}

var _ = strconv.Itoa
