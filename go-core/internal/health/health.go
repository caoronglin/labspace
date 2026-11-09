// Package health implements bounded service liveness probes with a TTL cache.
//
// It replaces the Python portal's asyncio health checker: the Go core runs on
// the host, so probes must target host-reachable URLs (published ports or
// container addresses resolved by an external sync job).
package health

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type Kind string

const (
	KindHTTP Kind = "http"
	KindTCP  Kind = "tcp"
	KindFile Kind = "file"
	KindHost Kind = "host"
)

// Target describes one probe.
type Target struct {
	// URL is an http(s) URL, a tcp://host:port endpoint or a file path.
	URL string
	// Kind selects the probe implementation.
	Kind Kind
	// Host overrides the HTTP Host header (KindHost).
	Host string
	// MaxAgeSeconds is the freshness window for KindFile probes.
	MaxAgeSeconds int
}

// Result is the probe outcome, shaped like the Python portal contract.
type Result struct {
	Status    string `json:"status"`
	LatencyMS *int   `json:"latency_ms"`
	Detail    string `json:"detail"`
}

// Prober probes targets and caches results for a TTL.
type Prober struct {
	client *http.Client
	ttl    time.Duration
	now    func() time.Time

	mu    sync.Mutex
	cache map[string]cached
}

type cached struct {
	at     time.Time
	result Result
}

// New returns a Prober with the given cache TTL.
func New(ttl time.Duration) *Prober {
	if ttl <= 0 {
		ttl = 30 * time.Second
	}
	return &Prober{
		client: &http.Client{
			Timeout: 6 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		ttl:   ttl,
		now:   time.Now,
		cache: map[string]cached{},
	}
}

// Check probes the target, reusing a cached result inside the TTL window.
func (p *Prober) Check(t Target) Result {
	key := string(t.Kind) + "|" + t.URL + "|" + t.Host
	p.mu.Lock()
	if c, ok := p.cache[key]; ok && p.now().Sub(c.at) < p.ttl {
		p.mu.Unlock()
		return c.result
	}
	p.mu.Unlock()

	res := p.probe(t)

	p.mu.Lock()
	p.cache[key] = cached{at: p.now(), result: res}
	p.mu.Unlock()
	return res
}

// Probe bypasses the cache.
func (p *Prober) Probe(t Target) Result { return p.probe(t) }

func (p *Prober) probe(t Target) Result {
	switch t.Kind {
	case KindTCP:
		return probeTCP(t.URL)
	case KindFile:
		return probeFile(t.URL, t.MaxAgeSeconds)
	default:
		return probeHTTP(p.client, t)
	}
}

func probeHTTP(client *http.Client, t Target) Result {
	start := time.Now()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, t.URL, nil)
	if err != nil {
		return Result{Status: "down", Detail: err.Error()}
	}
	if t.Host != "" {
		req.Host = t.Host
	}
	resp, err := client.Do(req)
	latency := int(time.Since(start) / time.Millisecond)
	if err != nil {
		return Result{Status: "down", LatencyMS: &latency, Detail: reason(err)}
	}
	defer func() { _ = resp.Body.Close() }()
	status := resp.StatusCode
	if status >= 500 {
		return Result{Status: "down", LatencyMS: &latency, Detail: fmt.Sprintf("HTTP %d", status)}
	}
	return Result{Status: "up", LatencyMS: &latency, Detail: fmt.Sprintf("HTTP %d", status)}
}

func probeTCP(endpoint string) Result {
	start := time.Now()
	target := strings.TrimPrefix(endpoint, "tcp://")
	conn, err := net.DialTimeout("tcp", target, 6*time.Second)
	latency := int(time.Since(start) / time.Millisecond)
	if err != nil {
		return Result{Status: "down", LatencyMS: &latency, Detail: reason(err)}
	}
	_ = conn.Close()
	return Result{Status: "up", LatencyMS: &latency, Detail: "TCP OK"}
}

func probeFile(path string, maxAge int) Result {
	if maxAge <= 0 {
		maxAge = 90
	}
	info, err := os.Stat(path)
	if err != nil {
		return Result{Status: "down", Detail: "心跳文件不存在"}
	}
	age := int(time.Since(info.ModTime()).Seconds())
	if age >= maxAge {
		return Result{Status: "down", Detail: fmt.Sprintf("心跳过期 %ds", age)}
	}
	return Result{Status: "up", Detail: fmt.Sprintf("心跳 %ds 前", age)}
}

// reason renders a short, human-readable failure cause.
func reason(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "connection refused"):
		return "连接被拒绝"
	case strings.Contains(msg, "no such host"):
		return "域名解析失败"
	case strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline exceeded") || errors.Is(err, context.DeadlineExceeded):
		return "请求超时"
	case strings.Contains(msg, "no route to host"):
		return "网络不可达"
	}
	if len(msg) > 120 {
		msg = msg[:120]
	}
	return msg
}
