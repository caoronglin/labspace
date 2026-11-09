package httpapi

import (
	"bytes"
	"encoding/json"
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

// signedCall reproduces the internal HMAC authentication used by the gateway.
func signedCall(t *testing.T, s *Server, method, uri string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	key := []byte("0123456789abcdef0123456789abcdef")
	v, _ := guard.New(key)
	if s.Verify == nil {
		s.Verify = v
	}
	nonce := "nonce_" + strconv.FormatInt(time.Now().UnixNano(), 10)
	a := guard.Actor{UserID: "alice@local", TenantID: "lab"}
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	req := httptest.NewRequest(method, uri, bytes.NewReader(body))
	req.Header.Set("X-Labgo-User", a.UserID)
	req.Header.Set("X-Labgo-Tenant", a.TenantID)
	req.Header.Set("X-Labgo-Admin", "0")
	req.Header.Set("X-Labgo-Time", ts)
	req.Header.Set("X-Labgo-Nonce", nonce)
	req.Header.Set("X-Labgo-Signature", guard.Sign(key, method, uri, a, ts, nonce, body))
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	return w
}

func TestMigratedRoutesRequireAuthentication(t *testing.T) {
	s := &Server{}
	for _, uri := range []string{
		"/v1/workbench/items", "/v1/snapotter/status", "/v1/databases/apis",
	} {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, httptest.NewRequest("GET", uri, nil))
		if w.Code != 401 {
			t.Fatalf("%s without auth => %d (want 401)", uri, w.Code)
		}
	}
}

func TestMigratedRoutesWired(t *testing.T) {
	s := &Server{
		DBAPIs:    &dbapis.Handler{Client: dbapis.New()},
		SnapOtter: &snapotter.Handler{Client: snapotter.New(snapotter.Config{BaseURL: "http://127.0.0.1:1"})},
		Workbench: &workbench.Handler{}, // no DB -> 503, proving the route is wired
	}
	// Workbench with no store must fail closed, not 404.
	w := signedCall(t, s, "GET", "/v1/workbench/summary", nil)
	if w.Code != 503 || !strings.Contains(w.Body.String(), "unavailable") {
		t.Fatalf("workbench route: %d %s", w.Code, w.Body.String())
	}
	// SnapOtter status reaches its handler (upstream down -> up=false, 200).
	w = signedCall(t, s, "GET", "/v1/snapotter/status", nil)
	if w.Code != 200 {
		t.Fatalf("snapotter route: %d %s", w.Code, w.Body.String())
	}
	var st map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &st)
	if st["up"] != false {
		t.Fatalf("snapotter status: %+v", st)
	}
	// Databases index reaches its handler.
	w = signedCall(t, s, "GET", "/v1/databases/index", nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "items") {
		t.Fatalf("databases route: %d %s", w.Code, w.Body.String())
	}
}

func TestDBAPIQueryRoute(t *testing.T) {
	s := &Server{DBAPIs: &dbapis.Handler{Client: dbapis.New()}}
	body := []byte(`{"key":"no-such-key","query":"x"}`)
	w := signedCall(t, s, "POST", "/v1/databases/query", body)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var res map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if res["ok"] != false || !strings.Contains(res["error"].(string), "没有可用的公开 API") {
		t.Fatalf("query result: %+v", res)
	}
}
