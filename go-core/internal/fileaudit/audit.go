// Package fileaudit records file preview/download activity so administrators can
// see who opened which file and when. Rows are retained for 90 days.
package fileaudit

import (
	"context"
	"database/sql"
	"time"
)

type Store struct{ DB *sql.DB }

type Event struct {
	ID     int64     `json:"id"`
	UserID string    `json:"userId"`
	Source string    `json:"source"`
	Path   string    `json:"path"`
	Name   string    `json:"name"`
	Action string    `json:"action"`
	Bytes  int64     `json:"bytes"`
	Status int       `json:"status"`
	At     time.Time `json:"at"`
}

// Record appends one access event. A nil store is a no-op so the file routes
// keep working when PostgreSQL is unavailable.
func (s *Store) Record(ctx context.Context, e Event) error {
	if s == nil || s.DB == nil {
		return nil
	}
	_, err := s.DB.ExecContext(ctx,
		`INSERT INTO labspace.file_events (user_id, source, path, name, action, bytes, status)
		 VALUES (?,?,?,?,?,?,?)`,
		e.UserID, e.Source, e.Path, e.Name, e.Action, e.Bytes, e.Status)
	return err
}

// List returns the newest events first, optionally filtered by user and action.
// It also prunes rows past the retention window: the admin panel is the only
// reader, so sweeping here keeps the table bounded without a background job.
func (s *Store) List(ctx context.Context, userID, action string, limit int) ([]Event, error) {
	if s == nil || s.DB == nil {
		return []Event{}, nil
	}
	if limit < 1 || limit > 200 {
		limit = 50
	}
	_, _ = s.DB.ExecContext(ctx,
		`DELETE FROM labspace.file_events WHERE at < now() - interval '90 days'`)
	query := `SELECT id, user_id, source, path, name, action, bytes, status, at
	          FROM labspace.file_events WHERE true`
	args := []any{}
	if userID != "" {
		query += ` AND user_id = ?`
		args = append(args, userID)
	}
	if action != "" {
		query += ` AND action = ?`
		args = append(args, action)
	}
	query += ` ORDER BY at DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.ID, &e.UserID, &e.Source, &e.Path, &e.Name, &e.Action, &e.Bytes, &e.Status, &e.At); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
