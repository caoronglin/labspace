package labfiles

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 共享文件-组员：学生只准上传材料，不准改目录结构；
// 删除权限定在时间窗内（“2 天内允许删除”）。
// 这两条是导师给的权限口径，必须由文件核心强制执行，而不是只在前端藏按钮。

func sharedTreeACL() ACL {
	return ACL{Identities: map[string][]Scope{
		"advisor@local": {
			{Source: "users", Path: "advisor", View: true, Download: true, Modify: true, Delete: true, Create: true},
		},
		"member@local": {
			// 只能看 + 传；不能下载、不能改、不能建子目录；
			// 删除权限定在 48 小时内。
			{
				Source:       "users",
				Path:         "advisor/共享文件-组员/2509_某某",
				View:         true,
				Create:       true,
				Delete:       true,
				DeleteWithin: "48h",
				NoDirs:       true,
			},
		},
	}}
}

func sharedTree(t *testing.T) (*Registry, string) {
	t.Helper()
	root := t.TempDir()
	for _, dir := range []string{
		"users/advisor/共享文件-组员/2509_某某/01_组会汇报",
		"users/advisor/共享文件-组员/2509_某某/02_论文",
		"users/advisor/共享文件-组员/2509_某某/03_其他",
	} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	reg := NewWithACL(root, sharedTreeACL(), filepath.Join(t.TempDir(), "acl.json"))
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	return reg, root
}

func TestMemberCannotCreateDirsButCanUpload(t *testing.T) {
	reg, _ := sharedTree(t)
	member := Identity{UserID: "member@local", Email: "member@local", Roles: []string{"lab-student"}}
	dir := "advisor/共享文件-组员/2509_某某/01_组会汇报"

	// 学生不能自己加子目录（目录结构由导师维护）。
	if _, err := reg.CreateDir(member, "users", dir+"/我自己加的"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member created a directory: %v", err)
	}
	// 但可以往指定目录上传文件。
	if _, err := reg.WriteFile(member, "users", dir, "实验记录.md", strings.NewReader("data"), false); err != nil {
		t.Fatalf("member upload rejected: %v", err)
	}
	// 上传不能落到别人的目录里。
	other := "advisor/共享文件-组员/2506_另一个人/01_组会汇报"
	if _, err := reg.WriteFile(member, "users", other, "越权.md", strings.NewReader("x"), false); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member uploaded into another member's folder: %v", err)
	}
}

func TestMemberDeleteOnlyWithinWindow(t *testing.T) {
	reg, root := sharedTree(t)
	member := Identity{UserID: "member@local", Email: "member@local", Roles: []string{"lab-student"}}
	dir := "advisor/共享文件-组员/2509_某某/01_组会汇报"

	// 窗口内：刚上传的可以删。
	entry, err := reg.WriteFile(member, "users", dir, "刚上传.md", strings.NewReader("data"), false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Trash(member, entry.ID); err != nil {
		t.Fatalf("member could not delete a fresh upload: %v", err)
	}

	// 窗口外：把文件的修改时间往前挪 3 天，就不该再能删。
	old := filepath.Join(root, "users", dir, "三天前的材料.md")
	if err := os.WriteFile(old, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-72 * time.Hour)
	if err := os.Chtimes(old, past, past); err != nil {
		t.Fatal(err)
	}
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	oldEntry, ok := reg.lookup("users", dir+"/三天前的材料.md")
	if !ok {
		t.Fatal("old file not indexed")
	}
	if _, err := reg.Trash(member, oldEntry.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member deleted an upload older than the window: %v", err)
	}
}

// TestMemberPermanentDeleteAlsoRespectsWindow 回归测试。
//
// 漏洞：Trash() 检查了"48h 内才可删"，但 Destroy()（permanent=1）没查窗口，
// 直接从磁盘抹掉 → 学生只要知道条目 id 就能永久删除导师三天前放进
// 共享目录的材料，且不进回收站、不可恢复。
// 永久删除比进回收站更危险，所以窗口判定必须在这条路上也生效。
func TestMemberPermanentDeleteAlsoRespectsWindow(t *testing.T) {
	reg, root := sharedTree(t)
	member := Identity{UserID: "member@local", Email: "member@local", Roles: []string{"lab-student"}}
	dir := "advisor/共享文件-组员/2509_某某/01_组会汇报"

	// 窗口内：刚上传的可以永久删。
	entry, err := reg.WriteFile(member, "users", dir, "刚上传.md", strings.NewReader("data"), false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Destroy(member, entry.ID); err != nil {
		t.Fatalf("member could not permanently delete a fresh upload: %v", err)
	}

	// 窗口外：三天前的材料，永久删除必须被拒绝，且文件仍在磁盘上。
	old := filepath.Join(root, "users", dir, "三天前的材料.md")
	if err := os.WriteFile(old, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-72 * time.Hour)
	if err := os.Chtimes(old, past, past); err != nil {
		t.Fatal(err)
	}
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	oldEntry, ok := reg.lookup("users", dir+"/三天前的材料.md")
	if !ok {
		t.Fatal("old file not indexed")
	}
	if _, err := reg.Destroy(member, oldEntry.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member permanently deleted an upload older than the window: %v", err)
	}
	if _, err := os.Stat(old); err != nil {
		t.Fatalf("file was removed despite the window check: %v", err)
	}
}

func TestAdvisorKeepsFullRightsOnMemberFolder(t *testing.T) {
	reg, _ := sharedTree(t)
	advisor := Identity{UserID: "advisor@local", Email: "advisor@local", Roles: []string{"lab-teacher"}}
	dir := "advisor/共享文件-组员/2509_某某"
	for _, action := range []string{"read", "download", "create", "mkdir", "modify", "delete"} {
		if !reg.CanPath(advisor, "users", dir, action) {
			t.Fatalf("advisor lost %s on the member folder", action)
		}
	}
}

// SetPersonalAccess 只能动“指向别人家目录”的那部分授权，
// 自己家目录的授权是开户时发的，必须原封不动 —— 否则组员会突然进不去自己的文件。
func TestSetPersonalAccessKeepsOwnHome(t *testing.T) {
	root := t.TempDir()
	for _, dir := range []string{
		"users/member",
		"users/advisor/共享文件-组员/2509_某某",
	} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	reg := NewWithACL(root, ACL{Identities: map[string][]Scope{
		"member@local": {
			{Source: "users", Path: "member", View: true, Download: true, Create: true, Modify: true, Delete: true},
		},
	}}, filepath.Join(t.TempDir(), "acl.json"))
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.SetPersonalAccess("member", []Grant{
		{Source: "users", Path: "advisor/共享文件-组员/2509_某某", Access: "upload", DeleteWithin: "48h"},
	}); err != nil {
		t.Fatalf("personal access rejected: %v", err)
	}
	member := Identity{UserID: "member@local", Email: "member@local", Roles: []string{"lab-student"}}
	if !reg.CanPath(member, "users", "member/我的文件.md", "create") {
		t.Fatal("own home grant was dropped by a personal-access update")
	}
	if !reg.CanPath(member, "users", "advisor/共享文件-组员/2509_某某/01_组会汇报/x.md", "create") {
		t.Fatal("the new personal grant was not applied")
	}
	// 也不能给自己的家目录发授权。
	if _, err := reg.SetPersonalAccess("member", []Grant{
		{Source: "users", Path: "member", Access: "write"},
	}); err == nil {
		t.Fatal("granting access to one's own home was accepted")
	}
}

// TestDestroyRemovesImmediately：直接删除（不进回收站）应当立刻消失，
// 且不留在回收站里；普通删除仍然要进回收站（可恢复）。
func TestDestroyRemovesImmediately(t *testing.T) {
	root := writeTree(t)
	reg := NewWithACL(root, aclWritable(), aclFile(t, root))
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	owner := student()

	// 直接删除
	if _, err := reg.Destroy(owner, entryID("users", "student01/maize.fa")); err != nil {
		t.Fatalf("destroy failed: %v", err)
	}
	if _, ok := reg.lookup("users", "student01/maize.fa"); ok {
		t.Fatal("destroyed entry is still indexed")
	}
	items, err := reg.ListTrash(owner)
	if err != nil {
		t.Fatal(err)
	}
	for _, it := range items {
		if it.Path == "student01/maize.fa" {
			t.Fatal("destroyed entry should not be in the trash")
		}
	}

	// 普通删除仍进回收站
	if _, err := reg.Trash(owner, entryID("users", "student01/maize.fa")); err == nil {
		t.Fatal("expected the second destroy to fail: file already gone")
	}
}

// ---------------------------------------------------------------- 教师策略

// teacherTree 造一棵带「共享文件-组员」的树：导师家目录下每个组员一套目录，
// 另有一位组员的个人文件（教师不该看见）。
func teacherTree(t *testing.T) string {
	t.Helper()
	root := writeTree(t)
	mk := func(rel string) {
		if err := os.MkdirAll(filepath.Join(root, rel), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	mk("users/advisor01/共享文件-组员/2506_赵同学/01_组会汇报")
	mk("users/advisor01/共享文件-组员/2605_钱同学/02_论文")
	mk("research/2026-11-10-钱同学")
	mk("meeting/2026-W48")
	if err := os.WriteFile(filepath.Join(root, "users/advisor01/共享文件-组员/2506_赵同学/01_组会汇报/w48.pdf"), []byte("pdf"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "research/2026-11-10-钱同学/plan.md"), []byte("plan"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

// teacherIdentity 是**别人家**的老师（advisor02）：真正的使用场景就是
// 陈老师看 admin01 家目录下那棵共享树，而不是看自己家。
func teacherIdentity() Identity {
	return Identity{UserID: "advisor02", Email: "advisor02@local", Roles: []string{"lab-teacher"}, Teacher: true}
}

// TestTeacherSeesEverySharedMemberTree：老师对**所有**「共享文件-组员」子树全权，
// 而学生只能看自己被授权的那一棵。
func TestTeacherSeesEverySharedMemberTree(t *testing.T) {
	reg := New(teacherTree(t), ACL{Identities: map[string][]Scope{}})
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	teacher := teacherIdentity()
	zhangjie := "advisor01/共享文件-组员/2506_赵同学"
	yangzhining := "advisor01/共享文件-组员/2605_钱同学"
	for _, p := range []string{zhangjie, yangzhining} {
		// "list" 只在源根上判定（见 decide）；目录本身用 read。
		for _, action := range []string{"read", "download", "create", "mkdir", "modify", "delete"} {
			if !reg.CanPath(teacher, "users", p, action) {
				t.Fatalf("teacher lost %s on %s", action, p)
			}
		}
	}
	// 共享树里的具体文件同样可读
	if !reg.Can(teacher, Entry{Source: "users", Path: zhangjie + "/01_组会汇报/w48.pdf"}, "read") {
		t.Fatal("teacher cannot read a file inside the member tree")
	}
	// 但教师的读写权限**不**扩散到组员的个人目录
	if reg.CanPath(teacher, "users", "student01/maize.fa", "read") {
		t.Fatal("teacher gained access to a personal home")
	}
	// 「共享给我」必须把这棵树列出来，否则界面里根本看不到入口
	found := false
	for _, s := range reg.SharedWith(teacher) {
		if s.Path == zhangjie || s.Path == yangzhining {
			found = true
			if !s.Writable {
				t.Fatalf("teacher tree %s reported read-only", s.Path)
			}
		}
	}
	if !found {
		t.Fatal("teacher's shared-member trees are missing from SharedWith")
	}
	// 上传/建目录按钮依赖这两份清单
	if !containsPath(reg.WritePaths(teacher, "users"), zhangjie) {
		t.Fatal("WritePaths omitted the member tree")
	}
	if !containsPath(reg.MkdirPaths(teacher, "users"), zhangjie) {
		t.Fatal("MkdirPaths omitted the member tree")
	}
}

// TestStudentOnlySeesOwnSharedMemberTree：学生只在自己那棵目录里有权限，
// 别人的共享树与自己无关。
func TestStudentOnlySeesOwnSharedMemberTree(t *testing.T) {
	reg := New(teacherTree(t), ACL{Identities: map[string][]Scope{
		"student01@local": {
			{Source: "users", Path: "student01", View: true, Create: true, Modify: true, Delete: true},
			{Source: "users", Path: "advisor01/共享文件-组员/2506_赵同学", View: true, Create: true, NoDirs: true},
		},
	}})
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	student := Identity{UserID: "student01@local", Email: "student01@local", Roles: []string{"lab-student"}}
	own := "advisor01/共享文件-组员/2506_赵同学"
	if !reg.CanPath(student, "users", own, "read") {
		t.Fatal("student lost access to their own member tree")
	}
	if reg.CanPath(student, "users", own, "mkdir") {
		t.Fatal("student obtained folder creation inside the member tree")
	}
	other := "advisor01/共享文件-组员/2605_钱同学"
	if reg.CanPath(student, "users", other, "read") {
		t.Fatal("student can read another member's tree")
	}
}

// TestTeacherPolicyCoversResearchAndMeeting：整源授权来自代码策略，
// 不依赖 ACL 文件里预先写好的条目（老配置里就没有这两条）。
func TestTeacherPolicyCoversResearchAndMeeting(t *testing.T) {
	reg := New(teacherTree(t), ACL{Identities: map[string][]Scope{}})
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	teacher := teacherIdentity()
	for _, source := range []string{"research", "meeting"} {
		if !reg.CanPath(teacher, source, "", "list") {
			t.Fatalf("teacher cannot list the %s source", source)
		}
	}
	if !reg.CanPath(teacher, "research", "2026-11-10-钱同学", "read") {
		t.Fatal("teacher cannot read a student's research folder")
	}
	if !reg.Writable(teacher, "research") {
		t.Fatal("teacher should be able to maintain research folders")
	}
	if !containsPath(reg.WritePaths(teacher, "research"), "") && !hasScope(reg.Scopes(teacher), "research", "") {
		t.Fatal("teacher research scope missing from Scopes()")
	}
}

// TestAdminDoesNotPenetrateResearchOrMeeting：管理员职责是平台运维，
// 课题资料与组会汇报属于教师业务数据，不接受管理员绕过。
func TestAdminDoesNotPenetrateResearchOrMeeting(t *testing.T) {
	reg := New(teacherTree(t), ACL{Identities: map[string][]Scope{}})
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	admin := Identity{UserID: "admin01", Email: "admin01@local", Roles: []string{"lab-admin"}, Admin: true}
	for _, source := range []string{"research", "meeting"} {
		if reg.CanPath(admin, source, "", "list") {
			t.Fatalf("admin bypassed %s", source)
		}
	}
	if reg.CanPath(admin, "research", "2026-11-10-钱同学", "read") {
		t.Fatal("admin read a student's research folder")
	}
	// 管理员对普通共享源仍然全权，这是职责内的运维能力
	if !reg.CanPath(admin, "public", "readme.md", "modify") {
		t.Fatal("admin lost the ordinary shared-source bypass")
	}
}

// TestExplicitDenyBeatsTeacherPolicy：收回某个人的权限必须仍然可表达。
func TestExplicitDenyBeatsTeacherPolicy(t *testing.T) {
	reg := New(teacherTree(t), ACL{Identities: map[string][]Scope{
		"advisor02@local": {{Source: "research", Path: "2026-11-10-钱同学", Deny: true}},
	}})
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	teacher := Identity{
		UserID: "advisor02@local", Email: "advisor02@local",
		Roles: []string{"lab-teacher"}, Teacher: true,
	}
	if reg.CanPath(teacher, "research", "2026-11-10-钱同学", "read") {
		t.Fatal("explicit deny lost to the teacher policy")
	}
	if !reg.CanPath(teacher, "research", "2026-11-10-钱同学-b", "read") {
		t.Fatal("deny leaked to a sibling folder")
	}
}

func containsPath(paths []string, want string) bool {
	for _, p := range paths {
		if p == want {
			return true
		}
	}
	return false
}

func hasScope(scopes []Scope, source, path string) bool {
	for _, s := range scopes {
		if s.Source == source && s.Path == path {
			return true
		}
	}
	return false
}

// TestTeacherKeepsOwnHomeWithoutProvisionedScope：老师能维护自己的家目录
// （组员目录同步就是用他自己身份建目录），不依赖开户时是否发过 users 授权。
func TestTeacherKeepsOwnHomeWithoutProvisionedScope(t *testing.T) {
	reg := New(teacherTree(t), ACL{Identities: map[string][]Scope{}})
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	teacher := teacherIdentity()
	if !reg.CanPath(teacher, "users", "advisor02/共享文件-组员", "mkdir") {
		t.Fatal("teacher cannot create the shared tree inside their own home")
	}
	if !reg.CanPath(teacher, "users", "advisor02/共享文件-组员/2605_郑同学/01_组会汇报", "create") {
		t.Fatal("teacher cannot upload inside the tree they just created")
	}
}
