package labfiles

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// trashACL 给出"个人空间可建可删"和"公共区可删但不可建"两种权限，
// 用来同时验证回收站的删除、恢复与越权边界。
func trashACL() ACL {
	rw := Scope{Source: "users", View: true, Download: true, Modify: true, Create: true, Delete: true}
	home := func(name string) Scope {
		s := rw
		s.Path = name
		return s
	}
	owner := Scope{Source: "public", Path: "mine", View: true, Download: true, Modify: true, Create: true, Delete: true}
	return ACL{Identities: map[string][]Scope{
		"student01@local": {home("student01"), owner},
		"student02@local": {home("student02")},
	}}
}

func account(name string) Identity {
	return Identity{UserID: name + "@local", Email: name + "@local", Roles: []string{"lab-student"}}
}

func trashReg(t *testing.T) (*Registry, string) {
	t.Helper()
	root := writeTree(t)
	if err := os.MkdirAll(filepath.Join(root, "public", "mine"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "public", "mine", "notes.md"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "users", "student01", "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"users/student01/sub/a.txt": "aaa",
		"users/student01/sub/b.txt": "bbbbb",
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	reg := New(root, trashACL())
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	return reg, root
}

func mustEntry(t *testing.T, reg *Registry, source, rel string) Entry {
	t.Helper()
	e, ok := reg.Get(entryID(source, rel))
	if !ok {
		t.Fatalf("entry %s/%s is not indexed", source, rel)
	}
	return e
}

func trashManifestRaw(t *testing.T, root string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(root, ".trash", trashManifestName))
	if err != nil {
		t.Fatalf("trash manifest: %v", err)
	}
	return string(raw)
}

func TestTrashRoundTripRestoresFileAndMtime(t *testing.T) {
	reg, root := trashReg(t)
	before := mustEntry(t, reg, "users", "student01/maize.fa")
	original, err := os.ReadFile(filepath.Join(root, "users", "student01", "maize.fa"))
	if err != nil {
		t.Fatal(err)
	}

	item, err := reg.Trash(account("student01"), before.ID)
	if err != nil {
		t.Fatalf("trash: %v", err)
	}
	if _, ok := reg.Get(before.ID); ok {
		t.Fatal("trashed entry is still indexed")
	}
	payload := filepath.Join(root, ".trash", item.ID)
	if info, err := os.Lstat(payload); err != nil || info.Size() != int64(len(original)) {
		t.Fatalf("payload not moved: %v", err)
	}
	if err := filepath.WalkDir(filepath.Join(root, "users"), func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Name() == "maize.fa" {
			return errors.New("personal file still on disk after trash")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	items, err := reg.ListTrash(account("student01"))
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("expected one trash item, got %d", len(items))
	}
	got := items[0]
	if got.Path != "student01/maize.fa" || got.Size != int64(len(original)) || !got.Restorable {
		t.Fatalf("unexpected item: %+v", got)
	}
	if got.DeletedBy != "student01" || got.SourceLabel == "" {
		t.Fatalf("item metadata incomplete: %+v", got)
	}
	if exp, perr := time.Parse(time.RFC3339, got.ExpiresAt); perr != nil {
		t.Fatalf("expiresAt is not a timestamp: %v", perr)
	} else if days := time.Until(exp) / (24 * time.Hour); days < 29 || days > 30 {
		t.Fatalf("unexpected retention window: %v", days)
	}

	e, err := reg.Restore(account("student01"), got.ID)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	body, err := os.ReadFile(filepath.Join(root, "users", "student01", "maize.fa"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != string(original) {
		t.Fatalf("content changed: %q", body)
	}
	if e.Modified != before.Modified {
		t.Fatalf("mtime not restored: %s != %s", e.Modified, before.Modified)
	}
	if _, err := os.Lstat(payload); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("payload left behind in the trash directory")
	}
	items, err = reg.ListTrash(account("student01"))
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("trash manifest not cleared: %s", trashManifestRaw(t, root))
	}
}

func TestTrashDirectoryCountsAndRestoresWholeTree(t *testing.T) {
	reg, root := trashReg(t)
	dir := mustEntry(t, reg, "users", "student01/sub")

	item, err := reg.Trash(account("student01"), dir.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !item.Dir || item.Paths != 3 || item.Size != int64(len("aaa")+len("bbbbb")) {
		t.Fatalf("directory not measured: %+v", item)
	}
	if _, err := os.Stat(filepath.Join(root, "users", "student01", "sub")); err == nil {
		t.Fatal("directory still on disk")
	}
	items, err := reg.ListTrash(account("student01"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Restore(account("student01"), items[0].ID); err != nil {
		t.Fatalf("restore directory: %v", err)
	}
	for name, want := range map[string]string{"a.txt": "aaa", "b.txt": "bbbbb"} {
		body, err := os.ReadFile(filepath.Join(root, "users", "student01", "sub", name))
		if err != nil || string(body) != want {
			t.Fatalf("child %s not restored: %q %v", name, body, err)
		}
	}
}

func TestRestoreRecreatesParentAndMergesDirectory(t *testing.T) {
	reg, root := trashReg(t)
	file := mustEntry(t, reg, "users", "student01/sub/a.txt")
	dir := mustEntry(t, reg, "users", "student01/sub")

	if _, err := reg.Trash(account("student01"), file.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Trash(account("student01"), dir.ID); err != nil {
		t.Fatal(err)
	}
	items, err := reg.ListTrash(account("student01"))
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("expected two items, got %d", len(items))
	}
	// 先恢复子文件：父目录已被删除，恢复必须把它重建出来。
	var fileItem, dirItem TrashItem
	for _, it := range items {
		if it.Dir {
			dirItem = it
		} else {
			fileItem = it
		}
	}
	if _, err := reg.Restore(account("student01"), fileItem.ID); err != nil {
		t.Fatalf("restore into a deleted parent: %v", err)
	}
	if body, err := os.ReadFile(filepath.Join(root, "users", "student01", "sub", "a.txt")); err != nil || string(body) != "aaa" {
		t.Fatalf("parent not recreated: %q %v", body, err)
	}
	// 再恢复父目录：目录已存在且不为空，按内容合并而不是覆盖。
	if _, err := reg.Restore(account("student01"), dirItem.ID); err != nil {
		t.Fatalf("merge restored directory: %v", err)
	}
	if body, err := os.ReadFile(filepath.Join(root, "users", "student01", "sub", "b.txt")); err != nil || string(body) != "bbbbb" {
		t.Fatalf("sibling not merged: %q %v", body, err)
	}
	items, err = reg.ListTrash(account("student01"))
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("merge left manifest rows behind: %+v", items)
	}
	if _, err := os.Stat(filepath.Join(root, ".trash", dirItem.ID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("merged payload directory not removed")
	}
}

func TestRestoreRefusesToOverwrite(t *testing.T) {
	reg, root := trashReg(t)
	file := mustEntry(t, reg, "users", "student01/maize.fa")
	if _, err := reg.Trash(account("student01"), file.ID); err != nil {
		t.Fatal(err)
	}
	replacement := []byte("new content")
	if err := os.WriteFile(filepath.Join(root, "users", "student01", "maize.fa"), replacement, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	items, err := reg.ListTrash(account("student01"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Restore(account("student01"), items[0].ID); !errors.Is(err, ErrExists) {
		t.Fatalf("expected ErrExists, got %v", err)
	}
	body, err := os.ReadFile(filepath.Join(root, "users", "student01", "maize.fa"))
	if err != nil || string(body) != string(replacement) {
		t.Fatalf("restore overwrote the newer file: %q", body)
	}
}

func TestTrashIsInvisibleAndUnrestorableForOthers(t *testing.T) {
	reg, root := trashReg(t)
	file := mustEntry(t, reg, "users", "student01/maize.fa")
	if _, err := reg.Trash(account("student01"), file.ID); err != nil {
		t.Fatal(err)
	}
	items, err := reg.ListTrash(account("student01"))
	if err != nil {
		t.Fatal(err)
	}
	id := items[0].ID

	for _, other := range []string{"student02", "labadmin"} {
		seen, err := reg.ListTrash(account(other))
		if err != nil {
			t.Fatal(err)
		}
		if len(seen) != 0 {
			t.Fatalf("%s can see personal trash: %+v", other, seen)
		}
		if _, err := reg.Restore(account(other), id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s reached into another account's trash: %v", other, err)
		}
		if _, err := reg.Purge(account(other), id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s could purge personal trash: %v", other, err)
		}
	}
	if _, err := reg.Trash(account("student02"), file.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a foreign personal file was trashed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, ".trash", id)); err != nil {
		t.Fatalf("payload disappeared while access was refused: %v", err)
	}
}

func TestTrashWithoutCreateRightIsNotRestorable(t *testing.T) {
	// 只给 delete：文件能进回收站，但恢复需要 create 权限，界面必须看得见这个差别。
	acl := ACL{Identities: map[string][]Scope{
		"student01@local": {{Source: "public", View: true, Download: true, Delete: true}},
	}}
	reg := New(writeTree(t), acl)
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	e := mustEntry(t, reg, "public", "readme.md")
	if _, err := reg.Trash(account("student01"), e.ID); err != nil {
		t.Fatal(err)
	}
	items, err := reg.ListTrash(account("student01"))
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Restorable {
		t.Fatalf("unexpected restorable flag: %+v", items)
	}
	if _, err := reg.Restore(account("student01"), items[0].ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("restore without create right: %v", err)
	}
}

func TestPurgeReleasesSpaceAndEmptySkipsForeignItems(t *testing.T) {
	reg, root := trashReg(t)
	file := mustEntry(t, reg, "users", "student01/maize.fa")
	item, err := reg.Trash(account("student01"), file.ID)
	if err != nil {
		t.Fatal(err)
	}
	payload := filepath.Join(root, ".trash", item.ID)

	sum, err := reg.Purge(account("student01"), item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if sum.Removed != 1 || sum.Bytes != int64(len(">m1\nATGC\n")) {
		t.Fatalf("unexpected purge summary: %+v", sum)
	}
	if _, err := os.Lstat(payload); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("purged payload survived")
	}
	if raw := trashManifestRaw(t, root); !strings.Contains(raw, `"items": []`) {
		t.Fatalf("manifest row not dropped: %s", raw)
	}

	shared := mustEntry(t, reg, "public", "mine/notes.md")
	if _, err := reg.Trash(account("student01"), shared.ID); err != nil {
		t.Fatal(err)
	}
	// student02 在 public/mine 没有任何权限：清空不得越权删掉别人的条目。
	sum, err = reg.Empty(account("student02"))
	if err != nil {
		t.Fatal(err)
	}
	if sum.Removed != 0 || sum.Skipped != 1 {
		t.Fatalf("empty crossed a permission boundary: %+v", sum)
	}
	items, err := reg.ListTrash(account("student01"))
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("foreign empty removed items: %+v", items)
	}
	if _, err := os.Stat(filepath.Join(root, ".trash", items[0].ID)); err != nil {
		t.Fatal("an item outside the caller's rights was purged")
	}
	sum, err = reg.Empty(account("student01"))
	if err != nil {
		t.Fatal(err)
	}
	if sum.Removed != 1 {
		t.Fatalf("own empty removed nothing: %+v", sum)
	}
	if _, err := os.Stat(filepath.Join(root, ".trash", items[0].ID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("empty left the payload on disk")
	}
}

func TestPurgeExpiredDropsOnlyExpiredItems(t *testing.T) {
	reg, root := trashReg(t)
	for _, rel := range []string{"student01/maize.fa", "student01/sub/a.txt"} {
		if _, err := reg.Trash(account("student01"), mustEntry(t, reg, "users", rel).ID); err != nil {
			t.Fatal(err)
		}
	}
	items, err := reg.ListTrash(account("student01"))
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("expected two trashed entries, got %d", len(items))
	}
	// 手工把一条记录的到期时间挪到过去，模拟保留期走完。
	stale := items[0].ID
	doc := struct {
		RetentionDays int         `json:"retentionDays"`
		Items         []TrashItem `json:"items"`
	}{Items: items}
	for i := range doc.Items {
		if doc.Items[i].ID == stale {
			doc.Items[i].ExpiresAt = time.Now().UTC().Add(-time.Hour).Format(time.RFC3339)
		}
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".trash", trashManifestName), append(raw, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}

	sum, err := reg.PurgeExpired()
	if err != nil {
		t.Fatal(err)
	}
	if sum.Removed != 1 {
		t.Fatalf("expiry removed %d items", sum.Removed)
	}
	if _, err := os.Lstat(filepath.Join(root, ".trash", stale)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("expired payload survived")
	}
	left, err := reg.ListTrash(account("student01"))
	if err != nil {
		t.Fatal(err)
	}
	if len(left) != 1 || left[0].ID == stale {
		t.Fatalf("wrong item expired: %+v", left)
	}
	// 幂等：没有过期条目时不应重写清单。
	again, err := reg.PurgeExpired()
	if err != nil || again.Removed != 0 {
		t.Fatalf("second sweep changed state: %+v %v", again, err)
	}
}

func TestTrashRefusesCorruptManifest(t *testing.T) {
	reg, root := trashReg(t)
	dir := filepath.Join(root, ".trash")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	garbage := []byte("{not json")
	if err := os.WriteFile(filepath.Join(dir, trashManifestName), garbage, 0o600); err != nil {
		t.Fatal(err)
	}
	e := mustEntry(t, reg, "users", "student01/maize.fa")
	if _, err := reg.Trash(account("student01"), e.ID); !errors.Is(err, ErrStorage) {
		t.Fatalf("corrupt manifest accepted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "users", "student01", "maize.fa")); err != nil {
		t.Fatal("the file moved even though the manifest could not be read")
	}
	raw, err := os.ReadFile(filepath.Join(dir, trashManifestName))
	if err != nil || string(raw) != string(garbage) {
		t.Fatalf("corrupt manifest was overwritten: %q", raw)
	}
	if _, err := reg.ListTrash(account("student01")); !errors.Is(err, ErrStorage) {
		t.Fatalf("listing hid the corruption: %v", err)
	}
}

func TestTrashIgnoresHandEditedIDsOutsideTheDirectory(t *testing.T) {
	reg, root := trashReg(t)
	e := mustEntry(t, reg, "users", "student01/maize.fa")
	if _, err := reg.Trash(account("student01"), e.ID); err != nil {
		t.Fatal(err)
	}
	items, err := reg.ListTrash(account("student01"))
	if err != nil {
		t.Fatal(err)
	}
	// 手改清单，把 ID 换成 "../../etc/passwd" 这类载荷：既不能恢复也不能清除。
	doc := struct {
		RetentionDays int         `json:"retentionDays"`
		Items         []TrashItem `json:"items"`
	}{RetentionDays: 30, Items: []TrashItem{{ID: "../../etc/passwd", Source: "users", Path: "student01/maize.fa", Name: "maize.fa", ExpiresAt: items[0].ExpiresAt}}}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".trash", trashManifestName), append(raw, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	seen, err := reg.ListTrash(account("student01"))
	if err != nil {
		t.Fatalf("invalid row reported as an error: %v", err)
	}
	if len(seen) != 0 {
		t.Fatalf("invalid id was listed: %+v", seen)
	}
	if _, err := reg.Restore(account("student01"), "../../etc/passwd"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("hand-edited id reached the filesystem: %v", err)
	}
	if _, err := reg.Purge(account("student01"), "../../etc/passwd"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("hand-edited id purgeable: %v", err)
	}
	if _, err := os.Stat("/etc/passwd"); err != nil {
		t.Fatalf("system file touched: %v", err)
	}
}

func TestDeprovisionUserClearsPersonalTrash(t *testing.T) {
	root := writeTree(t)
	aclPath := aclFile(t, root)
	reg := NewWithACL(root, trashACL(), aclPath)
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	ghost := account("student01")
	file := mustEntry(t, reg, "users", "student01/maize.fa")
	item, err := reg.Trash(ghost, file.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "users", "student01", "drafts"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "users", "student01", "drafts", "keep.txt"), []byte("private"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Trash(ghost, mustEntry(t, reg, "users", "student01/drafts").ID); err != nil {
		t.Fatal(err)
	}

	res, err := reg.DeprovisionUser("student01")
	if err != nil {
		t.Fatalf("deprovision: %v", err)
	}
	if res.TrashItems != 2 {
		t.Fatalf("personal trash rows left: %+v", res)
	}
	for _, id := range []string{item.ID} {
		if _, err := os.Lstat(filepath.Join(root, ".trash", id)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("trashed personal file %s survived the account removal", id)
		}
	}
	items, err := reg.ListTrash(Identity{Email: "student02@local"})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("removed account left rows in the manifest: %+v", items)
	}
	if raw := trashManifestRaw(t, root); strings.Contains(raw, item.ID) {
		t.Fatalf("manifest row survived the account removal: %s", raw)
	}
	if _, err := reg.Restore(account("student01"), item.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a deleted account can still restore: %v", err)
	}
}
