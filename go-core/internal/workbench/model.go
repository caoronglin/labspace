package workbench

import (
	"fmt"
	"strings"
	"time"
)

// Item is one workbench entry.
//
// 可空字段一律用 *string（JSON 里输出 null），不用 omitempty —— 契约要求
// 字段恒定存在，缺字段会让前端对同一接口的两种实现解析出不同结构。
type Item struct {
	ID         string   `json:"id"`
	UserID     string   `json:"user_id"`
	Kind       string   `json:"kind"`
	Title      string   `json:"title"`
	Content    string   `json:"content"`
	Status     string   `json:"status"`
	Priority   string   `json:"priority"`
	Tags       []string `json:"tags"`
	ProjectID  *string  `json:"project_id"`
	PlanID     *string  `json:"plan_id"`
	// 待办可挂到文件存储里的具体文件/目录（与 Python 契约对齐：字段恒存在，默认空串）。
	// 列由 migrations/0001_init.sql 提供（NOT NULL DEFAULT ''）。
	LinkSource string `json:"link_source"`
	LinkPath   string `json:"link_path"`
	DueDate    *string  `json:"due_date"`
	Source     string   `json:"source"`
	AIClass    *string  `json:"ai_class"`
	AIReason   *string  `json:"ai_reason"`
	Confidence float64  `json:"confidence"`
	CreatedAt  string   `json:"created_at"`
	UpdatedAt  string   `json:"updated_at"`
}

// Project is one tracked project.
type Project struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Status      string  `json:"status"`
	Health      string  `json:"health"`
	Progress    int     `json:"progress"`
	NextStep    string  `json:"next_step"`
	DueDate     *string `json:"due_date"`
	CreatedAt   string  `json:"created_at"`
	UpdatedAt   string  `json:"updated_at"`
}

// Plan is one direction or stage plan.
type Plan struct {
	ID        string  `json:"id"`
	Kind      string  `json:"kind"`
	Title     string  `json:"title"`
	Outcome   string  `json:"outcome"`
	Metrics   string  `json:"metrics"`
	Horizon   string  `json:"horizon"`
	Progress  int     `json:"progress"`
	Status    string  `json:"status"`
	NextStep  string  `json:"next_step"`
	DueDate   *string `json:"due_date"`
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at"`
}

// Brief is one daily brief.
type Brief struct {
	Date    string         `json:"date"`
	Content string         `json:"content"`
	Payload map[string]any `json:"payload"`
}

// Summary is the workbench home aggregation.
type Summary struct {
	Today struct {
		Tasks     []Item `json:"tasks"`
		Others    []Item `json:"others"`
		Overdue   []Item `json:"overdue"`
		DueToday  []Item `json:"dueToday"`
		DoneToday []Item `json:"doneToday"`
	} `json:"today"`
	Projects []Project `json:"projects"`
	Plans    struct {
		Directions []Plan `json:"directions"`
		Stages     []Plan `json:"stages"`
	} `json:"plans"`
	Brief *Brief `json:"brief"`
	Stats struct {
		ActiveTasks       int `json:"activeTasks"`
		ActiveProjects    int `json:"activeProjects"`
		ActiveDirections  int `json:"activeDirections"`
		Inbox             int `json:"inbox"`
		CompletedThisWeek int `json:"completedThisWeek"`
	} `json:"stats"`
}

// Error is a domain error carrying the HTTP status the API layer must return.
type Error struct {
	Status int
	Detail string
}

func (e *Error) Error() string { return e.Detail }

// BadRequest builds a 400 domain error.
func BadRequest(detail string) *Error { return &Error{Status: 400, Detail: detail} }

// NotFound builds a 404 domain error.
func NotFound(detail string) *Error { return &Error{Status: 404, Detail: detail} }

// ErrMeta carries the response metadata generated with the item.
type ErrMeta = Error

// isoDate renders a date pointer as YYYY-MM-DD.
func isoDate(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.Format("2006-01-02")
}

// parseDate accepts YYYY-MM-DD or an RFC3339 timestamp.
func parseDate(raw string) (*time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	if len(raw) >= 10 {
		if t, err := time.ParseInLocation("2006-01-02", raw[:10], time.Local); err == nil {
			return &t, nil
		}
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		local := t.Local()
		day := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.Local)
		return &day, nil
	}
	return nil, fmt.Errorf("日期格式无效：%s", raw)
}

// clampProgress keeps progress inside [0,100].
func clampProgress(v int) int {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}
