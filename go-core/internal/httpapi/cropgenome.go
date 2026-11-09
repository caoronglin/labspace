package httpapi

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// CropGenome describes the downstream CropGenome Toolkit service that the
// core fronts. The toolkit is an independent service with its own
// authentication model: it expects the identity of the caller to be asserted
// by an OIDC-aware reverse proxy through three headers.
//
// The core plays that role: it validates the portal session itself and only
// then forwards the request with the verified claims attached. The toolkit
// never sees a browser cookie and never trusts a client supplied identity.
type CropGenome struct {
	// BaseURL is the toolkit origin, e.g. http://127.0.0.1:8095.
	BaseURL string
	// Issuer and Audience must match the toolkit configuration; the toolkit
	// rejects a mismatch.
	Issuer   string
	Audience string
	// Timeout bounds a single upstream call.
	Timeout time.Duration
}

// serveCropGenome validates the portal session and proxies the request to the
// CropGenome toolkit with verified OIDC claims injected.
func (s *Server) serveCropGenome(w http.ResponseWriter, r *http.Request) {
	if s.CropGenome == nil || s.CropGenome.BaseURL == "" {
		deny(w, 503, "cropgenome backend unavailable")
		return
	}
	if s.Session == nil {
		deny(w, 401, "unauthenticated")
		return
	}
	actor, err := s.Session.FromRequest(r)
	if err != nil {
		deny(w, 401, "unauthenticated")
		return
	}
	// Mutating calls need the same CSRF proof as the rest of the portal.
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
	default:
		if err := s.Session.CheckCSRF(r); err != nil {
			deny(w, 403, "csrf verification failed")
			return
		}
	}
	base, err := url.Parse(s.CropGenome.BaseURL)
	if err != nil || base.Scheme == "" || base.Host == "" {
		deny(w, 503, "cropgenome backend misconfigured")
		return
	}
	// /cropgenome/<rest> → upstream /<rest>
	rest := strings.TrimPrefix(r.URL.Path, "/cropgenome")
	if rest == "" {
		rest = "/"
	}
	target := *base
	target.Path = strings.TrimSuffix(base.Path, "/") + rest
	target.RawQuery = r.URL.RawQuery

	ctx, cancel := context.WithTimeout(r.Context(), s.CropGenome.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, r.Method, target.String(), r.Body)
	if err != nil {
		deny(w, 502, "cropgenome request failed")
		return
	}
	for k, vs := range r.Header {
		switch strings.ToLower(k) {
		case "host", "cookie", "x-oidc-subject", "x-oidc-issuer", "x-oidc-audience", "x-oidc-role",
			"x-crop-dev-user", "x-crop-dev-admin":
			// Identity headers are set by the core, never by the caller.
			continue
		}
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	req.Header.Set("X-OIDC-Subject", actor.Email)
	req.Header.Set("X-OIDC-Issuer", s.CropGenome.Issuer)
	req.Header.Set("X-OIDC-Audience", s.CropGenome.Audience)
	if actor.Admin {
		req.Header.Set("X-OIDC-Role", "admin")
	} else {
		req.Header.Set("X-OIDC-Role", "user")
	}

	client := &http.Client{
		Timeout: s.CropGenome.Timeout,
		Transport: &http.Transport{
			DialContext:         (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
			MaxIdleConnsPerHost: 8,
			IdleConnTimeout:     30 * time.Second,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := client.Do(req)
	if err != nil {
		deny(w, 502, "cropgenome upstream unreachable")
		return
	}
	defer resp.Body.Close()
	for k, vs := range resp.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}
