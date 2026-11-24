package oidc

import (
	"crypto/sha256"
	"encoding/base64"
	"net/url"
	"strings"
	"testing"
	"time"
)

func testProvider(t *testing.T) *Provider {
	t.Helper()
	p, err := New(Config{
		Issuer:       "https://portal.example",
		Clients:      map[string]string{"bioinfo": "s3cret"},
		RedirectURIs: map[string][]string{"bioinfo": {"https://bio.example/apps/bioinfo/auth/callback"}},
		TokenTTL:     time.Hour,
		CodeTTL:      5 * time.Minute,
		KeyID:        "test-1",
	}, func(u, p string) (User, error) {
		if u == "student01" && p == "good" {
			return User{Subject: "u1", Email: "student01@lab.local", Name: "E2E", Roles: []string{"lab-student"}}, nil
		}
		return User{}, errBadCreds
	})
	if err != nil {
		t.Fatalf("new provider: %v", err)
	}
	return p
}

var errBadCreds = &credsError{}

type credsError struct{}

func (*credsError) Error() string { return "invalid credentials" }

func s256(challenge string) string {
	// 测试里用固定 verifier，直接算 S256
	return s256Of("verifier-123")
}

func s256Of(v string) string {
	sum := sha256.Sum256([]byte(v))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func authorize(t *testing.T, p *Provider) (string, url.Values) {
	t.Helper()
	q := url.Values{
		"client_id":             {"bioinfo"},
		"redirect_uri":          {"https://bio.example/apps/bioinfo/auth/callback"},
		"state":                 {"st-1"},
		"code_challenge":        {s256("verifier-123")},
		"code_challenge_method": {"S256"},
		"nonce":                 {"n-1"},
	}
	res := p.Authorize(q, "student01", "good")
	if res.Error != "" {
		t.Fatalf("authorize failed: %s %s", res.Error, res.Description)
	}
	u, err := url.Parse(res.Redirect)
	if err != nil {
		t.Fatalf("bad redirect: %v", err)
	}
	return u.Query().Get("code"), q
}

func TestAuthorizeAndToken(t *testing.T) {
	p := testProvider(t)
	code, _ := authorize(t, p)

	res, err := p.Token("bioinfo", "s3cret", code, "https://bio.example/apps/bioinfo/auth/callback", "verifier-123")
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	if res.IDToken == "" || res.AccessToken == "" || res.TokenType != "Bearer" {
		t.Fatalf("bad token result: %+v", res)
	}
	if res.ExpiresIn != 3600 {
		t.Fatalf("expires_in=%d", res.ExpiresIn)
	}

	// id_token 可被 userinfo 端点接受，且 claims 正确
	ui, err := p.Userinfo(res.AccessToken)
	if err != nil {
		t.Fatalf("userinfo: %v", err)
	}
	if ui["sub"] != "u1" || ui["email"] != "student01@lab.local" {
		t.Fatalf("bad claims: %+v", ui)
	}
}

func TestCodeIsOneTime(t *testing.T) {
	p := testProvider(t)
	code, _ := authorize(t, p)
	if _, err := p.Token("bioinfo", "s3cret", code, "https://bio.example/apps/bioinfo/auth/callback", "verifier-123"); err != nil {
		t.Fatalf("first token: %v", err)
	}
	if _, err := p.Token("bioinfo", "s3cret", code, "https://bio.example/apps/bioinfo/auth/callback", "verifier-123"); err == nil {
		t.Fatal("authorization code reused")
	}
}

func TestPKCEMismatch(t *testing.T) {
	p := testProvider(t)
	code, _ := authorize(t, p)
	if _, err := p.Token("bioinfo", "s3cret", code, "https://bio.example/apps/bioinfo/auth/callback", "wrong-verifier"); err == nil {
		t.Fatal("bad PKCE verifier accepted")
	}
}

func TestWrongClientSecret(t *testing.T) {
	p := testProvider(t)
	code, _ := authorize(t, p)
	if _, err := p.Token("bioinfo", "nope", code, "https://bio.example/apps/bioinfo/auth/callback", "verifier-123"); err == nil {
		t.Fatal("bad client secret accepted")
	}
}

func TestRedirectNotAllowed(t *testing.T) {
	p := testProvider(t)
	q := url.Values{
		"client_id":             {"bioinfo"},
		"redirect_uri":          {"https://evil.example/steal"},
		"code_challenge":        {s256("verifier-123")},
		"code_challenge_method": {"S256"},
	}
	res := p.Authorize(q, "student01", "good")
	if res.Error != "invalid_request" {
		t.Fatalf("redirect_uri not rejected: %+v", res)
	}
}

func TestBadCredentials(t *testing.T) {
	p := testProvider(t)
	q := url.Values{
		"client_id":             {"bioinfo"},
		"redirect_uri":          {"https://bio.example/apps/bioinfo/auth/callback"},
		"code_challenge":        {s256("verifier-123")},
		"code_challenge_method": {"S256"},
	}
	res := p.Authorize(q, "student01", "wrong")
	if res.Error != "access_denied" {
		t.Fatalf("bad credentials accepted: %+v", res)
	}
}

func TestDiscoveryAndJWKS(t *testing.T) {
	p := testProvider(t)
	d := p.Discovery()
	if d["issuer"] != "https://portal.example" {
		t.Fatalf("issuer: %v", d["issuer"])
	}
	if !strings.Contains(d["authorization_endpoint"].(string), "/authorize") {
		t.Fatalf("authorization_endpoint: %v", d["authorization_endpoint"])
	}
	jwks := p.JWKS()
	keys, ok := jwks["keys"].([]map[string]any)
	if !ok || len(keys) != 1 {
		t.Fatalf("jwks: %+v", jwks)
	}
	if keys[0]["kty"] != "RSA" || keys[0]["alg"] != "RS256" {
		t.Fatalf("bad jwk: %+v", keys[0])
	}
}

func TestDiscoveryForEntryHost(t *testing.T) {
	p := testProvider(t)
	issuer := "http://100.66.114.71/oidc"
	d := p.DiscoveryFor(issuer)
	if d["issuer"] != issuer {
		t.Fatalf("issuer: %v", d["issuer"])
	}
	if d["authorization_endpoint"] != issuer+"/authorize" || d["token_endpoint"] != issuer+"/token" {
		t.Fatalf("endpoints: %v", d)
	}
}

func TestTokenIssuerMatchesAuthorizationEntry(t *testing.T) {
	p := testProvider(t)
	issuer := "http://100.66.114.71/oidc"
	q := url.Values{
		"client_id":             {"bioinfo"},
		"redirect_uri":          {"https://bio.example/apps/bioinfo/auth/callback"},
		"state":                 {"st-1"},
		"code_challenge":        {s256("verifier-123")},
		"code_challenge_method": {"S256"},
	}
	res := p.AuthorizeFor(q, User{Subject: "u1", Email: "student01@lab.local", Name: "E2E"}, issuer)
	if res.Error != "" {
		t.Fatalf("authorize: %+v", res)
	}
	u, err := url.Parse(res.Redirect)
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := p.Token("bioinfo", "s3cret", u.Query().Get("code"), q.Get("redirect_uri"), "verifier-123")
	if err != nil {
		t.Fatal(err)
	}
	claims, err := p.verify(tokens.IDToken)
	if err != nil {
		t.Fatal(err)
	}
	if claims["iss"] != issuer {
		t.Fatalf("id_token issuer: %v", claims["iss"])
	}
}

func TestTokenSignatureVerified(t *testing.T) {
	p := testProvider(t)
	code, _ := authorize(t, p)
	res, err := p.Token("bioinfo", "s3cret", code, "https://bio.example/apps/bioinfo/auth/callback", "verifier-123")
	if err != nil {
		t.Fatal(err)
	}
	// 篡改 payload 后签名校验必须失败
	parts := strings.Split(res.IDToken, ".")
	if len(parts) != 3 {
		t.Fatalf("malformed id_token: %s", res.IDToken)
	}
	tampered := parts[0] + "." + base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"attacker"}`)) + "." + parts[2]
	if _, err := p.verify(tampered); err == nil {
		t.Fatal("tampered token accepted")
	}
}
