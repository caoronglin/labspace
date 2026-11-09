// Package workbench is the personal workbench data layer (items, projects,
// plans, daily briefs) plus the deterministic capture rule engine.
//
// It replaces Python's backend/app/workbench.py. Two deliberate changes:
//   - rows are fetched and normalised in Go, so the SQL no longer repeats the
//     same CASE WHEN block four times per statement;
//   - every statement is parameterised through pgwire, which keeps the
//     user_id isolation boundary intact (no string concatenation anywhere).
package workbench

import (
	"regexp"
	"strings"
	"time"
)

// Kinds, statuses, priorities and sources accepted by the API.
var (
	ItemKinds      = []string{"task", "project", "idea", "knowledge", "note", "memory", "plan"}
	ItemStatuses   = []string{"active", "done", "paused", "archived"}
	ItemPriorities = []string{"low", "normal", "high"}
	ItemSources    = []string{"manual", "capture", "agent"}
	ProjectStatus  = []string{"active", "done", "paused"}
	ProjectHealth  = []string{"on_track", "at_risk", "blocked", "done"}
	PlanKinds      = []string{"direction", "stage"}
	PlanStatuses   = []string{"active", "paused", "done", "archived"}
)

const (
	// MaxLimit bounds every list query.
	MaxLimit = 200
	// DefaultLimit is the page size when the caller does not ask.
	DefaultLimit = 50
	// DefaultBriefLimit is the number of briefs returned by default.
	DefaultBriefLimit = 7
	// TitleMax truncates a generated title.
	TitleMax = 60
	// MaxTags caps the extracted tag count.
	MaxTags = 5
)

// Contains reports whether value is one of allowed.
func Contains(allowed []string, value string) bool {
	for _, a := range allowed {
		if a == value {
			return true
		}
	}
	return false
}

// kindRule is one capture classification rule; the order matters (plan beats
// task beats project …).
type kindRule struct {
	kind  string
	words []string
}

var kindRules = []kindRule{
	{"plan", []string{"计划", "目标", "方向", "里程碑"}},
	{"task", []string{"待办", "需要", "要做", "记得", "完成", "deadline", "截止", "前完成", "提交", "发送", "准备", "整理", "修改", "回复", "联系", "安排", "上传", "打印", "报名"}},
	{"project", []string{"项目", "课题", "研究"}},
	{"idea", []string{"想法", "灵感", "点子", "或许", "可以试试"}},
	{"knowledge", []string{"文献", "论文", "笔记", "知识", "参考"}},
	{"memory", []string{"记住", "以后", "经验", "教训"}},
}

var (
	priorityHigh = []string{"紧急", "急", "尽快", "asap", "立刻"}
	priorityLow  = []string{"不急", "有空", "低优先"}
	tagRe        = regexp.MustCompile(`#([A-Za-z0-9_\p{Han}]+)`)
	isoDateRe    = regexp.MustCompile(`(\d{4})-(\d{1,2})-(\d{1,2})`)
	daysAfterRe  = regexp.MustCompile(`(\d+)\s*天后`)
	weekdayRe    = regexp.MustCompile(`(本|下)周([一二三四五六日天1-7])`)
	spaceRe      = regexp.MustCompile(`\s+`)
	weekdayNum   = map[string]int{"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 7, "天": 7}
)

// Analysis is the result of analysing a captured sentence.
type Analysis struct {
	Kind       string
	DueDate    *time.Time
	Tags       []string
	Priority   string
	Title      string
	Content    string
	Reason     string
	Confidence float64
}

// MatchKind returns the first matching kind and the keywords that hit.
func MatchKind(text string) (string, []string) {
	lower := strings.ToLower(text)
	for _, rule := range kindRules {
		var hits []string
		for _, w := range rule.words {
			if strings.Contains(lower, strings.ToLower(w)) {
				hits = append(hits, w)
			}
		}
		if len(hits) > 0 {
			return rule.kind, hits
		}
	}
	return "note", nil
}

// WeekStart returns the Monday of the week containing day.
func WeekStart(day time.Time) time.Time {
	offset := (int(day.Weekday()) + 6) % 7 // Monday = 0
	return time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, day.Location()).AddDate(0, 0, -offset)
}

// MatchDueDate extracts a due date and the matched keyword.
func MatchDueDate(text string, today time.Time) (*time.Time, string) {
	day := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, today.Location())
	if m := isoDateRe.FindStringSubmatch(text); m != nil {
		y, mo, d := atoi(m[1]), atoi(m[2]), atoi(m[3])
		if mo >= 1 && mo <= 12 && d >= 1 && d <= 31 {
			candidate := time.Date(y, time.Month(mo), d, 0, 0, 0, 0, day.Location())
			// Reject overflow such as 2024-02-31.
			if candidate.Day() == d {
				return &candidate, m[0]
			}
		}
	}
	if m := daysAfterRe.FindStringSubmatch(text); m != nil {
		got := day.AddDate(0, 0, atoi(m[1]))
		return &got, m[0]
	}
	if m := weekdayRe.FindStringSubmatch(text); m != nil {
		num := weekdayNum[m[2]]
		if num == 0 {
			num = atoi(m[2])
		}
		if num >= 1 && num <= 7 {
			base := WeekStart(day)
			offset := num - 1
			if m[1] == "下" {
				offset += 7
			}
			got := base.AddDate(0, 0, offset)
			return &got, m[0]
		}
	}
	switch {
	case strings.Contains(text, "后天"):
		got := day.AddDate(0, 0, 2)
		return &got, "后天"
	case strings.Contains(text, "明天"):
		got := day.AddDate(0, 0, 1)
		return &got, "明天"
	case strings.Contains(text, "今天"):
		return &day, "今天"
	case strings.Contains(text, "今日"):
		return &day, "今日"
	}
	return nil, ""
}

// MatchPriority extracts the priority. Low is checked first so that "不急" is
// not swallowed by "急".
func MatchPriority(text string) (string, string) {
	lower := strings.ToLower(text)
	for _, w := range priorityLow {
		if strings.Contains(lower, w) {
			return "low", w
		}
	}
	for _, w := range priorityHigh {
		if strings.Contains(lower, w) {
			return "high", w
		}
	}
	return "normal", ""
}

// MatchTags extracts up to MaxTags distinct tags, keeping first-seen order.
func MatchTags(text string) []string {
	var tags []string
	seen := map[string]bool{}
	for _, m := range tagRe.FindAllStringSubmatch(text, -1) {
		tag := m[1]
		if tag == "" || seen[tag] {
			continue
		}
		seen[tag] = true
		tags = append(tags, tag)
		if len(tags) >= MaxTags {
			break
		}
	}
	return tags
}

// BuildTitle takes the first line, drops tags and the date keyword, and keeps
// at most TitleMax characters.
func BuildTitle(text, dueKeyword string) string {
	first := text
	if i := strings.IndexAny(text, "\r\n"); i >= 0 {
		first = text[:i]
	}
	cleaned := tagRe.ReplaceAllString(first, " ")
	if dueKeyword != "" {
		cleaned = strings.ReplaceAll(cleaned, dueKeyword, "")
	}
	cleaned = strings.TrimSpace(spaceRe.ReplaceAllString(cleaned, " "))
	r := []rune(cleaned)
	if len(r) > TitleMax {
		return string(r[:TitleMax])
	}
	return cleaned
}

// Analyze applies the local rules to one sentence. No model is involved, so
// the same input always yields the same item.
func Analyze(text string, today time.Time) Analysis {
	raw := strings.TrimSpace(text)
	kind, kindHits := MatchKind(raw)
	due, dueKeyword := MatchDueDate(raw, today)
	tags := MatchTags(raw)
	priority, priorityHit := MatchPriority(raw)
	title := BuildTitle(raw, dueKeyword)

	hits := 0
	if len(kindHits) > 0 {
		hits = 1 + len(kindHits) - 1
	}
	if due != nil {
		hits++
	}
	if len(tags) > 0 {
		hits++
	}
	if priorityHit != "" {
		hits++
	}
	confidence := 0.4 + 0.05*float64(hits)
	if confidence > 0.95 {
		confidence = 0.95
	}
	if confidence < 0.4 {
		confidence = 0.4
	}

	var reasons []string
	if len(kindHits) > 0 {
		reasons = append(reasons, "识别到类型关键词「"+strings.Join(kindHits, "、")+"」")
	} else {
		reasons = append(reasons, "未识别到明确类型关键词，归为默认笔记")
	}
	if due != nil {
		reasons = append(reasons, "识别到截止日期「"+dueKeyword+"」（"+due.Format("2006-01-02")+"）")
	}
	if len(tags) > 0 {
		reasons = append(reasons, "识别到标签「"+strings.Join(tags, "、")+"」")
	}
	if priorityHit != "" {
		reasons = append(reasons, "识别到优先级关键词「"+priorityHit+"」")
	}

	return Analysis{
		Kind:       kind,
		DueDate:    due,
		Tags:       tags,
		Priority:   priority,
		Title:      title,
		Content:    raw,
		Reason:     strings.Join(reasons, "；"),
		Confidence: round2(confidence),
	}
}

func round2(v float64) float64 {
	// Keep the same two-decimal contract as the Python round().
	n := int64(v*100 + 0.5)
	return float64(n) / 100
}

func atoi(s string) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return n
		}
		n = n*10 + int(r-'0')
	}
	return n
}
