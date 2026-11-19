package labfiles

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// 回收站把删除变成"移动到 lab 根目录下的 .trash 并记账"，保留期内可原地恢复。
// .trash 不是任何一个文件源，Scan 只遍历 Sources() 里的目录，因此回收站内容
// 既不会出现在文件列表里，也不会被 ACL 当成可浏览路径。
//
// 锁顺序：trMu 之内可以取 mu（CanPath/Scan），反过来不行——否则
// ProvisionUser/DeprovisionUser 这类先持 mu 再碰清单的路径会自锁。
const (
	trashDirName      = ".trash"
	trashManifestName = "trash.json"
	// defaultTrashRetentionDays 是未配置 LABGO_TRASH_DAYS 时的保留期。
	// 全站统一 7 天：回收站与各类日志保持同一口径，不出现 30/90 天混用。
	defaultTrashRetentionDays = 7
)

var trashIDRE = regexp.MustCompile(`^[a-f0-9]{12}$`)

// TrashItem 是一条回收站记录。Paths/Size 在删除当场算好并落盘，
// 这样列表和用量统计不必再遍历负载目录。
type TrashItem struct {
	ID        string `json:"id"`
	Source    string `json:"source"`
	Path      string `json:"path"`
	Name      string `json:"name"`
	Dir       bool   `json:"dir"`
	Paths     int    `json:"paths"`
	Size      int64  `json:"size"`
	Modified  string `json:"modified"`
	DeletedAt string `json:"deletedAt"`
	ExpiresAt string `json:"expiresAt"`
	DeletedBy string `json:"deletedBy"`
	// Restorable 与 SourceLabel 只在列表接口现场计算，不落盘。
	Restorable  bool   `json:"restorable,omitempty"`
	SourceLabel string `json:"sourceLabel,omitempty"`
}

// TrashSummary 汇总一次清空/过期清理的结果。
type TrashSummary struct {
	Removed int   `json:"removed"`
	Skipped int   `json:"skipped"`
	Bytes   int64 `json:"bytes"`
}

// TrashRetentionDays 返回保留天数。LABGO_TRASH_DAYS 被限制在 1~365，
// 写成 0 或乱码不会让回收站变成黑洞。
func TrashRetentionDays() int {
	days := defaultTrashRetentionDays
	if raw := strings.TrimSpace(os.Getenv("LABGO_TRASH_DAYS")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			days = n
		}
	}
	if days > 365 {
		days = 365
	}
	return days
}

func (r *Registry) trashDir() string { return filepath.Join(r.root, trashDirName) }

// TrashDir 暴露回收站目录，供服务启动日志与运维提示使用。
func (r *Registry) TrashDir() string { return r.trashDir() }

// PrepareTrash 在启动时确认回收站目录可用。目录必须落在 lab 根上（同一文件系统，
// 删除才是改名而不是复制），而 lab 根通常由 root 拥有，所以首次创建往往需要
// 运维预置；这里只做一次真实的写入探测，好让启动日志给出可执行的修复命令。
func (r *Registry) PrepareTrash() error {
	dir := r.trashDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	probe, err := os.CreateTemp(dir, ".probe-*")
	if err != nil {
		return err
	}
	name := probe.Name()
	_ = probe.Close()
	return os.Remove(name)
}

func (r *Registry) trashManifest() string { return filepath.Join(r.trashDir(), trashManifestName) }

// trashPayload 把记录 ID 映射到磁盘负载；ID 必须是本机生成的十六进制串，
// 手改清单里的 "../x" 之类一律拒绝。
func (r *Registry) trashPayload(id string) (string, error) {
	if !trashIDRE.MatchString(id) {
		return "", fmt.Errorf("%w: unknown trash id", ErrInvalidPath)
	}
	return filepath.Join(r.trashDir(), id), nil
}

// loadTrash 读取清单。文件缺失表示空回收站；解析失败必须报错，
// 绝不能覆盖一个读不懂的清单——那等于丢掉别人的数据。
func (r *Registry) loadTrash() ([]TrashItem, error) {
	raw, err := os.ReadFile(r.trashManifest())
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, storageError("read trash manifest", err)
	}
	var doc struct {
		Items []TrashItem `json:"items"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("%w: trash manifest is corrupt: %v", ErrStorage, err)
	}
	items := make([]TrashItem, 0, len(doc.Items))
	for _, it := range doc.Items {
		if !trashIDRE.MatchString(it.ID) || it.Source == "" || it.Path == "" {
			continue
		}
		items = append(items, it)
	}
	return items, nil
}

// saveTrash 原子写回清单；目录权限 0700，负载内容受 ACL 层而不是文件系统约束。
func (r *Registry) saveTrash(items []TrashItem) error {
	if items == nil {
		items = []TrashItem{}
	}
	if err := os.MkdirAll(r.trashDir(), 0o700); err != nil {
		return storageError("create trash directory", err)
	}
	if err := os.Chmod(r.trashDir(), 0o700); err != nil {
		return storageError("chmod trash directory", err)
	}
	doc := struct {
		RetentionDays int         `json:"retentionDays"`
		Items         []TrashItem `json:"items"`
	}{RetentionDays: TrashRetentionDays(), Items: items}
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return storageError("encode trash manifest", err)
	}
	data = append(data, '\n')
	tmp, err := os.CreateTemp(r.trashDir(), ".trash-tmp-*")
	if err != nil {
		return storageError("create trash manifest", err)
	}
	name := tmp.Name()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		_ = os.Remove(name)
		return storageError("chmod trash manifest", err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(name)
		return storageError("write trash manifest", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		_ = os.Remove(name)
		return storageError("sync trash manifest", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(name)
		return storageError("close trash manifest", err)
	}
	if err := os.Rename(name, r.trashManifest()); err != nil {
		_ = os.Remove(name)
		return storageError("replace trash manifest", err)
	}
	return nil
}

func newTrashID() (string, error) {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", storageError("generate trash id", err)
	}
	return hex.EncodeToString(b[:]), nil
}

// measurePath 统计负载的路径数与字节数（目录不把自己的 inode 计成字节）。
func measurePath(p string) (int, int64, error) {
	info, err := os.Lstat(p)
	if err != nil {
		return 0, 0, err
	}
	if !info.IsDir() {
		return 1, info.Size(), nil
	}
	count, total := 1, int64(0)
	if err := filepath.WalkDir(p, func(sub string, d fs.DirEntry, err error) error {
		if err != nil || sub == p {
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
	return count, total, nil
}

// removePayload 永久删除回收站负载；目录复用 removeTree 的符号链接守卫。
func removePayload(p string) (int, int64, error) {
	info, err := os.Lstat(p)
	switch {
	case err == nil:
	case errors.Is(err, fs.ErrNotExist):
		return 0, 0, nil
	default:
		return 0, 0, err
	}
	if info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
		return removeTree(p)
	}
	size := info.Size()
	if err := os.Remove(p); err != nil {
		return 0, 0, err
	}
	return 1, size, nil
}

// Trash 把一个条目移入回收站。权限判定与旧的直接删除完全一致（先 delete，
// 无读权则按不存在处理），只是数据落到 .trash 而不是消失。
func (r *Registry) Trash(identity Identity, id string) (TrashItem, error) {
	e, ok := r.Get(id)
	if !ok || e.Path == "" {
		return TrashItem{}, ErrNotFound
	}
	if !r.CanPath(identity, e.Source, e.Path, "delete") {
		if !r.CanPath(identity, e.Source, e.Path, "read") {
			return TrashItem{}, ErrNotFound
		}
		return TrashItem{}, ErrForbidden
	}
	// 删除权可能被限定在时间窗内（如"学生只能删最近 48 小时上传的材料"）。
	// 窗口外的条目即使有 delete 权限也拒绝。
	if err := r.checkDeleteWindow(identity, e.Source, e.Path, e.Modified); err != nil {
		return TrashItem{}, err
	}
	full, err := r.diskPath(e.Source, e.Path)
	if err != nil {
		return TrashItem{}, ErrNotFound
	}
	info, err := os.Lstat(full)
	if err != nil {
		return TrashItem{}, ErrNotFound
	}
	paths, size, err := measurePath(full)
	if err != nil {
		return TrashItem{}, storageError("measure delete target", err)
	}

	r.trMu.Lock()
	defer r.trMu.Unlock()
	items, err := r.loadTrash()
	if err != nil {
		return TrashItem{}, err
	}
	itemID, err := newTrashID()
	if err != nil {
		return TrashItem{}, err
	}
	payload, err := r.trashPayload(itemID)
	if err != nil {
		return TrashItem{}, err
	}
	if _, err := os.Stat(r.trashDir()); err != nil {
		if err := os.MkdirAll(r.trashDir(), 0o700); err != nil {
			return TrashItem{}, storageError("create trash directory", err)
		}
	}
	if err := os.Rename(full, payload); err != nil {
		return TrashItem{}, storageError("move to trash", err)
	}
	now := time.Now().UTC()
	item := TrashItem{
		ID:        itemID,
		Source:    e.Source,
		Path:      e.Path,
		Name:      e.Name,
		Dir:       info.IsDir(),
		Paths:     paths,
		Size:      size,
		Modified:  e.Modified,
		DeletedAt: now.Format(time.RFC3339),
		ExpiresAt: now.AddDate(0, 0, TrashRetentionDays()).Format(time.RFC3339),
		DeletedBy: identity.LocalPart(),
	}
	items = append(items, item)
	if err := r.saveTrash(items); err != nil {
		// 记账失败必须把数据放回原位，否则条目既不在文件源也不在清单里。
		if rerr := os.Rename(payload, full); rerr != nil {
			return item, fmt.Errorf("%w: %v; data moved to %s", ErrStorage, err, payload)
		}
		return TrashItem{}, storageError("write trash manifest", err)
	}
	// 共享路径被删除后，把这一路径上的**共享授权**一并撤掉：
	// 文件本身已经移走（物理上只有一份），留着授权只会让列表里出现
	// "共享给某人"但点开是 404 的幽灵条目。
	r.purgeShareScopes(e.Path)
	if err := r.Scan(); err != nil {
		return item, storageError("rescan after trash", err)
	}
	return item, nil
}

// purgeShareScopes 撤掉某个路径上的共享授权。
//
// 判据：个人空间的"自己的家目录"授权写作 Source=users, Path=<用户名>（不含 "/"），
// 而共享授权写作 Path=<owner>/<相对路径>（含 "/"）。因此只清理含 "/" 的那些。
func (r *Registry) purgeShareScopes(path string) {
	if path == "" || !strings.Contains(path, "/") {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	changed := false
	for key, scopes := range r.acl.Identities {
		kept := make([]Scope, 0, len(scopes))
		for _, sc := range scopes {
			if sc.Source == "users" && strings.Contains(sc.Path, "/") &&
				(sc.Path == path || strings.HasPrefix(sc.Path, path+"/")) {
				changed = true
				continue
			}
			kept = append(kept, sc)
		}
		if len(kept) != len(scopes) {
			r.acl.Identities[key] = kept
		}
	}
	if !changed {
		return
	}
	if err := r.persistACLLocked(); err != nil {
		log.Printf("labfiles: purge share scopes for %s failed: %v", path, err)
	}
}

// ListTrash 返回调用者有权处置（即在原路径仍有 delete 权限）的回收站条目，
// 新的在前。别人删的条目不出现在个人空间里，共享目录则按目录权限可见。
func (r *Registry) ListTrash(identity Identity) ([]TrashItem, error) {
	r.trMu.Lock()
	defer r.trMu.Unlock()
	items, err := r.loadTrash()
	if err != nil {
		return nil, err
	}
	labels := map[string]string{}
	for _, src := range Sources() {
		labels[src.ID] = src.Label
	}
	out := []TrashItem{}
	for _, it := range items {
		if !r.CanPath(identity, it.Source, it.Path, "delete") {
			continue
		}
		it.Restorable = r.CanPath(identity, it.Source, it.Path, "create")
		it.SourceLabel = labels[it.Source]
		if it.SourceLabel == "" {
			it.SourceLabel = it.Source
		}
		out = append(out, it)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].DeletedAt != out[j].DeletedAt {
			return out[i].DeletedAt > out[j].DeletedAt
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// Restore 把条目移回原路径。目标已存在时拒绝覆盖（ErrExists），
// 父目录被人删掉时按需重建——否则"先删文件再删父目录"就永远恢复不了。
func (r *Registry) Restore(identity Identity, itemID string) (Entry, error) {
	r.trMu.Lock()
	defer r.trMu.Unlock()
	items, err := r.loadTrash()
	if err != nil {
		return Entry{}, err
	}
	idx := -1
	for i, it := range items {
		if it.ID == itemID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return Entry{}, ErrNotFound
	}
	it := items[idx]
	if !r.CanPath(identity, it.Source, it.Path, "delete") {
		return Entry{}, ErrNotFound
	}
	if !r.CanPath(identity, it.Source, it.Path, "create") {
		return Entry{}, ErrForbidden
	}
	payload, err := r.trashPayload(it.ID)
	if err != nil {
		return Entry{}, err
	}
	full, err := r.diskPath(it.Source, it.Path)
	if err != nil {
		return Entry{}, err
	}
	if _, err := os.Lstat(payload); err != nil {
		// 清单还在、负载已不在：目标存在说明上一次恢复其实已经完成，清掉记录即可；
		// 目标也不存在就是数据丢失，必须报错而不是假装成功。
		if _, terr := os.Lstat(full); terr == nil {
			if e, ok := r.lookup(it.Source, it.Path); ok {
				if err := r.saveTrash(dropTrashItem(items, idx)); err != nil {
					return Entry{}, err
				}
				return e, nil
			}
		}
		if err := r.saveTrash(dropTrashItem(items, idx)); err != nil {
			return Entry{}, err
		}
		return Entry{}, ErrNotFound
	}
	merged := false
	if info, err := os.Lstat(full); err == nil {
		// 目标位置已有东西。目录恢复时父目录常常是上一步恢复子文件时重建的，
		// 这种情形按内容合并；其余情况一律拒绝，绝不覆盖别人的新文件。
		if !it.Dir || !info.IsDir() {
			return Entry{}, ErrExists
		}
		if err := mergeIntoDir(payload, full); err != nil {
			return Entry{}, err
		}
		merged = true
	} else {
		if err := r.ensureRestoreParent(identity, it.Source, it.Path); err != nil {
			return Entry{}, err
		}
		if err := os.Rename(payload, full); err != nil {
			return Entry{}, storageError("restore from trash", err)
		}
		// 恢复后仍是原来那份文件：把修改时间写回去，避免列表显示"刚刚改过"。
		if mod, perr := time.Parse(time.RFC3339, it.Modified); perr == nil {
			if cerr := os.Chtimes(full, mod, mod); cerr != nil {
				log.Printf("WARN: restore mtime %s: %v", it.Path, cerr)
			}
		}
	}
	if err := r.saveTrash(dropTrashItem(items, idx)); err != nil {
		// 文件已回到原位，多出的清单行只会被下次恢复识别成"已完成"。
		log.Printf("WARN: trash manifest after restore: %v (item %s)", err, it.ID)
	}
	if err := r.Scan(); err != nil {
		return Entry{}, storageError("rescan after restore", err)
	}
	if merged {
		log.Printf("trash restored by %s: merged %s/%s", identity.LocalPart(), it.Source, it.Path)
	}
	if e, ok := r.lookup(it.Source, it.Path); ok {
		return e, nil
	}
	return Entry{}, ErrNotFound
}

// mergeIntoDir 把回收站负载目录的内容并进一个已存在的同名目录。
// 先整体查重再搬运，因此不会出现"一半覆盖、一半保留"的状态。
func mergeIntoDir(payload, target string) error {
	kids, err := os.ReadDir(payload)
	if err != nil {
		return storageError("read trash payload", err)
	}
	for _, d := range kids {
		if _, err := os.Lstat(filepath.Join(target, d.Name())); err == nil {
			return ErrExists
		}
	}
	for _, d := range kids {
		src := filepath.Join(payload, d.Name())
		dst := filepath.Join(target, d.Name())
		if err := os.Rename(src, dst); err != nil {
			return storageError("merge restored directory", err)
		}
	}
	return os.Remove(payload)
}

func dropTrashItem(items []TrashItem, idx int) []TrashItem {
	out := make([]TrashItem, 0, len(items)-1)
	out = append(out, items[:idx]...)
	return append(out, items[idx+1:]...)
}

// ensureRestoreParent 恢复条目的父目录。
func (r *Registry) ensureRestoreParent(identity Identity, source, rel string) error {
	parent := path.Dir(rel)
	if parent == "." || parent == "/" {
		parent = ""
	}
	if _, err := r.diskPath(source, parent); err != nil {
		return err
	}
	if _, _, err := r.parentDir(source, rel); err == nil {
		return nil
	}
	if !r.CanPath(identity, source, parent, "create") {
		return ErrForbidden
	}
	full, err := r.diskPath(source, parent)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(full, 0o775); err != nil {
		return storageError("restore parent directory", err)
	}
	return nil
}

// Purge 永久删除一条回收站记录（保留期未满时的显式操作）。
// Destroy 永久删除一个条目（**不进回收站**）。
//
// 与 Trash 的区别：Trash 先移到回收站、保留 7 天可恢复；

// checkDeleteWindow 校验该身份在给定路径上的删除时间窗。
//
// 授权上的 DeleteWithin（如"48h"）表示"只允许删最近这段时间内上传/修改的内容"。
// 窗口外的条目即使有 delete 权限也必须拒绝 —— 且这条规则必须覆盖
// **所有**删除路径（进回收站、永久删除、清理回收站），否则"更危险的那条路"
// 反而没有门槛。
func (r *Registry) checkDeleteWindow(identity Identity, source, path, modified string) error {
	window := r.deleteWindowFor(identity, source, path)
	if window <= 0 {
		return nil
	}
	t, err := time.Parse(time.RFC3339, modified)
	if err != nil {
		// 修改时间读不出来就按超期处理：宁可少让删，不多让删。
		return ErrForbidden
	}
	if time.Since(t) > window {
		return ErrForbidden
	}
	return nil
}

// Destroy 直接从磁盘抹掉，不可恢复。用于"确定不要了"的场景，
// 比如误传的大文件、涉密材料、批量清理。
//
// 权限与 Trash 一致（需要该路径的 delete 权限），共享路径同样会撤掉授权。
func (r *Registry) Destroy(identity Identity, id string) (TrashItem, error) {
	e, ok := r.Get(id)
	if !ok || e.Path == "" {
		return TrashItem{}, ErrNotFound
	}
	if !r.CanPath(identity, e.Source, e.Path, "delete") {
		if !r.CanPath(identity, e.Source, e.Path, "read") {
			return TrashItem{}, ErrNotFound
		}
		return TrashItem{}, ErrForbidden
	}
	// 永久删除**同样**受删除时间窗约束。
	//
	// 以前这里没有窗口判定：Trash() 检查了"48h 内才可删"，但 Destroy()
	// 直接从磁盘抹掉、绕过回收站与窗口 → 学生只要知道条目 id，
	// 就能把导师三天前放进共享目录的材料永久删掉，且不可恢复。
	// 永久删除比进回收站更危险，所以窗口判定必须在这条路上也生效。
	if err := r.checkDeleteWindow(identity, e.Source, e.Path, e.Modified); err != nil {
		return TrashItem{}, err
	}
	full, err := r.diskPath(e.Source, e.Path)
	if err != nil {
		return TrashItem{}, ErrNotFound
	}
	info, statErr := os.Lstat(full)
	if statErr != nil {
		return TrashItem{}, ErrNotFound
	}
	paths, size, err := measurePath(full)
	if err != nil {
		return TrashItem{}, storageError("measure destroy target", err)
	}
	if _, _, err := removePayload(full); err != nil {
		return TrashItem{}, storageError("destroy target", err)
	}
	// 共享路径被永久删除后，同样要撤掉授权（否则会留下点开即 404 的幽灵条目）
	r.purgeShareScopes(e.Path)
	item := TrashItem{
		ID:        e.ID,
		Source:    e.Source,
		Path:      e.Path,
		Name:      e.Name,
		Dir:       info.IsDir(),
		Paths:     paths,
		Size:      size,
		Modified:  e.Modified,
		DeletedAt: time.Now().UTC().Format(time.RFC3339),
		DeletedBy: identity.LocalPart(),
	}
	if err := r.Scan(); err != nil {
		return item, storageError("rescan after destroy", err)
	}
	return item, nil
}

func (r *Registry) Purge(identity Identity, itemID string) (TrashSummary, error) {
	empty := TrashSummary{}
	r.trMu.Lock()
	defer r.trMu.Unlock()
	items, err := r.loadTrash()
	if err != nil {
		return empty, err
	}
	for i, it := range items {
		if it.ID != itemID {
			continue
		}
		if !r.CanPath(identity, it.Source, it.Path, "delete") {
			return empty, ErrNotFound
		}
		payload, err := r.trashPayload(it.ID)
		if err != nil {
			return empty, err
		}
		paths, size, err := removePayload(payload)
		if err != nil {
			return empty, storageError("purge trash payload", err)
		}
		if err := r.saveTrash(dropTrashItem(items, i)); err != nil {
			return empty, err
		}
		log.Printf("trash purged: %s/%s by %s (%d paths, %d bytes)", it.Source, it.Path, identity.LocalPart(), paths, size)
		return TrashSummary{Removed: 1, Bytes: size}, nil
	}
	return empty, ErrNotFound
}

// Empty 清空调用者有权处置的条目；无权的条目留在原地并计入 Skipped，
// 这样"清空回收站"不会越权删掉同事刚删错的文件。
func (r *Registry) Empty(identity Identity) (TrashSummary, error) {
	r.trMu.Lock()
	defer r.trMu.Unlock()
	items, err := r.loadTrash()
	if err != nil {
		return TrashSummary{}, err
	}
	sum := TrashSummary{}
	kept := []TrashItem{}
	for _, it := range items {
		if !r.CanPath(identity, it.Source, it.Path, "delete") {
			kept = append(kept, it)
			sum.Skipped++
			continue
		}
		payload, perr := r.trashPayload(it.ID)
		if perr != nil {
			kept = append(kept, it)
			sum.Skipped++
			continue
		}
		paths, size, rerr := removePayload(payload)
		if rerr != nil {
			kept = append(kept, it)
			sum.Skipped++
			log.Printf("WARN: empty trash %s: %v", it.ID, rerr)
			continue
		}
		_ = paths
		sum.Removed++
		sum.Bytes += size
	}
	if sum.Removed == 0 {
		return sum, nil
	}
	if err := r.saveTrash(kept); err != nil {
		return sum, err
	}
	log.Printf("trash emptied by %s: %d items, %d bytes released", identity.LocalPart(), sum.Removed, sum.Bytes)
	return sum, nil
}

// PurgeExpired 清掉超过保留期的条目，由服务启动和定时扫描调用。
// 解析不了 ExpiresAt 或磁盘删除失败的条目留到下一次，绝不静默丢弃记录。
func (r *Registry) PurgeExpired() (TrashSummary, error) {
	r.trMu.Lock()
	defer r.trMu.Unlock()
	items, err := r.loadTrash()
	if err != nil {
		return TrashSummary{}, err
	}
	if len(items) == 0 {
		return TrashSummary{}, nil
	}
	now := time.Now().UTC()
	sum := TrashSummary{}
	kept := []TrashItem{}
	for _, it := range items {
		exp, perr := time.Parse(time.RFC3339, it.ExpiresAt)
		if perr != nil || now.Before(exp) {
			kept = append(kept, it)
			continue
		}
		payload, ierr := r.trashPayload(it.ID)
		if ierr != nil {
			kept = append(kept, it)
			continue
		}
		_, size, rerr := removePayload(payload)
		if rerr != nil {
			log.Printf("WARN: expire trash %s: %v", it.ID, rerr)
			kept = append(kept, it)
			continue
		}
		sum.Removed++
		sum.Bytes += size
	}
	if sum.Removed == 0 {
		return sum, nil
	}
	if err := r.saveTrash(kept); err != nil {
		return sum, err
	}
	log.Printf("trash expired: %d items, %d bytes released", sum.Removed, sum.Bytes)
	return sum, nil
}

// dropUserTrash 在硬删除账号时清掉其个人空间的回收站条目；
// 否则"删账号"只是把文件挪进 .trash，既不释放磁盘也仍然可被恢复。
func (r *Registry) dropUserTrash(name string) (int, int64, error) {
	r.trMu.Lock()
	defer r.trMu.Unlock()
	items, err := r.loadTrash()
	if err != nil {
		// 清单读不懂时不能继续：账号已经没了，覆盖清单会连别人的记录一起丢。
		return 0, 0, err
	}
	kept := []TrashItem{}
	count := 0
	var total int64
	for _, it := range items {
		if it.Source == "users" && localPartOfTrashPath(it.Path) == name {
			payload, perr := r.trashPayload(it.ID)
			if perr != nil {
				kept = append(kept, it)
				continue
			}
			_, size, rerr := removePayload(payload)
			if rerr != nil {
				kept = append(kept, it)
				log.Printf("WARN: drop account trash %s: %v", it.ID, rerr)
				continue
			}
			count++
			total += size
			continue
		}
		kept = append(kept, it)
	}
	if count == 0 {
		return 0, 0, nil
	}
	return count, total, r.saveTrash(kept)
}

func localPartOfTrashPath(rel string) string {
	if i := strings.Index(rel, "/"); i > 0 {
		return rel[:i]
	}
	return rel
}
