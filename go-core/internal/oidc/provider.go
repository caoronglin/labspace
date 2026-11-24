// Package oidc implements a minimal OpenID Connect Provider.
//
// 为什么自己实现：门户原先把 Casdoor 当唯一身份源，运行时多了一个容器、
// 一套数据库与一条 OIDC 往返。核心诉求只是「让生信实训平台等内网服务能用
// 标准 OIDC 登录」，而 Go 核心要求零第三方依赖（无 go.sum），所以这里用标准库
// （crypto/rsa + encoding/base64 + encoding/json）手写最小可用实现：
//
//   - /.well-known/openid-configuration  discovery
//   - /.well-known/jwks.json              公钥集合
//   - /authorize                          授权端点（authorization code + PKCE）
//   - /token                              令牌端点（code → id_token/access_token）
//   - /userinfo                           用户信息端点
//
// 安全取舍：
//   - 仅支持 PKCE（S256）+ 客户端密钥校验；不实现 implicit flow。
//   - code 一次性、短时效，绑定 client_id / redirect_uri / code_challenge。
//   - 私钥不出进程，仅公钥通过 JWKS 暴露。
package oidc

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Config describes the provider and its registered clients.
type Config struct {
	// Issuer is the provider's default base URL. HTTP handlers may override it
	// per request when the portal is reachable through multiple allowed hosts.
	Issuer string
	// Clients maps client_id to its secret (empty secret = public client,
	// which then must use PKCE).
	Clients map[string]string
	// RedirectURIs maps client_id to the allowed redirect URIs.
	RedirectURIs map[string][]string
	// TokenTTL is how long an issued token stays valid.
	TokenTTL time.Duration
	// CodeTTL is how long an authorization code stays valid.
	CodeTTL time.Duration
	// KeyID identifies the signing key in JWKS.
	KeyID string
}

// User is the authenticated subject presented to clients.
type User struct {
	Subject string
	Email   string
	Name    string
	Roles   []string
}

// Authorizer resolves the subject for a login request (username/password).
// It is injected by the caller so the provider stays storage-agnostic.
type Authorizer func(username, password string) (User, error)

// Provider is the OIDC provider instance.
type Provider struct {
	cfg    Config
	key    *rsa.PrivateKey
	keyID  string
	auth   Authorizer
	mu     sync.Mutex
	codes  map[string]*code
	issued map[string]int64 // tokenID -> expiry (unix seconds)
}

type code struct {
	clientID    string
	redirectURI string
	challenge   string
	nonce       string
	issuer      string
	user        User
	expires     time.Time
	used        bool
}

// New builds a provider with a freshly generated RSA signing key.
func New(cfg Config, auth Authorizer) (*Provider, error) {
	if cfg.Issuer == "" {
		return nil, errors.New("oidc: issuer is required")
	}
	if cfg.TokenTTL <= 0 {
		cfg.TokenTTL = time.Hour
	}
	if cfg.CodeTTL <= 0 {
		cfg.CodeTTL = 5 * time.Minute
	}
	if cfg.KeyID == "" {
		cfg.KeyID = "labspace-1"
	}
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, fmt.Errorf("oidc: generate key: %w", err)
	}
	return &Provider{
		cfg:    cfg,
		key:    k,
		keyID:  cfg.KeyID,
		auth:   auth,
		codes:  map[string]*code{},
		issued: map[string]int64{},
	}, nil
}

// issuerFor resolves the per-request issuer override, falling back to config.
func (p *Provider) issuerFor(override []string) string {
	if len(override) > 0 && strings.TrimSpace(override[0]) != "" {
		return strings.TrimRight(strings.TrimSpace(override[0]), "/")
	}
	return strings.TrimRight(p.cfg.Issuer, "/")
}

// JWKS returns the public key set.
func (p *Provider) JWKS() map[string]any {
	pub := p.key.PublicKey
	return map[string]any{
		"keys": []map[string]any{{
			"kty": "RSA",
			"use": "sig",
			"alg": "RS256",
			"kid": p.keyID,
			"n":   base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
			"e":   base64.RawURLEncoding.EncodeToString(bigEndian(pub.E)),
		}},
	}
}

// Discovery returns the provider metadata document.
func (p *Provider) Discovery() map[string]any {
	return p.DiscoveryFor(p.cfg.Issuer)
}

// DiscoveryFor publishes provider metadata for a specific allowed entry host.
// The issuer must match the host that issued the authorization code so clients
// can validate id_token.iss without being bounced to another portal address.
func (p *Provider) DiscoveryFor(issuer string) map[string]any {
	iss := strings.TrimRight(issuer, "/")
	return map[string]any{
		"issuer":                                iss,
		"authorization_endpoint":                iss + "/authorize",
		"token_endpoint":                        iss + "/token",
		"userinfo_endpoint":                     iss + "/userinfo",
		"jwks_uri":                              iss + "/.well-known/jwks.json",
		"response_types_supported":              []string{"code"},
		"subject_types_supported":               []string{"public"},
		"id_token_signing_alg_values_supported": []string{"RS256"},
		"scopes_supported":                      []string{"openid", "profile", "email", "groups"},
		"token_endpoint_auth_methods_supported": []string{"client_secret_post", "client_secret_basic", "none"},
		"code_challenge_methods_supported":      []string{"S256"},
		"claims_supported":                      []string{"sub", "email", "name", "groups", "preferred_username"},
	}
}

// AuthorizeResult is the outcome of a successful authorization.
type AuthorizeResult struct {
	// Redirect is where the user agent should be sent (with code & state).
	Redirect string
	// Error is a machine-readable error code when the request was rejected.
	Error string
	// Description explains the error in words.
	Description string
}

// Authorize validates an authorization request and, when the credentials are
// correct, issues a one-time authorization code.
//
// The flow is deliberately the "same page" form used by simple internal
// providers: the portal renders a small login form for this endpoint, posts
// username/password back, and the server answers with a redirect.
func (p *Provider) Authorize(query url.Values, username, password string, issuer ...string) AuthorizeResult {
	clientID := query.Get("client_id")
	redirectURI := query.Get("redirect_uri")
	state := query.Get("state")
	challenge := query.Get("code_challenge")
	method := query.Get("code_challenge_method")
	nonce := query.Get("nonce")

	if clientID == "" {
		return AuthorizeResult{Error: "invalid_request", Description: "client_id is required"}
	}
	secret, ok := p.cfg.Clients[clientID]
	if !ok {
		return AuthorizeResult{Error: "unauthorized_client", Description: "unknown client"}
	}
	if !p.redirectAllowed(clientID, redirectURI) {
		return AuthorizeResult{Error: "invalid_request", Description: "redirect_uri not allowed"}
	}
	if challenge == "" {
		return AuthorizeResult{Error: "invalid_request", Description: "code_challenge is required"}
	}
	if method != "S256" {
		return AuthorizeResult{Error: "invalid_request", Description: "code_challenge_method must be S256"}
	}

	// Public clients (no secret) still need PKCE; confidential clients may
	// authenticate later at the token endpoint.
	if secret == "" && challenge == "" {
		return AuthorizeResult{Error: "invalid_request", Description: "PKCE required for public clients"}
	}

	if username != "" || password != "" {
		if p.auth == nil {
			return AuthorizeResult{Error: "server_error", Description: "login not configured"}
		}
		u, err := p.auth(username, password)
		if err != nil {
			return AuthorizeResult{Error: "access_denied", Description: "invalid credentials"}
		}
		c := &code{
			clientID:    clientID,
			redirectURI: redirectURI,
			challenge:   challenge,
			nonce:       nonce,
			issuer:      p.issuerFor(issuer),
			user:        u,
			expires:     time.Now().Add(p.cfg.CodeTTL),
		}
		value, err := randomToken(32)
		if err != nil {
			return AuthorizeResult{Error: "server_error", Description: "无法生成授权码"}
		}
		p.mu.Lock()
		p.gcLocked()
		p.codes[value] = c
		p.mu.Unlock()

		sep := "?"
		if strings.Contains(redirectURI, "?") {
			sep = "&"
		}
		return AuthorizeResult{Redirect: fmt.Sprintf("%s%scode=%s&state=%s", redirectURI, sep, urlEscape(value), urlEscape(state))}
	}
	// No credentials supplied yet: the caller should render the login form.
	return AuthorizeResult{Error: "login_required", Description: "credentials required"}
}

// AuthorizeFor issues an authorization code for an already identified user.
//
// It exists because the portal authenticates the user with its own session
// (the password hash lives in the portal backend), so by the time the code
// flow reaches the authorize endpoint the subject is already known and only
// the client / redirect / PKCE checks remain.
func (p *Provider) AuthorizeFor(query url.Values, u User, issuer ...string) AuthorizeResult {
	clientID := query.Get("client_id")
	redirectURI := query.Get("redirect_uri")
	state := query.Get("state")
	challenge := query.Get("code_challenge")
	method := query.Get("code_challenge_method")
	nonce := query.Get("nonce")

	if clientID == "" {
		return AuthorizeResult{Error: "invalid_request", Description: "client_id is required"}
	}
	if _, ok := p.cfg.Clients[clientID]; !ok {
		return AuthorizeResult{Error: "unauthorized_client", Description: "unknown client"}
	}
	if !p.redirectAllowed(clientID, redirectURI) {
		return AuthorizeResult{Error: "invalid_request", Description: "redirect_uri not allowed"}
	}
	if challenge == "" {
		return AuthorizeResult{Error: "invalid_request", Description: "code_challenge is required"}
	}
	if method != "S256" {
		return AuthorizeResult{Error: "invalid_request", Description: "code_challenge_method must be S256"}
	}
	if u.Subject == "" {
		return AuthorizeResult{Error: "access_denied", Description: "no subject"}
	}

	c := &code{
		clientID:    clientID,
		redirectURI: redirectURI,
		challenge:   challenge,
		nonce:       nonce,
		issuer:      p.issuerFor(issuer),
		user:        u,
		expires:     time.Now().Add(p.cfg.CodeTTL),
	}
	value, err := randomToken(32)
	if err != nil {
		return AuthorizeResult{Error: "server_error", Description: "无法生成授权码"}
	}
	p.mu.Lock()
	p.gcLocked()
	p.codes[value] = c
	p.mu.Unlock()

	sep := "?"
	if strings.Contains(redirectURI, "?") {
		sep = "&"
	}
	return AuthorizeResult{Redirect: fmt.Sprintf("%s%scode=%s&state=%s", redirectURI, sep, urlEscape(value), urlEscape(state))}
}

// TokenResult is a successful token-endpoint response.
type TokenResult struct {
	AccessToken string
	IDToken     string
	TokenType   string
	ExpiresIn   int
}

// Token exchanges an authorization code for tokens.
func (p *Provider) Token(clientID, clientSecret, codeValue, redirectURI, codeVerifier string) (TokenResult, error) {
	secret, ok := p.cfg.Clients[clientID]
	if !ok {
		return TokenResult{}, errors.New("unknown client")
	}
	if secret != "" {
		if clientSecret == "" {
			return TokenResult{}, errors.New("client_secret required")
		}
		if subtleEqual(secret, clientSecret) == false {
			return TokenResult{}, errors.New("invalid client_secret")
		}
	}

	p.mu.Lock()
	c, found := p.codes[codeValue]
	if found {
		// One-time use: burn the code regardless of the outcome.
		delete(p.codes, codeValue)
	}
	p.mu.Unlock()
	if !found {
		return TokenResult{}, errors.New("invalid or expired code")
	}
	if time.Now().After(c.expires) {
		return TokenResult{}, errors.New("expired code")
	}
	if c.clientID != clientID {
		return TokenResult{}, errors.New("client mismatch")
	}
	if redirectURI != "" && c.redirectURI != redirectURI {
		return TokenResult{}, errors.New("redirect_uri mismatch")
	}
	// PKCE: verify S256(code_verifier) == code_challenge.
	if c.challenge != "" {
		sum := sha256.Sum256([]byte(codeVerifier))
		got := base64.RawURLEncoding.EncodeToString(sum[:])
		if subtleEqual(got, c.challenge) == false {
			return TokenResult{}, errors.New("PKCE verification failed")
		}
	}

	now := time.Now()
	jti, err := randomToken(16)
	if err != nil {
		return TokenResult{}, err
	}
	claims := map[string]any{
		"iss":                strings.TrimRight(c.issuer, "/"),
		"aud":                clientID,
		"sub":                c.user.Subject,
		"email":              c.user.Email,
		"preferred_username": c.user.Email,
		"name":               c.user.Name,
		"groups":             c.user.Roles,
		"iat":                now.Unix(),
		"exp":                now.Add(p.cfg.TokenTTL).Unix(),
		"jti":                jti,
	}
	if c.nonce != "" {
		claims["nonce"] = c.nonce
	}
	idToken, err := p.sign(claims)
	if err != nil {
		return TokenResult{}, err
	}
	jti2, err := randomToken(16)
	if err != nil {
		return TokenResult{}, err
	}
	// access_token 也带上用户声明：userinfo 端点只拿到 access_token，
	// 若这里只有 sub，客户端就拿不到邮箱与角色。
	accessToken, err := p.sign(map[string]any{
		"iss":                claims["iss"],
		"aud":                clientID,
		"sub":                c.user.Subject,
		"email":              c.user.Email,
		"preferred_username": c.user.Email,
		"name":               c.user.Name,
		"groups":             c.user.Roles,
		"scope":              "openid profile email groups",
		"iat":                now.Unix(),
		"exp":                now.Add(p.cfg.TokenTTL).Unix(),
		"jti":                jti2,
	})
	if err != nil {
		return TokenResult{}, err
	}
	p.mu.Lock()
	issuedID, _ := claims["jti"].(string)
	issuedExp, _ := claimInt64(claims["exp"])
	p.issued[issuedID] = issuedExp
	p.mu.Unlock()

	return TokenResult{
		AccessToken: accessToken,
		IDToken:     idToken,
		TokenType:   "Bearer",
		ExpiresIn:   int(p.cfg.TokenTTL.Seconds()),
	}, nil
}

// Userinfo returns the claims for an issued access token.
func (p *Provider) Userinfo(accessToken string) (map[string]any, error) {
	claims, err := p.verify(accessToken)
	if err != nil {
		return nil, err
	}
	exp, ok := claimInt64(claims["exp"])
	if !ok || exp < time.Now().Unix() {
		return nil, errors.New("token expired")
	}
	return map[string]any{
		"sub":                claims["sub"],
		"email":              claims["email"],
		"preferred_username": claims["email"],
		"name":               claims["name"],
		"groups":             claims["groups"],
	}, nil
}

// sign produces a compact JWS (RS256) for the given claims.
func (p *Provider) sign(claims map[string]any) (string, error) {
	header := map[string]any{"alg": "RS256", "typ": "JWT", "kid": p.keyID}
	hb, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	cb, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	signing := base64.RawURLEncoding.EncodeToString(hb) + "." + base64.RawURLEncoding.EncodeToString(cb)
	sum := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, p.key, crypto.SHA256, sum[:])
	if err != nil {
		return "", err
	}
	return signing + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

// verify checks the signature and expiry of a token issued by this provider.
func (p *Provider) verify(token string) (map[string]any, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("malformed token")
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(&p.key.PublicKey, crypto.SHA256, sum[:], sig); err != nil {
		return nil, errors.New("bad signature")
	}
	cb, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, err
	}
	claims := make(map[string]any)
	if err := json.Unmarshal(cb, &claims); err != nil {
		return nil, err
	}
	return claims, nil
}

// AllowedRedirect reports whether the redirect URI is registered for the client.
// Callers use it to re-validate a redirect target right before responding.
func (p *Provider) AllowedRedirect(clientID, redirectURI string) bool {
	return p.redirectAllowed(clientID, redirectURI)
}

// redirectAllowed checks the redirect URI against the client's allow-list.
// Exact match, or prefix match for "https://host/path/*" style entries.
func (p *Provider) redirectAllowed(clientID, redirectURI string) bool {
	if redirectURI == "" {
		return false
	}
	for _, allowed := range p.cfg.RedirectURIs[clientID] {
		if allowed == redirectURI {
			return true
		}
		if strings.HasSuffix(allowed, "/*") {
			if strings.HasPrefix(redirectURI, strings.TrimSuffix(allowed, "*")) {
				return true
			}
		}
	}
	return false
}

// gcLocked drops expired codes. Caller holds p.mu.
func (p *Provider) gcLocked() {
	now := time.Now()
	for k, c := range p.codes {
		if now.After(c.expires) {
			delete(p.codes, k)
		}
	}
}

// randomToken returns a URL-safe random string with n bytes of entropy.
//
// crypto/rand 失败时返回错误而不是 panic：这是库代码，调用方能决定如何降级，
// 而库内 panic 会把一个可处理的错误放大成进程崩溃。
func randomToken(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("oidc: crypto/rand unavailable: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// bigEndian encodes an RSA public exponent as a big-endian byte slice.
func bigEndian(e int) []byte {
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], uint64(e))
	i := 0
	for i < len(b)-1 && b[i] == 0 {
		i++
	}
	return b[i:]
}

// subtleEqual compares two strings in constant time.
func subtleEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := 0; i < len(a); i++ {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}

// claimInt64 reads an integer claim. JSON numbers decode to float64, so a
// plain type assertion to int64 would panic on every token.
func claimInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case int64:
		return n, true
	case int:
		return int64(n), true
	case float64:
		return int64(n), true
	case json.Number:
		i, err := n.Int64()
		return i, err == nil
	default:
		return 0, false
	}
}

// urlEscape percent-encodes a value for use in a query string.
func urlEscape(v string) string {
	var b strings.Builder
	for i := 0; i < len(v); i++ {
		c := v[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
			continue
		}
		const hex = "0123456789ABCDEF"
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&0x0f])
	}
	return b.String()
}
