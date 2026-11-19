package labfiles

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func writeTree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	mk := func(rel string) {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	mk("public")
	mk("users/student01")
	mk("users/student02")
	mk("plasmids")
	mk("genomes/grp-rnaseq")
	mk("genomes/grp-mcn")
	for rel, body := range map[string]string{
		"public/readme.md":           "public",
		"users/student01/maize.fa":   ">m1\nATGC\n",
		"users/student02/secret.fa":  ">s1\nATGC\n",
		"plasmids/plasmid.md":        "plasmid",
		"genomes/grp-rnaseq/data.fa": ">r1\nATGC\n",
	} {
		if err := os.WriteFile(filepath.Join(root, rel), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func acl() ACL {
	return ACL{Identities: map[string][]Scope{
		"student01@local": {
			{Source: "public", View: true, Download: true},
			{Source: "users", Path: "student01", View: true, Download: true, Modify: true},
			{Source: "plasmids", View: true, Download: true},
			{Source: "genomes", Path: "grp-rnaseq", View: true, Download: true},
		},
		"student02@local": {
			{Source: "public", View: true, Download: true},
			{Source: "users", Path: "student02", View: true, Download: true},
			{Source: "plasmids", View: true, Download: true},
			{Source: "genomes", Path: "grp-mcn", View: true, Download: true},
		},
	}}
}

func student() Identity {
	return Identity{UserID: "student01@local", Email: "student01@local", Roles: []string{"lab-student"}}
}

// aclWritable mirrors the production ACL shape: a user's own home directory is
// granted create/modify/delete, not just view/download. The base acl() fixture
// deliberately omits create, so the move tests build on this instead.
func aclWritable() ACL {
	a := acl()
	a.Identities["student01@local"] = []Scope{
		{Source: "public", View: true, Download: true},
		{Source: "users", Path: "student01", View: true, Download: true, Modify: true, Create: true, Delete: true},
		{Source: "plasmids", View: true, Download: true},
		{Source: "genomes", Path: "grp-rnaseq", View: true, Download: true},
	}
	return a
}

func TestScanIndexesRealTree(t *testing.T) {
	reg := New(writeTree(t), acl())
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	if reg.Count() < 10 {
		t.Fatalf("expected the full tree to be indexed, got %d", reg.Count())
	}
	var found bool
	for _, e := range reg.Visible(student(), "plasmids") {
		if e.Name == "plasmid.md" {
			found = true
		}
	}
	if !found {
		t.Fatal("shared plasmid note not visible to a lab student")
	}
}

func TestPersonalFilesArePrivate(t *testing.T) {
	reg := New(writeTree(t), acl())
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	for _, e := range reg.Visible(student(), "users") {
		if e.Name == "student02" {
			t.Fatal("another user's directory leaked")
		}
	}
	other := Identity{UserID: "student02@local", Email: "student02@local", Roles: []string{"lab-student"}}
	for _, e := range reg.Visible(other, "users") {
		if e.Name == "student01" {
			t.Fatal("cross-user directory leaked")
		}
	}
}

func TestGenomeGroupGrant(t *testing.T) {
	reg := New(writeTree(t), acl())
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	granted := 0
	for _, e := range reg.Visible(student(), "genomes") {
		if e.Path == "grp-rnaseq" {
			granted++
		}
	}
	if granted != 1 {
		t.Fatalf("expected the granted genome folder, got %d", granted)
	}
	outsider := Identity{UserID: "student02@local", Email: "student02@local", Roles: []string{"lab-student"}}
	for _, e := range reg.Visible(outsider, "genomes") {
		if e.Path == "grp-rnaseq" {
			t.Fatal("genome folder leaked to a non member")
		}
	}
}

func TestUnknownIdentitySeesNothing(t *testing.T) {
	reg := New(writeTree(t), acl())
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	visitor := Identity{UserID: "guest", Email: "guest@example.com", Roles: []string{"lab-student"}}
	for _, source := range []string{"public", "users", "plasmids", "genomes"} {
		if len(reg.Visible(visitor, source)) != 0 {
			t.Fatalf("identity without file scopes saw %s", source)
		}
	}
}

func TestAdminCannotBrowsePersonalFiles(t *testing.T) {
	// 组授权（包括管理组）只能作用于自己的家目录；别人的个人文件必须
	// 由本人显式共享（只读 scope），这是个人空间与共享盘的分界。
	tree := acl()
	tree.Groups = map[string][]Scope{
		"lab-admin": {{Source: "users", View: true, Download: true, Create: true, Modify: true, Delete: true}},
	}
	reg := New(writeTree(t), tree)
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	admin := Identity{UserID: "admin@local", Email: "admin@local", Roles: []string{"lab-admin"}, Admin: true}
	if got := reg.Visible(admin, "users"); len(got) != 0 {
		t.Fatalf("admin saw personal files despite the personal-space rule: %d entries", len(got))
	}
	if len(reg.Visible(admin, "public")) == 0 {
		t.Fatal("admin lost access to shared sources")
	}
	if reg.CanPath(admin, "users", "student01/maize.fa", "read") {
		t.Fatal("admin passed CanPath for another user's personal file")
	}
	if reg.CanPath(admin, "users", "student01/new.fa", "create") {
		t.Fatal("admin obtained write access to another user's home")
	}
	if paths := reg.WritePaths(admin, "users"); len(paths) != 1 || paths[0] != "admin" {
		t.Fatalf("group grant exposed more than the own home: %v", paths)
	}

	shared := acl()
	shared.Identities["admin@local"] = []Scope{
		{Source: "users", Path: "student01", View: true, Download: true},
	}
	reg2 := New(writeTree(t), shared)
	if err := reg2.Scan(); err != nil {
		t.Fatal(err)
	}
	if !reg2.CanPath(admin, "users", "student01/maize.fa", "read") {
		t.Fatal("an explicit share was not honoured")
	}
	if reg2.CanPath(admin, "users", "student01/maize.fa", "modify") {
		t.Fatal("an explicit read-only share granted write")
	}
}

func TestDownloadNeedsDownloadPermission(t *testing.T) {
	reg := New(writeTree(t), ACL{Identities: map[string][]Scope{
		"viewer@local": {{Source: "public", View: true}},
	}})
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	viewer := Identity{UserID: "viewer@local", Email: "viewer@local", Roles: []string{"lab-student"}}
	for _, e := range reg.Visible(viewer, "public") {
		if e.Name == "readme.md" {
			if reg.Can(viewer, e, "download") {
				t.Fatal("download granted without the download permission")
			}
			if !reg.Can(viewer, e, "preview") {
				t.Fatal("preview denied although view was granted")
			}
		}
	}
}

func TestResolveRejectsTraversal(t *testing.T) {
	reg := New(writeTree(t), acl())
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Read(Entry{Source: "users", Path: "../../etc/passwd"}, 1024); err == nil {
		t.Fatal("path traversal was accepted")
	}
}

func TestReadIsBounded(t *testing.T) {
	root := writeTree(t)
	big := filepath.Join(root, "public", "big.bin")
	if err := os.WriteFile(big, make([]byte, 4096), 0o644); err != nil {
		t.Fatal(err)
	}
	reg := New(root, acl())
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	entry, ok := reg.SourceRoot("public")
	if !ok {
		t.Fatal("missing source root")
	}
	for _, e := range reg.Visible(student(), "public") {
		if e.Name == "big.bin" {
			entry = e
		}
	}
	if _, err := reg.Read(entry, 1024); err == nil {
		t.Fatal("oversized file was returned")
	}
}

func aclFile(t *testing.T, root string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "labgo-acl.json")
	doc := map[string]any{
		"admins":      []string{"admin"},
		"exported_at": 1793710606,
		"source":      "quantum",
		"identities":  acl().Identities,
	}
	raw, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o640); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestProvisionUserCreatesPrivateSpace(t *testing.T) {
	root := writeTree(t)
	path := aclFile(t, root)
	reg := NewWithACL(root, acl(), path)
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	res, err := reg.ProvisionUser("student03")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Created {
		t.Fatal("expected a newly created home")
	}
	if info, err := os.Stat(filepath.Join(root, "users", "student03")); err != nil || !info.IsDir() {
		t.Fatalf("personal directory missing: %v", err)
	}
	identity := Identity{UserID: "student03@local", Email: "student03@local", Roles: []string{"lab-student"}}
	if !reg.Writable(identity, "users") {
		t.Fatal("new user cannot write personal files")
	}
	if len(reg.Visible(identity, "users")) != 1 {
		t.Fatalf("expected only the own home, got %d entries", len(reg.Visible(identity, "users")))
	}
	if !reg.Can(identity, Entry{Source: "public", Path: "readme.md"}, "read") {
		t.Fatal("public read scope missing")
	}
	if _, err := reg.ProvisionUser("student03"); err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, s := range reg.Scopes(identity) {
		if s.Source == "users" && s.Path == "student03" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("provisioning is not idempotent: %d user scopes", count)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("persisted ACL is not valid JSON: %v", err)
	}
	admins, _ := doc["admins"].([]any)
	if doc["source"] != "quantum" || len(admins) != 1 || admins[0] != "admin" {
		t.Fatalf("top-level ACL metadata was not preserved: %s", raw)
	}
}

func TestProvisionUserRequiresACLStore(t *testing.T) {
	reg := New(writeTree(t), acl())
	if _, err := reg.ProvisionUser("student03"); !errors.Is(err, ErrACLStore) {
		t.Fatalf("expected ACL store error, got %v", err)
	}
	if scopes := reg.Scopes(Identity{Email: "student03@local"}); len(scopes) != 0 {
		t.Fatal("in-memory ACL changed although persistence failed")
	}
}

func TestLoadACLSanitizesRetiredSources(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "retired.json")
	body := `{
	  "identities": {"student01@local": [
	    {"source":"course-materials","view":true},
	    {"source":"projects","path":"grp-mcn","view":true},
	    {"source":"public","view":true}
	  ]},
	  "groups": {"lab-student": [{"source":"course-materials","view":true},{"source":"genomes","view":true}]}
	}`
	if err := os.WriteFile(path, []byte(body), 0o640); err != nil {
		t.Fatal(err)
	}
	acl, err := LoadACL(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := acl.Identities["student01@local"]; len(got) != 1 || got[0].Source != "public" {
		t.Fatalf("retired identity scopes survived: %+v", got)
	}
	if got := acl.Groups["lab-student"]; len(got) != 1 || got[0].Source != "genomes" {
		t.Fatalf("retired group scopes survived: %+v", got)
	}
}

func TestScanRecordsCreatedTime(t *testing.T) {
	reg := New(writeTree(t), acl())
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	for _, e := range reg.Visible(student(), "public") {
		if e.Path == "readme.md" && e.Created == "" {
			t.Fatal("created time missing on public/readme.md")
		}
	}
}

func TestVisibleSortedGroupsDirsAndHonoursOrder(t *testing.T) {
	// 需要一个对整个 genomes 源可见的身份：源根只有在全源 scope 下才可列出，
	// 这样才能同时覆盖“源根置顶 / 目录先于文件 / 组内升降序”三种情形。
	full := ACL{Identities: map[string][]Scope{
		"teacher01@local": {{Source: "genomes", View: true, Download: true}},
	}}
	reg := New(writeTree(t), full)
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	teacher := Identity{UserID: "teacher01@local", Email: "teacher01@local"}
	asc := reg.VisibleSorted(teacher, "genomes", "name", false)
	if len(asc) < 3 || asc[0].Path != "" {
		t.Fatalf("source root must sort first: %+v", asc)
	}
	// 组内：目录整体排在文件之前
	seenFile := false
	for _, e := range asc[1:] {
		if e.Dir && seenFile {
			t.Fatalf("directory %q listed after files: %+v", e.Path, asc)
		}
		if !e.Dir {
			seenFile = true
		}
	}
	desc := reg.VisibleSorted(teacher, "genomes", "name", true)
	if len(desc) != len(asc) {
		t.Fatalf("desc listing lost entries: %d vs %d", len(desc), len(asc))
	}
	// 目录恒在文件前（与主流文件管理器一致），降序只反转组内顺序
	inverse := func(list []Entry) []string {
		names := make([]string, 0, len(list))
		for i := len(list) - 1; i >= 0; i-- {
			names = append(names, list[i].Name)
		}
		return names
	}
	split := func(list []Entry) (dirs, files []Entry) {
		for _, e := range list[1:] {
			if e.Dir {
				dirs = append(dirs, e)
			} else {
				files = append(files, e)
			}
		}
		return dirs, files
	}
	ascDirs, ascFiles := split(asc)
	descDirs, descFiles := split(desc)
	if got := inverse(ascDirs); !equalNames(got, descDirs) {
		t.Fatalf("dirs not reversed: want %v got %v", got, nameList(descDirs))
	}
	if got := inverse(ascFiles); !equalNames(got, descFiles) {
		t.Fatalf("files not reversed: want %v got %v", got, nameList(descFiles))
	}
}

func TestUsageAggregatesByDirectoryPrefix(t *testing.T) {
	reg := New(writeTree(t), acl())
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	usage := reg.Usage(student(), "genomes")
	if usage.Total <= 0 || usage.Files != 1 {
		t.Fatalf("unexpected usage: %+v", usage)
	}
	if usage.Dirs["grp-rnaseq"] != usage.Total {
		t.Fatalf("directory bucket missing: %+v", usage.Dirs)
	}
	if usage.Dirs[""] != usage.Total {
		t.Fatalf("root bucket must carry the total: %+v", usage.Dirs)
	}
	// 无权限的来源不应泄漏任何字节
	other := reg.Usage(Identity{Email: "nobody@local"}, "genomes")
	if other.Total != 0 {
		t.Fatalf("unauthorised usage leaked %d bytes", other.Total)
	}
}

func nameList(list []Entry) []string {
	out := make([]string, 0, len(list))
	for _, e := range list {
		out = append(out, e.Name)
	}
	return out
}

func equalNames(want []string, got []Entry) bool {
	if len(want) != len(got) {
		return false
	}
	for i := range want {
		if want[i] != got[i].Name {
			return false
		}
	}
	return true
}

// ---- 用户组（预配置）+ 用户单独权限 ----

func layeredACL() ACL {
	return ACL{
		Groups: map[string][]Scope{
			"lab-student": {
				{Source: "public", View: true, Download: true},
				{Source: "plasmids", View: true, Download: true},
			},
			"lab-teacher": {
				{Source: "public", View: true, Download: true},
				{Source: "plasmids", View: true, Download: true, Create: true, Modify: true, Delete: true},
			},
		},
		Identities: map[string][]Scope{
			"student01@local": {{Source: "users", Path: "student01", View: true, Create: true, Modify: true, Delete: true}},
			"revoked@local":   {{Source: "public", Deny: true}},
			"writer@local":    {{Source: "public", View: true, Download: true, Create: true, Modify: true, Delete: true}},
		},
	}
}

func TestGroupGrantsAreInheritedFromRoles(t *testing.T) {
	reg := New(writeTree(t), layeredACL())
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	student := Identity{UserID: "student01@local", Email: "student01@local", Roles: []string{"lab-student"}}
	if !reg.Can(student, Entry{Source: "public", Path: "readme.md"}, "read") {
		t.Fatal("group membership did not grant public read")
	}
	if !reg.Can(student, Entry{Source: "public", Path: "readme.md"}, "download") {
		t.Fatal("group download bit lost")
	}
	// 学生组对 public 只有读权限：写按钮必须与服务端判定一致
	if reg.Writable(student, "public") {
		t.Fatal("student obtained write access through the group")
	}
	outsider := Identity{UserID: "nobody", Email: "nobody@local"}
	if reg.Can(outsider, Entry{Source: "public", Path: "readme.md"}, "read") {
		t.Fatal("access granted without any group")
	}
}

func TestTeacherGroupCanWritePlasmids(t *testing.T) {
	reg := New(writeTree(t), layeredACL())
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	teacher := Identity{UserID: "ta01@local", Email: "ta01@local", Roles: []string{"lab-teacher"}}
	if !teacher.HasRole("lab-teacher") {
		t.Fatal("role helper broken")
	}
	for _, action := range []string{"create", "modify", "delete"} {
		if !reg.CanPath(teacher, "plasmids", "", action) {
			t.Fatalf("teacher lost %s through the group", action)
		}
	}
	if reg.CanPath(teacher, "public", "", "create") {
		t.Fatal("teacher obtained write access outside the group definition")
	}
	if !reg.Writable(teacher, "plasmids") {
		t.Fatal("Writable disagrees with CanPath")
	}
}

func TestExplicitDenyBeatsUserAndGroupAllow(t *testing.T) {
	reg := New(writeTree(t), layeredACL())
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	revoked := Identity{UserID: "revoked@local", Email: "revoked@local", Roles: []string{"lab-student"}}
	if reg.Can(revoked, Entry{Source: "public", Path: "readme.md"}, "read") {
		t.Fatal("group allow overrode the explicit deny")
	}
	if !reg.Can(revoked, Entry{Source: "plasmids", Path: "plasmid.md"}, "read") {
		t.Fatal("deny leaked into an unrelated source")
	}
	// 同一个人同时有个人允许与个人拒绝：拒绝仍然优先
	both := Identity{UserID: "writer@local", Email: "writer@local", Roles: []string{"lab-student"}}
	bothDeny := ACL{
		Groups: layeredACL().Groups,
		Identities: map[string][]Scope{
			"writer@local": {
				{Source: "public", View: true, Download: true},
				{Source: "public", Deny: true},
			},
		},
	}
	reg2 := New(writeTree(t), bothDeny)
	if err := reg2.Scan(); err != nil {
		t.Fatal(err)
	}
	if reg2.Can(both, Entry{Source: "public", Path: "readme.md"}, "read") {
		t.Fatal("user allow beat user deny")
	}
}

func TestDenyBeatsAdminBypass(t *testing.T) {
	acl := layeredACL()
	acl.Identities["revoked@local"] = []Scope{{Source: "public", Deny: true}}
	reg := New(writeTree(t), acl)
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	admin := Identity{UserID: "revoked@local", Email: "revoked@local", Roles: []string{"lab-admin"}, Admin: true}
	if reg.Can(admin, Entry{Source: "public", Path: "readme.md"}, "read") {
		t.Fatal("admin bypass ignored the explicit revoke")
	}
	if !reg.Can(admin, Entry{Source: "plasmids", Path: "plasmid.md"}, "read") {
		t.Fatal("admin bypass stopped working on unrelated paths")
	}
	if reg.Writable(admin, "public") {
		t.Fatal("Writable granted a denied source to an admin")
	}
	if paths := reg.WritePaths(admin, "public"); len(paths) != 0 {
		t.Fatalf("WritePaths leaked %v for a denied source", paths)
	}
}

func TestSourceRootNeedsWholeSourceScope(t *testing.T) {
	acl := ACL{
		Groups:     map[string][]Scope{"lab-student": {{Source: "genomes", Path: "grp-rnaseq", View: true, Download: true}}},
		Identities: map[string][]Scope{"p1@local": {}},
	}
	reg := New(writeTree(t), acl)
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	id := Identity{UserID: "p1@local", Email: "p1@local", Roles: []string{"lab-student"}}
	root, ok := reg.SourceRoot("genomes")
	if !ok {
		t.Fatal("source root missing")
	}
	if reg.Can(id, root, "list") {
		t.Fatal("directory-level grant exposed the whole source")
	}
	// 但被授权目录里的文件仍然可见
	if !reg.Can(id, Entry{Source: "genomes", Path: "grp-rnaseq/data.fa"}, "read") {
		t.Fatal("granted directory not readable")
	}
	if reg.Writable(id, "genomes") {
		t.Fatal("read-only grant must not report writable")
	}
}

func TestSubDirectoryOnlyGrantKeepsSourceWritable(t *testing.T) {
	acl := ACL{
		Groups: map[string][]Scope{
			"lab-teacher": {{Source: "genomes", Path: "grp-mcn", View: true, Create: true, Modify: true, Delete: true}},
		},
		Identities: map[string][]Scope{"ta02@local": {}},
	}
	reg := New(writeTree(t), acl)
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	id := Identity{UserID: "ta02@local", Email: "ta02@local", Roles: []string{"lab-teacher"}}
	if !reg.Writable(id, "genomes") {
		t.Fatal("writable sub-directory not reflected in the source")
	}
	if paths := reg.WritePaths(id, "genomes"); len(paths) != 1 || paths[0] != "grp-mcn" {
		t.Fatalf("unexpected write paths %v", paths)
	}
	if reg.CanPath(id, "genomes", "grp-rnaseq/new.txt", "create") {
		t.Fatal("write leaked to a sibling project")
	}
}

func TestPersonalShareGrantsReadOnlyToRecipient(t *testing.T) {
	root := writeTree(t)
	path := aclFile(t, root)
	reg := NewWithACL(root, acl(), path)
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	owner := Identity{UserID: "student01@local", Email: "student01@local"}
	share, err := reg.SetPersonalShare(owner, "maize.fa", []string{"student02"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if share.Path != "maize.fa" || len(share.Recipients) != 1 || share.Recipients[0] != "student02" {
		t.Fatalf("unexpected share: %+v", share)
	}
	if share.Writable {
		t.Fatal("a read-only share reported writable")
	}
	recipient := Identity{UserID: "student02@local", Email: "student02@local"}
	if !reg.CanPath(recipient, "users", "student01/maize.fa", "read") {
		t.Fatal("recipient cannot read the shared file")
	}
	if reg.CanPath(recipient, "users", "student01/maize.fa", "modify") {
		t.Fatal("share granted write access")
	}
	if reg.CanPath(recipient, "users", "student01/secret-other.fa", "read") {
		t.Fatal("share leaked to a sibling path")
	}
	shared := reg.SharedWith(recipient)
	if len(shared) != 1 || shared[0].Owner != "student01" || shared[0].Path != "student01/maize.fa" {
		t.Fatalf("shared-with listing wrong: %+v", shared)
	}
	if shared[0].Writable {
		t.Fatal("read-only share reported as writable")
	}
	shares := reg.PersonalShares("student01")
	if len(shares) != 1 || shares[0].Path != "maize.fa" || len(shares[0].Recipients) != 1 {
		t.Fatalf("owner share listing wrong: %+v", shares)
	}
	if shares[0].Writable {
		t.Fatal("owner share listing reported a read-only share as writable")
	}

	// 替换为空名单即撤销共享。
	if _, err := reg.SetPersonalShare(owner, "maize.fa", nil, false); err != nil {
		t.Fatal(err)
	}
	if reg.CanPath(recipient, "users", "student01/maize.fa", "read") {
		t.Fatal("revoked share still readable")
	}
	if len(reg.PersonalShares("student01")) != 0 {
		t.Fatal("revoked share still listed")
	}

	if _, err := reg.SetPersonalShare(owner, "maize.fa", []string{"ghost"}, false); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown recipient accepted: %v", err)
	}
	if _, err := reg.SetPersonalShare(owner, "../student02/secret.fa", nil, false); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("traversal accepted: %v", err)
	}
	if _, err := New(root, acl()).SetPersonalShare(owner, "maize.fa", nil, false); !errors.Is(err, ErrACLStore) {
		t.Fatalf("share without an ACL store accepted: %v", err)
	}
}

// shareACL mirrors the production ACL shape: both students own a fully
// writable home directory, so a shared file can really be moved into the
// recipient's own space.
func shareACL() ACL {
	a := aclWritable()
	a.Identities["student02@local"] = []Scope{
		{Source: "public", View: true, Download: true},
		{Source: "users", Path: "student02", View: true, Download: true, Create: true, Modify: true, Delete: true},
		{Source: "plasmids", View: true, Download: true},
		{Source: "genomes", Path: "grp-mcn", View: true, Download: true},
	}
	return a
}

func TestPersonalShareWritableGrantsEditRights(t *testing.T) {
	root := writeTree(t)
	path := aclFile(t, root)
	if err := os.WriteFile(filepath.Join(root, "users/student01/notes.md"), []byte("notes"), 0o644); err != nil {
		t.Fatal(err)
	}
	reg := NewWithACL(root, shareACL(), path)
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	owner := Identity{UserID: "student01@local", Email: "student01@local"}
	recipient := Identity{UserID: "student02@local", Email: "student02@local"}

	share, err := reg.SetPersonalShare(owner, "maize.fa", []string{"student02"}, true)
	if err != nil {
		t.Fatal(err)
	}
	if !share.Writable {
		t.Fatalf("writable share not reported: %+v", share)
	}
	if !reg.CanPath(recipient, "users", "student01/maize.fa", "modify") {
		t.Fatal("writable share did not grant modify")
	}
	if !reg.CanPath(recipient, "users", "student01/maize.fa", "create") {
		t.Fatal("writable share did not grant create")
	}
	if !reg.CanPath(recipient, "users", "student01/maize.fa/new.txt", "create") {
		t.Fatal("writable share did not grant create inside the shared directory")
	}
	// 共享出去的路径允许接收方删除：物理上只有一份，删除是全局的
	// （owner 那份也会消失），因此共享出去的条目必须有 delete 权限。
	if !reg.CanPath(recipient, "users", "student01/maize.fa", "delete") {
		t.Fatal("shared file must be deletable by the recipient")
	}
	if reg.CanPath(recipient, "users", "student01", "create") {
		t.Fatal("writable share escaped the shared path")
	}

	// SharedWith 与 PersonalShares 必须报告同一个"可编辑"标记。
	shared := reg.SharedWith(recipient)
	if len(shared) != 1 || !shared[0].Writable {
		t.Fatalf("shared-with listing wrong: %+v", shared)
	}
	shares := reg.PersonalShares("student01")
	if len(shares) != 1 || !shares[0].Writable {
		t.Fatalf("owner share listing wrong: %+v", shares)
	}

	// 标记随 ACL 一起落盘：重新加载后仍然是可写共享。
	loaded, err := LoadACL(path)
	if err != nil {
		t.Fatal(err)
	}
	reloaded := NewWithACL(root, loaded, path)
	if err := reloaded.Scan(); err != nil {
		t.Fatal(err)
	}
	if !reloaded.CanPath(recipient, "users", "student01/maize.fa", "modify") {
		t.Fatal("writable grant did not survive a reload")
	}

	// 接收方现在真的可以移动共享出来的文件（共享视图"无法移动"的根因修复）。
	var sharedFile Entry
	for _, e := range reg.Visible(recipient, "users") {
		if e.Path == "student01/maize.fa" {
			sharedFile = e
		}
	}
	if sharedFile.ID == "" {
		t.Fatal("shared file not visible to the recipient")
	}
	if _, err := reg.Move(recipient, sharedFile.ID, "student02"); err != nil {
		t.Fatalf("recipient could not move the shared file: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "users/student02/maize.fa")); err != nil {
		t.Fatalf("moved file missing in the recipient's home: %v", err)
	}
}

func TestPersonalShareReadOnlyKeepsRecipientLocked(t *testing.T) {
	root := writeTree(t)
	path := aclFile(t, root)
	if err := os.WriteFile(filepath.Join(root, "users/student01/notes.md"), []byte("notes"), 0o644); err != nil {
		t.Fatal(err)
	}
	reg := NewWithACL(root, shareACL(), path)
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	owner := Identity{UserID: "student01@local", Email: "student01@local"}
	recipient := Identity{UserID: "student02@local", Email: "student02@local"}

	// 先开一个可写共享，再改回只读：旧的写权限必须一并撤销。
	if _, err := reg.SetPersonalShare(owner, "notes.md", []string{"student02"}, true); err != nil {
		t.Fatal(err)
	}
	if !reg.CanPath(recipient, "users", "student01/notes.md", "modify") {
		t.Fatal("writable share did not grant modify")
	}

	share, err := reg.SetPersonalShare(owner, "notes.md", []string{"student02"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if share.Writable {
		t.Fatalf("read-only share reported writable: %+v", share)
	}
	if !reg.CanPath(recipient, "users", "student01/notes.md", "read") {
		t.Fatal("recipient cannot read the shared file")
	}
	if !reg.CanPath(recipient, "users", "student01/notes.md", "download") {
		t.Fatal("recipient cannot download the shared file")
	}
	if reg.CanPath(recipient, "users", "student01/notes.md", "modify") {
		t.Fatal("read-only share granted modify")
	}
	if reg.CanPath(recipient, "users", "student01/notes.md", "create") {
		t.Fatal("read-only share granted create")
	}
	shared := reg.SharedWith(recipient)
	if len(shared) != 1 || shared[0].Writable {
		t.Fatalf("shared-with listing wrong: %+v", shared)
	}
	shares := reg.PersonalShares("student01")
	if len(shares) != 1 || shares[0].Writable {
		t.Fatalf("owner share listing wrong: %+v", shares)
	}

	var sharedFile Entry
	for _, e := range reg.Visible(recipient, "users") {
		if e.Path == "student01/notes.md" {
			sharedFile = e
		}
	}
	if sharedFile.ID == "" {
		t.Fatal("shared file not visible to the recipient")
	}
	if _, err := reg.Move(recipient, sharedFile.ID, "student02"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("read-only share allowed a move: %v", err)
	}
}

func TestPersonalShareRecipientCannotEscalate(t *testing.T) {
	root := writeTree(t)
	path := aclFile(t, root)
	reg := NewWithACL(root, shareACL(), path)
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	owner := Identity{UserID: "student01@local", Email: "student01@local"}
	recipient := Identity{UserID: "student02@local", Email: "student02@local"}

	if _, err := reg.SetPersonalShare(owner, "maize.fa", []string{"student02"}, false); err != nil {
		t.Fatal(err)
	}
	// owner 恒取调用者身份：收件人无法把别人的家目录路径改成自己的可写共享。
	if _, err := reg.SetPersonalShare(recipient, "student01/maize.fa", []string{"student02"}, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("recipient could target another home: %v", err)
	}
	if _, err := reg.SetPersonalShare(recipient, "../student01/maize.fa", nil, true); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("traversal accepted: %v", err)
	}
	if _, err := reg.SetPersonalShare(recipient, "maize.fa", []string{"student02"}, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("recipient could share a path it does not own: %v", err)
	}
	// 收件人自己的那一份共享必须仍然是只读。
	if reg.CanPath(recipient, "users", "student01/maize.fa", "modify") {
		t.Fatal("recipient escalated its own grant")
	}
	shares := reg.PersonalShares("student01")
	if len(shares) != 1 || shares[0].Writable {
		t.Fatalf("owner share listing changed by the recipient: %+v", shares)
	}
}

func TestPersonalSpaceStaysPrivateForAdminGroups(t *testing.T) {
	acl := layeredACL()
	acl.Groups["lab-admin"] = []Scope{{Source: "users", View: true, Download: true, Create: true, Modify: true, Delete: true}}
	reg := New(writeTree(t), acl)
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	admin := Identity{UserID: "root@local", Email: "root@local", Roles: []string{"lab-admin"}, Admin: true}
	if len(reg.Visible(admin, "users")) != 0 {
		t.Fatal("group grant opened personal files to an admin")
	}
	if reg.CanPath(admin, "users", "student01/maize.fa", "read") {
		t.Fatal("admin read another user's personal file")
	}
	if !reg.CanPath(admin, "users", "root/notes.md", "create") {
		t.Fatal("admin lost their own personal space")
	}
	// 个人源的"可写路径"永远只可能是自己的家目录，绝不返回表示整源的空路径。
	if paths := reg.WritePaths(admin, "users"); len(paths) != 1 || paths[0] != "root" {
		t.Fatalf("personal source exposed as a whole: %v", paths)
	}
}

func TestSetGroupGrantsPersistsAndReloads(t *testing.T) {
	root := writeTree(t)
	path := aclFile(t, root)
	reg := NewWithACL(root, layeredACL(), path)
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	grants, err := reg.SetGroupGrants("lab-student", []Grant{
		{Source: "public", Path: "", Access: "read"},
		{Source: "plasmids", Path: "", Access: "write"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(grants) != 2 {
		t.Fatalf("unexpected grants: %+v", grants)
	}
	bySource := map[string]string{}
	for _, g := range grants {
		bySource[g.Source] = g.Access
	}
	if bySource["public"] != "read" || bySource["plasmids"] != "write" {
		t.Fatalf("wrong grants returned: %+v", grants)
	}
	student := Identity{UserID: "s9@local", Email: "s9@local", Roles: []string{"lab-student"}}
	if !reg.CanPath(student, "plasmids", "", "modify") {
		t.Fatal("edited group grant did not take effect")
	}
	reloaded, err := LoadACL(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(reloaded.Groups["lab-student"]) != 2 {
		t.Fatalf("group grants lost on persist: %+v", reloaded.Groups)
	}
	if _, err := reg.SetGroupGrants("Bad Name", nil); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("invalid group name accepted: %v", err)
	}
	if _, err := reg.SetGroupGrants("lab-student", []Grant{{Source: "users", Access: "read"}}); !errors.Is(err, ErrInvalidPath) {
		t.Fatal("group grant accepted a non-shared source")
	}
}

func TestFileGroupsAndDelete(t *testing.T) {
	root := writeTree(t)
	path := aclFile(t, root)
	acl := layeredACL()
	acl.Groups["genome-mcn"] = []Scope{{Source: "genomes", Path: "grp-mcn", View: true, Download: true}}
	reg := NewWithACL(root, acl, path)
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	groups := reg.FileGroups()
	if len(groups) != 3 {
		t.Fatalf("expected 3 groups, got %+v", groups)
	}
	if groups[0].Name != "genome-mcn" || groups[1].Name != "lab-student" || groups[2].Name != "lab-teacher" {
		t.Fatalf("groups must be sorted and labelled: %+v", groups)
	}
	if groups[0].Builtin || !groups[2].Builtin {
		t.Fatalf("builtin flag wrong: %+v", groups)
	}
	if err := reg.DeleteFileGroup("lab-student"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("builtin group deleted: %v", err)
	}
	if err := reg.DeleteFileGroup("genome-mcn"); err != nil {
		t.Fatal(err)
	}
	if len(reg.FileGroups()) != 2 {
		t.Fatal("custom group survived deletion")
	}
	member := Identity{UserID: "s1@local", Email: "s1@local", Roles: []string{"genome-mcn"}}
	if reg.Can(member, Entry{Source: "genomes", Path: "grp-mcn/data.fa"}, "read") {
		t.Fatal("deleted group still grants access")
	}
	if err := reg.DeleteFileGroup("ghost"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown group deletion: %v", err)
	}
}

func TestDefaultGroupsHaveOneRowPerDirectory(t *testing.T) {
	// 组模板是管理员在界面上看到的"默认值"：同一目录出现两行（一行只读一行读写）
	// 会让人无法判断真实权限，也让保存后的配置与显示不一致。
	for name, scopes := range DefaultGroups() {
		seen := map[string]bool{}
		for _, s := range scopes {
			key := s.Source + "\x00" + s.Path
			if seen[key] {
				t.Fatalf("group %s has duplicate rows for %s", name, key)
			}
			seen[key] = true
			if s.Deny {
				t.Fatalf("builtin group %s carries a deny row", name)
			}
			if (s.Create || s.Modify || s.Delete) && !(s.View && s.Download) {
				t.Fatalf("group %s grants write bits without read: %+v", name, s)
			}
		}
	}
}

func TestLoadACLSeedsGroupsUnlessDisabled(t *testing.T) {
	dir := t.TempDir()
	defaults, err := LoadACL(filepath.Join(dir, "missing.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(defaults.Groups) != len(DefaultGroups()) {
		t.Fatalf("builtin groups not seeded: %+v", defaults.Groups)
	}
	disabled := filepath.Join(dir, "disabled.json")
	body := `{"identities":{"student01@local":[{"source":"public","view":true}]},"groups":{}}`
	if err := os.WriteFile(disabled, []byte(body), 0o640); err != nil {
		t.Fatal(err)
	}
	acl, err := LoadACL(disabled)
	if err != nil {
		t.Fatal(err)
	}
	if acl.Groups == nil || len(acl.Groups) != 0 {
		t.Fatalf("an explicitly disabled group map was refilled: %+v", acl.Groups)
	}
}

func TestPreviewAccessReportsOrigin(t *testing.T) {
	reg := New(writeTree(t), layeredACL())
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	probes := reg.PreviewAccess(Identity{
		UserID: "student01@local", Email: "student01@local", Roles: []string{"lab-student"},
	})
	var publicRoot, plasmidRoot *EffectiveProbe
	for i := range probes {
		p := &probes[i]
		if p.Source == "public" && p.Path == "" {
			publicRoot = p
		}
		if p.Source == "plasmids" && p.Path == "" {
			plasmidRoot = p
		}
	}
	if publicRoot == nil || plasmidRoot == nil {
		t.Fatalf("preview missing source roots: %+v", probes)
	}
	if !publicRoot.Actions["read"] || publicRoot.Origin["read"] != "group:lab-student" {
		t.Fatalf("group origin not reported: %+v", publicRoot)
	}
	if publicRoot.Actions["create"] {
		t.Fatal("preview claims write access the group does not grant")
	}
	if !plasmidRoot.Actions["read"] {
		t.Fatal("plasmid source missing from preview")
	}
	revoked := reg.PreviewAccess(Identity{UserID: "revoked@local", Email: "revoked@local", Roles: []string{"lab-student"}})
	for _, p := range revoked {
		if p.Source == "public" && p.Actions["read"] {
			t.Fatalf("preview hid the deny rule: %+v", p)
		}
	}
	// 个人权限与组权限的来源标注必须可区分，管理界面靠它显示"继承自组"
	own := reg.PreviewAccess(Identity{UserID: "writer@local", Email: "writer@local"})
	var found bool
	for _, p := range own {
		if p.Source == "public" && p.Path == "" {
			found = true
			if p.Origin["read"] != "user" {
				t.Fatalf("individual grant mislabelled: %+v", p)
			}
			if !p.Actions["modify"] || p.Origin["modify"] != "user" {
				t.Fatalf("individual write grant missing: %+v", p)
			}
		}
	}
	if !found {
		t.Fatal("preview dropped the granted source")
	}
}

func TestAccountGrantsExportDenyRows(t *testing.T) {
	root := writeTree(t)
	reg := NewWithACL(root, layeredACL(), aclFile(t, root))
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	got := reg.AccountGrants()["revoked"]
	if len(got) != 1 || got[0].Access != "deny" || got[0].Source != "public" {
		t.Fatalf("deny grant not exported: %+v", got)
	}
	if _, err := reg.SetFileGrants("student01", []Grant{
		{Source: "public", Access: "read"},
		{Source: "public", Access: "deny"},
	}); err != nil {
		t.Fatal(err)
	}
	exported := reg.AccountGrants()["student01"]
	if len(exported) != 1 || exported[0].Access != "deny" {
		t.Fatalf("deny must win when both rows are sent: %+v", exported)
	}
	if reg.CanPath(Identity{Email: "student01@local"}, "public", "readme.md", "read") {
		t.Fatal("stored deny does not block reads")
	}
}

func TestDeprovisionUserRemovesEverything(t *testing.T) {
	root := writeTree(t)
	path := aclFile(t, root)
	doc := ACL{Identities: map[string][]Scope{
		"student01@local": {
			{Source: "public", View: true, Download: true},
			{Source: "users", Path: "student03", View: true, Download: true},
		},
	}}
	reg := NewWithACL(root, doc, path)
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.ProvisionUser("student03"); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(root, "users", "student03")
	if err := os.WriteFile(filepath.Join(home, "note.txt"), []byte("private"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	ghost := Identity{UserID: "student03@local", Email: "student03@local", Roles: []string{"lab-student"}}
	if !reg.Can(ghost, Entry{Source: "public", Path: "readme.md"}, "read") {
		t.Fatal("provisioned account cannot read public files")
	}

	res, err := reg.DeprovisionUser("student03")
	if err != nil {
		t.Fatalf("deprovision: %v", err)
	}
	if res.RemovedPaths < 1 || res.RemovedBytes < int64(len("private")) {
		t.Fatalf("personal tree was not counted: %+v", res)
	}
	if _, err := os.Stat(home); err == nil {
		t.Fatal("personal directory survived the removal")
	}
	if reg.Can(ghost, Entry{Source: "public", Path: "readme.md"}, "read") {
		t.Fatal("removed identity still reads public files")
	}
	if scopes := reg.Scopes(ghost); len(scopes) != 0 {
		t.Fatalf("ACL identities survived: %v", scopes)
	}
	if res.RevokedGrants != 1 {
		t.Fatalf("expected the foreign grant to be counted, got %d", res.RevokedGrants)
	}
	if reg.CanPath(Identity{Email: "student01@local"}, "users", "student03", "read") {
		t.Fatal("a grant to the removed home survived")
	}
	if again, err := reg.DeprovisionUser("student03"); err != nil || again.RemovedPaths != 0 {
		t.Fatalf("retrying a finished removal must be harmless: %+v %v", again, err)
	}
	for _, bad := range []string{"", "..", "student03/x", "ab"} {
		if _, err := reg.DeprovisionUser(bad); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("name %q accepted: %v", bad, err)
		}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("student03")) {
		t.Fatal("persisted ACL still mentions the removed account")
	}
}

func TestDeprovisionUserRequiresACLStore(t *testing.T) {
	reg := New(writeTree(t), acl())
	if _, err := reg.DeprovisionUser("student01"); !errors.Is(err, ErrACLStore) {
		t.Fatalf("expected ACL store error, got %v", err)
	}
	if got, want := len(reg.Scopes(Identity{Email: "student01@local"})), len(acl().Identities["student01@local"]); got != want {
		t.Fatalf("in-memory ACL changed although persistence failed: %d scopes, want %d", got, want)
	}
	if _, err := os.Stat(filepath.Join(reg.Root(), "users", "student01")); err != nil {
		t.Fatal("personal directory was removed although the ACL store refused")
	}
}

// Move is the "drag into another folder" operation. These tests pin the three
// properties the storage UI depends on: the subtree follows the directory, a
// destination collision is refused instead of overwritten, and a directory can
// never be moved into its own subtree.
//
// Note: Entry.Path inside one source is source-relative ("student01/maize.fa"),
// the source itself travels separately in Entry.Source.
func TestMoveRelocatesFileAndKeepsRegistryInSync(t *testing.T) {
	root := writeTree(t)
	if err := os.MkdirAll(filepath.Join(root, "users/student01/sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	reg := New(root, aclWritable())
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	var file Entry
	for _, e := range reg.Visible(student(), "users") {
		if e.Name == "maize.fa" {
			file = e
		}
	}
	if file.ID == "" {
		t.Fatal("seed file not indexed")
	}
	if _, err := reg.Move(student(), file.ID, "student01"); err != nil {
		t.Fatalf("moving into the same directory must be a no-op, got %v", err)
	}
	moved, err := reg.Move(student(), file.ID, "student01/sub")
	if err != nil {
		t.Fatalf("move failed: %v", err)
	}
	if moved.Path != "student01/sub/maize.fa" {
		t.Fatalf("unexpected destination: %q", moved.Path)
	}
	if _, err := os.Stat(filepath.Join(root, "users/student01/maize.fa")); !os.IsNotExist(err) {
		t.Fatal("source file still on disk after move")
	}
	if got, ok := reg.Get(moved.ID); !ok || got.Path != moved.Path {
		t.Fatalf("registry did not re-index the moved entry: %+v", got)
	}
}

func TestMoveRefusesOverwrite(t *testing.T) {
	root := writeTree(t)
	if err := os.MkdirAll(filepath.Join(root, "users/student01/target"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "users/student01/target/maize.fa"), []byte(">x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	reg := New(root, aclWritable())
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	var src Entry
	for _, e := range reg.Visible(student(), "users") {
		if e.Path == "student01/maize.fa" {
			src = e
		}
	}
	if src.ID == "" {
		t.Fatal("seed file not indexed")
	}
	if _, err := reg.Move(student(), src.ID, "student01/target"); !errors.Is(err, ErrExists) {
		t.Fatalf("expected ErrExists, got %v", err)
	}
}

func TestMoveRefusesDirectoryIntoItsOwnSubtree(t *testing.T) {
	root := writeTree(t)
	if err := os.MkdirAll(filepath.Join(root, "users/student01/a/b"), 0o755); err != nil {
		t.Fatal(err)
	}
	reg := New(root, aclWritable())
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	var dir Entry
	for _, e := range reg.Visible(student(), "users") {
		if e.Path == "student01/a" {
			dir = e
		}
	}
	if dir.ID == "" {
		t.Fatal("seed directory not indexed")
	}
	if _, err := reg.Move(student(), dir.ID, "student01/a/b"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("expected ErrInvalidPath, got %v", err)
	}
	if _, err := reg.Move(student(), dir.ID, "student01/a"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("expected ErrInvalidPath for self-move, got %v", err)
	}
}

func TestMoveRequiresModifyAndCreate(t *testing.T) {
	root := writeTree(t)
	if err := os.MkdirAll(filepath.Join(root, "public/drop"), 0o755); err != nil {
		t.Fatal(err)
	}
	reg := New(root, aclWritable())
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	var publicFile Entry
	for _, e := range reg.Visible(student(), "public") {
		if e.Name == "readme.md" {
			publicFile = e
		}
	}
	if publicFile.ID == "" {
		t.Fatal("seed public file not indexed")
	}
	if _, err := reg.Move(student(), publicFile.ID, "drop"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("read-only source must refuse the move, got %v", err)
	}
	other := Identity{UserID: "student02@local", Email: "student02@local", Roles: []string{"lab-student"}}
	if _, err := reg.Move(other, publicFile.ID, "drop"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-owner must not move another user's entry, got %v", err)
	}
}

// Copy 与目录大小是文件存储两个新能力：复制必须保留子树且不覆盖，
// 目录大小必须只统计同源子树（否则跨源串味，数字会莫名其妙变大）。
func TestCopyDuplicatesFileWithoutTouchingSource(t *testing.T) {
	root := writeTree(t)
	if err := os.MkdirAll(filepath.Join(root, "users/student01/target"), 0o755); err != nil {
		t.Fatal(err)
	}
	reg := New(root, aclWritable())
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	var src Entry
	for _, e := range reg.Visible(student(), "users") {
		if e.Path == "student01/maize.fa" {
			src = e
		}
	}
	if src.ID == "" {
		t.Fatal("seed file not indexed")
	}
	copied, err := reg.Copy(student(), src.ID, "student01/target", "")
	if err != nil {
		t.Fatalf("copy failed: %v", err)
	}
	if copied.Path != "student01/target/maize.fa" {
		t.Fatalf("unexpected destination: %q", copied.Path)
	}
	if _, err := os.Stat(filepath.Join(root, "users/student01/maize.fa")); err != nil {
		t.Fatal("copy must keep the source file")
	}
	if _, err := reg.Copy(student(), src.ID, "student01/target", ""); !errors.Is(err, ErrExists) {
		t.Fatalf("expected ErrExists on second copy, got %v", err)
	}
}

func TestCopyDirectoryRecursesAndSkipsHidden(t *testing.T) {
	root := writeTree(t)
	if err := os.MkdirAll(filepath.Join(root, "users/student01/proj/raw"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "users/student01/proj/raw/a.txt"), []byte("aaa"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "users/student01/proj/.hidden"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	reg := New(root, aclWritable())
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	var dir Entry
	for _, e := range reg.Visible(student(), "users") {
		if e.Path == "student01/proj" {
			dir = e
		}
	}
	if dir.ID == "" {
		t.Fatal("seed directory not indexed")
	}
	copied, err := reg.Copy(student(), dir.ID, "student01", "proj-copy")
	if err != nil {
		t.Fatalf("copy dir failed: %v", err)
	}
	if copied.Path != "student01/proj-copy" || !copied.Dir {
		t.Fatalf("unexpected copy result: %+v", copied)
	}
	if _, err := os.Stat(filepath.Join(root, "users/student01/proj-copy/raw/a.txt")); err != nil {
		t.Fatal("nested file missing from copied tree")
	}
	if _, err := os.Stat(filepath.Join(root, "users/student01/proj-copy/.hidden")); !os.IsNotExist(err) {
		t.Fatal("hidden files must not be copied")
	}
}

func TestVisibleFillsDirSizeFromOwnSourceOnly(t *testing.T) {
	reg := New(writeTree(t), aclWritable())
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	for _, e := range reg.Visible(student(), "users") {
		if e.Path != "student01" || !e.Dir {
			continue
		}
		// 只有 maize.fa（9 字节）；另一用户目录不计入
		if e.DirSize != int64(len(">m1\nATGC\n")) {
			t.Fatalf("unexpected dir size: %d", e.DirSize)
		}
		return
	}
	t.Fatal("home directory not visible")
}

// 共享文件的删除必须"全局生效"：接收方删了，owner 那份也没了（同一个物理文件），
// 并且这一路径上的共享授权要一起撤掉，不能留下"共享给某人但点开 404"的幽灵条目。
func TestSharedFileDeletePropagatesToOwner(t *testing.T) {
	root := writeTree(t)
	aclPath := filepath.Join(t.TempDir(), "acl.json")
	reg := NewWithACL(root, acl(), aclPath)
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	owner := Identity{UserID: "student01@local", Email: "student01@local", Roles: []string{"lab-student"}}
	recipient := Identity{UserID: "student02@local", Email: "student02@local", Roles: []string{"lab-student"}}

	// owner 把自己的一份共享给接收方
	if _, err := reg.SetPersonalShare(owner, "maize.fa", []string{"student02"}, false); err != nil {
		t.Fatalf("share failed: %v", err)
	}
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	shared, ok := reg.lookup("users", "student01/maize.fa")
	if !ok {
		t.Fatal("shared file not indexed")
	}
	// 接收方看得到这份文件
	if !reg.CanPath(recipient, "users", "student01/maize.fa", "read") {
		t.Fatal("recipient cannot read the shared file")
	}
	// 接收方可以删除（删除即全局删除）
	if _, err := reg.Trash(recipient, shared.ID); err != nil {
		t.Fatalf("recipient delete failed: %v", err)
	}
	// owner 那份也没了：物理文件只有一个
	if _, ok := reg.lookup("users", "student01/maize.fa"); ok {
		t.Fatal("owner copy still present after recipient deleted it")
	}
	if _, statErr := os.Stat(filepath.Join(root, "users", "student01", "maize.fa")); !os.IsNotExist(statErr) {
		t.Fatal("file still on disk after delete")
	}
	// 共享授权也要撤掉：不能再有人"共享给我"一个已删除的文件
	if reg.CanPath(recipient, "users", "student01/maize.fa", "read") {
		t.Fatal("share grant survived the deletion")
	}
}

func TestShareGrantAllowsDeleteForRecipient(t *testing.T) {
	aclPath := filepath.Join(t.TempDir(), "acl.json")
	reg := NewWithACL(writeTree(t), acl(), aclPath)
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	owner := Identity{UserID: "student01@local", Email: "student01@local", Roles: []string{"lab-student"}}
	recipient := Identity{UserID: "student02@local", Email: "student02@local", Roles: []string{"lab-student"}}
	if _, err := reg.SetPersonalShare(owner, "maize.fa", []string{"student02"}, false); err != nil {
		t.Fatal(err)
	}
	if !reg.CanPath(recipient, "users", "student01/maize.fa", "delete") {
		t.Fatal("recipient must be able to delete a shared file (delete is global)")
	}
}

// TestVisibleUnderWritePressureDoesNotDeadlock 守住一个会导致线上整体挂死的坑：
//
// Visible() 原来持有读锁时又调用 fillDirSizes()，后者再次 RLock。
// Go 的 RWMutex 是写者优先的——只要有写者在排队，新的 RLock 就会阻塞，
// 递归读锁于是永久死锁（实测表现：文件列表与 /v1/admin/file-access 全挂死，
// goroutine 卡在 RLock、进程 CPU 为 0%）。
//
// 这里一边持续写 ACL（制造写者排队），一边反复列目录；只要路径里还有递归
// 读锁，本测试就会超时失败。
func TestVisibleUnderWritePressureDoesNotDeadlock(t *testing.T) {
	root := writeTree(t)
	reg := NewWithACL(root, acl(), aclFile(t, root))
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	id := student()

	done := make(chan struct{})
	var wg sync.WaitGroup

	// 写者：不断改 ACL，制造持续的写锁竞争。
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-done:
				return
			default:
			}
			_, _ = reg.SetPersonalAccess("student02", []Grant{})
		}
	}()

	// 读者：反复列目录（走 Visible → fillDirSizesLocked）。
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for i := 0; i < 200; i++ {
			_ = reg.Visible(id, "users")
		}
	}()

	select {
	case <-readDone:
		close(done)
		wg.Wait()
	case <-time.After(20 * time.Second):
		close(done)
		t.Fatal("Visible 在写压力下死锁（递归 RLock）")
	}
}
