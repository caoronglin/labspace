package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"

	"labspace.local/go-core/internal/labfiles"
)

// serveAdmin implements the internal account-provisioning API. It is only
// reachable with the portal service token, never with a browser session, and
// is not proxied by nginx.
func (s *Server) serveAdmin(w http.ResponseWriter, r *http.Request, a actor) {
	if a.UserID != "service" || strings.TrimSpace(r.Header.Get("X-Lab-Service-Token")) == "" {
		deny(w, 403, "service token required")
		return
	}
	if s.Files == nil {
		deny(w, 503, "file registry unavailable")
		return
	}
	switch {
	case r.URL.Path == "/v1/admin/provision" && r.Method == http.MethodPost:
		var req struct {
			Name string `json:"name"`
		}
		if err := decodeAdminJSON(r, &req); err != nil {
			deny(w, 400, "invalid request body")
			return
		}
		res, err := s.Files.ProvisionUser(req.Name)
		if err != nil {
			adminError(w, err)
			return
		}
		jsonResponse(w, 200, res)
	case r.URL.Path == "/v1/admin/deprovision" && r.Method == http.MethodPost:
		var req struct {
			Name string `json:"name"`
		}
		if err := decodeAdminJSON(r, &req); err != nil {
			deny(w, 400, "invalid request body")
			return
		}
		res, err := s.Files.DeprovisionUser(req.Name)
		if err != nil {
			// The identities are already gone from the ACL even when the
			// directory removal failed; the caller aborts and ProvisionUser
			// repairs, so only the error is surfaced here.
			adminError(w, err)
			return
		}
		jsonResponse(w, 200, res)
	case r.URL.Path == "/v1/admin/file-access" && r.Method == http.MethodGet:
		jsonResponse(w, 200, map[string]any{
			"scopes":      s.Files.AccountGrants(),
			"directories": s.Files.Directories(),
			"groups":      s.Files.FileGroups(),
		})
	case strings.HasPrefix(r.URL.Path, "/v1/admin/personal-access/") && r.Method == http.MethodGet:
		name, err := url.PathUnescape(strings.TrimPrefix(r.URL.Path, "/v1/admin/personal-access/"))
		if err != nil || name == "" || strings.Contains(name, "/") {
			deny(w, 400, "invalid account name")
			return
		}
		jsonResponse(w, 200, map[string]any{"scopes": s.Files.PersonalAccess(name)})
	case strings.HasPrefix(r.URL.Path, "/v1/admin/personal-access/") && r.Method == http.MethodPut:
		name, err := url.PathUnescape(strings.TrimPrefix(r.URL.Path, "/v1/admin/personal-access/"))
		if err != nil || name == "" || strings.Contains(name, "/") {
			deny(w, 400, "invalid account name")
			return
		}
		var req struct {
			Grants []labfiles.Grant `json:"grants"`
		}
		if err := decodeAdminJSON(r, &req); err != nil {
			deny(w, 400, "invalid request body")
			return
		}
		scopes, err := s.Files.SetPersonalAccess(name, req.Grants)
		if err != nil {
			adminError(w, err)
			return
		}
		jsonResponse(w, 200, map[string]any{"ok": true, "scopes": scopes})
	case strings.HasPrefix(r.URL.Path, "/v1/admin/file-access/") && r.Method == http.MethodPut:
		name, err := url.PathUnescape(strings.TrimPrefix(r.URL.Path, "/v1/admin/file-access/"))
		if err != nil || name == "" || strings.Contains(name, "/") {
			deny(w, 400, "invalid account name")
			return
		}
		var req struct {
			Grants []labfiles.Grant `json:"grants"`
		}
		if err := decodeAdminJSON(r, &req); err != nil {
			deny(w, 400, "invalid request body")
			return
		}
		scopes, err := s.Files.SetFileGrants(name, req.Grants)
		if err != nil {
			adminError(w, err)
			return
		}
		jsonResponse(w, 200, map[string]any{"ok": true, "scopes": scopes})
	case r.URL.Path == "/v1/admin/acl/audit" && r.Method == http.MethodPost:
		// 只读巡检：把「授权对象没了 / 目录没了 / 非教师组能写课题目录」找出来。
		// 不改任何数据，所以 POST 也只需要服务令牌，不需要 CSRF。
		report := s.Files.AuditACL()
		jsonResponse(w, 200, map[string]any{
			"identities": report.Identities,
			"groups":     report.Groups,
			"findings":   report.Findings,
			"checkedAt":  report.CheckedAt,
			"clean":      !report.HasFindings(),
		})
	case r.URL.Path == "/v1/admin/file-groups" && r.Method == http.MethodGet:
		jsonResponse(w, 200, map[string]any{"groups": s.Files.FileGroups()})
	case strings.HasPrefix(r.URL.Path, "/v1/admin/file-groups/") && r.Method == http.MethodPut:
		name, err := url.PathUnescape(strings.TrimPrefix(r.URL.Path, "/v1/admin/file-groups/"))
		if err != nil || name == "" || strings.Contains(name, "/") {
			deny(w, 400, "invalid group name")
			return
		}
		var req struct {
			Grants []labfiles.Grant `json:"grants"`
		}
		if err := decodeAdminJSON(r, &req); err != nil {
			deny(w, 400, "invalid request body")
			return
		}
		grants, err := s.Files.SetGroupGrants(name, req.Grants)
		if err != nil {
			adminError(w, err)
			return
		}
		jsonResponse(w, 200, map[string]any{"ok": true, "name": name, "grants": grants})
	case strings.HasPrefix(r.URL.Path, "/v1/admin/file-groups/") && r.Method == http.MethodDelete:
		name, err := url.PathUnescape(strings.TrimPrefix(r.URL.Path, "/v1/admin/file-groups/"))
		if err != nil || name == "" {
			deny(w, 400, "invalid group name")
			return
		}
		if err := s.Files.DeleteFileGroup(name); err != nil {
			adminError(w, err)
			return
		}
		jsonResponse(w, 200, map[string]any{"ok": true})
	case r.URL.Path == "/v1/admin/file-access-preview" && r.Method == http.MethodPost:
		// 预演用的是与会话完全相同的身份字段，因此"看起来能访问"和"实际能访问"
		// 不会各说一套。角色由统一身份源提供，Go 侧不重复维护成员关系。
		var req struct {
			Name  string   `json:"name"`
			Email string   `json:"email"`
			Roles []string `json:"roles"`
			Admin bool     `json:"admin"`
		}
		if err := decodeAdminJSON(r, &req); err != nil {
			deny(w, 400, "invalid request body")
			return
		}
		name := strings.ToLower(strings.TrimSpace(req.Name))
		if name == "" {
			deny(w, 400, "account name is required")
			return
		}
		email := strings.ToLower(strings.TrimSpace(req.Email))
		if email == "" {
			email = name
		}
		probes := s.Files.PreviewAccess(labfiles.Identity{UserID: name, Email: email, Roles: req.Roles, Admin: req.Admin})
		jsonResponse(w, 200, map[string]any{"name": name, "probes": probes})
	default:
		deny(w, 404, "route not found")
	}
}

func decodeAdminJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 8<<10))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func adminError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, labfiles.ErrInvalidPath), errors.Is(err, labfiles.ErrNotFound):
		deny(w, 400, err.Error())
	case errors.Is(err, labfiles.ErrACLStore):
		log.Printf("admin ACL store: %v", err)
		deny(w, 503, "ACL store unavailable")
	default:
		log.Printf("admin provisioning: %v", err)
		deny(w, 500, "provisioning failed")
	}
}
