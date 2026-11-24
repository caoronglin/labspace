package httpapi

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/url"
	"strings"

	"errors"

	"labspace.local/go-core/internal/oidc"
	"labspace.local/go-core/internal/session"
)

// serveOIDC implements the OpenID Connect endpoints of the portal.
//
// 为什么需要它：门户原先把 Casdoor 当唯一身份源，内网服务（生信实训平台等）
// 要登录就得跳到 Casdoor 的登录页。现在门户自己做 IdP —— Go 核心用标准库
// 手写最小 OIDC Provider（见 internal/oidc），这里只是把它接到 HTTP 上：
//
//	GET  /.well-known/openid-configuration   discovery
//	GET  /.well-known/jwks.json               公钥集合
//	GET  /authorize                           授权端点（凭门户会话识别用户）
//	POST /token                               令牌端点（code → id_token/access_token）
//	GET  /userinfo                            用户信息
//
// 授权端点不自己做口令校验：口令校验留在门户后端（bcrypt 哈希在那里），
// 未登录时这里把用户送回门户登录页，登录后自动回到 authorize 继续。
func (s *Server) serveOIDC(w http.ResponseWriter, r *http.Request) {
	p := s.OIDC
	if p == nil {
		deny(w, 503, "oidc provider unavailable")
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/v1/oidc")
	switch path {
	case "/.well-known/openid-configuration":
		jsonResponse(w, 200, p.DiscoveryFor(s.oidcIssuer(r)))
	case "/.well-known/jwks.json":
		jsonResponse(w, 200, p.JWKS())
	case "/authorize":
		s.oidcAuthorize(w, r, p)
	case "/token":
		s.oidcToken(w, r, p)
	case "/userinfo":
		s.oidcUserinfo(w, r, p)
	default:
		deny(w, 404, "unknown oidc endpoint")
	}
}

// oidcAuthorize identifies the user from the portal session and issues a code.
//
// 未登录时把用户送回门户登录页，并带上完整的 authorize URL 作为回跳目标；
// 登录成功后门户会跳回来，这时会话已存在，直接签发授权码。
func (s *Server) oidcAuthorize(w http.ResponseWriter, r *http.Request, p *oidc.Provider) {
	q := r.URL.Query()
	// 校验 client / redirect_uri / PKCE 合法性：不合法的请求不该把用户带去登录页。
	if res := p.Authorize(q, "", ""); res.Error != "" && res.Error != "login_required" {
		jsonResponse(w, 400, map[string]any{"error": res.Error, "error_description": res.Description})
		return
	}
	actor, err := s.sessionActor(r)
	if err != nil {
		// 未登录 → 回门户登录页，back 指回当前 authorize URL。
		loginURL := s.portalLoginURL(r)
		// back 只允许站内相对路径：绝对 URL 或协议相对 URL（//host）都可能被
		// 用来把受害者弹到站外，登录页自身也会再校验一次，这里先收紧。
		back := r.URL.RequestURI()
		if !strings.HasPrefix(back, "/") || strings.HasPrefix(back, "//") {
			back = "/"
		}
		target := loginURL + "?back=" + url.QueryEscape(back)
		http.Redirect(w, r, target, http.StatusFound)
		return
	}
	// 用户已由门户会话确认，直接按该身份签发授权码。
	res := p.AuthorizeFor(q, oidcUserFromActor(actor), s.oidcIssuer(r))
	if res.Error != "" {
		jsonResponse(w, 400, map[string]any{"error": res.Error, "error_description": res.Description})
		return
	}
	// 回跳地址必须在客户端白名单里（provider 内部已校验，这里再确认一次，
	// 保证「将来 provider 改动」也不会把它变成开放重定向）。
	if !p.AllowedRedirect(q.Get("client_id"), res.Redirect) &&
		!sameOrigin(res.Redirect, q.Get("redirect_uri")) {
		jsonResponse(w, 400, map[string]any{"error": "invalid_request", "error_description": "redirect not allowed"})
		return
	}
	http.Redirect(w, r, res.Redirect, http.StatusFound)
}

// oidcToken exchanges an authorization code for tokens.
func (s *Server) oidcToken(w http.ResponseWriter, r *http.Request, p *oidc.Provider) {
	if r.Method != http.MethodPost {
		deny(w, 405, "token endpoint requires POST")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if err != nil {
		deny(w, 400, "cannot read request body")
		return
	}
	form, err := url.ParseQuery(string(body))
	if err != nil {
		deny(w, 400, "invalid form body")
		return
	}
	// client_secret_basic 也支持：Authorization: Basic base64(id:secret)
	clientID, clientSecret := form.Get("client_id"), form.Get("client_secret")
	if h := r.Header.Get("Authorization"); strings.HasPrefix(strings.ToLower(h), "basic ") {
		raw, decErr := base64Decode(strings.TrimSpace(h[len("basic "):]))
		if decErr == nil {
			if id, secret, ok := strings.Cut(raw, ":"); ok {
				clientID, clientSecret = id, secret
			}
		}
	}
	res, err := p.Token(clientID, clientSecret, form.Get("code"), form.Get("redirect_uri"), form.Get("code_verifier"))
	if err != nil {
		jsonResponse(w, 400, map[string]any{"error": "invalid_grant", "error_description": err.Error()})
		return
	}
	jsonResponse(w, 200, map[string]any{
		"access_token": res.AccessToken,
		"id_token":     res.IDToken,
		"token_type":   res.TokenType,
		"expires_in":   res.ExpiresIn,
	})
}

// oidcUserinfo returns the claims of the presented access token.
func (s *Server) oidcUserinfo(w http.ResponseWriter, r *http.Request, p *oidc.Provider) {
	token := ""
	if h := r.Header.Get("Authorization"); len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		token = strings.TrimSpace(h[7:])
	}
	if token == "" {
		deny(w, 401, "missing access token")
		return
	}
	claims, err := p.Userinfo(token)
	if err != nil {
		deny(w, 401, "invalid access token")
		return
	}
	jsonResponse(w, 200, claims)
}

// sameOrigin reports whether two URLs share scheme+host+port.
func sameOrigin(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	ua, errA := url.Parse(a)
	ub, errB := url.Parse(b)
	if errA != nil || errB != nil {
		return false
	}
	return ua.Scheme == ub.Scheme && ua.Host == ub.Host
}

// errNoSession signals that the request carries no valid portal session.
var errNoSession = errors.New("no portal session")

// sessionActor resolves the portal session carried by the request.
func (s *Server) sessionActor(r *http.Request) (session.Actor, error) {
	if s.Session == nil {
		return session.Actor{}, errNoSession
	}
	return s.Session.FromRequest(r)
}

// oidcUserFromActor maps a portal session actor to an OIDC subject.
func oidcUserFromActor(a session.Actor) oidc.User {
	email := strings.ToLower(strings.TrimSpace(a.Email))
	sub := a.Sub
	if sub == "" {
		sub = email
	}
	name := a.Name
	if name == "" {
		name = email
	}
	return oidc.User{Subject: sub, Email: email, Name: name, Roles: a.Roles}
}

// publicBase builds the portal's own base URL as seen by the client.
//
// 只采信白名单里的入口主机：X-Forwarded-Host 是客户端可控的，若直接拿它拼
// 回跳地址就成了开放重定向（攻击者能让受害者被弹到外部站点）。白名单为空时
// 退回部署时配置的固定 PublicURL —— 宁严不宽。
func (s *Server) publicBase(r *http.Request) string {
	// Prefer the current entry host when it is explicitly allowed. This keeps
	// LAN and Tailscale sessions on the same host instead of redirecting a
	// Tailscale-authenticated user to the LAN issuer (where the Cookie is absent).
	host := r.Header.Get("X-Forwarded-Host")
	if host == "" {
		host = r.Host
	}
	if s.hostAllowed(host) {
		proto := r.Header.Get("X-Forwarded-Proto")
		if proto != "http" && proto != "https" {
			proto = "http"
		}
		return proto + "://" + host
	}
	if s.PublicURL != "" {
		return strings.TrimRight(s.PublicURL, "/")
	}
	if !s.hostAllowed(host) {
		host = s.DefaultEntryHost
	}
	if host == "" {
		return ""
	}
	proto := r.Header.Get("X-Forwarded-Proto")
	if proto == "" {
		proto = "http"
	}
	return proto + "://" + host
}

// hostAllowed reports whether the entry host is one of the configured ones.
func (s *Server) hostAllowed(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "" {
		return false
	}
	if i := strings.Index(h, ":"); i > 0 {
		h = h[:i]
	}
	for _, allowed := range s.AllowedHosts {
		if strings.EqualFold(strings.TrimSpace(allowed), h) {
			return true
		}
	}
	return false
}

// oidcIssuer is the public OIDC namespace on the current allowed entry host.
func (s *Server) oidcIssuer(r *http.Request) string {
	return strings.TrimRight(s.publicBase(r), "/") + "/oidc"
}

// portalLoginURL points at the portal's own login page.
func (s *Server) portalLoginURL(r *http.Request) string {
	return s.publicBase(r) + "/login"
}

// base64Decode decodes standard base64 (used by HTTP Basic credentials).
func base64Decode(s string) (string, error) {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
