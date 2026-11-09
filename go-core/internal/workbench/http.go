package workbench

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
)

// Handler serves the 16 /v1/workbench/* routes. Authentication and CSRF are
// already enforced by httpapi.Server before the request is forwarded here;
// Handler only receives the verified user id.
type Handler struct{ Store *Store }

// Serve is called by httpapi.Server with the authenticated user id.
func (h *Handler) Serve(w http.ResponseWriter, r *http.Request, userID string) {
	path := strings.TrimPrefix(r.URL.Path, "/v1/workbench")
	if !knownRoute(path, r.Method) {
		// Reject unknown verbs/paths before touching storage, so 404 never
		// depends on whether a database happens to be wired.
		writeErr(w, 404, "unknown workbench route")
		return
	}
	if h == nil || h.Store == nil || h.Store.DB == nil {
		writeErr(w, 503, "workbench storage unavailable")
		return
	}
	q := r.URL.Query()
	ctx := r.Context()

	switch {
	// ---------------- items
	case path == "/items" && r.Method == http.MethodGet:
		limit, _ := strconv.Atoi(q.Get("limit"))
		items, total, err := h.Store.ListItems(ctx, userID, ItemFilter{
			Kind: q.Get("kind"), Status: q.Get("status"), ProjectID: q.Get("project_id"),
			Query: q.Get("q"), Limit: limit,
		})
		if err != nil {
			writeErr(w, 500, "list items failed")
			return
		}
		writeJSON(w, 200, map[string]any{"items": items, "total": total})

	case path == "/items" && r.Method == http.MethodPost:
		var body itemBody
		if !decode(w, r, &body) {
			return
		}
		if !in(body.Kind, ItemKinds) || body.Kind == "" {
			writeErr(w, 400, "条目类型无效")
			return
		}
		if !in(body.Status, ItemStatuses) || body.Status == "" {
			writeErr(w, 400, "条目状态无效")
			return
		}
		if !in(body.Priority, ItemPriorities) || body.Priority == "" {
			writeErr(w, 400, "优先级无效")
			return
		}
		it, err := h.Store.CreateItem(ctx, userID, ItemCreate{
			Kind: body.Kind, Title: body.Title, Content: body.Content, Priority: body.Priority,
			Status: body.Status, Tags: body.Tags, DueDate: body.DueDate,
			ProjectID: body.ProjectID, PlanID: body.PlanID,
		}, "manual", nil)
		if err != nil {
			writeErr(w, 500, "条目创建失败")
			return
		}
		writeJSON(w, 200, map[string]any{"item": it})

	case strings.HasPrefix(path, "/items/") && r.Method == http.MethodPatch:
		id := strings.TrimPrefix(path, "/items/")
		var raw map[string]json.RawMessage
		if !decode(w, r, &raw) {
			return
		}
		fields, err := itemPatch(raw)
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		it, err := h.Store.PatchItem(ctx, userID, id, fields)
		if err != nil {
			writeStoreErr(w, err, "条目不存在")
			return
		}
		writeJSON(w, 200, map[string]any{"item": it})

	case strings.HasPrefix(path, "/items/") && r.Method == http.MethodDelete:
		if err := h.Store.DeleteItem(ctx, userID, strings.TrimPrefix(path, "/items/")); err != nil {
			writeStoreErr(w, err, "条目不存在")
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})

	// ---------------- projects
	case path == "/projects" && r.Method == http.MethodGet:
		projects, err := h.Store.ListProjects(ctx, userID)
		if err != nil {
			writeErr(w, 500, "list projects failed")
			return
		}
		writeJSON(w, 200, map[string]any{"projects": projects})

	case path == "/projects" && r.Method == http.MethodPost:
		var body projectBody
		if !decode(w, r, &body) {
			return
		}
		if body.Name == "" {
			writeErr(w, 400, "项目名称不能为空")
			return
		}
		if !in(body.Status, ProjectStatus) || body.Status == "" {
			writeErr(w, 400, "项目状态无效")
			return
		}
		if !in(body.Health, ProjectHealth) || body.Health == "" {
			writeErr(w, 400, "项目健康度无效")
			return
		}
		p, err := h.Store.CreateProject(ctx, userID, ProjectCreate{
			Name: body.Name, Description: body.Description, NextStep: body.NextStep,
			Health: body.Health, Status: body.Status, DueDate: body.DueDate,
		})
		if err != nil {
			writeErr(w, 500, "项目创建失败")
			return
		}
		writeJSON(w, 200, map[string]any{"project": p})

	case strings.HasPrefix(path, "/projects/") && r.Method == http.MethodPatch:
		var raw map[string]json.RawMessage
		if !decode(w, r, &raw) {
			return
		}
		fields, err := projectPatch(raw)
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		p, err := h.Store.PatchProject(ctx, userID, strings.TrimPrefix(path, "/projects/"), fields)
		if err != nil {
			writeStoreErr(w, err, "项目不存在")
			return
		}
		writeJSON(w, 200, map[string]any{"project": p})

	case strings.HasPrefix(path, "/projects/") && r.Method == http.MethodDelete:
		if err := h.Store.DeleteProject(ctx, userID, strings.TrimPrefix(path, "/projects/")); err != nil {
			writeStoreErr(w, err, "项目不存在")
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})

	// ---------------- plans
	case path == "/plans" && r.Method == http.MethodGet:
		plans, err := h.Store.ListPlans(ctx, userID)
		if err != nil {
			writeErr(w, 500, "list plans failed")
			return
		}
		writeJSON(w, 200, map[string]any{"plans": plans})

	case path == "/plans" && r.Method == http.MethodPost:
		var body planBody
		if !decode(w, r, &body) {
			return
		}
		if body.Title == "" {
			writeErr(w, 400, "计划标题不能为空")
			return
		}
		if !in(body.Kind, PlanKinds) || body.Kind == "" {
			writeErr(w, 400, "计划类型无效")
			return
		}
		if !in(body.Status, PlanStatuses) || body.Status == "" {
			writeErr(w, 400, "计划状态无效")
			return
		}
		p, err := h.Store.CreatePlan(ctx, userID, PlanCreate{
			Kind: body.Kind, Title: body.Title, Outcome: body.Outcome, Metrics: body.Metrics,
			Horizon: body.Horizon, NextStep: body.NextStep, Status: body.Status,
			Progress: body.Progress, DueDate: body.DueDate,
		})
		if err != nil {
			writeErr(w, 500, "计划创建失败")
			return
		}
		writeJSON(w, 200, map[string]any{"plan": p})

	case strings.HasPrefix(path, "/plans/") && r.Method == http.MethodPatch:
		var raw map[string]json.RawMessage
		if !decode(w, r, &raw) {
			return
		}
		fields, err := planPatch(raw)
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		p, err := h.Store.PatchPlan(ctx, userID, strings.TrimPrefix(path, "/plans/"), fields)
		if err != nil {
			writeStoreErr(w, err, "计划不存在")
			return
		}
		writeJSON(w, 200, map[string]any{"plan": p})

	case strings.HasPrefix(path, "/plans/") && r.Method == http.MethodDelete:
		if err := h.Store.DeletePlan(ctx, userID, strings.TrimPrefix(path, "/plans/")); err != nil {
			writeStoreErr(w, err, "计划不存在")
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})

	// ---------------- briefs
	case path == "/briefs" && r.Method == http.MethodGet:
		limit, _ := strconv.Atoi(q.Get("limit"))
		briefs, err := h.Store.ListBriefs(ctx, userID, limit)
		if err != nil {
			writeErr(w, 500, "list briefs failed")
			return
		}
		writeJSON(w, 200, map[string]any{"briefs": briefs})

	case path == "/briefs" && r.Method == http.MethodPost:
		var body struct {
			Content string          `json:"content"`
			Payload json.RawMessage `json:"payload"`
		}
		if !decode(w, r, &body) {
			return
		}
		b, err := h.Store.CreateBrief(ctx, userID, body.Content, body.Payload)
		if err != nil {
			writeErr(w, 500, "简报写入失败")
			return
		}
		writeJSON(w, 200, map[string]any{"brief": b})

	// ---------------- capture
	case path == "/capture" && r.Method == http.MethodPost:
		var body struct {
			Text string `json:"text"`
		}
		if !decode(w, r, &body) {
			return
		}
		text := strings.TrimSpace(body.Text)
		if text == "" {
			writeErr(w, 400, "捕获内容不能为空")
			return
		}
		a := Analyze(text, h.Store.today())
		var due *string
		if a.DueDate != nil {
			s := a.DueDate.Format("2006-01-02")
			due = &s
		}
		it, err := h.Store.CreateItem(ctx, userID, ItemCreate{
			Kind: a.Kind, Title: a.Title, Content: a.Content, Priority: a.Priority,
			Status: "active", Tags: a.Tags, DueDate: due,
		}, "capture", &a)
		if err != nil {
			writeErr(w, 500, "捕获失败")
			return
		}
		writeJSON(w, 200, map[string]any{
			"item": it, "ai_class": a.Kind, "ai_reason": a.Reason,
			"confidence": a.Confidence,
			"extracted":  map[string]any{"due_date": due, "tags": a.Tags, "priority": a.Priority},
		})

	// ---------------- summary
	case path == "/summary" && r.Method == http.MethodGet:
		out, err := h.Store.Summary(ctx, userID)
		if err != nil {
			writeErr(w, 500, "summary failed")
			return
		}
		writeJSON(w, 200, out)

	default:
		writeErr(w, 404, "unknown workbench route")
	}
}

// knownRoute mirrors the switch in Serve; it exists so an unknown verb/path
// answers 404 instead of leaking storage state (503 vs 500).
func knownRoute(path, method string) bool {
	switch {
	case path == "/items":
		return method == http.MethodGet || method == http.MethodPost
	case path == "/projects":
		return method == http.MethodGet || method == http.MethodPost
	case path == "/plans":
		return method == http.MethodGet || method == http.MethodPost
	case path == "/briefs":
		return method == http.MethodGet || method == http.MethodPost
	case path == "/capture":
		return method == http.MethodPost
	case path == "/summary":
		return method == http.MethodGet
	}
	for _, base := range []string{"/items/", "/projects/", "/plans/"} {
		if strings.HasPrefix(path, base) && len(path) > len(base) {
			return method == http.MethodPatch || method == http.MethodDelete
		}
	}
	return false
}

// ---------------------------------------------------------------- request bodies

type itemBody struct {
	Kind      string   `json:"kind"`
	Title     string   `json:"title"`
	Content   string   `json:"content"`
	Priority  string   `json:"priority"`
	Status    string   `json:"status"`
	Tags      []string `json:"tags"`
	DueDate   *string  `json:"due_date"`
	ProjectID *string  `json:"project_id"`
	PlanID    *string  `json:"plan_id"`
}

// UnmarshalJSON applies the same defaults as the Pydantic models so an empty
// JSON body behaves like the Python route (kind=note, status=active, ...).
func (b *itemBody) UnmarshalJSON(data []byte) error {
	type alias itemBody
	def := alias{Kind: "note", Status: "active", Priority: "normal"}
	if err := json.Unmarshal(data, &def); err != nil {
		return err
	}
	*b = itemBody(def)
	return nil
}

type projectBody struct {
	Name        string  `json:"name"`
	Description string  `json:"description"`
	NextStep    string  `json:"next_step"`
	Health      string  `json:"health"`
	Status      string  `json:"status"`
	DueDate     *string `json:"due_date"`
}

func (b *projectBody) UnmarshalJSON(data []byte) error {
	type alias projectBody
	def := alias{Health: "on_track", Status: "active"}
	if err := json.Unmarshal(data, &def); err != nil {
		return err
	}
	*b = projectBody(def)
	return nil
}

type planBody struct {
	Kind     string  `json:"kind"`
	Title    string  `json:"title"`
	Outcome  string  `json:"outcome"`
	Metrics  string  `json:"metrics"`
	Horizon  string  `json:"horizon"`
	NextStep string  `json:"next_step"`
	Status   string  `json:"status"`
	Progress int     `json:"progress"`
	DueDate  *string `json:"due_date"`
}

func (b *planBody) UnmarshalJSON(data []byte) error {
	type alias planBody
	def := alias{Kind: "direction", Status: "active"}
	if err := json.Unmarshal(data, &def); err != nil {
		return err
	}
	*b = planBody(def)
	return nil
}

// patch builders validate enums and coerce progress into [0,100], mirroring
// the Python PATCH models. Unknown keys are ignored (sparse update).
func itemPatch(raw map[string]json.RawMessage) (PatchFields, error) {
	f := PatchFields{}
	copyStr := []string{"kind", "title", "content", "priority", "status", "project_id", "plan_id", "due_date"}
	for _, k := range copyStr {
		if v, ok := raw[k]; ok {
			var s string
			if err := json.Unmarshal(v, &s); err != nil {
				return nil, errors.New("字段 " + k + " 类型无效")
			}
			switch k {
			case "kind":
				if !in(s, ItemKinds) {
					return nil, errors.New("条目类型无效")
				}
			case "status":
				if !in(s, ItemStatuses) {
					return nil, errors.New("条目状态无效")
				}
			case "priority":
				if !in(s, ItemPriorities) {
					return nil, errors.New("优先级无效")
				}
			}
			f[k] = s
		}
	}
	if v, ok := raw["tags"]; ok {
		var tags []string
		if err := json.Unmarshal(v, &tags); err != nil {
			return nil, errors.New("tags 类型无效")
		}
		f["tags"] = textArray(tags)
	}
	return f, nil
}

func projectPatch(raw map[string]json.RawMessage) (PatchFields, error) {
	f := PatchFields{}
	for _, k := range []string{"name", "description", "next_step", "due_date", "health", "status"} {
		if v, ok := raw[k]; ok {
			var s string
			if err := json.Unmarshal(v, &s); err != nil {
				return nil, errors.New("字段 " + k + " 类型无效")
			}
			if k == "status" && !in(s, ProjectStatus) {
				return nil, errors.New("项目状态无效")
			}
			if k == "health" && !in(s, ProjectHealth) {
				return nil, errors.New("项目健康度无效")
			}
			f[k] = s
		}
	}
	if v, ok := raw["progress"]; ok {
		var n int
		if err := json.Unmarshal(v, &n); err != nil {
			return nil, errors.New("progress 类型无效")
		}
		f["progress"] = clamp(n)
	}
	return f, nil
}

func planPatch(raw map[string]json.RawMessage) (PatchFields, error) {
	f := PatchFields{}
	for _, k := range []string{"kind", "title", "outcome", "metrics", "horizon", "next_step", "due_date", "status"} {
		if v, ok := raw[k]; ok {
			var s string
			if err := json.Unmarshal(v, &s); err != nil {
				return nil, errors.New("字段 " + k + " 类型无效")
			}
			if k == "kind" && !in(s, PlanKinds) {
				return nil, errors.New("计划类型无效")
			}
			if k == "status" && !in(s, PlanStatuses) {
				return nil, errors.New("计划状态无效")
			}
			f[k] = s
		}
	}
	if v, ok := raw["progress"]; ok {
		var n int
		if err := json.Unmarshal(v, &n); err != nil {
			return nil, errors.New("progress 类型无效")
		}
		f["progress"] = clamp(n)
	}
	return f, nil
}

func in(v string, list []string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------- helpers

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func writeErr(w http.ResponseWriter, code int, reason string) {
	writeJSON(w, code, map[string]string{"error": reason})
}
func writeStoreErr(w http.ResponseWriter, err error, notFound string) {
	if errors.Is(err, ErrNotFound) {
		writeErr(w, 404, notFound)
		return
	}
	writeErr(w, 500, "storage error")
}
func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		writeErr(w, 400, "invalid JSON")
		return false
	}
	return true
}
