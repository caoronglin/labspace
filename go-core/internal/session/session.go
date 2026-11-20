// Package session verifies the LabSpace portal session (HS256 JWT issued by the
// FastAPI backend) so that the Go service can authenticate browser requests
// directly.
//
// The Go service is therefore not dependent on the Python gateway in the request
// path: nginx can route a path straight to Go, and Go applies exactly the same
// session semantics (HttpOnly cookie) plus the same double-submit CSRF rule.
package session

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// RevocationSource reports the Unix second from which a subject's sessions are
// invalid: any token issued before that instant must be refused. The second
// return value is false when the subject has never been revoked.
//
// The portal session is a stateless HS256 JWT, so without this lookup neither
// disabling nor deleting an account stops a cookie that is still inside its
// validity window.
type RevocationSource func(ctx context.Context, subject string) (int64, bool, error)

// Options carries the portal-side configuration the verifier must honour.
type Options struct {
	CookieName     string
	CSRFCookieName string
	AllowedOrigins []string
	AdminRoles     []string
	TeacherRoles   []string
	Now            func() time.Time
	Revoked        RevocationSource
	// RevocationTTL bounds how long a revocation lookup is cached. Short by
	// design: the whole point is that revocation bites quickly.
	RevocationTTL time.Duration
}

// Actor is the verified portal user.
type Actor struct {
	UserID  string   `json:"user_id"`
	Sub     string   `json:"sub"`
	Email   string   `json:"email"`
	Name    string   `json:"name"`
	Roles   []string `json:"roles"`
	Tenant  string   `json:"tenant"`
	Admin   bool     `json:"admin"`
	Teacher bool     `json:"teacher"`
	// PwdReset marks a session whose account still has the initial (or an
	// admin-set) password. Every service that honours the portal session must
	// refuse such a token for anything but the password-change endpoints,
	// otherwise "change your password first" is only enforced on the Python
	// routes and Go/nginx-proxied paths stay a back door.
	PwdReset bool `json:"pwd_reset"`
}

// HasRole reports whether the actor carries the given role (case-insensitive).
func (a Actor) HasRole(role string) bool {
	for _, r := range a.Roles {
		if strings.EqualFold(r, role) {
			return true
		}
	}
	return false
}

// LocalPart returns the mailbox part of the actor email (student01@local ->
// student01). The lab file tree uses that name for per-user directories.
func (a Actor) LocalPart() string {
	if i := strings.Index(a.Email, "@"); i > 0 {
		return a.Email[:i]
	}
	return a.Email
}

// Verifier validates portal sessions.
type Verifier struct {
	secret   []byte
	opts     Options
	revokeMu sync.Mutex
	revoke   map[string]revocationEntry
}

type revocationEntry struct {
	at    int64
	fetch time.Time
}

// New builds a verifier. The secret must be the portal's
// LABSPACE_SESSION_SECRET so both services accept the same session cookie.
func New(secret []byte, opts Options) (*Verifier, error) {
	if len(secret) < 16 {
		return nil, errors.New("session secret must be at least 16 bytes")
	}
	if opts.CookieName == "" {
		opts.CookieName = "labspace_session"
	}
	if opts.CSRFCookieName == "" {
		opts.CSRFCookieName = "labspace_csrf"
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.RevocationTTL <= 0 {
		opts.RevocationTTL = 15 * time.Second
	}
	return &Verifier{
		secret: append([]byte{}, secret...),
		opts:   opts,
		revoke: map[string]revocationEntry{},
	}, nil
}

// revokedAt returns the instant the subject's sessions became invalid.
// Lookups are cached for RevocationTTL; failures are not cached and are
// treated as "not revoked" so a database blip cannot log the lab out.
func (v *Verifier) revokedAt(ctx context.Context, subject string) (int64, bool) {
	if v.opts.Revoked == nil || subject == "" || subject == "service" {
		return 0, false
	}
	now := v.opts.Now()
	v.revokeMu.Lock()
	if e, ok := v.revoke[subject]; ok && now.Sub(e.fetch) < v.opts.RevocationTTL {
		v.revokeMu.Unlock()
		return e.at, e.at > 0
	}
	v.revokeMu.Unlock()

	at, found, err := v.opts.Revoked(ctx, subject)
	if err != nil {
		log.Printf("WARN: session revocation lookup for %q failed: %v (session accepted)", subject, err)
		return 0, false
	}
	if found && at <= 0 {
		at = now.Unix()
	}
	if !found {
		at = 0
	}
	v.revokeMu.Lock()
	v.revoke[subject] = revocationEntry{at: at, fetch: now}
	v.revokeMu.Unlock()
	return at, at > 0
}

// FromRequest verifies the session carried by the request (cookie first, then
// Bearer) and returns the actor.
func (v *Verifier) FromRequest(r *http.Request) (Actor, error) {
	token := ""
	if h := r.Header.Get("Authorization"); len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		token = strings.TrimSpace(h[7:])
	} else if c, err := r.Cookie(v.opts.CookieName); err == nil {
		token = c.Value
	}
	if token == "" {
		return Actor{}, errors.New("no session token")
	}
	claims, err := v.verify(token)
	if err != nil {
		return Actor{}, err
	}
	roles := toStrings(claims["roles"])
	actor := Actor{
		Sub:    stringClaim(claims, "sub"),
		Email:  strings.ToLower(strings.TrimSpace(stringClaim(claims, "email"))),
		Name:   stringClaim(claims, "name"),
		Roles:  roles,
		Tenant: "lab",

		PwdReset: boolClaim(claims, "pwd_reset"),
	}
	if actor.Email == "" {
		actor.Email = actor.Sub
	}
	// UserID 必须是会话里的用户主键（JWT 的 sub，即 PostgreSQL 里的 user id），
	// 不能用邮箱：工作台等接口按 user_id 列过滤，邮箱会查不到行。
	// 邮箱保留在 Actor.Email，需要按邮箱做的匹配（如文件作用域）走它。
	actor.UserID = actor.Sub
	if actor.UserID == "" {
		actor.UserID = actor.Email
	}
	if at, revoked := v.revokedAt(r.Context(), actor.Sub); revoked {
		if iat := intClaim(claims, "iat"); iat == 0 || iat < at {
			return Actor{}, errors.New("session revoked")
		}
	}
	for _, r := range roles {
		for _, admin := range v.opts.AdminRoles {
			if strings.EqualFold(r, admin) {
				actor.Admin = true
			}
		}
		for _, t := range v.opts.TeacherRoles {
			if strings.EqualFold(r, t) {
				actor.Teacher = true
			}
		}
	}
	return actor, nil
}

// CheckCSRF applies the portal's double-submit rule to mutating requests.
func (v *Verifier) CheckCSRF(r *http.Request) error {
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return nil
	}
	if origin := r.Header.Get("Origin"); origin != "" && !v.originAllowed(origin) {
		return errors.New("origin not allowed")
	}
	if h := r.Header.Get("Authorization"); len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		// Bearer callers cannot be cross-site forms; same exemption as the portal.
		return nil
	}
	header := r.Header.Get("X-CSRF-Token")
	cookie, err := r.Cookie(v.opts.CSRFCookieName)
	if err != nil || cookie.Value == "" || header == "" {
		return errors.New("csrf token missing")
	}
	if !hmac.Equal([]byte(header), []byte(cookie.Value)) {
		return errors.New("csrf token mismatch")
	}
	return nil
}

func (v *Verifier) originAllowed(origin string) bool {
	if len(v.opts.AllowedOrigins) == 0 {
		return true
	}
	for _, allowed := range v.opts.AllowedOrigins {
		if strings.EqualFold(strings.TrimRight(origin, "/"), strings.TrimRight(allowed, "/")) {
			return true
		}
	}
	return false
}

func (v *Verifier) verify(token string) (map[string]any, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("malformed session token")
	}
	headerRaw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, errors.New("malformed session header")
	}
	var header struct {
		Alg string `json:"alg"`
		Typ string `json:"typ"`
	}
	if err := json.Unmarshal(headerRaw, &header); err != nil {
		return nil, errors.New("malformed session header")
	}
	if header.Alg != "HS256" {
		return nil, errors.New("unsupported session algorithm")
	}
	mac := hmac.New(sha256.New, v.secret)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	expected := mac.Sum(nil)
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(sig, expected) {
		return nil, errors.New("bad session signature")
	}
	payloadRaw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, errors.New("malformed session payload")
	}
	var claims map[string]any
	if err := json.Unmarshal(payloadRaw, &claims); err != nil {
		return nil, errors.New("malformed session payload")
	}
	now := v.opts.Now().Unix()
	// 令牌必须带 exp：缺失即视为无效（避免出现「永不过期」的会话）
	exp := intClaim(claims, "exp")
	if exp == 0 {
		return nil, errors.New("session missing exp")
	}
	if now >= exp {
		return nil, errors.New("session expired")
	}
	if nbf := intClaim(claims, "nbf"); nbf != 0 && now < nbf {
		return nil, errors.New("session not yet valid")
	}
	return claims, nil
}

func stringClaim(claims map[string]any, key string) string {
	if v, ok := claims[key].(string); ok {
		return v
	}
	return ""
}

func boolClaim(claims map[string]any, key string) bool {
	switch v := claims[key].(type) {
	case bool:
		return v
	case string:
		return v == "true" || v == "1"
	case float64:
		return v != 0
	}
	return false
}

func intClaim(claims map[string]any, key string) int64 {
	switch v := claims[key].(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case json.Number:
		n, _ := v.Int64()
		return n
	}
	return 0
}

func toStrings(value any) []string {
	out := []string{}
	switch v := value.(type) {
	case []any:
		for _, item := range v {
			if s, ok := item.(string); ok && s != "" {
				out = append(out, s)
			}
		}
	case string:
		for _, part := range strings.Split(v, ",") {
			if p := strings.TrimSpace(part); p != "" {
				out = append(out, p)
			}
		}
	}
	return out
}
