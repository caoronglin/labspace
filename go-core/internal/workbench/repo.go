package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"labspace.local/go-core/internal/pgwire"
)

// DB is the minimal database surface the repository needs (pgwire.Pool or a
// test double).
type DB interface {
	Query(ctx context.Context, sql string, args ...any) (pgwire.Result, error)
	Exec(ctx context.Context, sql string, args ...any) (int64, error)
}

// Repo is the workbench data layer. Every statement is scoped by user_id.
type Repo struct {
	DB  DB
	Now func() time.Time
	// NewID generates row identifiers (uuid v4 by default).
	NewID func() string
}

// NewRepo wires the repository.
func NewRepo(db DB, newID func() string) *Repo {
	if newID == nil {
		newID = NewUUID
	}
	return &Repo{DB: db, Now: time.Now, NewID: newID}
}

// Schema is the DDL the workbench owns. It is idempotent and mirrors the
// portal's existing tables, so the Go layer never needs a migration tool.
const Schema = `
CREATE SCHEMA IF NOT EXISTS labspace;
CREATE TABLE IF NOT EXISTS labspace.workbench_items (
    id text PRIMARY KEY, user_id text NOT NULL, kind text NOT NULL DEFAULT 'note',
    title text NOT NULL, content text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'active',
    priority text NOT NULL DEFAULT 'normal', tags text[] NOT NULL DEFAULT '{}',
    project_id text, plan_id text, due_date date, source text NOT NULL DEFAULT 'manual',
    ai_class text, ai_reason text, confidence double precision,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workbench_items_user_idx ON labspace.workbench_items (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS workbench_items_due_idx ON labspace.workbench_items (user_id, due_date) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS labspace.workbench_projects (
    id text PRIMARY KEY, user_id text NOT NULL, name text NOT NULL, description text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'active', health text NOT NULL DEFAULT 'on_track',
    progress integer NOT NULL DEFAULT 0, next_step text NOT NULL DEFAULT '', due_date date,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workbench_projects_user_idx ON labspace.workbench_projects (user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS labspace.workbench_plans (
    id text PRIMARY KEY, user_id text NOT NULL, kind text NOT NULL DEFAULT 'direction', title text NOT NULL,
    outcome text NOT NULL DEFAULT '', metrics text NOT NULL DEFAULT '', horizon text NOT NULL DEFAULT '',
    progress integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'active',
    next_step text NOT NULL DEFAULT '', due_date date,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workbench_plans_user_idx ON labspace.workbench_plans (user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS labspace.workbench_briefs (
    id text PRIMARY KEY, user_id text NOT NULL, brief_date date NOT NULL,
    content text NOT NULL DEFAULT '', payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, brief_date)
);
`

// EnsureSchema creates the workbench tables when they are missing.
func (r *Repo) EnsureSchema(ctx context.Context) error {
	if _, err := r.DB.Exec(ctx, Schema); err != nil {
		return fmt.Errorf("workbench: schema: %w", err)
	}
	return nil
}

// itemColumns is the projection used by every item read.
const itemColumns = `id, user_id, kind, title, content, status, priority, tags,
	coalesce(project_id,''), coalesce(plan_id,''), due_date, source,
	coalesce(ai_class,''), coalesce(ai_reason,''), coalesce(confidence,0),
	created_at, updated_at`

func scanItem(res pgwire.Result, i int) (Item, error) {
	row := res.Rows[i]
	var it Item
	var created, updated time.Time
	var projectID, planID, due, aiClass, aiReason string
	if err := row.Scan(&it.ID, &it.UserID, &it.Kind, &it.Title, &it.Content, &it.Status,
		&it.Priority, &it.Tags, &projectID, &planID, &due, &it.Source,
		&aiClass, &aiReason, &it.Confidence, &created, &updated); err != nil {
		return it, err
	}
	it.ProjectID = ptrOrNil(projectID)
	it.PlanID = ptrOrNil(planID)
	it.DueDate = ptrOrNil(due)
	it.AIClass = ptrOrNil(aiClass)
	it.AIReason = ptrOrNil(aiReason)
	it.CreatedAt = created.Format(time.RFC3339Nano)
	it.UpdatedAt = updated.Format(time.RFC3339Nano)
	if it.Tags == nil {
		it.Tags = []string{}
	}
	return it, nil
}

// ListQuery filters ListItems.
type ListQuery struct {
	UserID    string
	Kind      string
	Status    string
	ProjectID string
	Q         string
	Limit     int
}

// ListItems returns the caller's items plus the unpaged total.
func (r *Repo) ListItems(ctx context.Context, q ListQuery) ([]Item, int, error) {
	limit := q.Limit
	if limit <= 0 {
		limit = DefaultLimit
	}
	if limit > MaxLimit {
		limit = MaxLimit
	}
	// One predicate, reused by the count and the page.
	where := `user_id = $1
		AND ($2 = '' OR kind = $2)
		AND ($3 = '' OR status = $3)
		AND ($4 = '' OR project_id = $4)
		AND ($5 = '' OR title ILIKE $6 OR content ILIKE $6)
		AND ($7 = '' OR kind = $7)`
	// ($7) is a no-op slot kept so the argument list stays positional and the
	// statement text is identical for count and page (plan cache reuse).
	like := ""
	if q.Q != "" {
		like = "%" + q.Q + "%"
	}
	args := []any{q.UserID, q.Kind, q.Status, q.ProjectID, q.Q, like, ""}

	countRes, err := r.DB.Query(ctx, "SELECT count(*) FROM labspace.workbench_items WHERE "+where, args...)
	if err != nil {
		return nil, 0, err
	}
	total := 0
	if len(countRes.Rows) > 0 {
		if err := countRes.Rows[0].Scan(&total); err != nil {
			return nil, 0, err
		}
	}
	pageArgs := append(append([]any{}, args...), limit)
	res, err := r.DB.Query(ctx,
		"SELECT "+itemColumns+" FROM labspace.workbench_items WHERE "+where+
			" ORDER BY (due_date IS NULL), due_date ASC, updated_at DESC LIMIT $8", pageArgs...)
	if err != nil {
		return nil, 0, err
	}
	items := make([]Item, 0, len(res.Rows))
	for i := range res.Rows {
		it, err := scanItem(res, i)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, it)
	}
	return items, total, nil
}

// ItemInput is the create payload.
type ItemInput struct {
	Kind      string
	Title     string
	Content   string
	Tags      []string
	Priority  string
	DueDate   string
	ProjectID string
	PlanID    string
	Status    string
}

// CreateItem inserts one item owned by userID.
func (r *Repo) CreateItem(ctx context.Context, userID string, in ItemInput) (Item, error) {
	if !Contains(ItemKinds, in.Kind) {
		return Item{}, BadRequest("条目类型无效")
	}
	if !Contains(ItemStatuses, in.Status) {
		return Item{}, BadRequest("条目状态无效")
	}
	if !Contains(ItemPriorities, in.Priority) {
		return Item{}, BadRequest("优先级无效")
	}
	due, err := parseDate(in.DueDate)
	if err != nil {
		return Item{}, BadRequest(err.Error())
	}
	title := strings.TrimSpace(in.Title)
	if title == "" {
		title = firstLine(in.Content)
	}
	if title == "" {
		return Item{}, BadRequest("标题不能为空")
	}
	id := r.NewID()
	if _, err = r.DB.Exec(ctx, `
		INSERT INTO labspace.workbench_items
			(id, user_id, kind, title, content, status, priority, tags, project_id, plan_id, due_date, source)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'manual')`,
		id, userID, in.Kind, title, in.Content, in.Status, in.Priority,
		nonNilTags(in.Tags), nullable(in.ProjectID), nullable(in.PlanID), dueArg(due)); err != nil {
		return Item{}, err
	}
	return r.getItem(ctx, userID, id)
}

// ItemPatch is the partial update payload; nil fields are left untouched.
type ItemPatch struct {
	Kind      *string
	Title     *string
	Content   *string
	Tags      *[]string
	Priority  *string
	DueDate   *string
	ProjectID *string
	PlanID    *string
	Status    *string
}

// PatchItem updates the given fields of one item.
func (r *Repo) PatchItem(ctx context.Context, userID, id string, p ItemPatch) (Item, error) {
	var sets []string
	var args []any
	add := func(column, cast string, value any) {
		args = append(args, value)
		sets = append(sets, fmt.Sprintf("%s = $%d%s", column, len(args), cast))
	}
	if p.Kind != nil {
		if !Contains(ItemKinds, *p.Kind) {
			return Item{}, BadRequest("条目类型无效")
		}
		add("kind", "::text", *p.Kind)
	}
	if p.Status != nil {
		if !Contains(ItemStatuses, *p.Status) {
			return Item{}, BadRequest("条目状态无效")
		}
		add("status", "::text", *p.Status)
	}
	if p.Priority != nil {
		if !Contains(ItemPriorities, *p.Priority) {
			return Item{}, BadRequest("优先级无效")
		}
		add("priority", "::text", *p.Priority)
	}
	if p.Title != nil {
		add("title", "::text", *p.Title)
	}
	if p.Content != nil {
		add("content", "::text", *p.Content)
	}
	if p.Tags != nil {
		add("tags", "::text[]", nonNilTags(*p.Tags))
	}
	if p.DueDate != nil {
		due, err := parseDate(*p.DueDate)
		if err != nil {
			return Item{}, BadRequest(err.Error())
		}
		add("due_date", "::date", dueArg(due))
	}
	if p.ProjectID != nil {
		add("project_id", "::text", nullable(*p.ProjectID))
	}
	if p.PlanID != nil {
		add("plan_id", "::text", nullable(*p.PlanID))
	}
	if len(sets) == 0 {
		return Item{}, BadRequest("没有需要更新的字段")
	}
	args = append(args, id, userID)
	q := fmt.Sprintf(`UPDATE labspace.workbench_items SET %s, updated_at = now()
		WHERE id = $%d AND user_id = $%d`, strings.Join(sets, ", "), len(args)-1, len(args))
	affected, err := r.DB.Exec(ctx, q, args...)
	if err != nil {
		return Item{}, err
	}
	if affected == 0 {
		return Item{}, NotFound("条目不存在")
	}
	return r.getItem(ctx, userID, id)
}

// DeleteItem removes one item owned by userID.
func (r *Repo) DeleteItem(ctx context.Context, userID, id string) error {
	affected, err := r.DB.Exec(ctx,
		`DELETE FROM labspace.workbench_items WHERE id = $1 AND user_id = $2`, id, userID)
	if err != nil {
		return err
	}
	if affected == 0 {
		return NotFound("条目不存在")
	}
	return nil
}

func (r *Repo) getItem(ctx context.Context, userID, id string) (Item, error) {
	res, err := r.DB.Query(ctx,
		"SELECT "+itemColumns+" FROM labspace.workbench_items WHERE id = $1 AND user_id = $2", id, userID)
	if err != nil {
		return Item{}, err
	}
	if len(res.Rows) == 0 {
		return Item{}, NotFound("条目不存在")
	}
	return scanItem(res, 0)
}

// ---- projects -------------------------------------------------------------

const projectColumns = `id, name, description, status, health, progress, next_step,
	due_date, created_at, updated_at`

// ListProjects returns the caller's projects, active first.
func (r *Repo) ListProjects(ctx context.Context, userID string) ([]Project, error) {
	res, err := r.DB.Query(ctx,
		"SELECT "+projectColumns+` FROM labspace.workbench_projects WHERE user_id = $1
		 ORDER BY (status <> 'active'), updated_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	return scanProjects(res), nil
}

func scanProjects(res pgwire.Result) []Project {
	out := make([]Project, 0, len(res.Rows))
	for i := range res.Rows {
		var p Project
		var due string
		var created, updated time.Time
		if err := res.Rows[i].Scan(&p.ID, &p.Name, &p.Description, &p.Status, &p.Health,
			&p.Progress, &p.NextStep, &due, &created, &updated); err != nil {
			continue
		}
		p.DueDate = ptrOrNil(due)
		p.CreatedAt = created.Format(time.RFC3339Nano)
		p.UpdatedAt = updated.Format(time.RFC3339Nano)
		out = append(out, p)
	}
	return out
}

// ProjectInput creates a project.
type ProjectInput struct {
	Name        string
	Description string
	Status      string
	Health      string
	NextStep    string
	DueDate     string
}

// CreateProject inserts one project.
func (r *Repo) CreateProject(ctx context.Context, userID string, in ProjectInput) (Project, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return Project{}, BadRequest("项目名称不能为空")
	}
	if !Contains(ProjectStatus, in.Status) {
		return Project{}, BadRequest("项目状态无效")
	}
	if !Contains(ProjectHealth, in.Health) {
		return Project{}, BadRequest("项目健康度无效")
	}
	due, err := parseDate(in.DueDate)
	if err != nil {
		return Project{}, BadRequest(err.Error())
	}
	id := r.NewID()
	if _, err = r.DB.Exec(ctx, `
		INSERT INTO labspace.workbench_projects
			(id, user_id, name, description, status, health, progress, next_step, due_date)
		VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8)`,
		id, userID, name, in.Description, in.Status, in.Health, in.NextStep, dueArg(due)); err != nil {
		return Project{}, err
	}
	return r.getProject(ctx, userID, id)
}

// ProjectPatch is the partial update payload.
type ProjectPatch struct {
	Name        *string
	Description *string
	NextStep    *string
	DueDate     *string
	Health      *string
	Status      *string
	Progress    *int
}

// PatchProject updates one project.
func (r *Repo) PatchProject(ctx context.Context, userID, id string, p ProjectPatch) (Project, error) {
	var sets []string
	var args []any
	add := func(column, cast string, value any) {
		args = append(args, value)
		sets = append(sets, fmt.Sprintf("%s = $%d%s", column, len(args), cast))
	}
	if p.Name != nil {
		add("name", "::text", strings.TrimSpace(*p.Name))
	}
	if p.Description != nil {
		add("description", "::text", *p.Description)
	}
	if p.NextStep != nil {
		add("next_step", "::text", *p.NextStep)
	}
	if p.Health != nil {
		if !Contains(ProjectHealth, *p.Health) {
			return Project{}, BadRequest("项目健康度无效")
		}
		add("health", "::text", *p.Health)
	}
	if p.Status != nil {
		if !Contains(ProjectStatus, *p.Status) {
			return Project{}, BadRequest("项目状态无效")
		}
		add("status", "::text", *p.Status)
	}
	if p.Progress != nil {
		add("progress", "::int", clampProgress(*p.Progress))
	}
	if p.DueDate != nil {
		due, err := parseDate(*p.DueDate)
		if err != nil {
			return Project{}, BadRequest(err.Error())
		}
		add("due_date", "::date", dueArg(due))
	}
	if len(sets) == 0 {
		return Project{}, BadRequest("没有需要更新的字段")
	}
	args = append(args, id, userID)
	q := fmt.Sprintf(`UPDATE labspace.workbench_projects SET %s, updated_at = now()
		WHERE id = $%d AND user_id = $%d`, strings.Join(sets, ", "), len(args)-1, len(args))
	affected, err := r.DB.Exec(ctx, q, args...)
	if err != nil {
		return Project{}, err
	}
	if affected == 0 {
		return Project{}, NotFound("项目不存在")
	}
	return r.getProject(ctx, userID, id)
}

// DeleteProject removes one project.
func (r *Repo) DeleteProject(ctx context.Context, userID, id string) error {
	affected, err := r.DB.Exec(ctx,
		`DELETE FROM labspace.workbench_projects WHERE id = $1 AND user_id = $2`, id, userID)
	if err != nil {
		return err
	}
	if affected == 0 {
		return NotFound("项目不存在")
	}
	return nil
}

func (r *Repo) getProject(ctx context.Context, userID, id string) (Project, error) {
	res, err := r.DB.Query(ctx,
		"SELECT "+projectColumns+" FROM labspace.workbench_projects WHERE id = $1 AND user_id = $2", id, userID)
	if err != nil {
		return Project{}, err
	}
	if len(res.Rows) == 0 {
		return Project{}, NotFound("项目不存在")
	}
	return scanProjects(res)[0], nil
}

// ---- plans ----------------------------------------------------------------

const planColumns = `id, kind, title, outcome, metrics, horizon, progress, status,
	next_step, due_date, created_at, updated_at`

// ListPlans returns the caller's plans.
func (r *Repo) ListPlans(ctx context.Context, userID string) ([]Plan, error) {
	res, err := r.DB.Query(ctx,
		"SELECT "+planColumns+` FROM labspace.workbench_plans WHERE user_id = $1
		 ORDER BY (status = 'archived'), kind, updated_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	return scanPlans(res), nil
}

func scanPlans(res pgwire.Result) []Plan {
	out := make([]Plan, 0, len(res.Rows))
	for i := range res.Rows {
		var p Plan
		var due string
		var created, updated time.Time
		if err := res.Rows[i].Scan(&p.ID, &p.Kind, &p.Title, &p.Outcome, &p.Metrics, &p.Horizon,
			&p.Progress, &p.Status, &p.NextStep, &due, &created, &updated); err != nil {
			continue
		}
		p.DueDate = ptrOrNil(due)
		p.CreatedAt = created.Format(time.RFC3339Nano)
		p.UpdatedAt = updated.Format(time.RFC3339Nano)
		out = append(out, p)
	}
	return out
}

// PlanInput creates a plan.
type PlanInput struct {
	Kind     string
	Title    string
	Outcome  string
	Metrics  string
	Horizon  string
	NextStep string
	DueDate  string
	Progress int
	Status   string
}

// CreatePlan inserts one plan.
func (r *Repo) CreatePlan(ctx context.Context, userID string, in PlanInput) (Plan, error) {
	title := strings.TrimSpace(in.Title)
	if title == "" {
		return Plan{}, BadRequest("计划标题不能为空")
	}
	if !Contains(PlanKinds, in.Kind) {
		return Plan{}, BadRequest("计划类型无效")
	}
	if !Contains(PlanStatuses, in.Status) {
		return Plan{}, BadRequest("计划状态无效")
	}
	due, err := parseDate(in.DueDate)
	if err != nil {
		return Plan{}, BadRequest(err.Error())
	}
	id := r.NewID()
	if _, err = r.DB.Exec(ctx, `
		INSERT INTO labspace.workbench_plans
			(id, user_id, kind, title, outcome, metrics, horizon, progress, status, next_step, due_date)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		id, userID, in.Kind, title, in.Outcome, in.Metrics, in.Horizon,
		clampProgress(in.Progress), in.Status, in.NextStep, dueArg(due)); err != nil {
		return Plan{}, err
	}
	return r.getPlan(ctx, userID, id)
}

// PlanPatch is the partial update payload.
type PlanPatch struct {
	Kind     *string
	Title    *string
	Outcome  *string
	Metrics  *string
	Horizon  *string
	NextStep *string
	DueDate  *string
	Progress *int
	Status   *string
}

// PatchPlan updates one plan.
func (r *Repo) PatchPlan(ctx context.Context, userID, id string, p PlanPatch) (Plan, error) {
	var sets []string
	var args []any
	add := func(column, cast string, value any) {
		args = append(args, value)
		sets = append(sets, fmt.Sprintf("%s = $%d%s", column, len(args), cast))
	}
	if p.Kind != nil {
		if !Contains(PlanKinds, *p.Kind) {
			return Plan{}, BadRequest("计划类型无效")
		}
		add("kind", "::text", *p.Kind)
	}
	if p.Status != nil {
		if !Contains(PlanStatuses, *p.Status) {
			return Plan{}, BadRequest("计划状态无效")
		}
		add("status", "::text", *p.Status)
	}
	if p.Title != nil {
		add("title", "::text", *p.Title)
	}
	if p.Outcome != nil {
		add("outcome", "::text", *p.Outcome)
	}
	if p.Metrics != nil {
		add("metrics", "::text", *p.Metrics)
	}
	if p.Horizon != nil {
		add("horizon", "::text", *p.Horizon)
	}
	if p.NextStep != nil {
		add("next_step", "::text", *p.NextStep)
	}
	if p.Progress != nil {
		add("progress", "::int", clampProgress(*p.Progress))
	}
	if p.DueDate != nil {
		due, err := parseDate(*p.DueDate)
		if err != nil {
			return Plan{}, BadRequest(err.Error())
		}
		add("due_date", "::date", dueArg(due))
	}
	if len(sets) == 0 {
		return Plan{}, BadRequest("没有需要更新的字段")
	}
	args = append(args, id, userID)
	q := fmt.Sprintf(`UPDATE labspace.workbench_plans SET %s, updated_at = now()
		WHERE id = $%d AND user_id = $%d`, strings.Join(sets, ", "), len(args)-1, len(args))
	affected, err := r.DB.Exec(ctx, q, args...)
	if err != nil {
		return Plan{}, err
	}
	if affected == 0 {
		return Plan{}, NotFound("计划不存在")
	}
	return r.getPlan(ctx, userID, id)
}

// DeletePlan removes one plan.
func (r *Repo) DeletePlan(ctx context.Context, userID, id string) error {
	affected, err := r.DB.Exec(ctx,
		`DELETE FROM labspace.workbench_plans WHERE id = $1 AND user_id = $2`, id, userID)
	if err != nil {
		return err
	}
	if affected == 0 {
		return NotFound("计划不存在")
	}
	return nil
}

func (r *Repo) getPlan(ctx context.Context, userID, id string) (Plan, error) {
	res, err := r.DB.Query(ctx,
		"SELECT "+planColumns+" FROM labspace.workbench_plans WHERE id = $1 AND user_id = $2", id, userID)
	if err != nil {
		return Plan{}, err
	}
	if len(res.Rows) == 0 {
		return Plan{}, NotFound("计划不存在")
	}
	return scanPlans(res)[0], nil
}

// ---- briefs ---------------------------------------------------------------

// ListBriefs returns the newest briefs for the caller.
func (r *Repo) ListBriefs(ctx context.Context, userID string, limit int) ([]Brief, error) {
	if limit <= 0 {
		limit = DefaultBriefLimit
	}
	if limit > MaxLimit {
		limit = MaxLimit
	}
	res, err := r.DB.Query(ctx,
		`SELECT brief_date, content, payload::text FROM labspace.workbench_briefs
		 WHERE user_id = $1 ORDER BY brief_date DESC LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	out := make([]Brief, 0, len(res.Rows))
	for i := range res.Rows {
		var b Brief
		var payload json.RawMessage
		if err := res.Rows[i].Scan(&b.Date, &b.Content, &payload); err != nil {
			continue
		}
		b.Payload = map[string]any{}
		if len(payload) > 0 {
			var obj map[string]any
			if err := json.Unmarshal(payload, &obj); err == nil && obj != nil {
				b.Payload = obj
			}
		}
		out = append(out, b)
	}
	return out, nil
}

// CreateBrief upserts today's brief.
func (r *Repo) CreateBrief(ctx context.Context, userID, content, payload string) (Brief, error) {
	if payload == "" {
		payload = "{}"
	}
	today := r.today()
	if _, err := r.DB.Exec(ctx, `
		INSERT INTO labspace.workbench_briefs (id, user_id, brief_date, content, payload)
		VALUES ($1,$2,$3,$4,$5::jsonb)
		ON CONFLICT (user_id, brief_date)
		DO UPDATE SET content = EXCLUDED.content, payload = EXCLUDED.payload`,
		r.NewID(), userID, today.Format("2006-01-02"), content, payload); err != nil {
		return Brief{}, err
	}
	res, err := r.DB.Query(ctx,
		`SELECT brief_date, content, payload::text FROM labspace.workbench_briefs
		 WHERE user_id = $1 AND brief_date = $2`, userID, today.Format("2006-01-02"))
	if err != nil {
		return Brief{}, err
	}
	if len(res.Rows) == 0 {
		return Brief{}, &Error{Status: 500, Detail: "简报写入失败"}
	}
	var b Brief
	if err := res.Rows[0].Scan(&b.Date, &b.Content, &b.Payload); err != nil {
		return Brief{}, err
	}
	return b, nil
}

// CaptureResult is the answer of the capture endpoint.
type CaptureResult struct {
	Item       Item    `json:"item"`
	AIClass    string  `json:"ai_class"`
	AIReason   string  `json:"ai_reason"`
	Confidence float64 `json:"confidence"`
	Extracted  struct {
		DueDate  string   `json:"due_date"`
		Tags     []string `json:"tags"`
		Priority string   `json:"priority"`
	} `json:"extracted"`
}

// Capture analyses the text locally and stores the resulting item.
func (r *Repo) Capture(ctx context.Context, userID, text string) (CaptureResult, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return CaptureResult{}, BadRequest("捕获内容不能为空")
	}
	a := Analyze(text, r.today())
	id := r.NewID()
	if _, err := r.DB.Exec(ctx, `
		INSERT INTO labspace.workbench_items
			(id, user_id, kind, title, content, status, priority, tags, due_date, source,
			 ai_class, ai_reason, confidence)
		VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,'capture',$9,$10,$11)`,
		id, userID, a.Kind, a.Title, a.Content, a.Priority, nonNilTags(a.Tags),
		dueArg(a.DueDate), a.Kind, a.Reason, a.Confidence); err != nil {
		return CaptureResult{}, err
	}
	item, err := r.getItem(ctx, userID, id)
	if err != nil {
		return CaptureResult{}, err
	}
	out := CaptureResult{Item: item, AIClass: a.Kind, AIReason: a.Reason, Confidence: a.Confidence}
	out.Extracted.DueDate = isoDate(a.DueDate)
	out.Extracted.Tags = nonNilTags(a.Tags)
	out.Extracted.Priority = a.Priority
	return out, nil
}

// ---- summary --------------------------------------------------------------

// Summary aggregates the workbench home. It issues a fixed number of queries
// (10) regardless of data size; the previous implementation ran four correlated
// count queries plus nine list queries per render.
func (r *Repo) Summary(ctx context.Context, userID string) (Summary, error) {
	var s Summary
	today := r.today()
	todayStr := today.Format("2006-01-02")
	dayStart := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, time.Local)
	dayEnd := dayStart.AddDate(0, 0, 1)
	weekStart := WeekStart(today)
	weekEnd := weekStart.AddDate(0, 0, 7)

	type spec struct {
		dest *[]Item
		sql  string
		args []any
	}
	queries := []spec{
		{&s.Today.Tasks, "SELECT " + itemColumns + " FROM labspace.workbench_items WHERE user_id = $1 AND status = 'active' AND kind = 'task' ORDER BY (due_date IS NULL), due_date ASC, updated_at DESC LIMIT $2", []any{userID, MaxLimit}},
		{&s.Today.Others, "SELECT " + itemColumns + " FROM labspace.workbench_items WHERE user_id = $1 AND status = 'active' AND kind <> 'task' ORDER BY (due_date IS NULL), due_date ASC, updated_at DESC LIMIT $2", []any{userID, MaxLimit}},
		{&s.Today.Overdue, "SELECT " + itemColumns + " FROM labspace.workbench_items WHERE user_id = $1 AND status = 'active' AND due_date < $2 ORDER BY due_date ASC LIMIT $3", []any{userID, todayStr, MaxLimit}},
		{&s.Today.DueToday, "SELECT " + itemColumns + " FROM labspace.workbench_items WHERE user_id = $1 AND status = 'active' AND due_date = $2 ORDER BY updated_at DESC LIMIT $3", []any{userID, todayStr, MaxLimit}},
		{&s.Today.DoneToday, "SELECT " + itemColumns + " FROM labspace.workbench_items WHERE user_id = $1 AND status = 'done' AND updated_at >= $2 AND updated_at < $3 ORDER BY updated_at DESC LIMIT $4", []any{userID, dayStart, dayEnd, MaxLimit}},
	}
	for _, q := range queries {
		res, err := r.DB.Query(ctx, q.sql, q.args...)
		if err != nil {
			return s, err
		}
		items := make([]Item, 0, len(res.Rows))
		for i := range res.Rows {
			it, err := scanItem(res, i)
			if err != nil {
				return s, err
			}
			items = append(items, it)
		}
		*q.dest = items
	}

	projects, err := r.DB.Query(ctx, "SELECT "+projectColumns+` FROM labspace.workbench_projects
		WHERE user_id = $1 AND status <> 'archived' ORDER BY (status <> 'active'), updated_at DESC LIMIT $2`, userID, MaxLimit)
	if err != nil {
		return s, err
	}
	s.Projects = scanProjects(projects)

	plansRes, err := r.DB.Query(ctx, "SELECT "+planColumns+` FROM labspace.workbench_plans
		WHERE user_id = $1 AND status <> 'archived' ORDER BY kind, updated_at DESC LIMIT $2`, userID, MaxLimit)
	if err != nil {
		return s, err
	}
	for _, p := range scanPlans(plansRes) {
		if p.Kind == "direction" {
			s.Plans.Directions = append(s.Plans.Directions, p)
		} else {
			s.Plans.Stages = append(s.Plans.Stages, p)
		}
	}

	briefRes, err := r.DB.Query(ctx,
		`SELECT brief_date, content, payload::text FROM labspace.workbench_briefs
		 WHERE user_id = $1 AND brief_date = $2`, userID, todayStr)
	if err != nil {
		return s, err
	}
	if len(briefRes.Rows) > 0 {
		var b Brief
		if err := briefRes.Rows[0].Scan(&b.Date, &b.Content, &b.Payload); err == nil {
			s.Brief = &b
		}
	}

	// One aggregate round trip instead of four separate count queries.
	statsRes, err := r.DB.Query(ctx, `
		SELECT
		 (SELECT count(*) FROM labspace.workbench_items WHERE user_id = $1 AND status='active' AND kind='task'),
		 (SELECT count(*) FROM labspace.workbench_projects WHERE user_id = $1 AND status='active'),
		 (SELECT count(*) FROM labspace.workbench_plans WHERE user_id = $1 AND status='active' AND kind='direction'),
		 (SELECT count(*) FROM labspace.workbench_items WHERE user_id = $1 AND status='active' AND kind='note'),
		 (SELECT count(*) FROM labspace.workbench_items WHERE user_id = $1 AND status='done' AND updated_at >= $2 AND updated_at < $3)`,
		userID, weekStart, weekEnd)
	if err != nil {
		return s, err
	}
	if len(statsRes.Rows) > 0 {
		if err := statsRes.Rows[0].Scan(&s.Stats.ActiveTasks, &s.Stats.ActiveProjects,
			&s.Stats.ActiveDirections, &s.Stats.Inbox, &s.Stats.CompletedThisWeek); err != nil {
			return s, err
		}
	}
	if s.Today.Tasks == nil {
		s.Today.Tasks = []Item{}
	}
	if s.Today.Others == nil {
		s.Today.Others = []Item{}
	}
	if s.Today.Overdue == nil {
		s.Today.Overdue = []Item{}
	}
	if s.Today.DueToday == nil {
		s.Today.DueToday = []Item{}
	}
	if s.Today.DoneToday == nil {
		s.Today.DoneToday = []Item{}
	}
	if s.Projects == nil {
		s.Projects = []Project{}
	}
	if s.Plans.Directions == nil {
		s.Plans.Directions = []Plan{}
	}
	if s.Plans.Stages == nil {
		s.Plans.Stages = []Plan{}
	}
	return s, nil
}

func (r *Repo) today() time.Time {
	now := r.Now()
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
}

func firstLine(content string) string {
	content = strings.TrimSpace(content)
	if i := strings.IndexAny(content, "\r\n"); i >= 0 {
		content = content[:i]
	}
	runes := []rune(strings.TrimSpace(content))
	if len(runes) > TitleMax {
		return string(runes[:TitleMax])
	}
	return string(runes)
}

func nullable(v string) any {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	return v
}

func dueArg(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.Format("2006-01-02")
}

func nonNilTags(tags []string) []string {
	if tags == nil {
		return []string{}
	}
	return tags
}

// IsError extracts a domain error.
func IsError(err error) (*Error, bool) {
	var e *Error
	if errors.As(err, &e) {
		return e, true
	}
	return nil, false
}
