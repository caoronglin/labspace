package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"labspace.local/go-core/internal/catalog"
	"labspace.local/go-core/internal/embed"
	"labspace.local/go-core/internal/health"
)

// serveServices exposes the portal service catalog and its liveness probes.
//
// The catalog is public (like the Python portal route it replaces); entries
// that are role gated stay hidden for callers without a session.
func (s *Server) serveServices(w http.ResponseWriter, r *http.Request, q map[string][]string) {
	if s.Catalog == nil {
		deny(w, 503, "catalog unavailable")
		return
	}
	host := r.Host
	roles := []string{}
	if s.Session != nil {
		if actor, err := s.actorFromRequest(r); err == nil {
			roles = actor.Roles
		}
	}
	_ = q

	switch {
	case r.URL.Path == "/v1/services" && r.Method == "GET":
		items := s.Catalog.Live(host, roles)
		jsonResponse(w, 200, map[string]any{"services": items, "count": len(items)})

	case r.URL.Path == "/v1/services/health" && r.Method == "GET":
		items := s.Catalog.Live(host, roles)
		out := make([]map[string]any, 0, len(items))
		for _, it := range items {
			entry := map[string]any{
				"id": it.ID, "name": it.Name, "description": it.Description,
				"category": it.Category, "url": it.URL, "icon": it.Icon,
				"openMode": it.OpenMode, "embed": it.Embed, "embedUrl": it.EmbedURL,
				"ssoUrl": it.SSOURL, "langNote": it.LangNote, "tags": it.Tags,
				"roles": it.Roles, "notes": it.Notes, "guide": it.Guide,
				"external": it.External,
				"health":   s.probeService(it),
			}
			// 外部内网服务的故障归外部主机，不计入本机巡检失败
			if it.External && entry["health"].(health.Result).Status == "down" {
				res := entry["health"].(health.Result)
				res.Status = "external-down"
				res.Detail = res.Detail + "（外部内网服务，需在 192.0.2.29 上恢复）"
				entry["health"] = res
			}
			out = append(out, entry)
		}
		jsonResponse(w, 200, map[string]any{"services": out})

	case strings.HasPrefix(r.URL.Path, "/v1/services/") && strings.HasSuffix(r.URL.Path, "/embed") && r.Method == "GET":
		id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1/services/"), "/embed")
		it, ok := s.Catalog.Find(id)
		if !ok {
			deny(w, 404, "服务不存在")
			return
		}
		adapted := catalog.AdaptItem(it, r.Host)
		target := adapted.EmbedURL
		if target == "" {
			target = adapted.URL
		}
		res := s.Embed.Check(embed.Target{
			ID:         adapted.ID,
			Name:       adapted.Name,
			URL:        target,
			SSOURL:     adapted.SSOURL,
			Embeddable: adapted.Embed,
			Ancestor:   ancestorOrigin(r),
		})
		res.URL = target
		res.SSOURL = adapted.SSOURL
		jsonResponse(w, 200, res)

	case strings.HasPrefix(r.URL.Path, "/v1/services/") && strings.HasSuffix(r.URL.Path, "/sso") && r.Method == "GET":
		id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1/services/"), "/sso")
		it, ok := s.Catalog.Find(id)
		if !ok {
			deny(w, 404, "服务不存在")
			return
		}
		adapted := catalog.AdaptItem(it, r.Host)
		jsonResponse(w, 200, map[string]any{
			"id":     adapted.ID,
			"name":   adapted.Name,
			"ssoUrl": adapted.SSOURL,
			"url":    adapted.URL,
			"hasSso": adapted.SSOURL != "",
		})

	case strings.HasPrefix(r.URL.Path, "/v1/services/") && strings.HasSuffix(r.URL.Path, "/health") && r.Method == "GET":
		id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1/services/"), "/health")
		it, ok := s.Catalog.Find(id)
		if !ok {
			deny(w, 404, "服务不存在")
			return
		}
		res := s.probeService(it)
		jsonResponse(w, 200, res)

	default:
		deny(w, 404, "unknown route")
	}
}

// ancestorOrigin 返回门户页面自身的源（frame-ancestors 匹配用）。
func ancestorOrigin(r *http.Request) string {
	proto := r.Header.Get("x-forwarded-proto")
	if proto == "" {
		proto = "http"
		if r.TLS != nil {
			proto = "https"
		}
	}
	return proto + "://" + r.Host
}

// probeService runs the configured health probe for one service.
func (s *Server) probeService(it catalog.Item) health.Result {
	if s.Health == nil {
		return health.Result{Status: "unknown", Detail: "健康检查未启用"}
	}
	if it.Health.URL == "" {
		return health.Result{Status: "not-configured"}
	}
	target := health.Target{
		URL:           s.Endpoints.Resolve(it.Health.URL),
		Kind:          health.Kind(it.Health.Kind),
		Host:          it.Health.Host,
		MaxAgeSeconds: it.Health.MaxAgeSecond,
	}
	return s.Health.Check(target)
}

// actorFromRequest resolves the session actor when a valid session cookie is
// present. Public routes treat a missing session as an anonymous caller.
func (s *Server) actorFromRequest(r *http.Request) (actor, error) {
	if s.Session == nil {
		return actor{}, errors.New("session verifier unavailable")
	}
	a, err := s.Session.FromRequest(r)
	if err != nil {
		return actor{}, err
	}
	return actor{
		UserID: a.UserID, TenantID: a.Tenant, Email: a.Email,
		Roles: a.Roles, Admin: a.Admin, Teacher: a.Teacher,
	}, nil
}
