package labfiles

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// 课题资料源（research）的目录结构：/srv/lab/research/<进组日期-姓名>/…
//
// 每个学生一个目录，授权语义是"该学生 + 指导老师两人共用"：学生的目录由
// 身份 scope 授权（写在 ACL 的 identities 里），老师的整源权限来自
// lab-teacher / lab-admin 用户组。

// ResearchFolderName 返回某个学生在课题资料源里的目录名：
// "{进组时间 YYYY-MM-DD}-{姓名}"，例如 "2024-09-01-陈同学"。
func ResearchFolderName(joinedAt time.Time, name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return ""
	}
	return joinedAt.Format("2006-01-02") + "-" + name
}

// EnsureResearchFolder 按需创建某个学生的课题资料目录，返回目录名。
// 目录已存在时是幂等操作。
func (r *Registry) EnsureResearchFolder(joinedAt time.Time, name string) (string, error) {
	folder := ResearchFolderName(joinedAt, name)
	if folder == "" {
		return "", fmt.Errorf("%w: invalid user name", ErrInvalidPath)
	}
	if folder != path.Base(folder) || strings.ContainsAny(folder, "/\\") {
		return "", fmt.Errorf("%w: invalid user name", ErrInvalidPath)
	}
	full := filepath.Join(r.root, "research", folder)
	if err := os.MkdirAll(full, 0o770); err != nil {
		return "", storageError("create research folder", err)
	}
	return folder, nil
}

// GrantResearchAccess 为某个学生开通课题资料目录：按需创建目录，并写入
// 该学生的身份 scope（view/download/create/modify）。
//
// 老师侧的整源权限由 lab-teacher / lab-admin 用户组提供，因此这里只需要
// 学生自己的那一条 scope。
func (r *Registry) GrantResearchAccess(name string, joinedAt time.Time) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", fmt.Errorf("%w: invalid user name", ErrInvalidPath)
	}
	folder, err := r.EnsureResearchFolder(joinedAt, name)
	if err != nil {
		return "", err
	}
	grant := Scope{Source: "research", Path: folder, View: true, Download: true, Create: true, Modify: true}
	r.mu.Lock()
	keys := r.aclKeysFor(name)
	previous := map[string][]Scope{}
	for _, key := range keys {
		previous[key] = append([]Scope(nil), r.acl.Identities[key]...)
		scopes := append([]Scope(nil), r.acl.Identities[key]...)
		r.acl.Identities[key] = mergeScope(scopes, grant)
	}
	if err := r.persistACLLocked(); err != nil {
		for key, scopes := range previous {
			if scopes == nil {
				delete(r.acl.Identities, key)
				continue
			}
			r.acl.Identities[key] = scopes
		}
		r.mu.Unlock()
		return "", err
	}
	r.mu.Unlock()
	return folder, nil
}

// ResearchFolders lists the student folders in the research source, sorted by
// name. It is used by the admin screens to pick a folder for a grant.
func (r *Registry) ResearchFolders() []string {
	base := filepath.Join(r.root, "research")
	items, err := os.ReadDir(base)
	if err != nil {
		return []string{}
	}
	out := []string{}
	for _, item := range items {
		if !item.IsDir() || strings.HasPrefix(item.Name(), ".") {
			continue
		}
		out = append(out, item.Name())
	}
	sort.Strings(out)
	return out
}
