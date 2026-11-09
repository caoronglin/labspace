package session

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

const secret = "test-secret-value-0123456789"

func sign(t *testing.T, claims map[string]any) string {
	t.Helper()
	header, _ := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	payload, _ := json.Marshal(claims)
	enc := base64.RawURLEncoding.EncodeToString
	body := enc(header) + "." + enc(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(body))
	return body + "." + enc(mac.Sum(nil))
}

func verifier(t *testing.T) *Verifier {
	t.Helper()
	v, err := New([]byte(secret), Options{AdminRoles: []string{"lab-admin"}, TeacherRoles: []string{"lab-teacher"}})
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func request(cookie string, headers map[string]string) *http.Request {
	r := httptest.NewRequest("GET", "http://portal.local/api/next/files", nil)
	if cookie != "" {
		r.AddCookie(&http.Cookie{Name: "labspace_session", Value: cookie})
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

func TestValidSessionCookie(t *testing.T) {
	v := verifier(t)
	token := sign(t, map[string]any{
		"sub": "uuid-1", "email": "student01@local", "name": "学生一",
		"roles": []string{"lab-student", "bioinfo-student"}, "iat": 1, "exp": time.Now().Add(time.Hour).Unix(),
	})
	actor, err := v.FromRequest(request(token, nil))
	if err != nil {
		t.Fatal(err)
	}
	if actor.Email != "student01@local" || actor.Admin || actor.LocalPart() != "student01" {
		t.Fatalf("unexpected actor: %+v", actor)
	}
	if !actor.HasRole("lab-student") {
		t.Fatal("roles lost")
	}
}

func TestAdminRoleIsRecognised(t *testing.T) {
	v := verifier(t)
	token := sign(t, map[string]any{"sub": "u", "email": "admin@local", "roles": []string{"lab-admin"}, "exp": time.Now().Add(time.Hour).Unix()})
	actor, err := v.FromRequest(request(token, nil))
	if err != nil {
		t.Fatal(err)
	}
	if !actor.Admin {
		t.Fatal("admin role ignored")
	}
}

func TestTamperedSignatureRejected(t *testing.T) {
	v := verifier(t)
	token := sign(t, map[string]any{"sub": "u", "email": "a@local", "exp": time.Now().Add(time.Hour).Unix()})
	tampered := token[:len(token)-2] + "xy"
	if _, err := v.FromRequest(request(tampered, nil)); err == nil {
		t.Fatal("tampered token accepted")
	}
}

func TestExpiredSessionRejected(t *testing.T) {
	v := verifier(t)
	token := sign(t, map[string]any{"sub": "u", "email": "a@local", "exp": time.Now().Add(-time.Minute).Unix()})
	if _, err := v.FromRequest(request(token, nil)); err == nil {
		t.Fatal("expired session accepted")
	}
}

func TestWrongSecretRejected(t *testing.T) {
	other := []byte("another-secret-value-98765")
	token := sign(t, map[string]any{"sub": "u", "email": "a@local", "exp": time.Now().Add(time.Hour).Unix()})
	v, _ := New(other, Options{})
	if _, err := v.FromRequest(request(token, nil)); err == nil {
		t.Fatal("token signed with another secret accepted")
	}
}

func TestBearerTokenAccepted(t *testing.T) {
	v := verifier(t)
	token := sign(t, map[string]any{"sub": "u", "email": "a@local", "exp": time.Now().Add(time.Hour).Unix()})
	r := httptest.NewRequest("GET", "http://portal.local/api/next/files", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	if _, err := v.FromRequest(r); err != nil {
		t.Fatal(err)
	}
}

func TestCSRFRequiresDoubleSubmit(t *testing.T) {
	v := verifier(t)
	r := httptest.NewRequest("POST", "http://portal.local/api/next/files", nil)
	r.AddCookie(&http.Cookie{Name: "labspace_csrf", Value: "csrf-token"})
	r.Header.Set("X-CSRF-Token", "csrf-token")
	if err := v.CheckCSRF(r); err != nil {
		t.Fatal(err)
	}

	missing := httptest.NewRequest("POST", "http://portal.local/api/next/files", nil)
	missing.AddCookie(&http.Cookie{Name: "labspace_csrf", Value: "csrf-token"})
	if err := v.CheckCSRF(missing); err == nil {
		t.Fatal("missing header accepted")
	}

	mismatch := httptest.NewRequest("POST", "http://portal.local/api/next/files", nil)
	mismatch.AddCookie(&http.Cookie{Name: "labspace_csrf", Value: "csrf-token"})
	mismatch.Header.Set("X-CSRF-Token", "other")
	if err := v.CheckCSRF(mismatch); err == nil {
		t.Fatal("mismatched token accepted")
	}

	get := httptest.NewRequest("GET", "http://portal.local/api/next/files", nil)
	if err := v.CheckCSRF(get); err != nil {
		t.Fatal("safe method must not require csrf")
	}
}

func TestCSRFRejectsForeignOrigin(t *testing.T) {
	v, err := New([]byte(secret), Options{AllowedOrigins: []string{"http://192.0.2.10"}})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "http://192.0.2.10/api/next/files", nil)
	r.Header.Set("Origin", "http://evil.example")
	if err := v.CheckCSRF(r); err == nil {
		t.Fatal("foreign origin accepted")
	}
	ok := httptest.NewRequest("POST", "http://192.0.2.10/api/next/files", nil)
	ok.Header.Set("Origin", "http://192.0.2.10")
	ok.AddCookie(&http.Cookie{Name: "labspace_csrf", Value: "csrf-token"})
	ok.Header.Set("X-CSRF-Token", "csrf-token")
	if err := v.CheckCSRF(ok); err != nil {
		t.Fatal(err)
	}
}

func TestRevokedSessionIsRefused(t *testing.T) {
	calls := map[string]int{}
	at := time.Now().Unix()
	source := func(_ context.Context, subject string) (int64, bool, error) {
		calls[subject]++
		if subject == "uuid-revoked" {
			return at, true, nil
		}
		return 0, false, nil
	}
	v, err := New([]byte(secret), Options{Revoked: source, RevocationTTL: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	revoked := sign(t, map[string]any{
		"sub": "uuid-revoked", "email": "student01@local",
		"iat": at - 60, "exp": time.Now().Add(time.Hour).Unix(),
	})
	if _, err := v.FromRequest(request(revoked, nil)); err == nil {
		t.Fatal("session issued before the revocation was accepted")
	}
	reissued := sign(t, map[string]any{
		"sub": "uuid-revoked", "email": "student01@local",
		"iat": at + 60, "exp": time.Now().Add(time.Hour).Unix(),
	})
	if _, err := v.FromRequest(request(reissued, nil)); err != nil {
		t.Fatalf("session issued after the revocation was refused: %v", err)
	}
	fresh := sign(t, map[string]any{
		"sub": "uuid-clean", "email": "student02@local",
		"iat": at - 60, "exp": time.Now().Add(time.Hour).Unix(),
	})
	actor, err := v.FromRequest(request(fresh, nil))
	if err != nil {
		t.Fatalf("unrelated account refused: %v", err)
	}
	if actor.Email != "student02@local" {
		t.Fatalf("unexpected actor: %+v", actor)
	}
	if calls["uuid-revoked"] != 1 || calls["uuid-clean"] != 1 {
		t.Fatalf("revocation lookups are not cached: %+v", calls)
	}
}

func TestRevocationLookupFailureKeepsTheLabWorking(t *testing.T) {
	v, err := New([]byte(secret), Options{
		Revoked: func(_ context.Context, _ string) (int64, bool, error) {
			return 0, false, errors.New("database is down")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	token := sign(t, map[string]any{
		"sub": "uuid-1", "email": "student01@local",
		"iat": 1, "exp": time.Now().Add(time.Hour).Unix(),
	})
	if _, err := v.FromRequest(request(token, nil)); err != nil {
		t.Fatalf("a database blip must not log everybody out: %v", err)
	}
}
