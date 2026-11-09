// Package plot implements the Plot Studio job API.
//
// The Go core owns job state, storage and HTTP; Python is only a renderer
// invoked with an allow-listed chart template and plain CSV input. Requests
// can never inject code, and every row is scoped by user_id.
package plot

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	statusQueued     = "queued"
	statusRunning    = "running"
	statusSucceeded  = "succeeded"
	statusFailed     = "failed"
	statusCancelled  = "cancelled"
	statusCancelling = "cancelling"
)

type Handler struct {
	DB     *sql.DB
	Root   string
	Python string
	Worker string
	// Timeout bounds one render. Python templates are synchronous.
	Timeout time.Duration

	mu      sync.Mutex
	running map[string]context.CancelFunc
	sem     chan struct{}

	metaMu    sync.Mutex
	metaAt    time.Time
	metaCache *Libraries
}

type Libraries struct {
	OK     bool            `json:"ok"`
	Python string          `json:"python"`
	Libs   map[string]bool `json:"libs"`
	Error  string          `json:"error,omitempty"`
}

type Sample struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Chart       string         `json:"chart"`
	Description string         `json:"description"`
	Data        string         `json:"data"`
	Newick      string         `json:"newick,omitempty"`
	Params      map[string]any `json:"params,omitempty"`
}

type ParamSpec struct {
	Key     string   `json:"key"`
	Label   string   `json:"label"`
	Type    string   `json:"type"`
	Options []string `json:"options,omitempty"`
	Help    string   `json:"help,omitempty"`
}

type Chart struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	Group       string      `json:"group"`
	Description string      `json:"description"`
	Columns     string      `json:"columns"`
	Library     string      `json:"library"`
	Params      []ParamSpec `json:"params"`
}

type Job struct {
	ID        string         `json:"id"`
	Title     string         `json:"title"`
	Chart     string         `json:"chart"`
	Status    string         `json:"status"`
	Message   string         `json:"message"`
	Params    map[string]any `json:"params"`
	Outputs   []Output       `json:"outputs"`
	CreatedAt int64          `json:"created_at"`
	UpdatedAt int64          `json:"updated_at"`
}

type Output struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

var charts = []Chart{
	{ID: "bar", Name: "柱状图", Group: "基础统计", Library: "seaborn", Description: "分组均值/总和比较，适合处理组差异。", Columns: "category,value[,group]", Params: []ParamSpec{
		{Key: "x", Label: "分类列", Type: "text"}, {Key: "y", Label: "数值列", Type: "text"},
		{Key: "group", Label: "分组列", Type: "text"}, {Key: "agg", Label: "聚合", Type: "select", Options: []string{"mean", "sum", "median", "max", "min"}},
		{Key: "horizontal", Label: "横向排列", Type: "checkbox"}, {Key: "title", Label: "标题", Type: "text"},
	}},
	{ID: "line", Name: "折线图", Group: "基础统计", Library: "seaborn", Description: "时间序列或剂量响应趋势。", Columns: "x,y[,group]", Params: []ParamSpec{
		{Key: "x", Label: "X 列", Type: "text"}, {Key: "y", Label: "Y 列", Type: "text"}, {Key: "group", Label: "分组列", Type: "text"}, {Key: "title", Label: "标题", Type: "text"},
	}},
	{ID: "scatter", Name: "散点图", Group: "基础统计", Library: "seaborn", Description: "两变量相关性，可加趋势线。", Columns: "x,y[,group]", Params: []ParamSpec{
		{Key: "x", Label: "X 列", Type: "text"}, {Key: "y", Label: "Y 列", Type: "text"}, {Key: "group", Label: "分组列", Type: "text"},
		{Key: "trendline", Label: "趋势线", Type: "checkbox"}, {Key: "title", Label: "标题", Type: "text"},
	}},
	{ID: "box", Name: "箱线图", Group: "基础统计", Library: "seaborn", Description: "组间分布与离群值。", Columns: "category,value[,group]", Params: []ParamSpec{
		{Key: "x", Label: "分类列", Type: "text"}, {Key: "y", Label: "数值列", Type: "text"}, {Key: "group", Label: "分组列", Type: "text"},
		{Key: "points", Label: "叠加样本点", Type: "checkbox"}, {Key: "title", Label: "标题", Type: "text"},
	}},
	{ID: "violin", Name: "小提琴图", Group: "基础统计", Library: "seaborn", Description: "分布密度与分位数。", Columns: "category,value[,group]", Params: []ParamSpec{
		{Key: "x", Label: "分类列", Type: "text"}, {Key: "y", Label: "数值列", Type: "text"}, {Key: "group", Label: "分组列", Type: "text"},
		{Key: "points", Label: "叠加样本点", Type: "checkbox"}, {Key: "title", Label: "标题", Type: "text"},
	}},
	{ID: "heatmap", Name: "热图", Group: "组学", Library: "seaborn", Description: "基因×样本表达矩阵或长表透视。", Columns: "矩阵：首列行名；或 x,y,value", Params: []ParamSpec{
		{Key: "x", Label: "列名（长表）", Type: "text"}, {Key: "y", Label: "行名（长表）", Type: "text"}, {Key: "value", Label: "数值（长表）", Type: "text"},
		{Key: "standardize", Label: "按行 Z-score", Type: "checkbox"}, {Key: "cmap", Label: "色带", Type: "select", Options: []string{"RdBu_r", "viridis", "YlGnBu", "coolwarm", "magma"}},
		{Key: "max_rows", Label: "最多行数", Type: "number"}, {Key: "title", Label: "标题", Type: "text"},
	}},
	{ID: "volcano", Name: "火山图", Group: "组学", Library: "seaborn", Description: "差异表达：log2FC 与显著性。", Columns: "gene,log2fc,padj", Params: []ParamSpec{
		{Key: "gene", Label: "基因列", Type: "text"}, {Key: "x", Label: "log2FC 列", Type: "text"}, {Key: "y", Label: "p/padj 列", Type: "text"},
		{Key: "fc_cut", Label: "FC 阈值", Type: "number"}, {Key: "p_cut", Label: "p 阈值", Type: "number"}, {Key: "labels", Label: "标注数量", Type: "number"}, {Key: "title", Label: "标题", Type: "text"},
	}},
	{ID: "venn", Name: "维恩图", Group: "集合", Library: "matplotlib-venn", Description: "2–3 个基因/集合重叠。", Columns: "gene,setA,setB,setC（0/1）", Params: []ParamSpec{
		{Key: "sets", Label: "集合列（逗号分隔）", Type: "text"}, {Key: "title", Label: "标题", Type: "text"},
	}},
	{ID: "tree", Name: "系统发育树", Group: "进化", Library: "ete3 + Biopython", Description: "Newick 树形图，分支长度可读。", Columns: "Newick 字符串", Params: []ParamSpec{
		{Key: "newick", Label: "Newick", Type: "textarea"}, {Key: "title", Label: "标题", Type: "text"},
	}},
	{ID: "circos", Name: "Circos 圈图", Group: "基因组", Library: "pyCircos", Description: "染色体区间数值的环形概览。", Columns: "chr,start,end,value", Params: []ParamSpec{
		{Key: "chr", Label: "染色体列", Type: "text"}, {Key: "start", Label: "起始列", Type: "text"}, {Key: "end", Label: "终止列", Type: "text"},
		{Key: "value", Label: "数值列", Type: "text"}, {Key: "pycircos", Label: "使用 pyCircos", Type: "checkbox"}, {Key: "title", Label: "标题", Type: "text"},
	}},
	{ID: "manhattan", Name: "曼哈顿图", Group: "基因组", Library: "matplotlib", Description: "GWAS 位点按染色体展开。", Columns: "chr,pos,pvalue", Params: []ParamSpec{
		{Key: "chr", Label: "染色体列", Type: "text"}, {Key: "pos", Label: "位置列", Type: "text"}, {Key: "y", Label: "p 值列", Type: "text"},
		{Key: "p_cut", Label: "显著性阈值", Type: "number"}, {Key: "title", Label: "标题", Type: "text"},
	}},
	{ID: "pca", Name: "PCA 散点", Group: "组学", Library: "numpy + seaborn", Description: "样本主成分投影，按分组着色。", Columns: "sample,group,gene1..geneN", Params: []ParamSpec{
		{Key: "group", Label: "分组列", Type: "text"}, {Key: "title", Label: "标题", Type: "text"},
	}},
	{ID: "gsea", Name: "GSEA 富集", Group: "组学", Library: "GSEApy", Description: "预排序基因集富集（需提供 GMT）。", Columns: "gene,score", Params: []ParamSpec{
		{Key: "gene", Label: "基因列", Type: "text"}, {Key: "score", Label: "排序值列", Type: "text"}, {Key: "gmt", Label: "GMT 内容", Type: "textarea"},
		{Key: "permutations", Label: "置换次数", Type: "number"}, {Key: "title", Label: "标题", Type: "text"},
	}},
}

// New builds a handler with production defaults. Call Init once at startup.
func New(db *sql.DB) *Handler {
	h := defaultHandler()
	h.DB = db
	return h
}

func defaultHandler() *Handler {
	return &Handler{
		Root:    envOr("LABGO_PLOT_ROOT", "/srv/labdata/plot"),
		Python:  envOr("LABGO_PLOT_PYTHON", "/opt/labplot-venv/bin/python"),
		Worker:  envOr("LABGO_PLOT_WORKER", "/opt/labspace/ops/plot_worker.py"),
		Timeout: 240 * time.Second,
		running: map[string]context.CancelFunc{},
		sem:     make(chan struct{}, 2),
	}
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func (h *Handler) Init(ctx context.Context) error {
	if h == nil || h.DB == nil {
		return errors.New("plot: database unavailable")
	}
	h.mu.Lock()
	if h.running == nil {
		h.running = map[string]context.CancelFunc{}
	}
	if h.sem == nil {
		h.sem = make(chan struct{}, 2)
	}
	if h.Timeout <= 0 {
		h.Timeout = 240 * time.Second
	}
	h.mu.Unlock()
	if _, err := h.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS labspace.plot_jobs (
    id text PRIMARY KEY,
    user_id text NOT NULL,
    title text NOT NULL DEFAULT '',
    chart text NOT NULL,
    status text NOT NULL DEFAULT 'queued',
    message text NOT NULL DEFAULT '',
    params text NOT NULL DEFAULT '{}',
    outputs text NOT NULL DEFAULT '[]',
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
)`); err != nil {
		return err
	}
	if _, err := h.DB.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS plot_jobs_user_idx ON labspace.plot_jobs (user_id, created_at DESC)`); err != nil {
		return err
	}
	return os.MkdirAll(h.Root, 0o755)
}

func (h *Handler) Serve(w http.ResponseWriter, r *http.Request, userID string) {
	path := strings.TrimPrefix(r.URL.Path, "/v1/plot")
	if h == nil || h.DB == nil {
		writeErr(w, 503, "plot storage unavailable")
		return
	}
	switch {
	case path == "/meta" && r.Method == http.MethodGet:
		h.meta(w)
	case path == "/jobs" && r.Method == http.MethodGet:
		h.list(w, r, userID)
	case path == "/jobs" && r.Method == http.MethodPost:
		h.create(w, r, userID)
	case strings.HasPrefix(path, "/jobs/"):
		h.jobRoute(w, r, userID, strings.TrimPrefix(path, "/jobs/"))
	default:
		writeErr(w, 404, "unknown plot route")
	}
}

func (h *Handler) meta(w http.ResponseWriter) {
	writeJSON(w, 200, map[string]any{
		"charts":    charts,
		"samples":   samples(),
		"libraries": h.libs(),
		"palettes":  []string{"npg", "aaas", "lancet", "nejm", "jama", "d3", "set2", "okabe", "ggplot"},
	})
}

func (h *Handler) libs() Libraries {
	h.metaMu.Lock()
	defer h.metaMu.Unlock()
	if h.metaCache != nil && time.Since(h.metaAt) < 2*time.Minute {
		return *h.metaCache
	}
	libs := Libraries{Libs: map[string]bool{}}
	if _, err := os.Stat(h.Python); err != nil {
		libs.Error = "Python 渲染环境未安装"
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, h.Python, h.Worker, "--check").Output()
		if err != nil {
			libs.Error = "渲染环境检查失败"
		} else if err := json.Unmarshal(out, &libs); err != nil {
			libs.Error = "渲染环境返回异常"
		}
	}
	h.metaCache = &libs
	h.metaAt = time.Now()
	return libs
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request, userID string) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 30
	}
	rows, err := h.DB.QueryContext(r.Context(), `SELECT id,title,chart,status,message,params,outputs,created_at,updated_at
		FROM labspace.plot_jobs WHERE user_id=? ORDER BY created_at DESC LIMIT ?`, userID, limit)
	if err != nil {
		writeErr(w, 500, "读取任务失败")
		return
	}
	defer rows.Close()
	items := []Job{}
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			writeErr(w, 500, "读取任务失败")
			return
		}
		items = append(items, j)
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

type createInput struct {
	Title  string         `json:"title"`
	Chart  string         `json:"chart"`
	Data   string         `json:"data"`
	Sample string         `json:"sample"`
	Params map[string]any `json:"params"`
	Wait   bool           `json:"wait"`
}

func (h *Handler) create(w http.ResponseWriter, r *http.Request, userID string) {
	var in createInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, 422, "请求格式不正确")
		return
	}
	in.Chart = strings.TrimSpace(in.Chart)
	chart := findChart(in.Chart)
	if chart == nil {
		writeErr(w, 422, "不支持的图表类型")
		return
	}
	if in.Params == nil {
		in.Params = map[string]any{}
	}
	if in.Sample != "" {
		if s := findSample(in.Sample); s != nil {
			if strings.TrimSpace(in.Data) == "" {
				in.Data = s.Data
			}
			if in.Chart == "tree" && in.Params["newick"] == nil && s.Newick != "" {
				in.Params["newick"] = s.Newick
			}
			for k, v := range s.Params {
				if _, exists := in.Params[k]; !exists {
					in.Params[k] = v
				}
			}
		}
	}
	if in.Chart == "tree" {
		if n, _ := in.Params["newick"].(string); strings.TrimSpace(n) == "" {
			writeErr(w, 422, "请提供 Newick 树字符串")
			return
		}
	} else if strings.TrimSpace(in.Data) == "" {
		writeErr(w, 422, "请粘贴 CSV 数据或选择示例数据")
		return
	}
	if len(in.Data) > 8<<20 {
		writeErr(w, 413, "数据超过 8 MiB")
		return
	}
	if in.Chart == "venn" {
		if s, ok := in.Params["sets"].(string); ok {
			parts := []string{}
			for _, p := range strings.Split(s, ",") {
				if p = strings.TrimSpace(p); p != "" {
					parts = append(parts, p)
				}
			}
			in.Params["sets"] = parts
		}
	}
	title := strings.TrimSpace(in.Title)
	if title == "" {
		title = chart.Name
	}
	if len(title) > 80 {
		title = title[:80]
	}
	id := newID()
	now := time.Now().UnixMilli()
	paramsJSON, _ := json.Marshal(in.Params)
	dir := filepath.Join(h.Root, id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		writeErr(w, 500, "创建任务目录失败")
		return
	}
	if err := os.WriteFile(filepath.Join(dir, "data.csv"), []byte(in.Data), 0o644); err != nil {
		writeErr(w, 500, "写入数据失败")
		return
	}
	jobFile, _ := json.Marshal(map[string]any{"id": id, "title": title, "chart": in.Chart, "params": in.Params})
	if err := os.WriteFile(filepath.Join(dir, "job.json"), jobFile, 0o644); err != nil {
		writeErr(w, 500, "写入任务失败")
		return
	}
	if _, err := h.DB.ExecContext(r.Context(), `INSERT INTO labspace.plot_jobs
		(id,user_id,title,chart,status,message,params,outputs,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?)`, id, userID, title, in.Chart, statusQueued, "等待渲染", string(paramsJSON), "[]", now, now); err != nil {
		writeErr(w, 500, "保存任务失败")
		return
	}
	h.start(id, dir)
	if in.Wait {
		deadline := time.Now().Add(60 * time.Second)
		for time.Now().Before(deadline) {
			job, err := h.get(context.Background(), id, userID)
			if err == nil && terminal(job.Status) {
				writeJSON(w, 200, job)
				return
			}
			time.Sleep(500 * time.Millisecond)
		}
	}
	job, err := h.get(r.Context(), id, userID)
	if err != nil {
		writeErr(w, 500, "读取任务失败")
		return
	}
	writeJSON(w, 202, job)
}

func (h *Handler) start(id, dir string) {
	go func() {
		h.sem <- struct{}{}
		defer func() { <-h.sem }()
		ctx, cancel := context.WithTimeout(context.Background(), h.Timeout)
		defer cancel()
		h.mu.Lock()
		h.running[id] = cancel
		h.mu.Unlock()
		defer func() {
			h.mu.Lock()
			delete(h.running, id)
			h.mu.Unlock()
		}()
		now := time.Now().UnixMilli()
		_, _ = h.DB.Exec(`UPDATE labspace.plot_jobs SET status=?,message=?,updated_at=? WHERE id=?`, statusRunning, "正在渲染", now, id)
		cmd := exec.CommandContext(ctx, h.Python, h.Worker, dir)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "MPLBACKEND=Agg", "LANG=C.UTF-8", "PYTHONUNBUFFERED=1")
		out, err := cmd.CombinedOutput()
		if len(out) > 0 {
			_ = os.WriteFile(filepath.Join(dir, "launch.log"), out, 0o644)
		}
		status, message, outputs := readStatus(dir)
		switch {
		case ctx.Err() == context.DeadlineExceeded:
			status, message = statusFailed, "渲染超时"
		case err != nil && status == "":
			status, message = statusFailed, "渲染进程异常退出"
		case status == "":
			status, message = statusFailed, "渲染未返回状态"
		}
		if status == statusRunning || status == statusQueued {
			status = statusFailed
		}
		payload, _ := json.Marshal(outputs)
		_, _ = h.DB.Exec(`UPDATE labspace.plot_jobs SET status=?,message=?,outputs=?,updated_at=? WHERE id=?`,
			status, truncate(message, 500), string(payload), time.Now().UnixMilli(), id)
	}()
}

func readStatus(dir string) (string, string, []Output) {
	raw, err := os.ReadFile(filepath.Join(dir, "status.json"))
	if err != nil {
		return "", "", nil
	}
	var st struct {
		Status  string   `json:"status"`
		Message string   `json:"message"`
		Outputs []Output `json:"outputs"`
	}
	if json.Unmarshal(raw, &st) != nil {
		return "", "", nil
	}
	return st.Status, st.Message, st.Outputs
}

func (h *Handler) jobRoute(w http.ResponseWriter, r *http.Request, userID, rest string) {
	parts := strings.SplitN(rest, "/", 2)
	id := parts[0]
	if id == "" {
		writeErr(w, 404, "任务不存在")
		return
	}
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}
	switch {
	case action == "" && r.Method == http.MethodGet:
		job, err := h.get(r.Context(), id, userID)
		if err != nil {
			writeErr(w, 404, "任务不存在")
			return
		}
		writeJSON(w, 200, job)
	case action == "" && r.Method == http.MethodDelete:
		h.remove(w, r, id, userID)
	case action == "cancel" && r.Method == http.MethodPost:
		h.cancel(w, r, id, userID)
	case action == "file" && r.Method == http.MethodGet:
		h.serveFile(w, r, id, userID)
	case action == "log" && r.Method == http.MethodGet:
		h.serveLog(w, r, id, userID)
	default:
		writeErr(w, 404, "unknown plot route")
	}
}

func (h *Handler) get(ctx context.Context, id, userID string) (Job, error) {
	row := h.DB.QueryRowContext(ctx, `SELECT id,title,chart,status,message,params,outputs,created_at,updated_at
		FROM labspace.plot_jobs WHERE id=? AND user_id=?`, id, userID)
	return scanJob(row)
}

type scanner interface {
	Scan(dest ...any) error
}

func scanJob(s scanner) (Job, error) {
	var j Job
	var params, outputs string
	if err := s.Scan(&j.ID, &j.Title, &j.Chart, &j.Status, &j.Message, &params, &outputs, &j.CreatedAt, &j.UpdatedAt); err != nil {
		return j, err
	}
	_ = json.Unmarshal([]byte(params), &j.Params)
	_ = json.Unmarshal([]byte(outputs), &j.Outputs)
	if j.Params == nil {
		j.Params = map[string]any{}
	}
	if j.Outputs == nil {
		j.Outputs = []Output{}
	}
	return j, nil
}

func (h *Handler) cancel(w http.ResponseWriter, r *http.Request, id, userID string) {
	job, err := h.get(r.Context(), id, userID)
	if err != nil {
		writeErr(w, 404, "任务不存在")
		return
	}
	if terminal(job.Status) {
		writeJSON(w, 200, job)
		return
	}
	h.mu.Lock()
	cancel := h.running[id]
	h.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	_, _ = h.DB.ExecContext(r.Context(), `UPDATE labspace.plot_jobs SET status=?,message=?,updated_at=? WHERE id=? AND user_id=?`,
		statusCancelled, "已取消", time.Now().UnixMilli(), id, userID)
	job, _ = h.get(r.Context(), id, userID)
	writeJSON(w, 200, job)
}

func (h *Handler) remove(w http.ResponseWriter, r *http.Request, id, userID string) {
	h.mu.Lock()
	cancel := h.running[id]
	h.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	res, err := h.DB.ExecContext(r.Context(), `DELETE FROM labspace.plot_jobs WHERE id=? AND user_id=?`, id, userID)
	if err != nil {
		writeErr(w, 500, "删除失败")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, 404, "任务不存在")
		return
	}
	_ = os.RemoveAll(filepath.Join(h.Root, id))
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (h *Handler) serveFile(w http.ResponseWriter, r *http.Request, id, userID string) {
	if _, err := h.get(r.Context(), id, userID); err != nil {
		writeErr(w, 404, "任务不存在")
		return
	}
	rel := filepath.ToSlash(strings.TrimSpace(r.URL.Query().Get("path")))
	if rel == "" || strings.Contains(rel, "..") {
		writeErr(w, 400, "路径不合法")
		return
	}
	base := filepath.Join(h.Root, id)
	target := filepath.Join(base, filepath.FromSlash(rel))
	if target != base && !strings.HasPrefix(target, base+string(os.PathSeparator)) {
		writeErr(w, 403, "路径越界")
		return
	}
	info, err := os.Stat(target)
	if err != nil || !info.Mode().IsRegular() {
		writeErr(w, 404, "文件不存在")
		return
	}
	ctype := mime.TypeByExtension(filepath.Ext(target))
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ctype)
	if r.URL.Query().Get("download") == "1" {
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filepath.Base(target)))
	}
	f, err := os.Open(target)
	if err != nil {
		writeErr(w, 500, "无法读取文件")
		return
	}
	defer f.Close()
	http.ServeContent(w, r, filepath.Base(target), info.ModTime(), f)
}

func (h *Handler) serveLog(w http.ResponseWriter, r *http.Request, id, userID string) {
	if _, err := h.get(r.Context(), id, userID); err != nil {
		writeErr(w, 404, "任务不存在")
		return
	}
	base := filepath.Join(h.Root, id)
	data, _ := os.ReadFile(filepath.Join(base, "run.log"))
	if len(data) == 0 {
		data, _ = os.ReadFile(filepath.Join(base, "launch.log"))
	}
	if len(data) > 200<<10 {
		data = data[len(data)-200<<10:]
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(data)
}

func findChart(id string) *Chart {
	for i := range charts {
		if charts[i].ID == id {
			return &charts[i]
		}
	}
	return nil
}

func findSample(id string) *Sample {
	for i := range sampleList {
		if sampleList[i].ID == id {
			return &sampleList[i]
		}
	}
	return nil
}

func terminal(status string) bool {
	return status == statusSucceeded || status == statusFailed || status == statusCancelled
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
