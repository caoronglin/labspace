package httpapi

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"labspace.local/go-core/internal/labfiles"
)

func adminRegistry(t *testing.T) (*labfiles.Registry, string) {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "users"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "genomes", "grp-mcn"), 0o755); err != nil {
		t.Fatal(err)
	}
	aclPath := filepath.Join(t.TempDir(), "acl.json")
	if err := os.WriteFile(aclPath, []byte(`{"admins":["admin"],"identities":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	reg := labfiles.NewWithACL(root, labfiles.ACL{Identities: map[string][]labfiles.Scope{}}, aclPath)
	if err := reg.Scan(); err != nil {
		t.Fatal(err)
	}
	return reg, root
}

func adminCall(s *Server, method, path, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("X-Lab-Service-Token", token)
	}
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	return w
}

func TestAdminRoutesRequireServiceToken(t *testing.T) {
	reg, _ := adminRegistry(t)
	s := &Server{ServiceToken: "service-secret", Files: reg}

	if r := adminCall(s, "POST", "/v1/admin/provision", "", `{"name":"student03"}`); r.Code != 401 {
		t.Fatalf("unauthenticated provisioning: %d", r.Code)
	}
	if r := adminCall(s, "POST", "/v1/admin/provision", "wrong", `{"name":"student03"}`); r.Code != 401 {
		t.Fatalf("wrong token accepted: %d", r.Code)
	}
	if _, err := os.Stat(filepath.Join(reg.Root(), "users", "student03")); !os.IsNotExist(err) {
		t.Fatal("rejected request created a directory")
	}
}

func TestAdminProvisionAndFileGrants(t *testing.T) {
	reg, root := adminRegistry(t)
	s := &Server{ServiceToken: "service-secret", Files: reg}

	r := adminCall(s, "POST", "/v1/admin/provision", "service-secret", `{"name":"student03"}`)
	if r.Code != 200 {
		t.Fatalf("provision: %d %s", r.Code, r.Body.String())
	}
	var res struct {
		Name    string           `json:"name"`
		Created bool             `json:"created"`
		Scopes  []labfiles.Scope `json:"scopes"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if !res.Created || res.Name != "student03" || len(res.Scopes) < 3 {
		t.Fatalf("unexpected provisioning result: %+v", res)
	}
	if info, err := os.Stat(filepath.Join(root, "users", "student03")); err != nil || !info.IsDir() {
		t.Fatal("personal directory missing")
	}

	r = adminCall(s, "PUT", "/v1/admin/file-access/student03", "service-secret",
		`{"grants":[{"source":"genomes","path":"grp-mcn","access":"read"}]}`)
	if r.Code != 200 {
		t.Fatalf("grant genome directory: %d %s", r.Code, r.Body.String())
	}
	r = adminCall(s, "GET", "/v1/admin/file-access", "service-secret", "")
	if r.Code != 200 {
		t.Fatalf("list access: %d", r.Code)
	}
	var access struct {
		Scopes map[string][]labfiles.Grant `json:"scopes"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &access); err != nil {
		t.Fatal(err)
	}
	grants := access.Scopes["student03"]
	if len(grants) != 1 || grants[0].Source != "genomes" || grants[0].Path != "grp-mcn" || grants[0].Access != "read" {
		t.Fatalf("unexpected grants: %v", grants)
	}

	r = adminCall(s, "PUT", "/v1/admin/file-access/student03", "service-secret",
		`{"grants":[{"source":"genomes","path":"missing","access":"read"}]}`)
	if r.Code != 400 {
		t.Fatalf("unknown directory accepted: %d", r.Code)
	}
	if r := adminCall(s, "PUT", "/v1/admin/file-access/student03", "service-secret",
		`{"grants":[{"source":"users","access":"read"}]}`); r.Code != 400 {
		t.Fatalf("personal source granted through the admin API: %d", r.Code)
	}
}

func TestAdminGroupRoutesAndAccessPreview(t *testing.T) {
	reg, _ := adminRegistry(t)
	s := &Server{ServiceToken: "service-secret", Files: reg}

	if r := adminCall(s, "GET", "/v1/admin/file-groups", "", ""); r.Code == 200 {
		t.Fatal("group listing served without a service token")
	}
	if r := adminCall(s, "GET", "/v1/admin/file-groups", "service-secret", ""); r.Code != 200 {
		t.Fatalf("list groups: %d %s", r.Code, r.Body.String())
	}

	body := `{"grants":[{"source":"public","path":"","access":"read"}]}`
	r := adminCall(s, "PUT", "/v1/admin/file-groups/lab-student", "service-secret", body)
	if r.Code != 200 {
		t.Fatalf("set group grants: %d %s", r.Code, r.Body.String())
	}
	projectBody := `{"grants":[{"source":"genomes","path":"grp-mcn","access":"write"}]}`
	if r := adminCall(s, "PUT", "/v1/admin/file-groups/genome-mcn", "service-secret", projectBody); r.Code != 200 {
		t.Fatalf("set custom group: %d %s", r.Code, r.Body.String())
	}
	// 组授权必须能从 file-access 视图读回，否则界面显示的是不存在于文件里的配置
	r = adminCall(s, "GET", "/v1/admin/file-access", "service-secret", "")
	var access struct {
		Groups []labfiles.Group `json:"groups"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &access); err != nil {
		t.Fatal(err)
	}
	if len(access.Groups) != 2 {
		t.Fatalf("groups not persisted: %+v", access.Groups)
	}
	if access.Groups[0].Name != "genome-mcn" || access.Groups[0].Builtin {
		t.Fatalf("custom group mislabelled: %+v", access.Groups[0])
	}
	if access.Groups[1].Name != "lab-student" || !access.Groups[1].Builtin {
		t.Fatalf("builtin group mislabelled: %+v", access.Groups[1])
	}

	preview := func(payload string) (map[string]map[string]bool, map[string]map[string]string) {
		t.Helper()
		rr := adminCall(s, "POST", "/v1/admin/file-access-preview", "service-secret", payload)
		if rr.Code != 200 {
			t.Fatalf("preview: %d %s", rr.Code, rr.Body.String())
		}
		var out struct {
			Probes []labfiles.EffectiveProbe `json:"probes"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		actions := map[string]map[string]bool{}
		origins := map[string]map[string]string{}
		for _, p := range out.Probes {
			key := p.Source + "/" + p.Path
			actions[key] = p.Actions
			origins[key] = p.Origin
		}
		return actions, origins
	}

	actions, origins := preview(`{"name":"student03","roles":["lab-student","genome-mcn"],"admin":false}`)
	if !actions["public/"]["read"] || origins["public/"]["read"] != "group:lab-student" {
		t.Fatalf("inherited group access missing: %+v %+v", actions, origins)
	}
	if !actions["genomes/grp-mcn"]["create"] || origins["genomes/grp-mcn"]["create"] != "group:genome-mcn" {
		t.Fatalf("custom group write not applied: %+v %+v", actions, origins)
	}
	if actions["genomes/"]["create"] {
		t.Fatal("sub-directory grant exposed the whole genome source")
	}

	// 个人权限可以覆盖组：单独拒绝后预演必须显示拒绝
	if r := adminCall(s, "PUT", "/v1/admin/file-access/student03", "service-secret",
		`{"grants":[{"source":"public","path":"","access":"deny"}]}`); r.Code != 200 {
		t.Fatalf("set individual deny: %d %s", r.Code, r.Body.String())
	}
	actions, _ = preview(`{"name":"student03","email":"student03@local","roles":["lab-student"],"admin":false}`)
	if actions["public/"]["read"] {
		t.Fatal("individual deny did not override the group grant")
	}
	// 管理员绕过仍然成立（对被拒绝之外的路径）
	actions, origins = preview(`{"name":"labadmin","roles":["lab-admin"],"admin":true}`)
	if !actions["public/"]["read"] || origins["public/"]["read"] != "admin" {
		t.Fatalf("admin bypass not reported: %+v %+v", actions, origins)
	}

	// 内置组承载成员关系语义，不允许删除；自定义组可以
	if r := adminCall(s, "DELETE", "/v1/admin/file-groups/lab-student", "service-secret", ""); r.Code != 400 {
		t.Fatalf("builtin group deleted: %d", r.Code)
	}
	if r := adminCall(s, "DELETE", "/v1/admin/file-groups/genome-mcn", "service-secret", ""); r.Code != 200 {
		t.Fatalf("delete custom group: %d %s", r.Code, r.Body.String())
	}
	if r := adminCall(s, "GET", "/v1/admin/file-groups", "service-secret", ""); strings.Contains(r.Body.String(), "genome-mcn") {
		t.Fatalf("deleted group still served: %s", r.Body.String())
	}
	if r := adminCall(s, "PUT", "/v1/admin/file-groups/Bad%20Name", "service-secret", body); r.Code != 400 {
		t.Fatalf("invalid group name accepted: %d", r.Code)
	}
	if r := adminCall(s, "PUT", "/v1/admin/file-groups/lab-student", "service-secret", `{"unknown":1}`); r.Code != 400 {
		t.Fatalf("unknown field accepted: %d", r.Code)
	}
}

func TestAdminDeprovisionRemovesAccount(t *testing.T) {
	reg, root := adminRegistry(t)
	s := &Server{ServiceToken: "service-secret", Files: reg}

	if r := adminCall(s, "POST", "/v1/admin/deprovision", "", `{"name":"student03"}`); r.Code != 401 {
		t.Fatalf("unauthenticated deprovisioning: %d", r.Code)
	}
	if r := adminCall(s, "POST", "/v1/admin/provision", "service-secret", `{"name":"student03"}`); r.Code != 200 {
		t.Fatalf("provision: %d %s", r.Code, r.Body.String())
	}
	home := filepath.Join(root, "users", "student03")
	if err := os.WriteFile(filepath.Join(home, "data.fa"), []byte(">seq\nATGC\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	r := adminCall(s, "POST", "/v1/admin/deprovision", "service-secret", `{"name":"student03"}`)
	if r.Code != 200 {
		t.Fatalf("deprovision: %d %s", r.Code, r.Body.String())
	}
	var res struct {
		Name          string   `json:"name"`
		ACLEntries    []string `json:"aclEntries"`
		RemovedPaths  int      `json:"removedPaths"`
		RemovedBytes  int64    `json:"removedBytes"`
		RevokedGrants int      `json:"revokedGrants"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.Name != "student03" || len(res.ACLEntries) == 0 || res.RemovedPaths != 1 || res.RemovedBytes != 10 {
		t.Fatalf("unexpected deprovision result: %+v", res)
	}
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Fatal("personal directory survived the removal")
	}
	r = adminCall(s, "GET", "/v1/admin/file-access", "service-secret", "")
	var access struct {
		Scopes map[string][]labfiles.Grant `json:"scopes"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &access); err != nil {
		t.Fatal(err)
	}
	if grants, ok := access.Scopes["student03"]; ok {
		t.Fatalf("removed account still carries file grants: %+v", grants)
	}

	for _, bad := range []string{`{"name":"../../etc"}`, `{"name":""}`, `{"name":"Student03/x"}`} {
		if r := adminCall(s, "POST", "/v1/admin/deprovision", "service-secret", bad); r.Code != 400 {
			t.Fatalf("invalid name %s accepted: %d", bad, r.Code)
		}
	}
}
