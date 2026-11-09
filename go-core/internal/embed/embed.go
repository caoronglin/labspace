// Package embed probes whether a third-party service may be rendered inside an
// iframe of the portal.
//
// It is a faithful port of the former Python implementation: the target
// response headers are inspected once and cached for a short TTL, so the
// browser never has to guess (a wrong guess shows a blank frame).
package embed

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Result mirrors the JSON contract the portal frontend already consumes.
type Result struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	URL        string `json:"url"`
	Embeddable bool   `json:"embeddable"`
	Reason     string `json:"reason"`
	Evidence   string `json:"evidence"`
	CheckedAt  string `json:"checked_at"`
	Status     int    `json:"status,omitempty"`
	SSOURL     string `json:"ssoUrl,omitempty"`
}

// Target describes the service to probe.
type Target struct {
	ID         string
	Name       string
	URL        string
	SSOURL     string
	Embeddable bool
	// Ancestor is the origin of the page that would embed the service
	// (e.g. "http://192.0.2.10"); frame-ancestors allowlists are matched
	// against it. Empty means "cannot decide" and falls back to lenient rules.
	Ancestor string
}

// Prober performs and caches the header inspection.
type Prober struct {
	client *http.Client
	ttl    time.Duration
	now    func() time.Time

	mu    sync.Mutex
	cache map[string]cached
}

type cached struct {
	at   time.Time
	res  Result
	seen bool
}

// New builds a prober with the given cache TTL.
func New(ttl time.Duration) *Prober {
	if ttl <= 0 {
		ttl = 300 * time.Second
	}
	return &Prober{
		client: &http.Client{
			Timeout: 8 * time.Second,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		ttl:   ttl,
		now:   time.Now,
		cache: map[string]cached{},
	}
}

// Check returns the cached verdict or performs a fresh probe.
func (p *Prober) Check(t Target) Result {
	p.mu.Lock()
	if c, ok := p.cache[t.ID]; ok && p.now().Sub(c.at) < p.ttl {
		p.mu.Unlock()
		return c.res
	}
	p.mu.Unlock()

	res := p.probe(t)

	p.mu.Lock()
	p.cache[t.ID] = cached{at: p.now(), res: res}
	p.mu.Unlock()
	return res
}

// probe performs the actual request and classifies the response headers.
func (p *Prober) probe(t Target) Result {
	res := Result{
		ID:         t.ID,
		Name:       t.Name,
		URL:        t.URL,
		Embeddable: false,
		CheckedAt:  p.now().Format("2006-01-02 15:04:05"),
		SSOURL:     t.SSOURL,
	}
	if !t.Embeddable {
		res.Reason = "该服务未提供内嵌入口"
		return res
	}
	if !strings.HasPrefix(t.URL, "http://") && !strings.HasPrefix(t.URL, "https://") {
		if strings.HasPrefix(t.URL, "/") && !strings.HasPrefix(t.URL, "//") {
			// 根路径为同源内嵌：X-Frame-Options: SAMEORIGIN 对同源父页面不构成限制。
			res.Embeddable = true
			res.Reason = "允许同源内嵌"
			return res
		}
		res.Reason = "内嵌地址协议不受支持"
		return res
	}

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, t.URL, nil)
	if err != nil {
		res.Reason = fmt.Sprintf("探测失败：%s", errType(err))
		return res
	}
	req.Header.Set("User-Agent", "D509LabSpace/1.0")
	resp, err := p.client.Do(req)
	if err != nil {
		res.Reason = fmt.Sprintf("探测失败：%s", errType(err))
		return res
	}
	defer resp.Body.Close()

	res.Status = resp.StatusCode
	ok, reason, evidence := classify(resp, t.Ancestor)
	res.Embeddable = ok
	res.Reason = reason
	res.Evidence = evidence
	return res
}

// classify inspects X-Frame-Options and CSP frame-ancestors.
//
// It returns (embeddable, reason, evidence). ancestor 为门户页面自身的源
// （如 http://198.51.100.71）：frame-ancestors 白名单只有覆盖它时才算允许嵌入。
func classify(resp *http.Response, ancestor string) (bool, string, string) {
	xfo := strings.TrimSpace(resp.Header.Get("X-Frame-Options"))
	csp := resp.Header.Get("Content-Security-Policy")
	frameAncestors := ""
	for _, part := range strings.Split(csp, ";") {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(strings.ToLower(part), "frame-ancestors") {
			frameAncestors = part
			break
		}
	}

	var evidence []string
	if xfo != "" {
		evidence = append(evidence, "X-Frame-Options: "+xfo)
	}
	if frameAncestors != "" {
		evidence = append(evidence, "CSP "+frameAncestors)
	}
	joined := strings.Join(evidence, "；")

	switch strings.ToUpper(xfo) {
	case "DENY", "SAMEORIGIN":
		return false, fmt.Sprintf("站点设置了 X-Frame-Options: %s，禁止被嵌入", xfo), joined
	}
	if frameAncestors != "" {
		value := ""
		if idx := strings.Index(frameAncestors, " "); idx >= 0 {
			value = frameAncestors[idx+1:]
		}
		tokens := map[string]bool{}
		for _, tok := range strings.Fields(value) {
			tokens[strings.Trim(strings.TrimSpace(tok), "'\"")] = true
		}
		if tokens["none"] {
			return false, fmt.Sprintf("站点设置了 CSP %s，禁止被嵌入", frameAncestors), joined
		}
		if tokens["*"] {
			return true, "允许嵌入（frame-ancestors: *）", joined
		}
		if frameAncestorsAllows(value, ancestor) {
			return true, "允许嵌入（frame-ancestors 覆盖当前入口）", joined
		}
		return false, fmt.Sprintf("站点限制了 CSP %s 的允许来源", frameAncestors), joined
	}
	if joined != "" {
		return true, "允许嵌入（响应头未禁止）", joined
	}
	return true, "允许嵌入（未设置 X-Frame-Options / frame-ancestors）", ""
}

// frameAncestorsAllows 判断 frame-ancestors 清单是否包含 ancestor 源。
//
// 支持三种写法：通配端口（http://198.51.100.71:*）、显式端口
// （http://198.51.100.71:80）与省略端口（按 scheme 默认端口比较）。
// 'self' 指文档自身源，门户与服务的端口不同，因此不构成允许。
func frameAncestorsAllows(value, ancestor string) bool {
	a, err := url.Parse(strings.TrimSpace(ancestor))
	if err != nil || a.Host == "" {
		return false
	}
	ahost := a.Hostname()
	aport := a.Port()
	if aport == "" {
		if strings.EqualFold(a.Scheme, "https") {
			aport = "443"
		} else {
			aport = "80"
		}
	}
	for _, raw := range strings.Fields(value) {
		tok := strings.Trim(raw, "'\"")
		if tok == "" || tok == "'self'" || tok == "*" {
			continue
		}
		// 通配端口 ":*" 不是合法的 URL 端口，url.Parse 会报错，先摘出来。
		wildcard := strings.HasSuffix(tok, ":*")
		if wildcard {
			tok = strings.TrimSuffix(tok, ":*")
		}
		t, terr := url.Parse(tok)
		if terr != nil || t.Host == "" {
			continue
		}
		if !strings.EqualFold(t.Scheme, a.Scheme) || !strings.EqualFold(t.Hostname(), ahost) {
			continue
		}
		switch {
		case wildcard:
			return true
		case t.Port() != "":
			if t.Port() == aport {
				return true
			}
		default:
			dflt := "80"
			if strings.EqualFold(t.Scheme, "https") {
				dflt = "443"
			}
			if aport == dflt {
				return true
			}
		}
	}
	return false
}

// errType maps a transport error to the short reason used by the portal.
func errType(err error) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "connection refused"):
		return "ConnectionRefusedError"
	case strings.Contains(msg, "no such host"):
		return "ConnectError"
	case strings.Contains(msg, "context deadline exceeded"), strings.Contains(msg, "Client.Timeout"):
		return "ReadTimeout"
	case strings.Contains(msg, "network is unreachable"):
		return "ConnectError"
	default:
		return "HTTPError"
	}
}
