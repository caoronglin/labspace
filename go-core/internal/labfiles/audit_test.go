package labfiles

import (
	"os"
	"path/filepath"
	"testing"
)

// 巡检要能在「垃圾数据」里准确报出三类异常，而不是只对干净 ACL 返回空。
func TestAuditACLFindsAllThreeProblems(t *testing.T) {
	root := t.TempDir()
	mk := func(rel string) {
		if err := os.MkdirAll(filepath.Join(root, rel), 0o770); err != nil {
			t.Fatal(err)
		}
	}
	mk("users/student01")
	mk("users/labadmin")
	mk("research/2026-11-10-陈同学")
	mk("meeting/2026-W47")

	acl := ACL{
		Identities: map[string][]Scope{
			// 1) 孤儿：家目录不存在
			"ghost-user": {{Source: "users", Path: "", View: true}},
			// 2) 悬空：目录不存在
			"student01": {
				{Source: "users", Path: "", View: true, Create: true},
				{Source: "research", Path: "2026-01-01-已删除项目", View: true},
			},
			// 3) 正常：目录真实存在
			"labadmin": {{Source: "research", Path: "2026-11-10-陈同学", View: true, Modify: true}},
		},
		Groups: map[string][]Scope{
			// 4) 过宽：学生组拿到课题目录写权限
			"lab-student": {{Source: "research", Path: "", View: true, Modify: true, Create: true}},
			"lab-teacher": {{Source: "meeting", Path: "", View: true, Modify: true}},
		},
	}
	r := NewWithACL(root, acl, "")
	report := r.AuditACL()

	kinds := map[string]int{}
	for _, f := range report.Findings {
		kinds[f.Kind]++
	}
	if kinds["orphan_identity"] != 1 {
		t.Fatalf("应报出 1 个孤儿授权，实际 %d：%+v", kinds["orphan_identity"], report.Findings)
	}
	if kinds["dangling_scope"] != 1 {
		t.Fatalf("应报出 1 个悬空授权，实际 %d：%+v", kinds["dangling_scope"], report.Findings)
	}
	if kinds["group_scope_too_broad"] != 1 {
		t.Fatalf("应报出 1 条过宽的组授权，实际 %d：%+v", kinds["group_scope_too_broad"], report.Findings)
	}
	if report.Identities != 3 || report.Groups != 2 {
		t.Fatalf("统计不对：identities=%d groups=%d", report.Identities, report.Groups)
	}
}

// 干净的 ACL 必须一份异常都不报：巡检如果总是「有话说」，运维就会忽略它。
func TestAuditACLCleanIsQuiet(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "users/student01"), 0o770); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "research/proj"), 0o770); err != nil {
		t.Fatal(err)
	}
	acl := ACL{
		Identities: map[string][]Scope{
			"student01": {{Source: "users", Path: "", View: true, Create: true}},
		},
		Groups: map[string][]Scope{
			"lab-teacher": {{Source: "research", Path: "proj", View: true, Modify: true}},
		},
	}
	report := NewWithACL(root, acl, "").AuditACL()
	if report.HasFindings() {
		t.Fatalf("干净 ACL 不该有异常：%+v", report.Findings)
	}
}

// 未知存储源也算问题：写错 source 名时授权永远不生效，但界面上看着「给了」。
func TestAuditACLUnknownSource(t *testing.T) {
	root := t.TempDir()
	acl := ACL{Identities: map[string][]Scope{"student01": {{Source: "no-such-source", View: true}}}}
	report := NewWithACL(root, acl, "").AuditACL()
	found := false
	for _, f := range report.Findings {
		if f.Kind == "dangling_scope" && f.Source == "no-such-source" {
			found = true
		}
	}
	if !found {
		t.Fatalf("未知存储源应报 dangling_scope：%+v", report.Findings)
	}
}
