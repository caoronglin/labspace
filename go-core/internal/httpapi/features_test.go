package httpapi

import (
	"bytes"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"labspace.local/go-core/internal/dbapis"
	"labspace.local/go-core/internal/guard"
	"labspace.local/go-core/internal/snapotter"
	"labspace.local/go-core/internal/workbench"
)

// signedServer builds a Server authenticated with the HMAC service signature so
// the tests exercise the real routing and authorisation path.
func signedServer(t *testing.T, app *Server) (func(method, uri, user string, body []byte) *httptest.ResponseRecorder, *[]byte) {
	t.Helper()
	key := []byte("0123456789abcdef0123456789abcdef")
	v, err := guard.New(key)
	if err != nil {
		t.Fatalf("guard: %v", err)
	}
	app.Verify = v
	call := func(method, uri, user string, body []byte) *httptest.ResponseRecorder {
		nonce := "nonce_" + strconv.FormatInt(time.Now().UnixNano(), 10)
		ts := strconv.FormatInt(time.Now().Unix(), 10)
		a := guard.Actor{UserID: user, TenantID: "lab"}
		req := httptest.NewRequest(method, uri, bytes.NewReader(body))
		req.Header.Set("X-Labgo-User", a.UserID)
		req.Header.Set("X-Labgo-Tenant", a.TenantID)
		req.Header.Set("X-Labgo-Admin", "0")
		req.Header.Set("X-Labgo-Time", ts)
		req.Header.Set("X-Labgo-Nonce", nonce)
		req.Header.Set("X-Labgo-Signature", guard.Sign(key, method, uri, a, ts, nonce, body))
		w := httptest.NewRecorder()
		app.ServeHTTP(w, req)
		return w
	}
	return call, &key
}

func TestWorkbenchRouteRequiresUser(t *testing.T) {
	app := &Server{Workbench: &workbench.Handler{Store: &workbench.Store{}}}
	// The service token has no owner, so workbench routes must refuse it
	// before the storage check ever runs.
	app.ServiceToken = "svc"
	req := httptest.NewRequest("GET", "/v1/workbench/summary", nil)
	req.Header.Set("X-Lab-Service-Token", "svc")
	w := httptest.NewRecorder()
	app.ServeHTTP(w, req)
	if w.Code != 403 {
		t.Fatalf("service token status = %d want 403", w.Code)
	}
}

func TestWorkbenchRoutesMap(t *testing.T) {
	app := &Server{Workbench: &workbench.Handler{Store: &workbench.Store{}}}
	call, _ := signedServer(t, app)

	cases := []struct {
		method string
		uri    string
		body   string
		want   int
	}{
		// No store wired: the fail-closed answer is 503, never a panic.
		{"GET", "/v1/workbench/items?limit=5", "", 503},
		{"GET", "/v1/workbench/summary", "", 503},
		// Unknown verbs and paths must be rejected before touching storage,
		// so the answer is 404 regardless of whether a database is wired.
		{"PUT", "/v1/workbench/items", "", 404},
		{"GET", "/v1/workbench/nonsense", "", 404},
	}
	for _, c := range cases {
		w := call(c.method, c.uri, "alice", []byte(c.body))
		if w.Code != c.want {
			t.Errorf("%s %s = %d want %d (%s)", c.method, c.uri, w.Code, c.want, strings.TrimSpace(w.Body.String()))
		}
	}
}

func TestWorkbenchValidationRejectsBadInput(t *testing.T) {
	app := &Server{Workbench: &workbench.Handler{Store: &workbench.Store{}}}
	call, _ := signedServer(t, app)
	for _, uri := range []string{"/v1/workbench/items", "/v1/workbench/projects", "/v1/workbench/plans"} {
		w := call("POST", uri, "alice", []byte(`not json`))
		if w.Code != 503 && w.Code != 400 {
			t.Errorf("%s bad json = %d want 400/503", uri, w.Code)
		}
	}
}

func TestResearchRoutesAreReadOnlyAndValidated(t *testing.T) {
	app := &Server{DBAPIs: &dbapis.Handler{Client: dbapis.New()}}
	call, _ := signedServer(t, app)

	// The adapter index is metadata only: no upstream request is performed.
	if w := call("GET", "/v1/databases/apis", "alice", nil); w.Code != 200 {
		t.Fatalf("index status = %d (%s)", w.Code, w.Body.String())
	}
	if w := call("POST", "/v1/databases/query", "alice", []byte(`bad json`)); w.Code != 400 {
		t.Errorf("bad json status = %d want 400", w.Code)
	}
	if w := call("POST", "/v1/databases/query", "alice", []byte(`{"key":"nope","query":"x"}`)); w.Code != 200 && w.Code != 400 {
		t.Errorf("unknown key status = %d", w.Code)
	}
	if w := call("GET", "/v1/databases/nonsense", "alice", nil); w.Code != 404 {
		t.Errorf("unknown path status = %d want 404", w.Code)
	}
}

func TestSnapOtterDownloadRejectsSSRF(t *testing.T) {
	app := &Server{SnapOtter: &snapotter.Handler{Client: snapotter.New(snapotter.Config{BaseURL: "http://lab-snapotter:1349"})}}
	call, _ := signedServer(t, app)
	for _, target := range []string{
		"http://169.254.169.254/latest/meta-data/",
		"http://evil.example/x",
		"//evil.example/x",
		"file:///etc/passwd",
		"gopher://127.0.0.1:6379/_INFO",
	} {
		w := call("GET", "/v1/snapotter/download?url="+urlEscape(target), "alice", nil)
		if w.Code != 400 {
			t.Errorf("%s: status = %d want 400", target, w.Code)
		}
	}
	// A same-origin path is accepted by the resolver (the upstream is a dead
	// port, so the transport fails — but with 400/502, never a host rewrite).
	if w := call("GET", "/v1/snapotter/download?url=%2Fapi%2Fv1%2Fjobs%2F1%2Fresult", "alice", nil); w.Code == 200 {
		t.Errorf("dead upstream returned 200")
	}
}

func TestSnapOtterToolSegmentsAreValidated(t *testing.T) {
	app := &Server{SnapOtter: &snapotter.Handler{Client: snapotter.New(snapotter.Config{BaseURL: "http://127.0.0.1:1"})}}
	call, _ := signedServer(t, app)
	for _, uri := range []string{
		"/v1/snapotter/tools/image/..",
		"/v1/snapotter/tools/image/../../etc",
		"/v1/snapotter/tools/image",
	} {
		w := call("POST", uri, "alice", []byte{})
		if w.Code == 200 {
			t.Errorf("%s: status = %d, want rejection", uri, w.Code)
		}
	}
}

func urlEscape(s string) string {
	return strings.NewReplacer(":", "%3A", "/", "%2F").Replace(s)
}
