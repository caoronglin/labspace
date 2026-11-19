package labfiles

import (
	"archive/tar"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestSourcesIncludeResearchAndMeeting 课题资料与组会汇报必须是共享源。
func TestSourcesIncludeResearchAndMeeting(t *testing.T) {
	labels := map[string]string{}
	for _, src := range Sources() {
		labels[src.ID] = src.Label
	}
	if labels["research"] != "课题资料" {
		t.Fatalf("research source missing or mislabelled: %q", labels["research"])
	}
	if labels["meeting"] != "组会汇报" {
		t.Fatalf("meeting source missing or mislabelled: %q", labels["meeting"])
	}
	for _, src := range Sources() {
		if (src.ID == "research" || src.ID == "meeting") && !src.Shared {
			t.Fatalf("source %s must be shared", src.ID)
		}
	}
}

// TestDefaultGroupsGrantResearchAndMeeting 检查组默认授权：
// 课题资料给老师与管理员（整源读写），组会汇报只给管理员。
func TestDefaultGroupsGrantResearchAndMeeting(t *testing.T) {
	groups := DefaultGroups()
	student := groups["lab-student"]
	for _, s := range student {
		if s.Source == "research" || s.Source == "meeting" {
			t.Fatalf("students must not get %s by default: %+v", s.Source, s)
		}
	}
	teacher := groups["lab-teacher"]
	found := false
	for _, s := range teacher {
		if s.Source == "research" && s.Path == "" && s.View && s.Download && s.Create && s.Modify && s.Delete {
			found = true
		}
	}
	if !found {
		t.Fatalf("lab-teacher lacks the whole-source research scope: %+v", teacher)
	}
	for _, s := range teacher {
		if s.Source == "meeting" {
			t.Fatalf("lab-teacher must not get the whole meeting source: %+v", s)
		}
	}
	admin := groups["lab-admin"]
	adminResearch, adminMeeting := false, false
	for _, s := range admin {
		if s.Source == "research" && s.Path == "" && s.Modify && s.Delete {
			adminResearch = true
		}
		if s.Source == "meeting" && s.Path == "" && s.Modify && s.Delete {
			adminMeeting = true
		}
	}
	if !adminResearch || !adminMeeting {
		t.Fatalf("lab-admin scopes wrong: research=%v meeting=%v %+v", adminResearch, adminMeeting, admin)
	}
}

// TestISOWeekFolderAcrossYearBoundary 周目录名的跨年边界。
//
// 规则：周一为一周之始，包含 1 月 1 日的那一周记作该年的第 1 周。
func TestISOWeekFolderAcrossYearBoundary(t *testing.T) {
	cases := []struct {
		at   time.Time
		want string
	}{
		{time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC), "2026-W01"},
		{time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC), "2026-W48"},
		// 2026-12-31 是周四，它所在的一周（12-28 ~ 2027-01-03）跨年，
		// 记作 2027 的第 1 周。
		{time.Date(2026, 12, 31, 12, 0, 0, 0, time.UTC), "2027-W01"},
		{time.Date(2027, 1, 3, 12, 0, 0, 0, time.UTC), "2027-W01"},
		{time.Date(2027, 1, 4, 12, 0, 0, 0, time.UTC), "2027-W02"},
	}
	for _, c := range cases {
		if got := ISOWeekFolder(c.at); got != c.want {
			t.Fatalf("ISOWeekFolder(%s) = %s want %s", c.at.Format("2006-01-02"), got, c.want)
		}
	}
}

// TestEnsureMeetingFolderCreatesDirectory 组会周目录按需创建。
func TestEnsureMeetingFolderCreatesDirectory(t *testing.T) {
	root := t.TempDir()
	reg := New(root, ACL{Identities: map[string][]Scope{}})
	rel, err := reg.EnsureMeetingFolder("2026-W48")
	if err != nil {
		t.Fatal(err)
	}
	if rel != "2026-W48" {
		t.Fatalf("unexpected source-relative path %q", rel)
	}
	info, err := os.Stat(filepath.Join(root, "meeting", "2026-W48"))
	if err != nil || !info.IsDir() {
		t.Fatalf("meeting folder not created: %v", err)
	}
	if _, err := reg.EnsureMeetingFolder("not-a-week"); err == nil {
		t.Fatal("invalid week folder accepted")
	}
}

// TestCompressOldMeetingFoldersCompressesAndRemoves 老周目录被压缩成
// tar.gz，原目录被删除；最近的周目录保持原样。
func TestCompressOldMeetingFoldersCompressesAndRemoves(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "meeting")
	now := time.Now()
	old := ISOWeekFolder(now.AddDate(0, 0, -5*7))
	recent := ISOWeekFolder(now.AddDate(0, 0, -7))
	current := ISOWeekFolder(now)
	for _, week := range []string{old, recent, current} {
		dir := filepath.Join(base, week)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "report.md"), []byte("report of "+week), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	reg := New(root, ACL{Identities: map[string][]Scope{}})
	compressed, err := reg.CompressOldMeetingFolders(2)
	if err != nil {
		t.Fatal(err)
	}
	if len(compressed) != 1 || compressed[0] != old {
		t.Fatalf("unexpected compressed list: %v", compressed)
	}
	if _, err := os.Stat(filepath.Join(base, old)); !os.IsNotExist(err) {
		t.Fatal("compressed week folder still on disk")
	}
	archive := filepath.Join(base, old+".tar.gz")
	if _, err := os.Stat(archive); err != nil {
		t.Fatalf("archive missing: %v", err)
	}
	for _, week := range []string{recent, current} {
		if _, err := os.Stat(filepath.Join(base, week)); err != nil {
			t.Fatalf("recent week %s was compressed: %v", week, err)
		}
	}
	// 压缩包里必须真的装着原文件。
	f, err := os.Open(archive)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	found := ""
	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		if header.Name == old+"/report.md" {
			found = string(body)
		}
	}
	if found != "report of "+old {
		t.Fatalf("archived content wrong: %q", found)
	}
	// 已经压过的目录不再重复压缩。
	again, err := reg.CompressOldMeetingFolders(2)
	if err != nil {
		t.Fatal(err)
	}
	if len(again) != 0 {
		t.Fatalf("already compressed folder was compressed again: %v", again)
	}
}

// TestMeetingWeekIsInvisibleWithoutGrant 没有授权名单的人看不到任何周目录。
func TestMeetingWeekIsInvisibleWithoutGrant(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "meeting", "2026-W48")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "report.md"), []byte("report"), 0o644); err != nil {
		t.Fatal(err)
	}
	reg := New(root, ACL{Identities: map[string][]Scope{}})
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	student := Identity{UserID: "student01@local", Email: "student01@local", Roles: []string{"lab-student"}}
	if visible := reg.Visible(student, "meeting"); len(visible) != 0 {
		t.Fatalf("meeting week visible without a grant: %+v", visible)
	}
}

// TestSetMeetingAccessGrantsAndRevokes 周目录名单是替换语义。
func TestSetMeetingAccessGrantsAndRevokes(t *testing.T) {
	root := t.TempDir()
	aclPath := filepath.Join(t.TempDir(), "labgo-acl.json")
	reg := NewWithACL(root, ACL{Identities: map[string][]Scope{}}, aclPath)

	names, err := reg.SetMeetingAccess("2026-W48", []string{"Student01@local", "student01@local"})
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 1 || names[0] != "student01@local" {
		t.Fatalf("unexpected roster: %v", names)
	}
	if _, err := os.Stat(filepath.Join(root, "meeting", "2026-W48")); err != nil {
		t.Fatalf("meeting folder not created: %v", err)
	}
	loaded, err := LoadACL(aclPath)
	if err != nil {
		t.Fatal(err)
	}
	granted := false
	for _, s := range loaded.Identities["student01@local"] {
		if s.Source == "meeting" && s.Path == "2026-W48" && s.View && s.Modify && s.Create {
			granted = true
		}
	}
	if !granted {
		t.Fatalf("meeting scope not written: %+v", loaded.Identities["student01@local"])
	}

	// 换成另一份名单：旧的人立刻失去访问权。
	if _, err := reg.SetMeetingAccess("2026-W48", []string{"student02@local"}); err != nil {
		t.Fatal(err)
	}
	loaded, err = LoadACL(aclPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range loaded.Identities["student01@local"] {
		if s.Source == "meeting" && s.Path == "2026-W48" {
			t.Fatal("revoked member still holds the meeting scope")
		}
	}
	second := false
	for _, s := range loaded.Identities["student02@local"] {
		if s.Source == "meeting" && s.Path == "2026-W48" && s.View {
			second = true
		}
	}
	if !second {
		t.Fatalf("new member has no scope: %+v", loaded.Identities["student02@local"])
	}
}

// TestResearchFolderName 目录名是"{进组时间}-{姓名}"。
func TestResearchFolderName(t *testing.T) {
	joined := time.Date(2024, 9, 1, 0, 0, 0, 0, time.UTC)
	if got := ResearchFolderName(joined, "陈同学"); got != "2024-09-01-陈同学" {
		t.Fatalf("unexpected research folder name %q", got)
	}
	if got := ResearchFolderName(joined, "  "); got != "" {
		t.Fatalf("blank name produced %q", got)
	}
}

// TestGrantResearchAccessScopesTheStudent 学生只看到自己的课题目录，
// 老师（lab-teacher 组）能看到全部学生目录。
func TestGrantResearchAccessScopesTheStudent(t *testing.T) {
	root := t.TempDir()
	aclPath := filepath.Join(t.TempDir(), "labgo-acl.json")
	reg := NewWithACL(root, ACL{Identities: map[string][]Scope{}}, aclPath)

	folder, err := reg.GrantResearchAccess("陈同学", time.Date(2024, 9, 1, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if folder != "2024-09-01-陈同学" {
		t.Fatalf("unexpected folder %q", folder)
	}
	if _, err := os.Stat(filepath.Join(root, "research", folder)); err != nil {
		t.Fatalf("research folder not created: %v", err)
	}
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}

	student := Identity{UserID: "陈同学@local", Email: "陈同学@local", Roles: []string{"lab-student"}}
	visible := reg.Visible(student, "research")
	if len(visible) != 1 || visible[0].Path != folder {
		t.Fatalf("student sees %+v", visible)
	}
	other := Identity{UserID: "李四@local", Email: "李四@local", Roles: []string{"lab-student"}}
	if visible := reg.Visible(other, "research"); len(visible) != 0 {
		t.Fatalf("another student sees %+v", visible)
	}
	// 老师通过 lab-teacher 组的整源授权看到全部学生目录。
	teacher := Identity{UserID: "teacher@local", Email: "teacher@local", Roles: []string{"lab-teacher"}}
	acl := reg.acl
	acl.Groups = DefaultGroups()
	teacherReg := New(root, acl)
	if err := teacherReg.Scan(); err != nil {
		t.Fatal(err)
	}
	visible = teacherReg.Visible(teacher, "research")
	found := false
	for _, e := range visible {
		if e.Path == folder {
			found = true
		}
	}
	if !found {
		t.Fatalf("teacher does not see the student folder: %+v", visible)
	}
}

// TestWriteFileCreatesMissingSourceDirectory 新建的共享源目录在第一次上传
// 时按需创建，而不是因为目录缺失报错。
func TestWriteFileCreatesMissingSourceDirectory(t *testing.T) {
	root := t.TempDir()
	acl := ACL{Identities: map[string][]Scope{
		"student01@local": {{Source: "research", Path: "2024-09-01-陈同学", View: true, Download: true, Create: true, Modify: true}},
	}}
	reg := New(root, acl)
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	student := Identity{UserID: "student01@local", Email: "student01@local", Roles: []string{"lab-student"}}
	entry, err := reg.WriteFile(student, "research", "2024-09-01-陈同学", "progress.md",
		strings.NewReader("week 1\n"), false)
	if err != nil {
		t.Fatal(err)
	}
	if entry.Path != "2024-09-01-陈同学/progress.md" {
		t.Fatalf("unexpected entry path %q", entry.Path)
	}
	raw, err := os.ReadFile(filepath.Join(root, "research", "2024-09-01-陈同学", "progress.md"))
	if err != nil || string(raw) != "week 1\n" {
		t.Fatalf("upload not stored: %q %v", raw, err)
	}
}
