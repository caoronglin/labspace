package httpapi

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"labspace.local/go-core/internal/fileaudit"
	"labspace.local/go-core/internal/labfiles"
	"labspace.local/go-core/internal/preview"
)

// serveFiles exposes the lab file tree with native read and write operations.
// Every request is authorised against the source scopes before any content or
// metadata leaves the service, and writes are checked again at the target path.
func (s *Server) serveFiles(w http.ResponseWriter, r *http.Request, a actor, q url.Values) {
	if s.Files == nil {
		deny(w, 503, "file registry unavailable")
		return
	}
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/files"), "/")
	identity := a.fileIdentity()
	writable := a.UserID != "" && a.UserID != "service"

	switch r.Method {
	case http.MethodPost:
		if !writable || identity.Email == "" {
			deny(w, 403, "file writes require a user identity")
			return
		}
		switch rest {
		case "upload":
			s.uploadFile(w, r, identity, q)
		case "mkdir":
			s.mkdirFile(w, r, identity)
		case "ensure-meeting-folder":
			s.ensureMeetingFolder(w, r, identity)
		case "rename":
			s.renameFile(w, r, identity)
		case "move":
			s.moveFile(w, r, identity)
		case "copy":
			s.copyFile(w, r, identity)
		case "trash/restore":
			s.restoreTrash(w, r, identity)
		case "shares":
			s.sharePersonal(w, r, identity)
		default:
			deny(w, 404, "route not found")
		}
		return
	case http.MethodPut:
		if !writable || identity.Email == "" {
			deny(w, 403, "file writes require a user identity")
			return
		}
		s.updateFileContent(w, r, identity, rest)
		return
	case http.MethodDelete:
		if !writable || identity.Email == "" {
			deny(w, 403, "file writes require a user identity")
			return
		}
		// 回收站操作必须在"条目 id"分支之前处理：DELETE /files/trash 会被
		// 当成一个叫 trash 的条目，语义完全跑偏。
		if rest == "trash" {
			sum, err := s.Files.Empty(identity)
			if err != nil {
				fileError(w, err)
				return
			}
			jsonResponse(w, 200, map[string]any{"ok": true, "summary": sum})
			return
		}
		if itemID, ok := strings.CutPrefix(rest, "trash/"); ok && itemID != "" && !strings.Contains(itemID, "/") {
			sum, err := s.Files.Purge(identity, itemID)
			if err != nil {
				fileError(w, err)
				return
			}
			jsonResponse(w, 200, map[string]any{"ok": true, "summary": sum})
			return
		}
		if rest == "" || strings.Contains(rest, "/") {
			deny(w, 400, "a file id is required")
			return
		}
		// ?permanent=1：直接删除，不进回收站（不可恢复）。
		// 用于"确定不要了"的场景：误传大文件、涉密材料、批量清理。
		if q.Get("permanent") == "1" || q.Get("permanent") == "true" {
			item, err := s.Files.Destroy(identity, rest)
			if err != nil {
				fileError(w, err)
				return
			}
			jsonResponse(w, 200, map[string]any{"ok": true, "destroyed": item})
			return
		}
		item, err := s.Files.Trash(identity, rest)
		if err != nil {
			fileError(w, err)
			return
		}
		jsonResponse(w, 200, map[string]any{"ok": true, "trash": item})
		return
	case http.MethodGet, http.MethodHead:
		// continue below
	default:
		deny(w, 405, "method not allowed")
		return
	}

	if rest == "sources" {
		out := []map[string]any{}
		scopes := s.Files.Scopes(identity)
		for _, src := range labfiles.Sources() {
			root, ok := s.Files.SourceRoot(src.ID)
			listable := ok && s.Files.Can(identity, root, "list")
			if !listable {
				// Per-user scopes (users/<name>, projects/<project>) do not grant
				// a source-wide path, but the source is still browsable: Visible
				// filters each entry against the caller's own scopes.
				for _, sc := range scopes {
					if sc.Source == src.ID && sc.View {
						listable = true
						break
					}
				}
			}
			out = append(out, map[string]any{
				"id": src.ID, "label": src.Label, "shared": src.Shared,
				"listable": listable, "writable": s.Files.Writable(identity, src.ID),
				"writePaths": s.Files.WritePaths(identity, src.ID),
				// 「能传文件」与「能建目录」分开报：学生在共享目录里只准上传，
				// 界面据此把「新建文件夹」藏起来（否则点了就是 403）。
				"mkdirPaths": s.Files.MkdirPaths(identity, src.ID),
			})
		}
		jsonResponse(w, 200, map[string]any{"sources": out})
		return
	}

	if rest == "shares" {
		owner := identity.LocalPart()
		if owner == "" {
			deny(w, 403, "shares require a user identity")
			return
		}
		jsonResponse(w, 200, map[string]any{
			"owner":      owner,
			"shares":     s.Files.PersonalShares(owner),
			"sharedWith": s.Files.SharedWith(identity),
			"recipients": s.Files.ShareRecipients(owner),
		})
		return
	}

	if rest == "access-log" {
		if !a.Admin {
			deny(w, 403, "access log requires an administrator")
			return
		}
		if s.FileAudit == nil {
			deny(w, 503, "file audit unavailable")
			return
		}
		limit := 50
		if n, err := strconv.Atoi(q.Get("limit")); err == nil {
			limit = n
		}
		action := strings.ToLower(strings.TrimSpace(q.Get("action")))
		events, err := s.FileAudit.List(r.Context(), strings.TrimSpace(q.Get("user")), action, limit)
		if err != nil {
			log.Printf("file audit list: %v", err)
			deny(w, 500, "access log unavailable")
			return
		}
		jsonResponse(w, 200, map[string]any{
			"events":        events,
			"count":         len(events),
			"retentionDays": 7,
		})
		return
	}

	// 批量下载在写出任何字节之前完成权限与配额校验，避免响应开始后才发现
	// 某个条目不可读，只能给用户一个半截压缩包。
	if rest == "archive" {
		s.downloadArchive(w, r, a, identity, q)
		return
	}

	if rest == "trash" {
		items, err := s.Files.ListTrash(identity)
		if err != nil {
			fileError(w, err)
			return
		}
		var total int64
		paths := 0
		for _, it := range items {
			total += it.Size
			paths += it.Paths
		}
		jsonResponse(w, 200, map[string]any{
			"items":         items,
			"count":         len(items),
			"paths":         paths,
			"totalBytes":    total,
			"retentionDays": labfiles.TrashRetentionDays(),
		})
		return
	}

	if rest == "" {
		source := q.Get("source")
		if source == "" {
			deny(w, 400, "source query parameter is required")
			return
		}
		known := false
		for _, src := range labfiles.Sources() {
			if src.ID == source {
				known = true
				break
			}
		}
		if !known {
			deny(w, 400, "unknown source")
			return
		}
		sortKey := strings.ToLower(strings.TrimSpace(q.Get("sort")))
		order := "asc"
		if strings.EqualFold(q.Get("order"), "desc") {
			order = "desc"
		}
		entries := s.Files.VisibleSorted(identity, source, sortKey, order == "desc")
		resp := map[string]any{
			"source":  source,
			"entries": entries,
			"count":   len(entries),
			"root":    s.Files.Root(),
			"sort":    sortKey,
			"order":   order,
			"usage":   s.Files.Usage(identity, source),
			// 移动目标选择器需要一份可读目录清单：只返回调用方有权读取的目录，
			// 不在前端做权限推断，也不额外暴露无权目录的存在。
			"dirs": s.Files.VisibleDirs(identity, source),
		}
		if source == "users" {
			home := identity.LocalPart()
			resp["home"] = home
			resp["sharedWith"] = s.Files.SharedWith(identity)
			resp["shares"] = s.Files.PersonalShares(home)
		}
		jsonResponse(w, 200, resp)
		return
	}

	parts := strings.Split(rest, "/")
	entry, ok := s.Files.Get(parts[0])
	if !ok {
		deny(w, 404, "resource not found")
		return
	}
	// A resource the caller may not see must not even be announced.
	if !s.Files.Can(identity, entry, "read") {
		deny(w, 404, "resource not found")
		return
	}

	switch {
	case len(parts) == 1:
		jsonResponse(w, 200, entry)
	case len(parts) == 2 && parts[1] == "preview":
		if entry.Dir {
			deny(w, 400, "cannot preview a directory")
			return
		}
		if !s.Files.Can(identity, entry, "preview") {
			deny(w, 404, "resource not found")
			return
		}
		data, err := s.Files.Read(entry, labfiles.MaxPreviewBytes)
		if err != nil {
			deny(w, previewErrorCode(err), "preview input unavailable")
			return
		}
		result, e := preview.Render(entry.Name, data)
		if e != nil {
			deny(w, 400, "invalid or oversized preview input")
			return
		}
		if tikaEligible(result.Kind, entry.Name) {
			endpoint := os.Getenv("LABGO_TIKA_URL")
			if endpoint == "" {
				endpoint = "http://127.0.0.1:9998"
			}
			if extracted, terr := preview.TikaText(entry.Name, data, endpoint); terr == nil {
				result = extracted
			}
		}
		s.recordFileEvent(a, entry, "preview", int64(len(data)))
		jsonResponse(w, 200, result)
	case len(parts) == 2 && parts[1] == "content":
		s.readFileContent(w, identity, entry)
	case len(parts) == 2 && parts[1] == "download":
		if entry.Dir {
			deny(w, 400, "cannot download a directory")
			return
		}
		if !s.Files.Can(identity, entry, "download") {
			deny(w, 404, "resource not found")
			return
		}
		f, err := s.Files.Open(entry)
		if err != nil {
			deny(w, 404, "resource not found")
			return
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			deny(w, 404, "resource not found")
			return
		}
		w.Header().Set("Content-Disposition", contentDisposition(entry.Name))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		s.recordFileEvent(a, entry, "download", info.Size())
		http.ServeContent(w, r, entry.Name, info.ModTime(), f)
	default:
		deny(w, 404, "route not found")
	}
}

// fileContent 是在线编辑接口的载荷：文本内容与内容哈希（etag）。
type fileContent struct {
	Text string `json:"text"`
	ETag string `json:"etag"`
}

// decodeContentBody 读取在线编辑的请求体。上限比普通 JSON 宽：文本内容
// 本身可达 1 MiB（见 labfiles.MaxEditBytes）。
func decodeContentBody(r *http.Request, v any) bool {
	dec := json.NewDecoder(io.LimitReader(r.Body, labfiles.MaxEditBytes+(64<<10)))
	dec.DisallowUnknownFields()
	return dec.Decode(v) == nil
}

// readFileContent 返回一个可在线编辑文件的文本内容与 etag。
// 读取权限由调用方（条目分发处）已经复核过的 read 判定保证。
func (s *Server) readFileContent(w http.ResponseWriter, identity labfiles.Identity, entry labfiles.Entry) {
	if !labfiles.Editable(entry.Name) {
		deny(w, 400, "only text files can be edited online")
		return
	}
	text, etag, err := s.Files.ReadContent(entry)
	if err != nil {
		fileError(w, err)
		return
	}
	jsonResponse(w, 200, fileContent{Text: text, ETag: etag})
}

// updateFileContent 在线编辑一个文本文件。
//
// 并发保护：请求带 etag（调用方读到的内容哈希）。与当前文件不一致时返回
// 409 并附上当前 etag，避免两个人同时编辑时互相覆盖。
func (s *Server) updateFileContent(w http.ResponseWriter, r *http.Request, identity labfiles.Identity, rest string) {
	parts := strings.Split(rest, "/")
	if len(parts) != 2 || parts[1] != "content" || parts[0] == "" {
		deny(w, 404, "route not found")
		return
	}
	entry, ok := s.Files.Get(parts[0])
	if !ok {
		deny(w, 404, "resource not found")
		return
	}
	// 看不到的资源连存在都不该泄露：先按 read 判定，无权读的一律 404。
	if !s.Files.Can(identity, entry, "read") {
		deny(w, 404, "resource not found")
		return
	}
	if entry.Dir {
		deny(w, 400, "cannot edit a directory")
		return
	}
	if !labfiles.Editable(entry.Name) {
		deny(w, 400, "only text files can be edited online")
		return
	}
	var req struct {
		Text string `json:"text"`
		ETag string `json:"etag"`
	}
	if !decodeContentBody(r, &req) {
		deny(w, 400, "invalid content request")
		return
	}
	if len(req.Text) > labfiles.MaxEditBytes {
		deny(w, 413, "text exceeds the 1 MiB limit")
		return
	}
	entry, etag, err := s.Files.WriteContent(identity, entry, req.Text, req.ETag)
	if err != nil {
		var conflict *labfiles.ConflictError
		if errors.As(err, &conflict) {
			// 把当前 etag 一并返回：调用方重新拉取内容后可以继续编辑。
			jsonResponse(w, 409, map[string]any{
				"error": "content changed since it was read",
				"etag":  conflict.Current,
			})
			return
		}
		fileError(w, err)
		return
	}
	jsonResponse(w, 200, map[string]any{"entry": entry, "etag": etag})
}

// recordFileEvent appends one preview/download event without delaying the
// response. The request context dies with the response, so the insert gets its
// own short-lived context; audit failures only log and never fail the read.
func (s *Server) recordFileEvent(a actor, entry labfiles.Entry, action string, size int64) {
	if s.FileAudit == nil || a.Email == "" {
		return
	}
	ev := fileaudit.Event{
		UserID: a.Email, Source: entry.Source, Path: entry.Path, Name: entry.Name,
		Action: action, Bytes: size, Status: 200,
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := s.FileAudit.Record(ctx, ev); err != nil {
			log.Printf("file audit: %v", err)
		}
	}()
}

// tikaEligible limits the fallback to document formats whose text extraction
// is useful and safe; bioinformatics binaries keep their explicit notice.
func tikaEligible(kind, name string) bool {
	if kind != "requires-worker" && kind != "unsupported" {
		return false
	}
	switch strings.ToLower(path.Ext(name)) {
	case ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
		".odt", ".ods", ".odp", ".rtf", ".epub", ".html", ".htm":
		return true
	}
	return false
}

func fileError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, labfiles.ErrStorage):
		// 存储层拒绝写入不是权限策略问题，必须记下来并与 403 区分，
		// 否则界面只会显示一个裸状态码，谁也看不出是目录不可写。
		log.Printf("file storage error: %v", err)
		deny(w, 500, "storage rejected the write; check directory permissions")
	case errors.Is(err, labfiles.ErrForbidden):
		deny(w, 403, "permission denied")
	case errors.Is(err, labfiles.ErrExists):
		deny(w, 409, "resource already exists")
	case errors.Is(err, labfiles.ErrInvalidPath):
		deny(w, 400, "invalid path or name")
	case errors.Is(err, labfiles.ErrNotFound):
		deny(w, 404, "resource not found")
	case errors.Is(err, labfiles.ErrTooLarge):
		deny(w, 413, "upload exceeds the size limit")
	case errors.Is(err, labfiles.ErrConflict):
		deny(w, 409, "content changed since it was read")
	default:
		deny(w, 400, "file operation failed")
	}
}

// fileErrorText renders one move failure inside a batch response without
// aborting the whole request: the caller keeps the succeeded entries and gets
// a per-id reason for the rejected ones.
func fileErrorText(err error) string {
	switch {
	case errors.Is(err, labfiles.ErrForbidden):
		return "permission denied"
	case errors.Is(err, labfiles.ErrExists):
		return "resource already exists"
	case errors.Is(err, labfiles.ErrInvalidPath):
		return "invalid path or name"
	case errors.Is(err, labfiles.ErrNotFound):
		return "resource not found"
	case errors.Is(err, labfiles.ErrTooLarge):
		return "upload exceeds the size limit"
	case errors.Is(err, labfiles.ErrStorage):
		return "storage rejected the write"
	default:
		return "file operation failed"
	}
}

func decodeFileBody(r *http.Request, v any) bool {
	dec := json.NewDecoder(io.LimitReader(r.Body, 64<<10))
	dec.DisallowUnknownFields()
	return dec.Decode(v) == nil
}

func (s *Server) uploadFile(w http.ResponseWriter, r *http.Request, identity labfiles.Identity, q url.Values) {
	source := q.Get("source")
	if source == "" {
		deny(w, 400, "source is required")
		return
	}
	dir := q.Get("dir")
	overwrite := q.Get("overwrite") == "1" || q.Get("overwrite") == "true"
	mr, err := r.MultipartReader()
	if err != nil {
		deny(w, 400, "multipart form required")
		return
	}
	for {
		part, perr := mr.NextPart()
		if errors.Is(perr, io.EOF) {
			break
		}
		if perr != nil {
			deny(w, 400, "invalid upload")
			return
		}
		if part.FormName() != "file" {
			part.Close()
			continue
		}
		rawName := strings.ReplaceAll(part.FileName(), `\`, "/")
		name := path.Base(rawName)
		if name == "" || name == "." || name == "/" {
			part.Close()
			deny(w, 400, "invalid file name")
			return
		}
		entry, werr := s.Files.WriteFile(identity, source, dir, name, part, overwrite)
		part.Close()
		if werr != nil {
			fileError(w, werr)
			return
		}
		jsonResponse(w, 200, map[string]any{"entry": entry})
		return
	}
	deny(w, 400, "file field is required")
}

// ensureMeetingFolder 确保组会汇报的周目录存在（ISO 周目录）。
//
// 组会目录的授权是**目录级**的：文件核心写 ACL 时要求目标目录已经存在，
// 否则会报 "unknown directory"。因此授权之前必须先把目录建出来。
// 教师与管理员都能建；普通成员不行（他们只是被授权访问既有目录）。
func (s *Server) ensureMeetingFolder(w http.ResponseWriter, r *http.Request, identity labfiles.Identity) {
	var req struct {
		YearWeek string `json:"yearWeek"`
	}
	if !decodeFileBody(r, &req) || req.YearWeek == "" {
		deny(w, 400, "yearWeek is required")
		return
	}
	if !identity.Teacher && !identity.Admin {
		deny(w, 403, "only teachers may create meeting folders")
		return
	}
	path, err := s.Files.EnsureMeetingFolder(req.YearWeek)
	if err != nil {
		fileError(w, err)
		return
	}
	jsonResponse(w, 200, map[string]any{"ok": true, "path": path})
}

func (s *Server) mkdirFile(w http.ResponseWriter, r *http.Request, identity labfiles.Identity) {
	var req struct {
		Source string `json:"source"`
		Path   string `json:"path"`
	}
	if !decodeFileBody(r, &req) || req.Source == "" || req.Path == "" {
		deny(w, 400, "source and path are required")
		return
	}
	entry, err := s.Files.CreateDir(identity, req.Source, req.Path)
	if err != nil {
		fileError(w, err)
		return
	}
	jsonResponse(w, 200, map[string]any{"entry": entry})
}

func (s *Server) renameFile(w http.ResponseWriter, r *http.Request, identity labfiles.Identity) {
	var req struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if !decodeFileBody(r, &req) || req.ID == "" || req.Name == "" {
		deny(w, 400, "id and name are required")
		return
	}
	entry, err := s.Files.Rename(identity, req.ID, req.Name)
	if err != nil {
		fileError(w, err)
		return
	}
	jsonResponse(w, 200, map[string]any{"entry": entry})
}

// copyFile duplicates one entry into another directory of the same source.
// name is optional; when omitted the original name is reused.
func (s *Server) copyFile(w http.ResponseWriter, r *http.Request, identity labfiles.Identity) {
	var req struct {
		ID     string `json:"id"`
		Target string `json:"target"`
		Name   string `json:"name"`
	}
	if !decodeFileBody(r, &req) || req.ID == "" {
		deny(w, 400, "id is required")
		return
	}
	entry, err := s.Files.Copy(identity, req.ID, req.Target, req.Name)
	if err != nil {
		fileError(w, err)
		return
	}
	jsonResponse(w, 200, map[string]any{"entry": entry})
}

// moveFile relocates one entry into another directory of the same source.
// The destination is a source-relative path; "" means the source root.
func (s *Server) moveFile(w http.ResponseWriter, r *http.Request, identity labfiles.Identity) {
	var req struct {
		ID      string `json:"id"`
		Target  string `json:"target"`
		Entries []struct {
			ID string `json:"id"`
		} `json:"entries"`
	}
	if !decodeFileBody(r, &req) {
		deny(w, 400, "invalid move request")
		return
	}
	ids := []string{}
	if req.ID != "" {
		ids = append(ids, req.ID)
	}
	for _, e := range req.Entries {
		if e.ID != "" {
			ids = append(ids, e.ID)
		}
	}
	if len(ids) == 0 {
		deny(w, 400, "at least one entry id is required")
		return
	}
	if len(ids) > 200 {
		deny(w, 400, "too many entries in one move")
		return
	}
	moved := make([]labfiles.Entry, 0, len(ids))
	failed := make([]map[string]string, 0)
	var firstErr error
	for _, id := range ids {
		entry, err := s.Files.Move(identity, id, req.Target)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			failed = append(failed, map[string]string{"id": id, "error": fileErrorText(err)})
			continue
		}
		moved = append(moved, entry)
	}
	if len(moved) == 0 && firstErr != nil {
		fileError(w, firstErr)
		return
	}
	jsonResponse(w, 200, map[string]any{"moved": moved, "failed": failed})
}

func (s *Server) restoreTrash(w http.ResponseWriter, r *http.Request, identity labfiles.Identity) {
	var req struct {
		ID string `json:"id"`
	}
	if !decodeFileBody(r, &req) || req.ID == "" {
		deny(w, 400, "trash id is required")
		return
	}
	entry, err := s.Files.Restore(identity, req.ID)
	if err != nil {
		fileError(w, err)
		return
	}
	jsonResponse(w, 200, map[string]any{"ok": true, "entry": entry})
}

// sharePersonal replaces the reader list of one path inside the caller's own
// personal space. The owner always comes from the session, never from the body.
// writable is optional and defaults to false: sharing stays read-only unless
// the owner explicitly grants edit rights.
func (s *Server) sharePersonal(w http.ResponseWriter, r *http.Request, identity labfiles.Identity) {
	var req struct {
		Path       string   `json:"path"`
		Recipients []string `json:"recipients"`
		Writable   bool     `json:"writable"`
	}
	if !decodeFileBody(r, &req) || strings.TrimSpace(req.Path) == "" {
		deny(w, 400, "path is required")
		return
	}
	share, err := s.Files.SetPersonalShare(identity, req.Path, req.Recipients, req.Writable)
	if err != nil {
		fileError(w, err)
		return
	}
	jsonResponse(w, 200, map[string]any{"ok": true, "share": share})
}

// maxArchiveFiles/maxArchiveBytes bound one multi-file download. The caller
// gets an explicit 413 before the response starts rather than a truncated zip.
const (
	maxArchiveFiles = 2000
	maxArchiveBytes = int64(1 << 30)
)

// downloadArchive streams selected files (and the contents of selected
// directories) as one zip. Every entry is authorised individually; entries the
// caller cannot download are silently omitted, and a selection with nothing
// left is reported as 404 instead of an empty archive.
func (s *Server) downloadArchive(w http.ResponseWriter, r *http.Request, a actor, identity labfiles.Identity, q url.Values) {
	if r.Method != http.MethodGet {
		deny(w, 405, "method not allowed")
		return
	}
	raw := strings.TrimSpace(q.Get("ids"))
	if raw == "" {
		deny(w, 400, "at least one file id is required")
		return
	}
	picks := strings.Split(raw, ",")
	if len(picks) > 500 {
		deny(w, 400, "too many selected entries")
		return
	}

	seen := map[string]bool{}
	byID := map[string]labfiles.Entry{}
	for _, id := range picks {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		entry, ok := s.Files.Get(id)
		if !ok || !s.Files.Can(identity, entry, "read") {
			deny(w, 404, "resource not found")
			return
		}
		collectible := []labfiles.Entry{entry}
		if entry.Dir {
			collectible = nil
			prefix := entry.Path + "/"
			for _, child := range s.Files.Visible(identity, entry.Source) {
				if !child.Dir && strings.HasPrefix(child.Path, prefix) {
					collectible = append(collectible, child)
				}
			}
		}
		for _, item := range collectible {
			if s.Files.Can(identity, item, "download") {
				byID[item.ID] = item
			}
		}
	}

	files := make([]labfiles.Entry, 0, len(byID))
	var total int64
	for _, entry := range byID {
		files = append(files, entry)
		total += entry.Size
	}
	if len(files) == 0 {
		deny(w, 404, "no downloadable files in the selection")
		return
	}
	if len(files) > maxArchiveFiles || total > maxArchiveBytes {
		deny(w, 413, "selection exceeds the archive limit")
		return
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })

	base := commonDirOf(files)
	// 跨文件源选择时路径可能同名（如两个源下的 readme.md），用源 ID 前缀
	// 保证 zip 成员名唯一。
	sources := map[string]bool{}
	for _, entry := range files {
		sources[entry.Source] = true
	}
	multiSource := len(sources) > 1
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Disposition", contentDisposition("lab-files-"+time.Now().Format("20060102-150405")+".zip"))

	zw := zip.NewWriter(w)
	for _, entry := range files {
		name := entry.Path
		switch {
		case multiSource:
			name = entry.Source + "/" + entry.Path
		case base != "":
			name = strings.TrimPrefix(name, base+"/")
		}
		header := &zip.FileHeader{Name: name, Method: zip.Deflate}
		if t, err := time.Parse(time.RFC3339, entry.Modified); err == nil {
			header.Modified = t
		}
		dst, err := zw.CreateHeader(header)
		if err != nil {
			log.Printf("archive create %s: %v", entry.Path, err)
			return
		}
		src, err := s.Files.Open(entry)
		if err != nil {
			log.Printf("archive open %s: %v", entry.Path, err)
			return
		}
		n, err := io.Copy(dst, src)
		src.Close()
		if err != nil {
			log.Printf("archive copy %s: %v", entry.Path, err)
			return
		}
		s.recordFileEvent(a, entry, "download", n)
	}
	if err := zw.Close(); err != nil {
		log.Printf("archive close: %v", err)
	}
}

// commonDirOf strips the shared directory prefix so a single folder download
// does not repeat public/<group>/<course>/... in every zip member name.
func commonDirOf(entries []labfiles.Entry) string {
	if len(entries) == 0 {
		return ""
	}
	dirOf := func(p string) []string {
		d := path.Dir(p)
		if d == "." || d == "/" {
			return nil
		}
		return strings.Split(d, "/")
	}
	parts := dirOf(entries[0].Path)
	for _, entry := range entries[1:] {
		other := dirOf(entry.Path)
		i := 0
		for i < len(parts) && i < len(other) && parts[i] == other[i] {
			i++
		}
		parts = parts[:i]
		if len(parts) == 0 {
			return ""
		}
	}
	return strings.Join(parts, "/")
}

func previewErrorCode(err error) int {
	if strings.Contains(err.Error(), "exceeds") {
		return 413
	}
	return 404
}

func contentDisposition(name string) string {
	safe := strings.ReplaceAll(name, `"`, "")
	safe = strings.ReplaceAll(safe, "\n", "")
	safe = strings.ReplaceAll(safe, "\r", "")
	return `attachment; filename="` + safe + `"; filename*=UTF-8''` + url.PathEscape(name)
}
