package workbench

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Store is the workbench data layer. DB is injected so the same code runs
// against the stdlib pgwire driver in production and a mock/fake in tests.
type Store struct {
	DB  *sql.DB
	Now func() time.Time
}

var ErrNotFound = errors.New("not found")

// textArray encodes a Go string slice as a PostgreSQL text array literal.
// database/sql rejects []string as a driver.Value, so the store hands the
// driver a string; pgwire's paramText also understands this form.
func textArray(tags []string) string {
	if len(tags) == 0 {
		return "{}"
	}
	parts := make([]string, len(tags))
	for i, t := range tags {
		t = strings.ReplaceAll(t, `\`, `\\`)
		t = strings.ReplaceAll(t, `"`, `\"`)
		parts[i] = `"` + t + `"`
	}
	return "{" + strings.Join(parts, ",") + "}"
}

func (s *Store) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}
func (s *Store) today() time.Time {
	n := s.now()
	return time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, n.Location())
}

// ---------------------------------------------------------------- output shapes

// scan nullable helper: PostgreSQL text columns arrive as string or nil.
func ns(v any) *string {
	if v == nil {
		return nil
	}
	switch x := v.(type) {
	case string:
		s := x
		if len(s) >= 10 && s[4] == '-' {
			// date/timestamp ISO text passes through unchanged
		}
		return &s
	case []byte:
		s := string(x)
		return &s
	case time.Time:
		s := x.Format(time.RFC3339Nano)
		return &s
	default:
		s := fmt.Sprint(x)
		return &s
	}
}

// nsPtr 把可空列转成 *string：NULL → nil（JSON null），非 NULL → 指针。
func nsPtr(v any) *string {
	if v == nil {
		return nil
	}
	s := deref(ns(v))
	return &s
}

// isoTimestamp 把 PostgreSQL 的文本时间戳规范成 Python 端同样的 ISO-8601。
//
// PostgreSQL 文本格式是 "2026-11-04 22:07:47.078721+08"，Python 的
// datetime.isoformat() 给的是 "2026-11-04T22:07:47.078721+08:00"。
// 两种写法 JS 都能解析，但 Safari 不认 "+08" 这种没有分钟的偏移量，
// 所以这里统一成标准 ISO。
func isoTimestamp(v any) string {
	s := strings.TrimSpace(deref(ns(v)))
	if s == "" {
		return ""
	}
	if i := strings.IndexByte(s, ' '); i > 0 {
		s = s[:i] + "T" + s[i+1:]
	}
	// 结尾的 "+08" / "-05" 补成 "+08:00" / "-05:00"
	if n := len(s); n >= 3 {
		tz := s[n-3:]
		if (tz[0] == '+' || tz[0] == '-') && isDigits(tz[1:]) {
			s += ":00"
		}
	}
	return s
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func nFloat(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int64:
		return float64(x)
	case string:
		var f float64
		_, _ = fmt.Sscan(x, &f)
		return f
	}
	return 0
}

func nInt(v any) int {
	switch x := v.(type) {
	case int64:
		return int(x)
	case float64:
		return int(x)
	case string:
		var i int
		_, _ = fmt.Sscan(x, &i)
		return i
	}
	return 0
}

// parseTags accepts a PostgreSQL text array literal like {"a","b"} or a JSON
// array. Both forms appear depending on the driver.
func parseTags(v any) []string {
	out := []string{}
	if v == nil {
		return out
	}
	switch x := v.(type) {
	case []string:
		return x
	case string:
		s := strings.TrimSpace(x)
		if strings.HasPrefix(s, "{") && strings.HasSuffix(s, "}") {
			inner := strings.TrimSuffix(strings.TrimPrefix(s, "{"), "}")
			for _, part := range strings.Split(inner, ",") {
				part = strings.Trim(strings.TrimSpace(part), `"`)
				if part != "" {
					out = append(out, part)
				}
			}
			return out
		}
		_ = json.Unmarshal([]byte(s), &out)
	}
	return out
}

func scanItemStmt(rows *sql.Rows) (Item, error) {
	var (
		id, userID, kind, title, content, status, priority, source string
		linkSource, linkPath                                       string
		tagsRaw, projectID, planID, dueDate, aiClass, aiReason, created, updated, confidence any
	)
	if err := rows.Scan(&id, &userID, &kind, &title, &content, &status, &priority,
		&tagsRaw, &projectID, &planID, &linkSource, &linkPath, &dueDate, &source, &aiClass, &aiReason,
		&confidence, &created, &updated); err != nil {
		return Item{}, err
	}
	return Item{
		ID: id, UserID: userID, Kind: def(kind, "note"), Title: def(title, ""),
		Content: def(content, ""), Status: def(status, "active"),
		Priority: def(priority, "normal"), Tags: parseTags(tagsRaw),
		ProjectID: nsPtr(projectID), PlanID: nsPtr(planID), DueDate: nsPtr(dueDate),
		LinkSource: def(linkSource, ""), LinkPath: def(linkPath, ""),
		Source: def(source, "manual"), AIClass: nsPtr(aiClass), AIReason: nsPtr(aiReason),
		Confidence: nFloat(confidence), CreatedAt: isoTimestamp(created), UpdatedAt: isoTimestamp(updated),
	}, nil
}

func def(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

const itemCols = `id, user_id, kind, title, content, status, priority, tags, project_id, plan_id, link_source, link_path, due_date, source, ai_class, ai_reason, confidence, created_at, updated_at`
const projectCols = `id, name, description, status, health, progress, next_step, due_date, created_at, updated_at`
const planCols = `id, kind, title, outcome, metrics, horizon, progress, status, next_step, due_date, created_at, updated_at`

func scanProject(rows *sql.Rows) (Project, error) {
	var id, name, desc, status, health, nextStep string
	var progress, due, created, updated any
	if err := rows.Scan(&id, &name, &desc, &status, &health, &progress, &nextStep, &due, &created, &updated); err != nil {
		return Project{}, err
	}
	return Project{ID: id, Name: name, Description: desc, Status: def(status, "active"),
		Health: def(health, "on_track"), Progress: nInt(progress), NextStep: nextStep,
		DueDate: nsPtr(due), CreatedAt: isoTimestamp(created), UpdatedAt: isoTimestamp(updated)}, nil
}

func scanPlan(rows *sql.Rows) (Plan, error) {
	var id, kind, title, outcome, metrics, horizon, status, nextStep string
	var progress, due, created, updated any
	if err := rows.Scan(&id, &kind, &title, &outcome, &metrics, &horizon, &progress, &status, &nextStep, &due, &created, &updated); err != nil {
		return Plan{}, err
	}
	return Plan{ID: id, Kind: def(kind, "direction"), Title: title, Outcome: outcome,
		Metrics: metrics, Horizon: horizon, Progress: nInt(progress), Status: def(status, "active"),
		NextStep: nextStep, DueDate: nsPtr(due), CreatedAt: isoTimestamp(created), UpdatedAt: isoTimestamp(updated)}, nil
}

func scanBrief(rows *sql.Rows) (Brief, error) {
	var date, content any
	var payload any
	if err := rows.Scan(&date, &content, &payload); err != nil {
		return Brief{}, err
	}
	b := Brief{Date: isoTimestamp(date), Content: fmt.Sprint(content), Payload: map[string]any{}}
	if payload != nil {
		raw := ""
		switch x := payload.(type) {
		case string:
			raw = x
		case []byte:
			raw = string(x)
		}
		if raw != "" {
			var obj map[string]any
			if err := json.Unmarshal([]byte(raw), &obj); err == nil && obj != nil {
				b.Payload = obj
			}
		}
	}
	return b, nil
}

// ---------------------------------------------------------------- items

type ItemFilter struct {
	Kind, Status, ProjectID, Query string
	Limit                          int
}

func (s *Store) ListItems(ctx context.Context, userID string, f ItemFilter) ([]Item, int, error) {
	if f.Limit < 1 {
		f.Limit = 50
	}
	if f.Limit > 200 {
		f.Limit = 200
	}
	like := ""
	if f.Query != "" {
		like = "%" + f.Query + "%"
	}
	// 注意：过滤条件里的占位符必须带显式类型（CAST(? AS text)）。
	// PostgreSQL 无法为裸 NULL 参数推断类型，会报
	// "could not determine data type of parameter $N"（42P18）。
	where := `user_id=? AND (CAST(? AS text) IS NULL OR kind=?) AND (CAST(? AS text) IS NULL OR status=?) AND (CAST(? AS text) IS NULL OR project_id=?) AND (CAST(? AS text) IS NULL OR title ILIKE ? OR content ILIKE ?)`
	args := []any{userID, nullIfEmpty(f.Kind), f.Kind, nullIfEmpty(f.Status), f.Status,
		nullIfEmpty(f.ProjectID), f.ProjectID, nullIfEmpty(f.Query), like, like}

	var total int
	if err := s.DB.QueryRowContext(ctx, `SELECT count(*) FROM labspace.workbench_items WHERE `+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	q := `SELECT ` + itemCols + ` FROM labspace.workbench_items WHERE ` + where +
		` ORDER BY (due_date IS NULL), due_date ASC, updated_at DESC LIMIT ?`
	rows, err := s.DB.QueryContext(ctx, q, append(args, f.Limit)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []Item{}
	for rows.Next() {
		it, e := scanItemStmt(rows)
		if e != nil {
			return nil, 0, e
		}
		out = append(out, it)
	}
	return out, total, rows.Err()
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

type ItemCreate struct {
	Kind, Title, Content, Priority, Status string
	Tags                                   []string
	DueDate, ProjectID, PlanID             *string
	LinkSource, LinkPath                   string
}

func (s *Store) CreateItem(ctx context.Context, userID string, in ItemCreate, source string, ai *Analysis) (Item, error) {
	if in.Kind == "" {
		in.Kind = "note"
	}
	if in.Status == "" {
		in.Status = "active"
	}
	if in.Priority == "" {
		in.Priority = "normal"
	}
	title := strings.TrimSpace(in.Title)
	if title == "" {
		lines := strings.Split(strings.TrimSpace(in.Content), "\n")
		if len(lines) > 0 && lines[0] != "" {
			r := []rune(lines[0])
			if len(r) > 60 {
				r = r[:60]
			}
			title = string(r)
		}
	}
	if source == "" {
		source = "manual"
	}
	var aiClass, aiReason any
	var confidence any
	if ai != nil {
		aiClass, aiReason, confidence = ai.Kind, ai.Reason, ai.Confidence
	}
	q := `INSERT INTO labspace.workbench_items
	 (id, user_id, kind, title, content, status, priority, tags, project_id, plan_id, link_source, link_path, due_date, source, ai_class, ai_reason, confidence)
	 VALUES (gen_random_uuid()::text, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ` + itemCols
	rows, err := s.DB.QueryContext(ctx, q, userID, in.Kind, title, in.Content, in.Status,
		in.Priority, textArray(in.Tags), in.ProjectID, in.PlanID, in.LinkSource, in.LinkPath, in.DueDate, source, aiClass, aiReason, confidence)
	if err != nil {
		return Item{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		return Item{}, errors.New("item creation failed")
	}
	return scanItemStmt(rows)
}

// PatchFields is a sparse update. Unlike the Python version (which used a
// CASE-WHEN for every column and rewrote the whole row), this builds a SET
// clause containing only the provided fields — less write amplification and
// fewer locks, with identical semantics.
type PatchFields map[string]any

func buildPatch(fields PatchFields, allowed []string) (string, []any, error) {
	sets := []string{}
	args := []any{}
	for _, col := range allowed {
		v, ok := fields[col]
		if !ok {
			continue
		}
		sets = append(sets, col+"=?")
		args = append(args, v)
	}
	if len(sets) == 0 {
		return "", nil, errors.New("no fields to update")
	}
	sets = append(sets, "updated_at=now()")
	return strings.Join(sets, ", "), args, nil
}

var itemPatchCols = []string{"kind", "title", "content", "tags", "priority", "due_date", "project_id", "plan_id", "status", "link_source", "link_path"}

func (s *Store) PatchItem(ctx context.Context, userID, id string, fields PatchFields) (Item, error) {
	set, args, err := buildPatch(fields, itemPatchCols)
	if err != nil {
		return Item{}, err
	}
	q := `UPDATE labspace.workbench_items SET ` + set + ` WHERE id=? AND user_id=? RETURNING ` + itemCols
	rows, err := s.DB.QueryContext(ctx, q, append(args, id, userID)...)
	if err != nil {
		return Item{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		return Item{}, ErrNotFound
	}
	return scanItemStmt(rows)
}

func (s *Store) DeleteItem(ctx context.Context, userID, id string) error {
	res, err := s.DB.ExecContext(ctx, `DELETE FROM labspace.workbench_items WHERE id=? AND user_id=?`, id, userID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// ---------------------------------------------------------------- projects

func (s *Store) ListProjects(ctx context.Context, userID string) ([]Project, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT `+projectCols+` FROM labspace.workbench_projects WHERE user_id=? ORDER BY (status <> 'active'), updated_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Project{}
	for rows.Next() {
		p, e := scanProject(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

type ProjectCreate struct {
	Name, Description, NextStep, Health, Status string
	DueDate                                     *string
}

func (s *Store) CreateProject(ctx context.Context, userID string, in ProjectCreate) (Project, error) {
	if in.Status == "" {
		in.Status = "active"
	}
	if in.Health == "" {
		in.Health = "on_track"
	}
	q := `INSERT INTO labspace.workbench_projects
	 (id, user_id, name, description, status, health, progress, next_step, due_date)
	 VALUES (gen_random_uuid()::text, ?, ?, ?, ?, ?, 0, ?, ?) RETURNING ` + projectCols
	rows, err := s.DB.QueryContext(ctx, q, userID, strings.TrimSpace(in.Name), in.Description, in.Status, in.Health, in.NextStep, in.DueDate)
	if err != nil {
		return Project{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		return Project{}, errors.New("project creation failed")
	}
	return scanProject(rows)
}

var projectPatchCols = []string{"name", "description", "next_step", "due_date", "health", "status", "progress"}

func (s *Store) PatchProject(ctx context.Context, userID, id string, fields PatchFields) (Project, error) {
	set, args, err := buildPatch(fields, projectPatchCols)
	if err != nil {
		return Project{}, err
	}
	rows, err := s.DB.QueryContext(ctx, `UPDATE labspace.workbench_projects SET `+set+` WHERE id=? AND user_id=? RETURNING `+projectCols, append(args, id, userID)...)
	if err != nil {
		return Project{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		return Project{}, ErrNotFound
	}
	return scanProject(rows)
}

func (s *Store) DeleteProject(ctx context.Context, userID, id string) error {
	res, err := s.DB.ExecContext(ctx, `DELETE FROM labspace.workbench_projects WHERE id=? AND user_id=?`, id, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ---------------------------------------------------------------- plans

func (s *Store) ListPlans(ctx context.Context, userID string) ([]Plan, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT `+planCols+` FROM labspace.workbench_plans WHERE user_id=? ORDER BY (status = 'archived'), kind, updated_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Plan{}
	for rows.Next() {
		p, e := scanPlan(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

type PlanCreate struct {
	Kind, Title, Outcome, Metrics, Horizon, NextStep, Status string
	Progress                                                 int
	DueDate                                                  *string
}

func (s *Store) CreatePlan(ctx context.Context, userID string, in PlanCreate) (Plan, error) {
	if in.Kind == "" {
		in.Kind = "direction"
	}
	if in.Status == "" {
		in.Status = "active"
	}
	q := `INSERT INTO labspace.workbench_plans
	 (id, user_id, kind, title, outcome, metrics, horizon, progress, status, next_step, due_date)
	 VALUES (gen_random_uuid()::text, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ` + planCols
	rows, err := s.DB.QueryContext(ctx, q, userID, in.Kind, strings.TrimSpace(in.Title), in.Outcome,
		in.Metrics, in.Horizon, clamp(in.Progress), in.Status, in.NextStep, in.DueDate)
	if err != nil {
		return Plan{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		return Plan{}, errors.New("plan creation failed")
	}
	return scanPlan(rows)
}

var planPatchCols = []string{"kind", "title", "outcome", "metrics", "horizon", "next_step", "due_date", "progress", "status"}

func (s *Store) PatchPlan(ctx context.Context, userID, id string, fields PatchFields) (Plan, error) {
	set, args, err := buildPatch(fields, planPatchCols)
	if err != nil {
		return Plan{}, err
	}
	rows, err := s.DB.QueryContext(ctx, `UPDATE labspace.workbench_plans SET `+set+` WHERE id=? AND user_id=? RETURNING `+planCols, append(args, id, userID)...)
	if err != nil {
		return Plan{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		return Plan{}, ErrNotFound
	}
	return scanPlan(rows)
}

func (s *Store) DeletePlan(ctx context.Context, userID, id string) error {
	res, err := s.DB.ExecContext(ctx, `DELETE FROM labspace.workbench_plans WHERE id=? AND user_id=?`, id, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func clamp(n int) int {
	if n < 0 {
		return 0
	}
	if n > 100 {
		return 100
	}
	return n
}

// ---------------------------------------------------------------- briefs

func (s *Store) ListBriefs(ctx context.Context, userID string, limit int) ([]Brief, error) {
	if limit < 1 {
		limit = 7
	}
	if limit > 200 {
		limit = 200
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT brief_date, content, payload FROM labspace.workbench_briefs WHERE user_id=? ORDER BY brief_date DESC LIMIT ?`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Brief{}
	for rows.Next() {
		b, e := scanBrief(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *Store) CreateBrief(ctx context.Context, userID, content string, payload json.RawMessage) (Brief, error) {
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	day := s.today().Format("2006-01-02")
	q := `INSERT INTO labspace.workbench_briefs (id, user_id, brief_date, content, payload)
	 VALUES (gen_random_uuid()::text, ?, ?, ?, ?::jsonb)
	 ON CONFLICT (user_id, brief_date) DO UPDATE SET content=EXCLUDED.content, payload=EXCLUDED.payload
	 RETURNING brief_date, content, payload`
	rows, err := s.DB.QueryContext(ctx, q, userID, day, content, string(payload))
	if err != nil {
		return Brief{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		return Brief{}, errors.New("brief upsert failed")
	}
	return scanBrief(rows)
}

// ---------------------------------------------------------------- summary

func (s *Store) queryItems(ctx context.Context, q string, args ...any) ([]Item, error) {
	rows, err := s.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Item{}
	for rows.Next() {
		it, e := scanItemStmt(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

func (s *Store) count(ctx context.Context, q string, args ...any) int {
	var n int
	if err := s.DB.QueryRowContext(ctx, q, args...).Scan(&n); err != nil {
		return 0
	}
	return n
}

func (s *Store) Summary(ctx context.Context, userID string) (Summary, error) {
	out := Summary{}
	today := s.today()
	dayStart := today
	dayEnd := today.AddDate(0, 0, 1)
	weekStart := WeekStart(today)
	weekEnd := weekStart.AddDate(0, 0, 7)
	todayStr := today.Format("2006-01-02")

	var err error
	activeWhere := `WHERE user_id=? AND status='active'`
	if out.Today.Tasks, err = s.queryItems(ctx, `SELECT `+itemCols+` FROM labspace.workbench_items `+activeWhere+` AND kind='task' ORDER BY (due_date IS NULL), due_date ASC, updated_at DESC`, userID); err != nil {
		return out, err
	}
	if out.Today.Others, err = s.queryItems(ctx, `SELECT `+itemCols+` FROM labspace.workbench_items `+activeWhere+` AND kind <> 'task' ORDER BY (due_date IS NULL), due_date ASC, updated_at DESC`, userID); err != nil {
		return out, err
	}
	if out.Today.Overdue, err = s.queryItems(ctx, `SELECT `+itemCols+` FROM labspace.workbench_items `+activeWhere+` AND due_date < ? ORDER BY due_date ASC`, append([]any{userID}, todayStr)...); err != nil {
		return out, err
	}
	if out.Today.DueToday, err = s.queryItems(ctx, `SELECT `+itemCols+` FROM labspace.workbench_items `+activeWhere+` AND due_date = ? ORDER BY updated_at DESC`, append([]any{userID}, todayStr)...); err != nil {
		return out, err
	}
	if out.Today.DoneToday, err = s.queryItems(ctx, `SELECT `+itemCols+` FROM labspace.workbench_items WHERE user_id=? AND status='done' AND updated_at >= ? AND updated_at < ? ORDER BY updated_at DESC`, userID, dayStart, dayEnd); err != nil {
		return out, err
	}

	if out.Projects, err = s.queryProjects(ctx, `SELECT `+projectCols+` FROM labspace.workbench_projects WHERE user_id=? AND status <> 'archived' ORDER BY (status <> 'active'), updated_at DESC`, userID); err != nil {
		return out, err
	}
	if out.Plans.Directions, err = s.queryPlans(ctx, `SELECT `+planCols+` FROM labspace.workbench_plans WHERE user_id=? AND kind='direction' AND status <> 'archived' ORDER BY updated_at DESC`, userID); err != nil {
		return out, err
	}
	if out.Plans.Stages, err = s.queryPlans(ctx, `SELECT `+planCols+` FROM labspace.workbench_plans WHERE user_id=? AND kind='stage' AND status <> 'archived' ORDER BY updated_at DESC`, userID); err != nil {
		return out, err
	}

	briefRows, err := s.DB.QueryContext(ctx, `SELECT brief_date, content, payload FROM labspace.workbench_briefs WHERE user_id=? AND brief_date=?`, userID, todayStr)
	if err != nil {
		return out, err
	}
	if briefRows.Next() {
		b, e := scanBrief(briefRows)
		if e != nil {
			briefRows.Close()
			return out, e
		}
		out.Brief = &b
	}
	briefRows.Close()

	out.Stats.ActiveTasks = s.count(ctx, `SELECT count(*) FROM labspace.workbench_items WHERE user_id=? AND status='active' AND kind='task'`, userID)
	out.Stats.ActiveProjects = s.count(ctx, `SELECT count(*) FROM labspace.workbench_projects WHERE user_id=? AND status='active'`, userID)
	out.Stats.ActiveDirections = s.count(ctx, `SELECT count(*) FROM labspace.workbench_plans WHERE user_id=? AND status='active' AND kind='direction'`, userID)
	out.Stats.Inbox = s.count(ctx, `SELECT count(*) FROM labspace.workbench_items WHERE user_id=? AND status='active' AND kind='note'`, userID)
	out.Stats.CompletedThisWeek = s.count(ctx, `SELECT count(*) FROM labspace.workbench_items WHERE user_id=? AND status='done' AND updated_at >= ? AND updated_at < ?`, userID, weekStart, weekEnd)
	return out, nil
}

func (s *Store) queryProjects(ctx context.Context, q string, args ...any) ([]Project, error) {
	rows, err := s.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Project{}
	for rows.Next() {
		p, e := scanProject(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) queryPlans(ctx context.Context, q string, args ...any) ([]Plan, error) {
	rows, err := s.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Plan{}
	for rows.Next() {
		p, e := scanPlan(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// deref flattens a nullable text column into the model's plain string. The
// models use "" (plus omitempty) instead of *string so the JSON shape stays
// stable for the existing frontend.
func deref(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

// ptrOrNil 把空字符串当成 NULL（JSON null），用于 pgwire 扫描路径：
// pgwire 的 assign 对 NULL 列写入的是空字符串，无法区分 NULL 与 ”。
func ptrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
