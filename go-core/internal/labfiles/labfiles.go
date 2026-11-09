// Package labfiles exposes the lab file tree as a permission-checked resource
// registry with native list/preview/download/create/rename/delete operations.
//
// The source directories under /srv/lab and their per-user scopes are owned
// by this service; the portal no longer delegates file lifecycle to a third-party browser:
//
//   - every user owns a list of scopes (source path + prefix + permissions),
//   - an entry is visible when a scope of the same source covers the entry
//     path and grants the matching permission,
//   - writes are checked against the same scopes before touching disk.
//
// The scope list stays in a small JSON file so this package needs no database
// driver and no access to any external file-manager state.
package labfiles

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	// MaxPreviewBytes bounds a single preview payload.
	MaxPreviewBytes = 8 << 20
	// MaxDownloadBytes bounds a single inline download.
	MaxDownloadBytes = 32 << 20
	// MaxUploadBytes bounds one native upload.
	MaxUploadBytes = 200 << 20
)

// Source describes one exported directory tree under /srv/lab.
type Source struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Shared bool   `json:"shared"`
	Dir    string `json:"-"`
}

// Sources are the shared lab sources plus each account's personal space.
func Sources() []Source {
	return []Source{
		{ID: "public", Label: "公共资料", Shared: true},
		{ID: "plasmids", Label: "公共质粒", Shared: true},
		{ID: "genomes", Label: "公共基因组", Shared: true},
		{ID: "users", Label: "个人文件", Shared: false},
	}
}

// Entry is one file or directory in the lab tree.
type Entry struct {
	ID       string `json:"id"`
	Source   string `json:"source"`
	Path     string `json:"path"`
	Name     string `json:"name"`
	Dir      bool   `json:"dir"`
	Size     int64  `json:"size"`
	Modified string `json:"modified"`
	// Created 是条目创建时间（ext4 crtime）；文件系统未提供 birth time
	// 时由 Scan 回退为修改时间。
	Created string `json:"created"`
}

// Scope is one ACL grant: a source, a path prefix inside it and the
// permissions granted there.
type Scope struct {
	Source   string `json:"source"`
	Path     string `json:"path"`
	View     bool   `json:"view"`
	Download bool   `json:"download"`
	Modify   bool   `json:"modify"`
	Delete   bool   `json:"delete"`
	Create   bool   `json:"create"`
	// Deny 把该条目变成显式拒绝。拒绝优先于任何允许（包括管理员绕过），
	// 这样"单独收回某个人的某项权限"才是可表达、可验证的配置。
	Deny bool `json:"deny,omitempty"`
}

// grants reports whether the scope allows action. A denied scope never grants.
func (s Scope) grants(action string) bool {
	if s.Deny {
		return false
	}
	switch action {
	case "read", "preview":
		return s.View
	case "download":
		return s.Download
	case "create":
		return s.Create
	case "modify":
		return s.Modify
	case "delete":
		return s.Delete
	}
	return false
}

// ACL 是两层权限模型：预配置用户组（groups）给出默认授权，
// 用户单独权限（identities）在其之上叠加允许或拒绝。
type ACL struct {
	Identities map[string][]Scope `json:"identities"`
	Groups     map[string][]Scope `json:"groups,omitempty"`
}

// DefaultGroups 是开箱即用的预配置用户组。组名与 Casdoor 的 group 名称一致，
// 因此成员关系由统一身份源维护，这里只定义"这个组默认能做什么"。
func DefaultGroups() map[string][]Scope {
	public := Scope{Source: "public", View: true, Download: true}
	plasmids := Scope{Source: "plasmids", View: true, Download: true}
	genomes := Scope{Source: "genomes", View: true, Download: true}
	shared := []Scope{public, plasmids, genomes}
	rw := func(s Scope) Scope {
		s.Create, s.Modify, s.Delete = true, true, true
		return s
	}
	// 同一目录在模板里只允许出现一行：两行"只读 + 读写"这种自相矛盾的
	// 配置正是权限界面难读的根源。
	merge := func(scopes ...Scope) []Scope {
		out := []Scope{}
		for _, s := range scopes {
			out = mergeScope(out, s)
		}
		sort.Slice(out, func(i, j int) bool {
			if out[i].Source != out[j].Source {
				return out[i].Source < out[j].Source
			}
			return out[i].Path < out[j].Path
		})
		return out
	}
	return map[string][]Scope{
		"lab-student": merge(shared...),
		// 教师维护公共基因组数据，其余共享源只读。
		"lab-teacher": merge(public, plasmids, rw(genomes)),
		// 实验室管理员管理全部共享内容；个人空间仍然互相隔离。
		"lab-admin": merge(rw(public), rw(plasmids), rw(genomes)),
	}
}

// LoadACL reads an ACL file. A missing file yields an empty (fail-closed) ACL.
func LoadACL(path string) (ACL, error) {
	acl := ACL{Identities: map[string][]Scope{}}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			acl.Groups = DefaultGroups()
			return acl, nil
		}
		return acl, err
	}
	if err := json.Unmarshal(raw, &acl); err != nil {
		return ACL{Identities: map[string][]Scope{}}, fmt.Errorf("invalid acl file: %w", err)
	}
	if acl.Identities == nil {
		acl.Identities = map[string][]Scope{}
	}
	// 缺少 groups 键时填入预配置组；显式写成 {} 则表示管理员关掉了组授权，
	// 必须尊重，否则每次改动都会把组权限重新种回去。
	if acl.Groups == nil {
		acl.Groups = DefaultGroups()
	}
	sanitizeSources(&acl)
	return acl, nil
}

// sanitizeSources drops scopes that point at sources this build no longer
// serves (for example the retired course-materials/projects trees). Without
// this, permission screens keep advertising categories that cannot be opened.
func sanitizeSources(acl *ACL) {
	known := map[string]bool{}
	for _, src := range Sources() {
		known[src.ID] = true
	}
	prune := func(scopes []Scope) []Scope {
		out := scopes[:0]
		for _, s := range scopes {
			if known[s.Source] {
				out = append(out, s)
			}
		}
		return out
	}
	for key, scopes := range acl.Identities {
		acl.Identities[key] = prune(scopes)
	}
	for name, scopes := range acl.Groups {
		acl.Groups[name] = prune(scopes)
	}
}

// Identity is the authenticated portal user.
type Identity struct {
	UserID string
	Email  string
	Roles  []string
	Admin  bool
	// Teacher marks lab-teacher members.
	Teacher bool
}

// LocalPart returns the mailbox part of the identity email.
func (i Identity) LocalPart() string {
	if p := strings.Index(i.Email, "@"); p > 0 {
		return i.Email[:p]
	}
	return i.Email
}

// HasRole reports whether the identity carries the given role.
func (i Identity) HasRole(role string) bool {
	for _, r := range i.Roles {
		if strings.EqualFold(r, role) {
			return true
		}
	}
	return false
}

// Registry indexes the lab tree.
type Registry struct {
	root    string
	aclPath string
	acl     ACL
	mu      sync.RWMutex
	entries map[string]Entry
	// trMu 只保护回收站清单的读改写；顺序必须是 trMu -> mu，见 trash.go。
	trMu sync.Mutex
}

// New builds a registry rooted at the lab data directory (default /srv/lab).
// The ACL is read-only; use NewWithACL when account provisioning may write it.
func New(root string, acl ACL) *Registry {
	return NewWithACL(root, acl, "")
}

// NewWithACL is New plus the path used to persist ACL changes.
func NewWithACL(root string, acl ACL, aclPath string) *Registry {
	if root == "" {
		root = "/srv/lab"
	}
	if acl.Identities == nil {
		acl.Identities = map[string][]Scope{}
	}
	return &Registry{root: root, aclPath: aclPath, acl: acl, entries: map[string]Entry{}}
}

// Root returns the configured lab root.
func (r *Registry) Root() string { return r.root }

// Scan re-indexes the tree from disk.
func (r *Registry) Scan() error {
	entries := map[string]Entry{}
	for _, src := range Sources() {
		base := filepath.Join(r.root, src.ID)
		if _, err := os.Stat(base); err != nil {
			continue
		}
		births := birthTimes(base)
		err := filepath.WalkDir(base, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			rel, rerr := filepath.Rel(base, p)
			if rerr != nil {
				return nil
			}
			if rel == "." {
				info, ierr := d.Info()
				if ierr != nil {
					return nil
				}
				entries[entryID(src.ID, "")] = Entry{
					ID: entryID(src.ID, ""), Source: src.ID, Path: "", Name: src.ID,
					Dir: true, Size: 0, Modified: info.ModTime().UTC().Format(time.RFC3339),
					Created: createdOf(births, p, info),
				}
				return nil
			}
			if strings.HasPrefix(d.Name(), ".") {
				if d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			info, ierr := d.Info()
			if ierr != nil {
				return nil
			}
			size := info.Size()
			if d.IsDir() {
				size = 0
			}
			e := Entry{
				ID: entryID(src.ID, rel), Source: src.ID, Path: filepath.ToSlash(rel),
				Name: d.Name(), Dir: d.IsDir(), Size: size,
				Modified: info.ModTime().UTC().Format(time.RFC3339),
				Created:  createdOf(births, p, info),
			}
			entries[e.ID] = e
			return nil
		})
		if err != nil {
			return err
		}
	}
	r.mu.Lock()
	r.entries = entries
	r.mu.Unlock()
	return nil
}

// createdOf 返回条目的创建时间文本：优先 ext4 crtime，其次 ctime，最后 mtime。
func createdOf(births map[string]int64, abs string, info fs.FileInfo) string {
	if n, ok := births[abs]; ok && n > 0 {
		return time.Unix(n, 0).UTC().Format(time.RFC3339)
	}
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		if sec := st.Ctim.Sec; sec > 0 {
			return time.Unix(sec, 0).UTC().Format(time.RFC3339)
		}
	}
	return info.ModTime().UTC().Format(time.RFC3339)
}

// birthTimes 读取目录树内每个路径的创建时间（Unix 秒）。
//
// ext4 的 crtime 只能通过 statx 取得，而核心刻意只依赖标准库，因此这里
// 每个来源调用一次 coreutils（find + stat）批量读取；命令不存在或文件系统
// 不支持时返回空表，由 createdOf 逐级回退。
func birthTimes(base string) map[string]int64 {
	out := map[string]int64{}
	cmd := exec.Command("find", base, "-exec", "stat", "-c", "%W|%n", "{}", "+")
	raw, err := cmd.Output()
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(raw), "\n") {
		sec, abs, found := strings.Cut(strings.TrimSpace(line), "|")
		if !found {
			continue
		}
		n, cerr := strconv.ParseInt(sec, 10, 64)
		if cerr != nil || n <= 0 {
			continue
		}
		out[abs] = n
	}
	return out
}

// Count returns the number of indexed entries.
func (r *Registry) Count() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.entries)
}

// Get returns one entry by id.
func (r *Registry) Get(id string) (Entry, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	e, ok := r.entries[id]
	return e, ok
}

// SourceRoot returns the entry of a source container.
func (r *Registry) SourceRoot(source string) (Entry, bool) {
	return r.Get(entryID(source, ""))
}

// rule 是一条参与判定的授权。Origin 说明它来自用户单独权限还是某个组，
// 管理界面要靠它区分"继承自组"与"为该用户单独设置"。
type rule struct {
	Scope  Scope
	Origin string
}

// blocks 判断一条拒绝条目是否覆盖该动作。没有置任何权限位的拒绝条目，
// 视为对该路径的全部动作拒绝。
func (s Scope) blocks(action string) bool {
	if !s.Deny {
		return false
	}
	if !s.View && !s.Download && !s.Modify && !s.Delete && !s.Create {
		return true
	}
	switch action {
	case "list", "read", "preview":
		return s.View
	case "download":
		return s.Download
	case "create":
		return s.Create
	case "modify":
		return s.Modify
	case "delete":
		return s.Delete
	}
	return false
}

// userScopes 返回该身份的用户单独权限。邮箱键优先，其次用户 ID 与信箱前缀，
// 这样同一人的口令登录与 OIDC 登录共用一套文件权限。
func (r *Registry) userScopes(identity Identity) []Scope {
	for _, key := range []string{identity.Email, identity.UserID, identity.LocalPart()} {
		if key == "" {
			continue
		}
		if scopes, ok := r.acl.Identities[key]; ok && len(scopes) > 0 {
			return scopes
		}
	}
	return nil
}

// rulesFor 展开「预配置组 + 用户单独权限」两层授权。调用方必须持有锁。
func (r *Registry) rulesFor(identity Identity) []rule {
	out := []rule{}
	for _, s := range r.userScopes(identity) {
		out = append(out, rule{Scope: s, Origin: "user"})
	}
	seen := map[string]bool{}
	for _, role := range identity.Roles {
		role = strings.TrimSpace(role)
		for name, scopes := range r.acl.Groups {
			if seen[name] || !strings.EqualFold(name, role) {
				continue
			}
			seen[name] = true
			for _, s := range scopes {
				out = append(out, rule{Scope: s, Origin: "group:" + name})
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Origin < out[j].Origin })
	return out
}

// decide 按 deny > 用户 allow > 组 allow > 管理员绕过 的顺序判定。
func decide(rules []rule, source, path, action string, admin bool) (bool, string) {
	userAllow, groupAllow := false, ""
	for _, ru := range rules {
		if ru.Scope.Source != source || !scopeCovers(ru.Scope, path) {
			continue
		}
		if ru.Scope.blocks(action) {
			return false, ru.Origin
		}
		allowed := false
		if action == "list" {
			// 源根只能通过覆盖整源的作用域列出，目录级授权不会公开整个来源。
			allowed = path == "" && ru.Scope.Path == "" && ru.Scope.View
		} else {
			allowed = ru.Scope.grants(action)
		}
		if !allowed {
			continue
		}
		if ru.Origin == "user" {
			userAllow = true
		} else if groupAllow == "" {
			groupAllow = ru.Origin
		}
	}
	switch {
	case userAllow:
		return true, "user"
	case groupAllow != "":
		return true, groupAllow
	case admin:
		return true, "admin"
	}
	return false, ""
}

// Scopes 返回该身份实际生效的授权（组 + 用户，不含拒绝条目）。它只用于粗粒度的
// "这个源能不能列" 与管理界面展示；逐条目的判定一律走 can/CanPath。
func (r *Registry) Scopes(identity Identity) []Scope {
	r.mu.RLock()
	defer r.mu.RUnlock()
	rules := r.rulesFor(identity)
	out := make([]Scope, 0, len(rules))
	for _, ru := range rules {
		if ru.Scope.Deny {
			continue
		}
		out = append(out, ru.Scope)
	}
	return out
}

// Visible lists the entries of one source that the identity may see.
func (r *Registry) Visible(identity Identity, source string) []Entry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := []Entry{}
	for _, e := range r.entries {
		if e.Source != source {
			continue
		}
		if e.Path == "" {
			if r.can(identity, e, "list") {
				out = append(out, e)
			}
			continue
		}
		if r.can(identity, e, "read") {
			out = append(out, e)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Path == "" {
			return true
		}
		if out[j].Path == "" {
			return false
		}
		return out[i].Path < out[j].Path
	})
	return out
}

// VisibleSorted 与 Visible 相同，但按指定字段排序：目录恒排在文件之前，
// 组内按 key（name/size/modified/created/path）比较，desc 反转。
// 排序发生在服务侧，前端只需展示，避免"只排当前页"的错觉。
func (r *Registry) VisibleSorted(identity Identity, source, key string, desc bool) []Entry {
	out := r.Visible(identity, source)
	if len(out) < 2 {
		return out
	}
	name := strings.ToLower(strings.TrimSpace(key))
	sort.SliceStable(out, func(i, j int) bool {
		if name == "path" {
			if desc {
				return out[i].Path > out[j].Path
			}
			return out[i].Path < out[j].Path
		}
		// 源根（Path 为空）始终置顶，与 Visible 的行为一致
		if out[i].Path == "" || out[j].Path == "" {
			return out[i].Path == "" && out[j].Path != ""
		}
		if out[i].Dir != out[j].Dir {
			return out[i].Dir
		}
		cmp := compareEntries(out[i], out[j], name)
		if cmp == 0 {
			cmp = strings.Compare(out[i].Name, out[j].Name)
		}
		if desc {
			return cmp > 0
		}
		return cmp < 0
	})
	return out
}

func compareEntries(a, b Entry, key string) int {
	switch key {
	case "size":
		if a.Size < b.Size {
			return -1
		}
		if a.Size > b.Size {
			return 1
		}
		return 0
	case "modified":
		return strings.Compare(a.Modified, b.Modified)
	case "created":
		return strings.Compare(a.Created, b.Created)
	default:
		return strings.Compare(a.Name, b.Name)
	}
}

// Usage 汇总某来源内该身份可见的字节数：按目录前缀累加（目录自身 size 为 0，
// 必须由其下文件汇总），供前端展示存储空间使用。
type Usage struct {
	Total int64            `json:"total"`
	Files int64            `json:"files"`
	Dirs  map[string]int64 `json:"dirs"`
}

func (r *Registry) Usage(identity Identity, source string) Usage {
	usage := Usage{Dirs: map[string]int64{}}
	for _, e := range r.Visible(identity, source) {
		if e.Dir {
			continue
		}
		usage.Total += e.Size
		usage.Files++
		dir := path.Dir(e.Path)
		if dir == "." {
			dir = ""
		}
		for {
			usage.Dirs[dir] += e.Size
			if dir == "" {
				break
			}
			dir = path.Dir(dir)
			if dir == "." {
				dir = ""
			}
		}
	}
	return usage
}

// Can reports whether the identity may perform the action on the entry.
func (r *Registry) Can(identity Identity, e Entry, action string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.can(identity, e, action)
}

// personalPathAllowed enforces that the "users" source only ever exposes the
// caller's own home directory, including for administrators. Personal space is
// not a shared drive; support access must go through an explicit export.
func personalPathAllowed(identity Identity, path string) bool {
	if path == "" {
		return false
	}
	home := identity.LocalPart()
	if home == "" {
		return false
	}
	return path == home || strings.HasPrefix(path, home+"/")
}

// personalAccessLocked 判定个人文件上的动作：自己的家目录直接放行，他人的
// 家目录只接受"收件人本人单独权限"里的显式共享。组授权与管理员绕过都不能
// 打开别人的家目录，这是个人空间与共享盘的分界。调用方必须持有锁。
func (r *Registry) personalAccessLocked(identity Identity, rel, action string) bool {
	if personalPathAllowed(identity, rel) {
		return true
	}
	for _, ru := range r.rulesFor(identity) {
		if ru.Origin != "user" || ru.Scope.Source != "users" || ru.Scope.Deny {
			continue
		}
		if !scopeCovers(ru.Scope, rel) {
			continue
		}
		if ru.Scope.grants(action) {
			return true
		}
	}
	return false
}

// can 判定条目上的动作。调用方必须持有锁。
func (r *Registry) can(identity Identity, e Entry, action string) bool {
	if e.Source == "users" && !r.personalAccessLocked(identity, e.Path, action) {
		return false
	}
	ok, _ := decide(r.rulesFor(identity), e.Source, e.Path, action, identity.Admin)
	return ok
}

// writeActions 是全部写操作，用于"这个位置能不能写"的粗粒度判定。
var writeActions = []string{"create", "modify", "delete"}

// writableAt 报告 rel 处是否存在任意写权限。界面用它决定是否亮出写操作按钮，
// 服务端写操作用 CanPath 逐条复核，两者必须走同一套规则。
func writableAt(rules []rule, source, rel string, admin bool) bool {
	for _, action := range writeActions {
		if ok, _ := decide(rules, source, rel, action, admin); ok {
			return true
		}
	}
	return false
}

// Sentinel errors returned by the write operations; the HTTP layer maps them
// to status codes without leaking filesystem details.
var (
	ErrForbidden   = errors.New("permission denied")
	ErrExists      = errors.New("resource already exists")
	ErrInvalidPath = errors.New("invalid path or name")
	ErrNotFound    = errors.New("resource not found")
	ErrTooLarge    = errors.New("upload exceeds the size limit")
	// ErrStorage 是存储层拒绝写入（目录权限、只读挂载等）。它必须与策略拒绝
	// ErrForbidden 分开：两者都报 403 时，运维会把文件系统权限问题误读成
	// "账号没权限"，而界面只能显示一个裸状态码。
	ErrStorage = errors.New("storage write rejected")
)

// storageError wraps a filesystem failure with the operation that hit it.
func storageError(op string, err error) error {
	return fmt.Errorf("%w: %s: %w", ErrStorage, op, err)
}

// CanPath checks an action against a source-relative path that may not exist
// yet (used for create/upload/rename destinations).
func (r *Registry) CanPath(identity Identity, source, rel, action string) bool {
	rel = strings.Trim(rel, "/")
	r.mu.RLock()
	defer r.mu.RUnlock()
	if source == "users" && !r.personalAccessLocked(identity, rel, action) {
		return false
	}
	ok, _ := decide(r.rulesFor(identity), source, rel, action, identity.Admin)
	return ok
}

// Writable reports whether the identity holds any write scope in a source.
func (r *Registry) Writable(identity Identity, source string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	rules := r.rulesFor(identity)
	if source == "users" {
		home := identity.LocalPart()
		if home == "" {
			return false
		}
		// 个人空间不是共享盘，管理员也不得绕过自己的家目录。
		return writableAt(rules, source, home, false)
	}
	return writableAt(rules, source, "", identity.Admin) || anyPathWritable(rules, source, identity.Admin)
}

// anyPathWritable 处理"只授权到某个子目录"的情况：源根本不可写，但目录可写。
func anyPathWritable(rules []rule, source string, admin bool) bool {
	for _, ru := range rules {
		if ru.Scope.Source != source || ru.Scope.Path == "" {
			continue
		}
		if writableAt(rules, source, ru.Scope.Path, admin) {
			return true
		}
	}
	return false
}

// ProvisionResult reports the personal space created for an account.
type ProvisionResult struct {
	Name    string  `json:"name"`
	Home    string  `json:"home"`
	Created bool    `json:"created"`
	Scopes  []Scope `json:"scopes"`
}

var provisionNameRE = regexp.MustCompile(`^[a-z][a-z0-9._-]{2,31}$`)

// ErrACLStore marks failures to persist ACL changes; callers must surface
// them instead of silently granting in-memory-only access.
var ErrACLStore = errors.New("ACL store unavailable")

func localPart(key string) string {
	if p := strings.Index(key, "@"); p > 0 {
		return key[:p]
	}
	return key
}

// aclKeysFor returns every ACL key that resolves to the account name. The
// historical export contains both bare names and e-mail keys for the same
// person, and Scopes() prefers the e-mail key, so all of them must agree.
func (r *Registry) aclKeysFor(name string) []string {
	keys := []string{}
	for key := range r.acl.Identities {
		if key == name || localPart(key) == name {
			keys = append(keys, key)
		}
	}
	if len(keys) == 0 {
		return []string{name}
	}
	sort.Strings(keys)
	return keys
}

func personalScopes(name string) []Scope {
	return []Scope{
		{Source: "public", Path: "", View: true, Download: true},
		{Source: "plasmids", Path: "", View: true, Download: true},
		{Source: "genomes", Path: "", View: true, Download: true},
		{Source: "users", Path: name, View: true, Download: true, Create: true, Modify: true, Delete: true},
	}
}

// PersonalShare is one path inside an owner's home shared with other accounts.
// Path is relative to the owner's home directory.
type PersonalShare struct {
	Path       string   `json:"path"`
	Recipients []string `json:"recipients"`
}

// SharedEntry is one entry another account has shared with the caller.
type SharedEntry struct {
	ID       string `json:"id"`
	Owner    string `json:"owner"`
	Path     string `json:"path"`
	Name     string `json:"name"`
	Dir      bool   `json:"dir"`
	Size     int64  `json:"size"`
	Modified string `json:"modified"`
	Created  string `json:"created"`
}

// PersonalShares lists the paths an owner shared together with their readers.
func (r *Registry) PersonalShares(owner string) []PersonalShare {
	owner = strings.ToLower(strings.TrimSpace(owner))
	prefix := owner + "/"
	if owner == "" {
		return []PersonalShare{}
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	byPath := map[string]map[string]bool{}
	for key, scopes := range r.acl.Identities {
		name := localPart(key)
		if name == "" || name == owner {
			continue
		}
		for _, s := range scopes {
			if s.Source != "users" || s.Deny {
				continue
			}
			var rel string
			switch {
			case strings.HasPrefix(s.Path, prefix):
				rel = strings.TrimPrefix(s.Path, prefix)
			default:
				continue
			}
			if rel == "" {
				continue
			}
			if byPath[rel] == nil {
				byPath[rel] = map[string]bool{}
			}
			byPath[rel][name] = true
		}
	}
	out := make([]PersonalShare, 0, len(byPath))
	for rel, people := range byPath {
		names := make([]string, 0, len(people))
		for name := range people {
			names = append(names, name)
		}
		sort.Strings(names)
		out = append(out, PersonalShare{Path: rel, Recipients: names})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// SetPersonalShare replaces the readers of one home-relative path. Recipients
// receive read-only access through an explicit user scope; groups and admins
// can never be used to reach another account's home.
func (r *Registry) SetPersonalShare(owner, rel string, recipients []string) (PersonalShare, error) {
	owner = strings.ToLower(strings.TrimSpace(owner))
	if !provisionNameRE.MatchString(owner) {
		return PersonalShare{}, fmt.Errorf("%w: invalid user name", ErrInvalidPath)
	}
	clean, err := cleanRelative(rel)
	if err != nil || clean == "" {
		return PersonalShare{}, fmt.Errorf("%w: a path inside the personal space is required", ErrInvalidPath)
	}
	full := owner + "/" + clean
	disk := filepath.Join(r.root, "users", filepath.FromSlash(full))
	if info, statErr := os.Stat(disk); statErr != nil || info == nil {
		return PersonalShare{}, fmt.Errorf("%w: unknown personal path", ErrNotFound)
	}

	seen := map[string]bool{}
	people := []string{}
	for _, name := range recipients {
		name = strings.ToLower(strings.TrimSpace(name))
		if name == "" || name == owner || seen[name] {
			continue
		}
		if !provisionNameRE.MatchString(name) {
			return PersonalShare{}, fmt.Errorf("%w: invalid recipient", ErrInvalidPath)
		}
		if info, statErr := os.Stat(filepath.Join(r.root, "users", name)); statErr != nil || !info.IsDir() {
			return PersonalShare{}, fmt.Errorf("%w: unknown recipient", ErrNotFound)
		}
		seen[name] = true
		people = append(people, name)
	}
	sort.Strings(people)

	r.mu.Lock()
	previous := make(map[string][]Scope, len(r.acl.Identities))
	for key, scopes := range r.acl.Identities {
		previous[key] = append([]Scope(nil), scopes...)
	}
	// 同一路径的旧名单先整体撤销，再写入新名单：共享是"替换"语义，
	// 否则取消勾选的人会一直保留历史授权。
	for key, scopes := range r.acl.Identities {
		kept := make([]Scope, 0, len(scopes))
		for _, s := range scopes {
			if s.Source == "users" && s.Path == full {
				continue
			}
			kept = append(kept, s)
		}
		r.acl.Identities[key] = kept
	}
	for _, name := range people {
		for _, key := range r.aclKeysFor(name) {
			r.acl.Identities[key] = mergeScope(r.acl.Identities[key], Scope{
				Source: "users", Path: full, View: true, Download: true,
			})
		}
	}
	if err := r.persistACLLocked(); err != nil {
		r.acl.Identities = previous
		r.mu.Unlock()
		return PersonalShare{}, err
	}
	r.mu.Unlock()
	return PersonalShare{Path: clean, Recipients: people}, nil
}

// SharedWith lists the personal entries other accounts explicitly shared with
// the caller. Entries that disappeared from disk or are denied are omitted.
func (r *Registry) SharedWith(identity Identity) []SharedEntry {
	owner := identity.LocalPart()
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := []SharedEntry{}
	seen := map[string]bool{}
	for _, ru := range r.rulesFor(identity) {
		if ru.Origin != "user" || ru.Scope.Source != "users" || ru.Scope.Deny {
			continue
		}
		p := ru.Scope.Path
		if p == "" || p == owner || strings.HasPrefix(p, owner+"/") {
			continue
		}
		if seen[p] {
			continue
		}
		e, ok := r.entries[entryID("users", p)]
		if !ok || !r.can(identity, e, "read") {
			continue
		}
		seen[p] = true
		who := p
		if i := strings.Index(p, "/"); i > 0 {
			who = p[:i]
		}
		out = append(out, SharedEntry{
			ID: e.ID, Owner: who, Path: e.Path, Name: e.Name, Dir: e.Dir, Size: e.Size,
			Modified: e.Modified, Created: e.Created,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Owner != out[j].Owner {
			return out[i].Owner < out[j].Owner
		}
		return out[i].Path < out[j].Path
	})
	return out
}

// ShareRecipients lists accounts that own a personal directory, excluding the
// caller, so the share dialog can offer real recipients only.
func (r *Registry) ShareRecipients(owner string) []string {
	owner = strings.ToLower(strings.TrimSpace(owner))
	base := filepath.Join(r.root, "users")
	entries, err := os.ReadDir(base)
	if err != nil {
		return []string{}
	}
	out := []string{}
	for _, e := range entries {
		name := strings.ToLower(e.Name())
		if !e.IsDir() || strings.HasPrefix(name, ".") || name == owner || !provisionNameRE.MatchString(name) {
			continue
		}
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// mergeScope adds want to scopes, widening an existing identical scope in
// place so repairs also restore missing write bits.
func mergeScope(scopes []Scope, want Scope) []Scope {
	for i := range scopes {
		if scopes[i].Source == want.Source && scopes[i].Path == want.Path {
			scopes[i].View = scopes[i].View || want.View
			scopes[i].Download = scopes[i].Download || want.Download
			scopes[i].Modify = scopes[i].Modify || want.Modify
			scopes[i].Delete = scopes[i].Delete || want.Delete
			scopes[i].Create = scopes[i].Create || want.Create
			return scopes
		}
	}
	return append(scopes, want)
}

// ProvisionUser creates the personal directory and guarantees the base file
// scopes of an account. It is idempotent and preserves extra grants such as
// project folders. Admins still cannot see personal files (personalPathAllowed).
func (r *Registry) ProvisionUser(name string) (ProvisionResult, error) {
	name = strings.ToLower(strings.TrimSpace(name))
	if !provisionNameRE.MatchString(name) {
		return ProvisionResult{}, fmt.Errorf("%w: invalid user name", ErrInvalidPath)
	}
	home := filepath.Join(r.root, "users", name)
	created := false
	info, err := os.Stat(home)
	switch {
	case err == nil:
		if !info.IsDir() {
			return ProvisionResult{}, fmt.Errorf("%w: personal path is not a directory", ErrInvalidPath)
		}
	case errors.Is(err, fs.ErrNotExist):
		if err := os.MkdirAll(home, 0o770); err != nil {
			return ProvisionResult{}, fmt.Errorf("create personal directory: %w", err)
		}
		created = true
	default:
		return ProvisionResult{}, fmt.Errorf("inspect personal directory: %w", err)
	}
	if created {
		if err := os.Chmod(home, 0o770); err != nil {
			return ProvisionResult{}, fmt.Errorf("set personal directory mode: %w", err)
		}
	}

	r.mu.Lock()
	keys := r.aclKeysFor(name)
	previous := make(map[string][]Scope, len(keys))
	for _, key := range keys {
		previous[key] = append([]Scope(nil), r.acl.Identities[key]...)
		scopes := append([]Scope(nil), r.acl.Identities[key]...)
		for _, want := range personalScopes(name) {
			scopes = mergeScope(scopes, want)
		}
		r.acl.Identities[key] = scopes
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
		return ProvisionResult{}, err
	}
	scopes := append([]Scope(nil), r.acl.Identities[keys[0]]...)
	r.mu.Unlock()

	if err := r.Scan(); err != nil {
		return ProvisionResult{}, err
	}
	return ProvisionResult{
		Name: name, Home: home, Created: created, Scopes: scopes,
	}, nil
}

// DeprovisionResult reports what removing an account from the file tree touched.
type DeprovisionResult struct {
	Name          string   `json:"name"`
	Home          string   `json:"home"`
	ACLEntries    []string `json:"aclEntries"`
	RevokedGrants int      `json:"revokedGrants"`
	RemovedPaths  int      `json:"removedPaths"`
	RemovedBytes  int64    `json:"removedBytes"`
	// TrashItems/TrashBytes 单独交代回收站里那份残留，避免和目录删除混数。
	TrashItems int   `json:"trashItems"`
	TrashBytes int64 `json:"trashBytes"`
}

// removeTree counts and deletes one directory tree without following symlinks.
// A missing tree counts as done (0, nil) so a retried removal stays idempotent.
func removeTree(dir string) (int, int64, error) {
	info, err := os.Lstat(dir)
	switch {
	case err == nil:
	case errors.Is(err, fs.ErrNotExist):
		return 0, 0, nil
	default:
		return 0, 0, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return 0, 0, fmt.Errorf("%w: personal path is not a directory", ErrInvalidPath)
	}
	count := 0
	var total int64
	if err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == dir {
			return err
		}
		count++
		if fi, ierr := d.Info(); ierr == nil && !d.IsDir() && fi.Mode()&os.ModeSymlink == 0 {
			total += fi.Size()
		}
		return nil
	}); err != nil {
		return count, total, err
	}
	if err := os.RemoveAll(dir); err != nil {
		return count, total, err
	}
	return count, total, nil
}

// DeprovisionUser removes an account from the file tree for good: its ACL
// identities first, so no request can reach the data while it is being
// deleted, then the personal directory itself. Grants that other identities
// hold on that home are dropped as well, because the path is gone.
//
// A disk failure does NOT roll the ACL removal back: the account has lost
// access and ProvisionUser is the documented repair for a half-finished call.
func (r *Registry) DeprovisionUser(name string) (DeprovisionResult, error) {
	name = strings.ToLower(strings.TrimSpace(name))
	if !provisionNameRE.MatchString(name) {
		return DeprovisionResult{}, fmt.Errorf("%w: invalid user name", ErrInvalidPath)
	}
	usersBase := filepath.Join(r.root, "users")
	home := filepath.Join(usersBase, name)
	if rel, err := filepath.Rel(usersBase, home); err != nil || rel != name {
		return DeprovisionResult{}, fmt.Errorf("%w: personal path escapes the tree", ErrInvalidPath)
	}

	res := DeprovisionResult{Name: name, Home: home, ACLEntries: []string{}}
	r.mu.Lock()
	previous := make(map[string][]Scope, len(r.acl.Identities))
	for key, scopes := range r.acl.Identities {
		previous[key] = append([]Scope(nil), scopes...)
	}
	for key, scopes := range previous {
		if key == name || localPart(key) == name {
			delete(r.acl.Identities, key)
			res.ACLEntries = append(res.ACLEntries, key)
			continue
		}
		kept := make([]Scope, 0, len(scopes))
		for _, s := range scopes {
			// 共享授权可能落在子路径（users/name/docs）；只删精确匹配会把
			// "已经不存在的账号"的共享留给下一个人。
			if s.Source == "users" && (s.Path == name || strings.HasPrefix(s.Path, name+"/")) {
				res.RevokedGrants++
				continue
			}
			kept = append(kept, s)
		}
		r.acl.Identities[key] = kept
	}
	sort.Strings(res.ACLEntries)
	if err := r.persistACLLocked(); err != nil {
		r.acl.Identities = previous
		r.mu.Unlock()
		return res, err
	}
	r.mu.Unlock()

	removed, bytes, err := removeTree(home)
	res.RemovedPaths, res.RemovedBytes = removed, bytes
	if err != nil {
		return res, err
	}
	// 回收站里的个人文件同样属于这个账号：留着记录就等于把文件留给下一个人。
	trashCount, trashBytes, terr := r.dropUserTrash(name)
	res.TrashItems, res.TrashBytes = trashCount, trashBytes
	res.RemovedPaths += trashCount
	res.RemovedBytes += trashBytes
	if terr != nil {
		return res, terr
	}
	if err := r.Scan(); err != nil {
		return res, fmt.Errorf("rescan file tree: %w", err)
	}
	return res, nil
}

// Grant is a directory-level permission assignment used by the admin UI.
// Access is "read" (view/download only), "write" (also create, modify and
// delete) or "deny" (explicitly revoke, which beats any inherited group grant).
type Grant struct {
	Source string `json:"source"`
	Path   string `json:"path"`
	Access string `json:"access"`
}

func (r *Registry) validateGrant(g Grant) (Scope, error) {
	shared := false
	for _, src := range Sources() {
		if src.ID == g.Source && src.Shared {
			shared = true
			break
		}
	}
	if !shared {
		return Scope{}, fmt.Errorf("%w: unknown shared source", ErrInvalidPath)
	}
	clean, err := cleanRelative(g.Path)
	if err != nil {
		return Scope{}, err
	}
	if clean != "" {
		info, statErr := os.Stat(filepath.Join(r.root, g.Source, filepath.FromSlash(clean)))
		if statErr != nil || !info.IsDir() {
			return Scope{}, fmt.Errorf("%w: unknown directory", ErrNotFound)
		}
	}
	switch strings.ToLower(strings.TrimSpace(g.Access)) {
	case "read":
		return Scope{Source: g.Source, Path: clean, View: true, Download: true}, nil
	case "write":
		return Scope{Source: g.Source, Path: clean, View: true, Download: true,
			Create: true, Modify: true, Delete: true}, nil
	case "deny":
		// 只置 Deny、不置任何权限位：拒绝该路径下的一切操作。
		return Scope{Source: g.Source, Path: clean, Deny: true}, nil
	default:
		return Scope{}, fmt.Errorf("%w: access must be read, write or deny", ErrInvalidPath)
	}
}

// SetFileGrants replaces every shared-source permission of an account with the
// supplied directory grants. Personal-space scopes ("users") are preserved.
func (r *Registry) SetFileGrants(name string, grants []Grant) ([]Scope, error) {
	name = strings.ToLower(strings.TrimSpace(name))
	if !provisionNameRE.MatchString(name) {
		return nil, fmt.Errorf("%w: invalid user name", ErrInvalidPath)
	}
	granted := make([]Scope, 0, len(grants))
	index := map[string]int{}
	for _, g := range grants {
		scope, err := r.validateGrant(g)
		if err != nil {
			return nil, err
		}
		key := scope.Source + "\x00" + scope.Path
		if i, ok := index[key]; ok {
			if scope.Deny {
				// 同一目录同时给出允许与拒绝时，拒绝优先：判定的优先级就是 deny > allow。
				granted[i] = scope
				continue
			}
			if granted[i].Deny {
				continue
			}
			granted[i].Create = granted[i].Create || scope.Create
			granted[i].Modify = granted[i].Modify || scope.Modify
			granted[i].Delete = granted[i].Delete || scope.Delete
			continue
		}
		index[key] = len(granted)
		granted = append(granted, scope)
	}
	sort.Slice(granted, func(i, j int) bool {
		if granted[i].Source != granted[j].Source {
			return granted[i].Source < granted[j].Source
		}
		return granted[i].Path < granted[j].Path
	})

	r.mu.Lock()
	keys := r.aclKeysFor(name)
	previous := make(map[string][]Scope, len(keys))
	for _, key := range keys {
		previous[key] = append([]Scope(nil), r.acl.Identities[key]...)
		scopes := make([]Scope, 0, len(granted)+2)
		for _, s := range r.acl.Identities[key] {
			if s.Source == "users" {
				scopes = append(scopes, s)
			}
		}
		scopes = append(scopes, granted...)
		r.acl.Identities[key] = scopes
	}
	if err := r.persistACLLocked(); err != nil {
		for key, scopes := range previous {
			r.acl.Identities[key] = scopes
		}
		r.mu.Unlock()
		return nil, err
	}
	result := append([]Scope(nil), r.acl.Identities[keys[0]]...)
	r.mu.Unlock()
	return result, nil
}

// AccountGrants maps account names (mailbox part) to their shared-directory
// grants. Personal-space scopes are never exported.
func (r *Registry) AccountGrants() map[string][]Grant {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := map[string][]Grant{}
	seen := map[string]map[string]int{}
	for key, scopes := range r.acl.Identities {
		name := localPart(key)
		if name == "" {
			continue
		}
		if seen[name] == nil {
			seen[name] = map[string]int{}
		}
		for _, s := range scopes {
			if s.Source == "users" {
				continue
			}
			access := groupAccess(s)
			gkey := s.Source + "\x00" + s.Path
			if i, ok := seen[name][gkey]; ok {
				cur := out[name][i].Access
				// 同一个人在文件里可能同时有邮箱键与裸名键：deny 优先，其次 write。
				if access == "deny" || (cur != "deny" && access == "write") {
					out[name][i].Access = access
				}
				continue
			}
			seen[name][gkey] = len(out[name])
			out[name] = append(out[name], Grant{Source: s.Source, Path: s.Path, Access: access})
		}
	}
	for name := range out {
		sort.Slice(out[name], func(i, j int) bool {
			if out[name][i].Source != out[name][j].Source {
				return out[name][i].Source < out[name][j].Source
			}
			return out[name][i].Path < out[name][j].Path
		})
	}
	return out
}

// Group 是一个预配置用户组：组名与 Casdoor 的 group 一致，授权由这里维护。
type Group struct {
	Name    string  `json:"name"`
	Grants  []Grant `json:"grants"`
	Builtin bool    `json:"builtin"`
}

var groupNameRE = regexp.MustCompile(`^[a-z][a-z0-9_-]{1,31}$`)

func groupAccess(s Scope) string {
	switch {
	case s.Deny:
		return "deny"
	case s.Create || s.Modify || s.Delete:
		return "write"
	case s.View || s.Download:
		return "read"
	}
	return "read"
}

func grantsOf(scopes []Scope) []Grant {
	out := make([]Grant, 0, len(scopes))
	for _, s := range scopes {
		out = append(out, Grant{Source: s.Source, Path: s.Path, Access: groupAccess(s)})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Source != out[j].Source {
			return out[i].Source < out[j].Source
		}
		return out[i].Path < out[j].Path
	})
	return out
}

// FileGroups 返回全部预配置用户组。内置组即使被改过也标记 builtin，
// 管理界面据此决定能不能删除。
func (r *Registry) FileGroups() []Group {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Group, 0, len(r.acl.Groups))
	for name, scopes := range r.acl.Groups {
		_, builtin := DefaultGroups()[name]
		out = append(out, Group{Name: name, Grants: grantsOf(scopes), Builtin: builtin})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// SetGroupGrants 用一组目录授权替换某个用户组的权限。组是"预配置默认值"，
// 因此成员的个人权限仍可覆盖它；这里只维护组本身。
func (r *Registry) SetGroupGrants(name string, grants []Grant) ([]Grant, error) {
	name = strings.ToLower(strings.TrimSpace(name))
	if !groupNameRE.MatchString(name) {
		return nil, fmt.Errorf("%w: invalid group name", ErrInvalidPath)
	}
	scopes := make([]Scope, 0, len(grants))
	index := map[string]int{}
	for _, g := range grants {
		scope, err := r.validateGrant(g)
		if err != nil {
			return nil, err
		}
		key := scope.Source + "\x00" + scope.Path
		if i, ok := index[key]; ok {
			if scope.Deny {
				scopes[i] = scope
				continue
			}
			if scopes[i].Deny {
				continue
			}
			scopes[i].Create = scopes[i].Create || scope.Create
			scopes[i].Modify = scopes[i].Modify || scope.Modify
			scopes[i].Delete = scopes[i].Delete || scope.Delete
			continue
		}
		index[key] = len(scopes)
		scopes = append(scopes, scope)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	var previous []Scope
	_, existed := r.acl.Groups[name]
	if existed {
		previous = append([]Scope(nil), r.acl.Groups[name]...)
	}
	if r.acl.Groups == nil {
		r.acl.Groups = map[string][]Scope{}
	}
	r.acl.Groups[name] = scopes
	if err := r.persistACLLocked(); err != nil {
		if existed {
			r.acl.Groups[name] = previous
		} else {
			delete(r.acl.Groups, name)
		}
		return nil, err
	}
	return grantsOf(scopes), nil
}

// DeleteFileGroup 移除一个自定义用户组。内置组不可删除：删掉 lab-student
// 会让所有学生账号同时失去共享目录的默认只读权限，而 Casdoor 的成员关系还在。
func (r *Registry) DeleteFileGroup(name string) error {
	name = strings.ToLower(strings.TrimSpace(name))
	if _, builtin := DefaultGroups()[name]; builtin {
		return fmt.Errorf("%w: builtin group cannot be deleted", ErrInvalidPath)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	previous, existed := r.acl.Groups[name]
	if !existed {
		return fmt.Errorf("%w: unknown group", ErrNotFound)
	}
	delete(r.acl.Groups, name)
	if err := r.persistACLLocked(); err != nil {
		r.acl.Groups[name] = previous
		return err
	}
	return nil
}

// EffectiveProbe 是"这个人在这条路径上实际能做什么"的预检结果。
type EffectiveProbe struct {
	Source  string            `json:"source"`
	Path    string            `json:"path"`
	Actions map[string]bool   `json:"actions"`
	Origin  map[string]string `json:"origin"`
}

// probeActions 是预检覆盖的动作集合，与判定的入口保持一致。
var probeActions = []string{"list", "read", "download", "create", "modify", "delete"}

// PreviewAccess 按「组 + 个人权限」的实际判定顺序预演某个身份的权限。
// 身份由调用方（统一身份源）原样给出，因此预演结果与真实会话完全一致。
func (r *Registry) PreviewAccess(identity Identity) []EffectiveProbe {
	r.mu.RLock()
	rules := r.rulesFor(identity)
	r.mu.RUnlock()

	paths := map[string]map[string]bool{}
	for _, src := range Sources() {
		if !src.Shared {
			continue
		}
		paths[src.ID] = map[string]bool{"": true}
	}
	for _, ru := range rules {
		if bySource, ok := paths[ru.Scope.Source]; ok {
			bySource[ru.Scope.Path] = true
		}
	}
	out := []EffectiveProbe{}
	for _, src := range Sources() {
		if !src.Shared {
			continue
		}
		list := make([]string, 0, len(paths[src.ID]))
		for p := range paths[src.ID] {
			list = append(list, p)
		}
		sort.Strings(list)
		for _, p := range list {
			probe := EffectiveProbe{
				Source:  src.ID,
				Path:    p,
				Actions: map[string]bool{},
				Origin:  map[string]string{},
			}
			for _, action := range probeActions {
				ok, origin := decide(rules, src.ID, p, action, identity.Admin)
				probe.Actions[action] = ok
				if ok {
					probe.Origin[action] = origin
				}
			}
			out = append(out, probe)
		}
	}
	return out
}

// Directories lists every directory of the shared sources, including the
// source root ("").
func (r *Registry) Directories() map[string][]string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := map[string][]string{}
	for _, src := range Sources() {
		if src.Shared {
			out[src.ID] = []string{""}
		}
	}
	for _, e := range r.entries {
		if !e.Dir || e.Path == "" {
			continue
		}
		if _, ok := out[e.Source]; ok {
			out[e.Source] = append(out[e.Source], e.Path)
		}
	}
	for source := range out {
		sort.Strings(out[source])
	}
	return out
}

// WritePaths returns the source-relative directories where the identity holds
// write permission. An empty path means the whole source is writable.
func (r *Registry) WritePaths(identity Identity, source string) []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	rules := r.rulesFor(identity)
	candidates := map[string]bool{}
	if source == "users" {
		home := identity.LocalPart()
		if home == "" {
			return []string{}
		}
		// 个人空间只暴露自己的家目录，绝不返回表示"整源可写"的空路径。
		candidates[home] = true
	} else {
		candidates[""] = true
		for _, ru := range rules {
			if ru.Scope.Source == source {
				candidates[ru.Scope.Path] = true
			}
		}
	}
	admin := identity.Admin && source != "users"
	out := []string{}
	for p := range candidates {
		if writableAt(rules, source, p, admin) {
			out = append(out, p)
		}
	}
	sort.Strings(out)
	return out
}

// persistACLLocked rewrites the ACL document atomically, preserving unknown
// top-level fields (admins, export metadata) from the existing file.
func (r *Registry) persistACLLocked() error {
	if r.aclPath == "" {
		return fmt.Errorf("%w: path not configured", ErrACLStore)
	}
	raw := map[string]json.RawMessage{}
	if b, err := os.ReadFile(r.aclPath); err == nil {
		if err := json.Unmarshal(b, &raw); err != nil {
			return fmt.Errorf("%w: existing file is invalid", ErrACLStore)
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("%w: %v", ErrACLStore, err)
	}
	identities, err := json.Marshal(r.acl.Identities)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrACLStore, err)
	}
	raw["identities"] = identities
	// groups 必须与 identities 一起落盘：只写后者的话，管理员在界面上调整的
	// 用户组授权会在下一次保存时被静默丢弃。
	groups := r.acl.Groups
	if groups == nil {
		groups = map[string][]Scope{}
	}
	groupsRaw, err := json.Marshal(groups)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrACLStore, err)
	}
	raw["groups"] = groupsRaw
	data, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return fmt.Errorf("%w: %v", ErrACLStore, err)
	}
	data = append(data, '\n')

	tmp, err := os.CreateTemp(filepath.Dir(r.aclPath), ".labgo-acl-*.tmp")
	if err != nil {
		return fmt.Errorf("%w: %v", ErrACLStore, err)
	}
	tmpName := tmp.Name()
	fail := func(err error) error {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return fmt.Errorf("%w: %v", ErrACLStore, err)
	}
	if err := tmp.Chmod(0o640); err != nil {
		return fail(err)
	}
	if _, err := tmp.Write(data); err != nil {
		return fail(err)
	}
	if err := tmp.Sync(); err != nil {
		return fail(err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("%w: %v", ErrACLStore, err)
	}
	if err := os.Rename(tmpName, r.aclPath); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("%w: %v", ErrACLStore, err)
	}
	return nil
}

// cleanRelative normalises a source-relative path and rejects traversal,
// hidden segments and empty names.
func cleanRelative(p string) (string, error) {
	p = strings.TrimSpace(strings.ReplaceAll(p, `\`, "/"))
	p = strings.TrimPrefix(p, "/")
	if p == "" {
		return "", nil
	}
	if strings.ContainsRune(p, 0) {
		return "", ErrInvalidPath
	}
	c := path.Clean(p)
	if c != p || c == "." {
		return "", ErrInvalidPath
	}
	for _, seg := range strings.Split(c, "/") {
		if seg == "" || seg == "." || seg == ".." || strings.HasPrefix(seg, ".") {
			return "", ErrInvalidPath
		}
	}
	return c, nil
}

func validName(name string) error {
	clean, err := cleanRelative(name)
	if err != nil || clean != name || strings.Contains(clean, "/") {
		return ErrInvalidPath
	}
	return nil
}

func (r *Registry) sourceDir(source string) (string, bool) {
	for _, src := range Sources() {
		if src.ID == source {
			return filepath.Join(r.root, src.ID), true
		}
	}
	return "", false
}

// diskPath maps a source-relative path to disk, refusing traversal.
func (r *Registry) diskPath(source, rel string) (string, error) {
	base, ok := r.sourceDir(source)
	if !ok {
		return "", ErrInvalidPath
	}
	clean, err := cleanRelative(rel)
	if err != nil {
		return "", err
	}
	if clean == "" {
		return base, nil
	}
	full := filepath.Join(base, filepath.FromSlash(clean))
	baseClean := filepath.Clean(base)
	if full != baseClean && !strings.HasPrefix(full, baseClean+string(os.PathSeparator)) {
		return "", ErrInvalidPath
	}
	return full, nil
}

// parentDir resolves the parent of rel and verifies it stays inside the source
// after symlink resolution.
func (r *Registry) parentDir(source, rel string) (string, string, error) {
	full, err := r.diskPath(source, rel)
	if err != nil {
		return "", "", err
	}
	base, _ := r.sourceDir(source)
	resolvedBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		return "", "", ErrNotFound
	}
	parent := filepath.Dir(full)
	resolvedParent, err := filepath.EvalSymlinks(parent)
	if err != nil {
		return "", "", ErrNotFound
	}
	if resolvedParent != resolvedBase && !strings.HasPrefix(resolvedParent, resolvedBase+string(os.PathSeparator)) {
		return "", "", ErrInvalidPath
	}
	if info, err := os.Stat(resolvedParent); err != nil || !info.IsDir() {
		return "", "", ErrNotFound
	}
	return full, parent, nil
}

func (r *Registry) lookup(source, rel string) (Entry, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	e, ok := r.entries[entryID(source, rel)]
	return e, ok
}

// CreateDir creates one directory inside a writable scope.
func (r *Registry) CreateDir(identity Identity, source, rel string) (Entry, error) {
	clean, err := cleanRelative(rel)
	if err != nil || clean == "" {
		return Entry{}, ErrInvalidPath
	}
	if !r.CanPath(identity, source, clean, "create") {
		return Entry{}, ErrForbidden
	}
	full, _, err := r.parentDir(source, clean)
	if err != nil {
		return Entry{}, err
	}
	if _, err := os.Lstat(full); err == nil {
		return Entry{}, ErrExists
	}
	if err := os.Mkdir(full, 0o770); err != nil {
		return Entry{}, storageError("mkdir", err)
	}
	if err := r.Scan(); err != nil {
		return Entry{}, err
	}
	if e, ok := r.lookup(source, clean); ok {
		return e, nil
	}
	return Entry{}, ErrNotFound
}

// WriteFile stores one upload under dir/name, replacing it only when overwrite
// is true and the scope grants modify on the existing entry.
func (r *Registry) WriteFile(identity Identity, source, dir, name string, src io.Reader, overwrite bool) (Entry, error) {
	dirClean, err := cleanRelative(dir)
	if err != nil {
		return Entry{}, ErrInvalidPath
	}
	if err := validName(name); err != nil {
		return Entry{}, err
	}
	rel := name
	if dirClean != "" {
		rel = dirClean + "/" + name
	}
	full, parent, err := r.parentDir(source, rel)
	if err != nil {
		return Entry{}, err
	}
	if info, statErr := os.Lstat(full); statErr == nil {
		if info.IsDir() {
			return Entry{}, ErrExists
		}
		if !r.CanPath(identity, source, rel, "modify") {
			return Entry{}, ErrForbidden
		}
		if !overwrite {
			return Entry{}, ErrExists
		}
	} else if !r.CanPath(identity, source, rel, "create") {
		return Entry{}, ErrForbidden
	}
	tmp, err := os.CreateTemp(parent, ".upload-*")
	if err != nil {
		return Entry{}, storageError("open upload staging directory", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	n, copyErr := io.Copy(tmp, io.LimitReader(src, MaxUploadBytes+1))
	closeErr := tmp.Close()
	if copyErr != nil || closeErr != nil {
		return Entry{}, copyErr
	}
	if n > MaxUploadBytes {
		return Entry{}, ErrTooLarge
	}
	if err := os.Chmod(tmpName, 0o640); err != nil {
		return Entry{}, storageError("chmod staged upload", err)
	}
	if err := os.Rename(tmpName, full); err != nil {
		return Entry{}, storageError("commit staged upload", err)
	}
	if err := r.Scan(); err != nil {
		return Entry{}, err
	}
	if e, ok := r.lookup(source, rel); ok {
		return e, nil
	}
	return Entry{}, ErrNotFound
}

// Rename moves or renames one entry inside its source.
func (r *Registry) Rename(identity Identity, id, newName string) (Entry, error) {
	e, ok := r.Get(id)
	if !ok || e.Path == "" {
		return Entry{}, ErrNotFound
	}
	if err := validName(newName); err != nil {
		return Entry{}, err
	}
	if !r.CanPath(identity, e.Source, e.Path, "modify") {
		if !r.CanPath(identity, e.Source, e.Path, "read") {
			return Entry{}, ErrNotFound
		}
		return Entry{}, ErrForbidden
	}
	parent := ""
	if i := strings.LastIndex(e.Path, "/"); i >= 0 {
		parent = e.Path[:i]
	}
	rel := newName
	if parent != "" {
		rel = parent + "/" + newName
	}
	if rel == e.Path {
		return e, nil
	}
	if !r.CanPath(identity, e.Source, rel, "create") {
		return Entry{}, ErrForbidden
	}
	oldFull, err := r.diskPath(e.Source, e.Path)
	if err != nil {
		return Entry{}, ErrNotFound
	}
	newFull, _, err := r.parentDir(e.Source, rel)
	if err != nil {
		return Entry{}, err
	}
	if _, err := os.Lstat(newFull); err == nil {
		return Entry{}, ErrExists
	}
	if err := os.Rename(oldFull, newFull); err != nil {
		return Entry{}, storageError("rename entry", err)
	}
	if err := r.Scan(); err != nil {
		return Entry{}, err
	}
	if moved, ok := r.lookup(e.Source, rel); ok {
		return moved, nil
	}
	return Entry{}, ErrNotFound
}

// Delete moves one file or directory (with its whole subtree) into the
// recycle bin. Permission rules are unchanged; the data stays recoverable in
// .trash until TrashRetentionDays() passes. See trash.go.
func (r *Registry) Delete(identity Identity, id string) error {
	_, err := r.Trash(identity, id)
	return err
}

// scopeCovers reports whether a scope path prefix covers an entry path.
func scopeCovers(s Scope, path string) bool {
	if s.Path == "" {
		return true
	}
	if path == s.Path {
		return true
	}
	return strings.HasPrefix(path, s.Path+"/")
}

// Read returns the content of a file entry, bounded by maxBytes.
func (r *Registry) Read(e Entry, maxBytes int64) ([]byte, error) {
	if e.Dir {
		return nil, errors.New("cannot read a directory")
	}
	full, err := r.resolve(e)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(full)
	if err != nil {
		return nil, err
	}
	if maxBytes > 0 && info.Size() > maxBytes {
		return nil, fmt.Errorf("file exceeds %d byte limit", maxBytes)
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return nil, err
	}
	return data, nil
}

// Open returns an open file handle for streaming downloads.
func (r *Registry) Open(e Entry) (*os.File, error) {
	if e.Dir {
		return nil, errors.New("cannot open a directory")
	}
	full, err := r.resolve(e)
	if err != nil {
		return nil, err
	}
	return os.Open(full)
}

// resolve maps an entry to an absolute path, refusing path traversal.
func (r *Registry) resolve(e Entry) (string, error) {
	clean := path.Clean("/" + e.Path)
	clean = strings.TrimPrefix(clean, "/")
	if clean != e.Path {
		return "", errors.New("invalid resource path")
	}
	base := filepath.Join(r.root, e.Source)
	full := filepath.Join(base, filepath.FromSlash(clean))
	if !strings.HasPrefix(full, filepath.Clean(base)+string(os.PathSeparator)) && full != filepath.Clean(base) {
		return "", errors.New("resource path escapes the lab root")
	}
	return full, nil
}

func entryID(source, rel string) string {
	sum := sha256.Sum256([]byte(source + "/" + rel))
	return "f_" + hex.EncodeToString(sum[:])[:24]
}
