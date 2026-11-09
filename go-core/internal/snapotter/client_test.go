package snapotter

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestResolveDownload(t *testing.T) {
	const base = "http://lab-snapotter:1349"
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"/api/v1/jobs/1/result", "/api/v1/jobs/1/result", false},
		{"/jobs/1/result", "/api/v1/jobs/1/result", false},
		{"https://lab-snapotter:1349/api/v1/jobs/2/out?a=1", "/api/v1/jobs/2/out?a=1", false},
		{"http://localhost:1349/api/v1/x", "/api/v1/x", false},
		// SSRF: an attacker-supplied absolute URL must never be proxied.
		{"http://169.254.169.254/latest/meta-data/", "", true},
		{"http://evil.example/api/v1/x", "", true},
		{"//evil.example/x", "", true},
		{"file:///etc/passwd", "", true},
		{"", "", true},
	}
	for _, c := range cases {
		got, err := ResolveDownload(c.in, base)
		if c.wantErr {
			if err == nil {
				t.Errorf("%q: expected error, got %q", c.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("%q: unexpected error %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("%q: got %q want %q", c.in, got, c.want)
		}
	}
}

func TestResolveDownloadUsesConfiguredHost(t *testing.T) {
	// A deployment on a custom hostname must still be able to read its own
	// downloads (the Python allow-list hard-coded only loopback names).
	got, err := ResolveDownload("http://snap.internal:1349/api/v1/jobs/9/x", "http://snap.internal:1349")
	if err != nil || got != "/api/v1/jobs/9/x" {
		t.Fatalf("got %q err %v", got, err)
	}
}

func TestSanitizeFilename(t *testing.T) {
	if got := SanitizeFilename(`../../etc/passwd"`); strings.ContainsAny(got, `/\`) || strings.Contains(got, `"`) {
		t.Fatalf("sanitize = %q", got)
	}
	if got := SanitizeFilename(""); got != "" {
		t.Fatalf("empty = %q", got)
	}
	if got := SanitizeFilename("report.pdf"); got != "report.pdf" {
		t.Fatalf("plain = %q", got)
	}
}

func TestCatalogCachesAndFallsBack(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if hits > 1 {
			http.Error(w, "boom", 500)
			return
		}
		w.Header().Set("Content-Type", "text/yaml")
		_, _ = io.WriteString(w, sample)
	}))
	defer srv.Close()

	now := time.Unix(1700000000, 0)
	c := New(Config{BaseURL: srv.URL, Now: func() time.Time { return now }})
	tools, err := c.Catalog(context.Background())
	if err != nil || len(tools) == 0 {
		t.Fatalf("catalog: %v %d", err, len(tools))
	}
	// Inside the TTL the cached catalogue is served without a request.
	if _, err = c.Catalog(context.Background()); err != nil || hits != 1 {
		t.Fatalf("expected cache hit, hits=%d err=%v", hits, err)
	}
	// After the TTL the refresh fails, so the stale copy must be returned.
	now = now.Add(11 * time.Minute)
	got, err := c.Catalog(context.Background())
	if err != nil || len(got) == 0 {
		t.Fatalf("stale fallback: %v %d", err, len(got))
	}
	if len(c.Snapshot()) != len(got) {
		t.Fatal("snapshot mismatch")
	}
}

func TestSubmitStreamsMultipart(t *testing.T) {
	var gotSettings, gotFile, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		gotSettings = r.FormValue("settings")
		f, _, err := r.FormFile("file")
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		defer func() { _ = f.Close() }()
		b, _ := io.ReadAll(f)
		gotFile = string(b)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"jobId":"j1","status":"queued"}`)
	}))
	defer srv.Close()

	c := New(Config{BaseURL: srv.URL, APIKey: "si_test"})
	out, err := c.Submit(context.Background(), SubmitOptions{
		Section:  "image",
		ToolID:   "resize",
		Filename: `weird "name".png`,
		Settings: `{"width":100}`,
		Size:     4,
		Open:     func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader("data")), nil },
	})
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	if gotAuth != "Bearer si_test" {
		t.Fatalf("api key not forwarded: %q", gotAuth)
	}
	if gotSettings != `{"width":100}` || gotFile != "data" {
		t.Fatalf("multipart = %q %q", gotSettings, gotFile)
	}
	var decoded map[string]any
	if err := json.Unmarshal(out, &decoded); err != nil || decoded["jobId"] != "j1" {
		t.Fatalf("answer = %s", out)
	}
}

func TestSubmitRejectsOversizedUpload(t *testing.T) {
	c := New(Config{BaseURL: "http://127.0.0.1:1", MaxUpload: 10})
	_, err := c.Submit(context.Background(), SubmitOptions{
		Section: "x", ToolID: "y", Size: 11,
		Open: func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader("")), nil },
	})
	var tooLarge *UploadTooLargeError
	if err == nil || !asUploadTooLarge(err, &tooLarge) {
		t.Fatalf("expected UploadTooLargeError, got %v", err)
	}
}

func asUploadTooLarge(err error, target **UploadTooLargeError) bool {
	e, ok := err.(*UploadTooLargeError)
	if ok {
		*target = e
	}
	return ok
}

func TestJobStatusUnknown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL})
	out, err := c.JobStatus(context.Background(), "abc")
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if out["status"] != "unknown" {
		t.Fatalf("out = %v", out)
	}
}

func TestPipelinesDegrade(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", 500)
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL})
	out := c.Pipelines(context.Background())
	if _, ok := out["pipelines"]; !ok {
		t.Fatalf("expected empty pipeline list, got %v", out)
	}
}

func TestDownloadRejectsForeignHost(t *testing.T) {
	c := New(Config{BaseURL: "http://lab-snapotter:1349"})
	if _, _, _, err := c.Download(context.Background(), "http://169.254.169.254/x"); err == nil {
		t.Fatal("expected SSRF rejection")
	}
}
