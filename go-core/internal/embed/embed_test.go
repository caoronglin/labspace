package embed

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestClassifyAllowsWhenNoHeaders(t *testing.T) {
	rec := httptest.NewRecorder()
	rec.Header().Set("Content-Type", "text/html")
	resp := rec.Result()
	ok, reason, evidence := classify(resp, "http://192.0.2.10")
	if !ok {
		t.Fatalf("expected embeddable, got reason=%q", reason)
	}
	if evidence != "" {
		t.Fatalf("expected no evidence, got %q", evidence)
	}
}

func TestClassifyDeniesXFrameOptions(t *testing.T) {
	for _, value := range []string{"DENY", "SAMEORIGIN", "deny"} {
		rec := httptest.NewRecorder()
		rec.Header().Set("X-Frame-Options", value)
		ok, reason, _ := classify(rec.Result(), "http://192.0.2.10")
		if ok {
			t.Fatalf("expected not embeddable for X-Frame-Options: %s", value)
		}
		if reason == "" {
			t.Fatalf("expected reason for X-Frame-Options: %s", value)
		}
	}
}

func TestClassifyDeniesFrameAncestorsNone(t *testing.T) {
	rec := httptest.NewRecorder()
	rec.Header().Set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'")
	ok, reason, evidence := classify(rec.Result(), "http://192.0.2.10")
	if ok {
		t.Fatal("expected not embeddable for frame-ancestors 'none'")
	}
	if evidence == "" {
		t.Fatal("expected CSP evidence")
	}
	if reason == "" {
		t.Fatal("expected reason")
	}
}

func TestClassifyDeniesRestrictedFrameAncestors(t *testing.T) {
	rec := httptest.NewRecorder()
	rec.Header().Set("Content-Security-Policy", "frame-ancestors 'self'")
	if ok, _, _ := classify(rec.Result(), "http://192.0.2.10"); ok {
		t.Fatal("expected not embeddable for restricted frame-ancestors")
	}
}

func TestClassifyAllowsWildcardFrameAncestors(t *testing.T) {
	rec := httptest.NewRecorder()
	rec.Header().Set("Content-Security-Policy", "frame-ancestors *")
	if ok, _, _ := classify(rec.Result(), "http://192.0.2.10"); !ok {
		t.Fatal("expected embeddable for frame-ancestors *")
	}
}

func TestClassifyAllowsEntryHostInFrameAncestors(t *testing.T) {
	rec := httptest.NewRecorder()
	rec.Header().Set(
		"Content-Security-Policy",
		"frame-ancestors 'self' http://192.0.2.10:* http://198.51.100.71:*",
	)
	cases := map[string]bool{
		"http://198.51.100.71": true,
		"http://192.0.2.10":   true,
		"http://10.0.0.9":       false,
	}
	for ancestor, want := range cases {
		ok, _, _ := classify(rec.Result(), ancestor)
		if ok != want {
			t.Fatalf("ancestor %s: got embeddable=%v want %v", ancestor, ok, want)
		}
	}
}

func TestProbeDisabledEmbedEntry(t *testing.T) {
	p := New(time.Minute)
	res := p.Check(Target{ID: "x", Name: "X", URL: "http://127.0.0.1:1/", Embeddable: false})
	if res.Embeddable {
		t.Fatal("expected not embeddable")
	}
	if res.Reason != "该服务未提供内嵌入口" {
		t.Fatalf("unexpected reason %q", res.Reason)
	}
}

func TestProbeAllowsSameOriginRelativePath(t *testing.T) {
	p := New(time.Minute)
	res := p.Check(Target{ID: "x", Name: "X", URL: "/cropgenome/", Embeddable: true})
	if !res.Embeddable {
		t.Fatalf("expected same-origin embeddable, got reason=%q", res.Reason)
	}
	if res.Reason != "允许同源内嵌" {
		t.Fatalf("unexpected reason %q", res.Reason)
	}
}

func TestProbeRejectsUnsupportedScheme(t *testing.T) {
	p := New(time.Minute)
	for _, u := range []string{"javascript:alert(1)", "file:///etc/passwd", "//evil.example/"} {
		res := p.Check(Target{ID: u, Name: "X", URL: u, Embeddable: true})
		if res.Embeddable {
			t.Fatalf("expected not embeddable for %q", u)
		}
		if res.Reason != "内嵌地址协议不受支持" {
			t.Fatalf("unexpected reason %q for %q", res.Reason, u)
		}
	}
}

func TestProbeLiveServiceAndCache(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		w.WriteHeader(200)
	}))
	defer srv.Close()

	p := New(time.Minute)
	target := Target{ID: "svc", Name: "Svc", URL: srv.URL, Embeddable: true}
	res := p.Check(target)
	if res.Embeddable {
		t.Fatal("expected not embeddable")
	}
	if res.Status != 200 {
		t.Fatalf("expected status 200, got %d", res.Status)
	}
	if hits != 1 {
		t.Fatalf("expected 1 request, got %d", hits)
	}
	again := p.Check(target)
	if hits != 1 {
		t.Fatalf("expected cached result, got %d requests", hits)
	}
	if again.Reason != res.Reason {
		t.Fatalf("cached reason mismatch: %q vs %q", again.Reason, res.Reason)
	}
}

func TestProbeUnreachableTarget(t *testing.T) {
	p := New(time.Minute)
	res := p.Check(Target{ID: "dead", Name: "Dead", URL: "http://127.0.0.1:9/", Embeddable: true})
	if res.Embeddable {
		t.Fatal("expected not embeddable")
	}
	if res.Reason == "" {
		t.Fatal("expected failure reason")
	}
}
