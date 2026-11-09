// Package portal stores per-user portal state: favorites and recent visits.
// It replaces the Python backend/app/db.py favorites/recent functions while
// keeping the exact response shapes of the routes it replaces.
package portal

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
)

const recentKeep = 12

type Store struct{ DB *sql.DB }

func (s *Store) ListFavorites(ctx context.Context, userID string) ([]string, error) {
	rows, err := s.DB.QueryContext(ctx,
		`SELECT service_id FROM labspace.favorites WHERE user_id=? ORDER BY created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *Store) AddFavorite(ctx context.Context, userID, serviceID string) error {
	_, err := s.DB.ExecContext(ctx,
		`INSERT INTO labspace.favorites (user_id, service_id) VALUES (?,?) ON CONFLICT DO NOTHING`,
		userID, serviceID)
	return err
}

func (s *Store) RemoveFavorite(ctx context.Context, userID, serviceID string) error {
	_, err := s.DB.ExecContext(ctx,
		`DELETE FROM labspace.favorites WHERE user_id=? AND service_id=?`, userID, serviceID)
	return err
}

func (s *Store) ListRecent(ctx context.Context, userID string, limit int) ([]string, error) {
	if limit < 1 || limit > recentKeep {
		limit = recentKeep
	}
	rows, err := s.DB.QueryContext(ctx,
		`SELECT service_id FROM labspace.recent WHERE user_id=? ORDER BY visited_at DESC LIMIT ?`,
		userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *Store) TouchRecent(ctx context.Context, userID, serviceID string, keep int) error {
	if keep < 1 || keep > recentKeep {
		keep = recentKeep
	}
	if _, err := s.DB.ExecContext(ctx,
		`INSERT INTO labspace.recent (user_id, service_id, visited_at) VALUES (?,?, now())
		 ON CONFLICT (user_id, service_id) DO UPDATE SET visited_at = now()`,
		userID, serviceID); err != nil {
		return err
	}
	_, err := s.DB.ExecContext(ctx,
		`DELETE FROM labspace.recent WHERE user_id=? AND service_id NOT IN (
			SELECT service_id FROM labspace.recent WHERE user_id=? ORDER BY visited_at DESC LIMIT ?
		)`, userID, userID, keep)
	return err
}

// Handler serves /v1/favorites and /v1/recent. Authentication and CSRF are
// already enforced by httpapi.Server before the request reaches here.
type Handler struct {
	Store *Store
	// ServiceExists rejects favorites for unknown services, exactly like the
	// Python route (404 "服务不存在").
	ServiceExists func(string) bool
}

func (h *Handler) Serve(w http.ResponseWriter, r *http.Request, userID string) {
	if h == nil || h.Store == nil || h.Store.DB == nil {
		writeJSON(w, 503, map[string]string{"error": "portal storage unavailable"})
		return
	}
	ctx := r.Context()
	switch {
	case r.URL.Path == "/v1/favorites" && r.Method == http.MethodGet:
		items, err := h.Store.ListFavorites(ctx, userID)
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": "list favorites failed"})
			return
		}
		writeJSON(w, 200, map[string]any{"favorites": items})

	case strings.HasPrefix(r.URL.Path, "/v1/favorites/") && r.Method == http.MethodPost:
		id := strings.TrimPrefix(r.URL.Path, "/v1/favorites/")
		if id == "" || strings.Contains(id, "/") {
			writeJSON(w, 404, map[string]string{"detail": "服务不存在"})
			return
		}
		if h.ServiceExists != nil && !h.ServiceExists(id) {
			writeJSON(w, 404, map[string]string{"detail": "服务不存在"})
			return
		}
		if err := h.Store.AddFavorite(ctx, userID, id); err != nil {
			writeJSON(w, 500, map[string]string{"error": "add favorite failed"})
			return
		}
		items, err := h.Store.ListFavorites(ctx, userID)
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": "list favorites failed"})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "favorites": items})

	case strings.HasPrefix(r.URL.Path, "/v1/favorites/") && r.Method == http.MethodDelete:
		id := strings.TrimPrefix(r.URL.Path, "/v1/favorites/")
		if id == "" || strings.Contains(id, "/") {
			writeJSON(w, 404, map[string]string{"detail": "服务不存在"})
			return
		}
		if err := h.Store.RemoveFavorite(ctx, userID, id); err != nil {
			writeJSON(w, 500, map[string]string{"error": "remove favorite failed"})
			return
		}
		items, err := h.Store.ListFavorites(ctx, userID)
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": "list favorites failed"})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "favorites": items})

	case r.URL.Path == "/v1/recent" && r.Method == http.MethodGet:
		items, err := h.Store.ListRecent(ctx, userID, recentKeep)
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": "list recent failed"})
			return
		}
		writeJSON(w, 200, map[string]any{"recent": items})

	case strings.HasPrefix(r.URL.Path, "/v1/recent/") && r.Method == http.MethodPost:
		id := strings.TrimPrefix(r.URL.Path, "/v1/recent/")
		if id == "" || strings.Contains(id, "/") {
			writeJSON(w, 404, map[string]string{"detail": "服务不存在"})
			return
		}
		if err := h.Store.TouchRecent(ctx, userID, id, recentKeep); err != nil {
			writeJSON(w, 500, map[string]string{"error": "touch recent failed"})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})

	default:
		writeJSON(w, 404, map[string]string{"error": "route not found"})
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
