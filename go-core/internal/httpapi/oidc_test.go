package httpapi

import (
	"net/http/httptest"
	"testing"
)

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
