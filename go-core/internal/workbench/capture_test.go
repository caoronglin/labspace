package workbench

import (
	"testing"
	"time"
)

func TestAnalyze(t *testing.T) {
	today := time.Date(2026, 11, 4, 0, 0, 0, 0, time.UTC) // Wednesday
	cases := []struct {
		name       string
		text       string
		kind       string
		due        string
		priority   string
		tags       []string
		wantReason bool
	}{
		{"task deadline", "记得明天提交论文 #论文 #ddl 紧急", "task", "2026-11-05", "high", []string{"论文", "ddl"}, true},
		{"plan", "下周二做实验计划：整理数据", "plan", "2026-11-10", "normal", nil, true},
		{"project", "新项目课题启动，不急", "project", "", "low", nil, true},
		{"idea", "或许可以试试新的分析方法", "idea", "", "normal", nil, true},
		{"knowledge", "参考文献阅读笔记", "knowledge", "", "normal", nil, true},
		{"iso date", "2026-12-01 前完成报告", "task", "2026-12-01", "normal", nil, true},
		{"days after", "3天后回复邮件", "task", "2026-11-07", "normal", nil, true},
		{"today", "今天联系导师", "task", "2026-11-04", "normal", nil, true},
		{"low priority", "不急，有空再整理", "task", "", "low", nil, true},
		{"plain note", "随便写点什么", "note", "", "normal", nil, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Analyze(c.text, today)
			if got.Kind != c.kind {
				t.Fatalf("kind=%q want %q", got.Kind, c.kind)
			}
			if c.due == "" && got.DueDate != nil {
				t.Fatalf("unexpected due %v", got.DueDate)
			}
			if c.due != "" {
				if got.DueDate == nil || got.DueDate.Format("2006-01-02") != c.due {
					t.Fatalf("due=%v want %s", got.DueDate, c.due)
				}
			}
			if got.Priority != c.priority {
				t.Fatalf("priority=%q want %q", got.Priority, c.priority)
			}
			if len(got.Tags) != len(c.tags) {
				t.Fatalf("tags=%v want %v", got.Tags, c.tags)
			}
			for i := range c.tags {
				if got.Tags[i] != c.tags[i] {
					t.Fatalf("tags=%v want %v", got.Tags, c.tags)
				}
			}
			if got.Title == "" {
				t.Fatal("empty title")
			}
			if got.Content != c.text {
				t.Fatalf("content mismatch")
			}
			if (got.Reason != "") != c.wantReason {
				t.Fatalf("ai_reason=%q", got.Reason)
			}
			if got.Confidence < 0.4 || got.Confidence > 0.95 {
				t.Fatalf("confidence out of range: %f", got.Confidence)
			}
		})
	}
}

func TestMatchPriorityLowBeforeHigh(t *testing.T) {
	// "不急" contains "急"; low must win.
	p, hit := MatchPriority("不急，这个不急")
	if p != "low" || hit != "不急" {
		t.Fatalf("got %q %q", p, hit)
	}
}

func TestBuildTitleStripsTagsAndDate(t *testing.T) {
	got := BuildTitle("#标签 明天 提交报告\n第二行", "明天")
	if got != "提交报告" {
		t.Fatalf("title=%q", got)
	}
}

func TestTagLimitAndDedup(t *testing.T) {
	tags := MatchTags("#a #b #a #c #d #e #f #g")
	if len(tags) != 5 {
		t.Fatalf("tags=%v", tags)
	}
	if tags[0] != "a" || tags[1] != "b" {
		t.Fatalf("order/dedup broken: %v", tags)
	}
}
