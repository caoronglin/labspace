package httpapi

import (
	"archive/zip"
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"labspace.local/go-core/internal/labfiles"
	"labspace.local/go-core/internal/session"
)

const fileSecret = "file-route-secret-0123456789"

func fileToken(t *testing.T, email string, roles []string) string {
	t.Helper()
	enc := base64.RawURLEncoding.EncodeToString
	header, _ := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	payload, _ := json.Marshal(map[string]any{
		"sub": email, "email": email, "roles": roles, "exp": time.Now().Add(time.Hour).Unix(),
	})
	body := enc(header) + "." + enc(payload)
	mac := hmac.New(sha256.New, []byte(fileSecret))
	mac.Write([]byte(body))
	return body + "." + enc(mac.Sum(nil))
}

func fileRegistry(t *testing.T) *labfiles.Registry {
	t.Helper()
	return fileRegistryACL(t, labfiles.ACL{Identities: map[string][]labfiles.Scope{
		"student01@local": {
			{Source: "public", View: true, Download: true},
			{Source: "users", Path: "student01", View: true, Download: true},
			{Source: "plasmids", View: true, Download: true},
			{Source: "genomes", Path: "grp-rnaseq", View: true, Download: true},
		},
		"student02@local": {
			{Source: "public", View: true, Download: true},
			{Source: "users", Path: "student02", View: true, Download: true},
			{Source: "plasmids", View: true, Download: true},
		},
	}})
}

// fileTree 建立一份最小实验室文件树，返回根目录。
func fileTree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	mk := func(rel string) {
		if err := os.MkdirAll(filepath.Join(root, rel), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	mk("public")
	mk("users/student01")
	mk("users/student02")
	mk("plasmids")
	mk("genomes/grp-rnaseq")
	for rel, body := range map[string]string{
		"public/readme.md":         "hello",
		"users/student01/maize.fa": ">m1\nATGC\n",
		"users/student02/other.fa": ">s1\nATGC\n",
		"plasmids/plasmid.md":      "plasmid",
	} {
		if err := os.WriteFile(filepath.Join(root, rel), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func fileRegistryACL(t *testing.T, acl labfiles.ACL) *labfiles.Registry {
	t.Helper()
	reg := labfiles.New(fileTree(t), acl)
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	return reg
}

// writableFileServer 给两个学生的个人空间加上建/改/删权限，用于回收站路由测试。
func writableFileServer(t *testing.T) (*Server, string) {
	t.Helper()
	root := fileTree(t)
	scopes := func(name string) []labfiles.Scope {
		return []labfiles.Scope{{Source: "users", Path: name, View: true, Download: true, Modify: true, Create: true, Delete: true}}
	}
	reg := labfiles.New(root, labfiles.ACL{Identities: map[string][]labfiles.Scope{
		"student01@local": scopes("student01"),
		"student02@local": scopes("student02"),
	}})
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	v, err := session.New([]byte(fileSecret), session.Options{AdminRoles: []string{"lab-admin"}})
	if err != nil {
		t.Fatal(err)
	}
	return &Server{Session: v, Files: reg}, root
}

func fileServer(t *testing.T) *Server {
	t.Helper()
	v, err := session.New([]byte(fileSecret), session.Options{AdminRoles: []string{"lab-admin"}})
	if err != nil {
		t.Fatal(err)
	}
	return &Server{Session: v, Files: fileRegistry(t)}
}

func fileCall(t *testing.T, s *Server, method, uri, token string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, uri, nil)
	if token != "" {
		r.AddCookie(&http.Cookie{Name: "labspace_session", Value: token})
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func entryIDByName(t *testing.T, s *Server, source, name string) string {
	t.Helper()
	token := fileToken(t, "student01@local", []string{"lab-student"})
	r := fileCall(t, s, "GET", "/v1/files?source="+source, token)
	if r.Code != 200 {
		t.Fatalf("list %s: %d %s", source, r.Code, r.Body.String())
	}
	var payload struct {
		Entries []labfiles.Entry `json:"entries"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	for _, e := range payload.Entries {
		if e.Name == name {
			return e.ID
		}
	}
	t.Fatalf("entry %s not found in %s", name, source)
	return ""
}

func TestFileRoutesRequireSession(t *testing.T) {
	s := fileServer(t)
	if r := fileCall(t, s, "GET", "/v1/files?source=public", ""); r.Code != 401 {
		t.Fatal("anonymous file listing accepted", r.Code)
	}
}

func TestFileListingIsScoped(t *testing.T) {
	s := fileServer(t)
	token := fileToken(t, "student01@local", []string{"lab-student"})
	r := fileCall(t, s, "GET", "/v1/files?source=users", token)
	if r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	if strings.Contains(r.Body.String(), "student02") {
		t.Fatal("another user's directory leaked")
	}
	if !strings.Contains(r.Body.String(), "maize.fa") {
		t.Fatal("own file missing")
	}
}

func TestPreviewAndDownload(t *testing.T) {
	s := fileServer(t)
	id := entryIDByName(t, s, "plasmids", "plasmid.md")
	token := fileToken(t, "student01@local", []string{"lab-student"})

	p := fileCall(t, s, "GET", "/v1/files/"+id+"/preview", token)
	if p.Code != 200 {
		t.Fatal(p.Code, p.Body.String())
	}
	if !strings.Contains(p.Body.String(), "plasmid") {
		t.Fatal("preview content missing", p.Body.String())
	}

	d := fileCall(t, s, "GET", "/v1/files/"+id+"/download", token)
	if d.Code != 200 {
		t.Fatal(d.Code, d.Body.String())
	}
	if d.Body.String() != "plasmid" {
		t.Fatal("download content mismatch")
	}
	if cd := d.Header().Get("Content-Disposition"); !strings.Contains(cd, "plasmid.md") {
		t.Fatal("content disposition missing", cd)
	}
}

func TestArchiveDownloadZipsSelection(t *testing.T) {
	s := fileServer(t)
	token := fileToken(t, "student01@local", []string{"lab-student"})
	readme := entryIDByName(t, s, "public", "readme.md")
	maize := entryIDByName(t, s, "users", "maize.fa")

	uri := "/v1/files/archive?ids=" + url.QueryEscape(readme+","+maize)
	r := fileCall(t, s, "GET", uri, token)
	if r.Code != 200 {
		t.Fatalf("archive: %d %s", r.Code, r.Body.String())
	}
	if ct := r.Header().Get("Content-Type"); ct != "application/zip" {
		t.Fatalf("unexpected content type %q", ct)
	}
	zr, err := zip.NewReader(bytes.NewReader(r.Body.Bytes()), int64(r.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, zf := range zr.File {
		rc, err := zf.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		got[zf.Name] = string(body)
	}
	// 跨源选择时成员名带源前缀，避免同名文件互相覆盖。
	if got["public/readme.md"] != "hello" {
		t.Fatalf("readme missing from archive: %v", got)
	}
	if got["users/student01/maize.fa"] != ">m1\nATGC\n" {
		t.Fatalf("maize missing from archive: %v", got)
	}
}

func TestArchiveDownloadHidesForeignFiles(t *testing.T) {
	s := fileServer(t)
	owner := fileToken(t, "student01@local", []string{"lab-student"})
	other := fileToken(t, "student02@local", []string{"lab-student"})
	maize := entryIDByName(t, s, "users", "maize.fa")

	if r := fileCall(t, s, "GET", "/v1/files/archive?ids="+maize, other); r.Code != 404 {
		t.Fatalf("cross-user archive was not hidden: %d %s", r.Code, r.Body.String())
	}
	if r := fileCall(t, s, "GET", "/v1/files/archive", owner); r.Code != 400 {
		t.Fatalf("empty archive selection accepted: %d", r.Code)
	}
}

func TestForeignResourceIsHidden(t *testing.T) {
	s := fileServer(t)
	id := entryIDByName(t, s, "public", "readme.md")
	// The other student cannot see the personal directory of student01.
	own := fileToken(t, "student01@local", []string{"lab-student"})
	other := fileToken(t, "student02@local", []string{"lab-student"})
	otherID := ""
	r := fileCall(t, s, "GET", "/v1/files?source=users", other)
	var payload struct {
		Entries []labfiles.Entry `json:"entries"`
	}
	_ = json.Unmarshal(r.Body.Bytes(), &payload)
	for _, e := range payload.Entries {
		if e.Name == "other.fa" {
			otherID = e.ID
		}
	}
	if otherID == "" {
		t.Fatal("own file of the second student missing")
	}
	if r := fileCall(t, s, "GET", "/v1/files/"+otherID+"/download", own); r.Code != 404 {
		t.Fatal("cross-user read was not hidden", r.Code)
	}
	if r := fileCall(t, s, "GET", "/v1/files/"+id, own); r.Code != 200 {
		t.Fatal("shared file must stay visible", r.Code)
	}
}

func TestFileErrorSeparatesStorageFromPolicyDenial(t *testing.T) {
	// 这两类拒绝必须给出不同状态码：都报 403 时，"目录不可写"会被误读成
	// "账号没有权限"，界面里只剩一个裸状态码。
	cases := []struct {
		err  error
		want int
	}{
		{fmt.Errorf("%w: mkdir: %w", labfiles.ErrStorage, os.ErrPermission), 500},
		{labfiles.ErrForbidden, 403},
		{labfiles.ErrExists, 409},
		{labfiles.ErrNotFound, 404},
	}
	for _, c := range cases {
		w := httptest.NewRecorder()
		fileError(w, c.err)
		if w.Code != c.want {
			t.Fatalf("error %q mapped to %d want %d", c.err, w.Code, c.want)
		}
	}
}

func TestMutatingRequestNeedsCSRF(t *testing.T) {
	s := fileServer(t)
	token := fileToken(t, "student01@local", []string{"lab-student"})
	r := httptest.NewRequest("POST", "/v1/files", nil)
	r.AddCookie(&http.Cookie{Name: "labspace_session", Value: token})
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("mutating request without csrf accepted", w.Code)
	}
}

// fileMutate 发一个通过双提交 CSRF 校验的写请求。
func fileMutate(t *testing.T, s *Server, method, uri, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	r := httptest.NewRequest(method, uri, rd)
	if token != "" {
		r.AddCookie(&http.Cookie{Name: "labspace_session", Value: token})
		r.AddCookie(&http.Cookie{Name: "labspace_csrf", Value: "csrf-value"})
		r.Header.Set("X-CSRF-Token", "csrf-value")
	}
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

type trashPage struct {
	Items         []labfiles.TrashItem `json:"items"`
	Count         int                  `json:"count"`
	TotalBytes    int64                `json:"totalBytes"`
	RetentionDays int                  `json:"retentionDays"`
}

func readTrash(t *testing.T, s *Server, token string) trashPage {
	t.Helper()
	r := fileCall(t, s, "GET", "/v1/files/trash", token)
	if r.Code != 200 {
		t.Fatalf("trash listing: %d %s", r.Code, r.Body.String())
	}
	var page trashPage
	if err := json.Unmarshal(r.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	return page
}

func TestFileDeleteRoutesThroughTrash(t *testing.T) {
	s, root := writableFileServer(t)
	token := fileToken(t, "student01@local", []string{"lab-student"})
	id := entryIDByName(t, s, "users", "maize.fa")

	w := fileMutate(t, s, "DELETE", "/v1/files/"+id, token, "")
	if w.Code != 200 {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
	var deleted struct {
		OK    bool               `json:"ok"`
		Trash labfiles.TrashItem `json:"trash"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &deleted); err != nil {
		t.Fatal(err)
	}
	if !deleted.OK || deleted.Trash.ID == "" || deleted.Trash.ExpiresAt == "" {
		t.Fatalf("delete response does not describe the trash item: %s", w.Body.String())
	}
	body := fileCall(t, s, "GET", "/v1/files?source=users", token).Body.String()
	if strings.Contains(body, "maize.fa") {
		t.Fatal("trashed file still listed")
	}
	if _, err := os.Stat(filepath.Join(root, ".trash", deleted.Trash.ID)); err != nil {
		t.Fatalf("payload not in the trash directory: %v", err)
	}

	page := readTrash(t, s, token)
	if page.Count != 1 || len(page.Items) != 1 {
		t.Fatalf("unexpected trash page: %+v", page)
	}
	if page.TotalBytes != int64(len(">m1\nATGC\n")) || page.RetentionDays != 30 {
		t.Fatalf("unexpected trash summary: %+v", page)
	}
	if page.Items[0].SourceLabel == "" || !page.Items[0].Restorable {
		t.Fatalf("item not enriched for the UI: %+v", page.Items[0])
	}

	// 恢复也是写操作，必须过 CSRF。
	if r := fileCall(t, s, "POST", "/v1/files/trash/restore", token); r.Code != 403 {
		t.Fatalf("restore without csrf accepted: %d", r.Code)
	}
	w = fileMutate(t, s, "POST", "/v1/files/trash/restore", token, `{"id":"`+deleted.Trash.ID+`"}`)
	if w.Code != 200 {
		t.Fatalf("restore: %d %s", w.Code, w.Body.String())
	}
	raw, err := os.ReadFile(filepath.Join(root, "users", "student01", "maize.fa"))
	if err != nil || string(raw) != ">m1\nATGC\n" {
		t.Fatalf("file not restored: %q %v", raw, err)
	}
	if page = readTrash(t, s, token); page.Count != 0 {
		t.Fatalf("restore left the manifest row: %+v", page)
	}

	// 再删一次并彻底清除。
	if r := fileMutate(t, s, "DELETE", "/v1/files/"+id, token, ""); r.Code != 200 {
		t.Fatalf("second delete: %d %s", r.Code, r.Body.String())
	}
	page = readTrash(t, s, token)
	if page.Count != 1 {
		t.Fatalf("second delete not recorded: %+v", page)
	}
	w = fileMutate(t, s, "DELETE", "/v1/files/trash/"+page.Items[0].ID, token, "")
	if w.Code != 200 {
		t.Fatalf("purge: %d %s", w.Code, w.Body.String())
	}
	var purged struct {
		Summary labfiles.TrashSummary `json:"summary"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &purged); err != nil {
		t.Fatal(err)
	}
	if purged.Summary.Removed != 1 {
		t.Fatalf("purge summary wrong: %s", w.Body.String())
	}
	if _, err := os.Lstat(filepath.Join(root, ".trash", page.Items[0].ID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("purged payload still on disk")
	}
	if page = readTrash(t, s, token); page.Count != 0 {
		t.Fatalf("purge left the manifest row: %+v", page)
	}

	// DELETE /v1/files/trash 必须是"清空"，不能被当成一个叫 trash 的条目 id。
	w = fileMutate(t, s, "DELETE", "/v1/files/trash", token, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "summary") {
		t.Fatalf("empty-trash route misrouted: %d %s", w.Code, w.Body.String())
	}
	if r := fileMutate(t, s, "DELETE", "/v1/files/trash/does-not-exist", token, ""); r.Code != 404 {
		t.Fatalf("unknown trash id: %d %s", r.Code, r.Body.String())
	}
}

func TestTrashListingNeedsSessionAndStaysPrivate(t *testing.T) {
	s, _ := writableFileServer(t)
	token := fileToken(t, "student01@local", []string{"lab-student"})
	other := fileToken(t, "student02@local", []string{"lab-student"})

	if r := fileCall(t, s, "GET", "/v1/files/trash", ""); r.Code != 401 {
		t.Fatalf("anonymous trash listing accepted: %d", r.Code)
	}
	id := entryIDByName(t, s, "users", "maize.fa")
	w := fileMutate(t, s, "DELETE", "/v1/files/"+id, token, "")
	if w.Code != 200 {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
	var deleted struct {
		Trash labfiles.TrashItem `json:"trash"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &deleted); err != nil {
		t.Fatal(err)
	}
	if page := readTrash(t, s, other); page.Count != 0 {
		t.Fatalf("another account's trash leaked: %+v", page)
	}
	w = fileMutate(t, s, "POST", "/v1/files/trash/restore", other, `{"id":"`+deleted.Trash.ID+`"}`)
	if w.Code != 404 {
		t.Fatalf("cross-account restore accepted: %d %s", w.Code, w.Body.String())
	}
}
