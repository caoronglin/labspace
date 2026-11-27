package httpapi

import (
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"labspace.local/go-core/internal/oidc"
)

func TestOIDCLoginRedirectUsesPublicPath(t *testing.T) {
	provider, err := oidc.New(oidc.Config{
		Issuer:  "http://192.0.2.10/oidc",
		Clients: map[string]string{"bioinfo-training": "secret"},
		RedirectURIs: map[string][]string{
			"bioinfo-training": {"http://192.0.2.10/apps/bioinfo/api/v1/auth/callback"},
		},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{
		PublicURL:        "http://192.0.2.10",
		AllowedHosts:     []string{"192.0.2.10"},
		DefaultEntryHost: "192.0.2.10",
		OIDC:             provider,
	}
	query := url.Values{
		"client_id":             {"bioinfo-training"},
		"redirect_uri":          {"http://192.0.2.10/apps/bioinfo/api/v1/auth/callback"},
		"response_type":         {"code"},
		"state":                 {"state-1"},
		"code_challenge":        {"challenge-1"},
		"code_challenge_method": {"S256"},
	}
	r := httptest.NewRequest("GET", "/v1/oidc/authorize?"+query.Encode(), nil)
	r.Header.Set("X-Forwarded-Host", "192.0.2.10")
	r.Header.Set("X-Forwarded-Proto", "http")
	w := httptest.NewRecorder()
	s.oidcAuthorize(w, r, provider)
	if w.Code != 302 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	location, err := url.Parse(w.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if location.Path != "/login" {
		t.Fatalf("login path=%s", location.Path)
	}
	back := location.Query().Get("back")
	if !strings.HasPrefix(back, "/oidc/authorize?") || strings.Contains(back, "/v1/oidc") {
		t.Fatalf("public OIDC back path leaked internal prefix: %s", back)
	}
}

func TestPublicBaseFollowsAllowedEntryHost(t *testing.T) {
	s := &Server{
		PublicURL:        "http://192.0.2.10",
		AllowedHosts:     []string{"192.0.2.10", "198.51.100.71"},
		DefaultEntryHost: "192.0.2.10",
	}
	r := httptest.NewRequest("GET", "/oidc/.well-known/openid-configuration", nil)
	r.Header.Set("X-Forwarded-Host", "198.51.100.71")
	r.Header.Set("X-Forwarded-Proto", "http")
	if got := s.publicBase(r); got != "http://198.51.100.71" {
		t.Fatalf("allowed entry host: %s", got)
	}
	if got := s.oidcIssuer(r); got != "http://198.51.100.71/oidc" {
		t.Fatalf("oidc issuer: %s", got)
	}
	r.Header.Set("X-Forwarded-Host", "evil.example")
	if got := s.publicBase(r); got != "http://192.0.2.10" {
		t.Fatalf("untrusted host fallback: %s", got)
	}
}
