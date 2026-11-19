package labfiles

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// MaxEditBytes bounds one inline text edit (1 MiB).
const MaxEditBytes = 1 << 20

// editableExtensions 是允许在线编辑的文本扩展名白名单。
//
// 名单只收"纯文本"格式：序列化的二进制（fasta/fastq 之类）走原有的上传
// 流程，在线编辑器写它们只会制造看不见的损坏。
var editableExtensions = map[string]bool{
	"txt": true, "md": true, "csv": true, "tsv": true, "json": true,
	"yaml": true, "yml": true, "tex": true, "bib": true, "py": true,
	"js": true, "ts": true, "tsx": true, "sh": true, "conf": true,
	"ini": true, "toml": true, "log": true,
}

// Editable reports whether a file name may be edited online.
func Editable(name string) bool {
	ext := strings.TrimPrefix(strings.ToLower(path.Ext(name)), ".")
	return editableExtensions[ext]
}

// ContentETag returns the content hash used for optimistic concurrency:
// the first 16 bytes of the sha256 digest, hex encoded.
func ContentETag(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:16])
}

// ErrConflict reports that the file changed since the caller read it.
var ErrConflict = errors.New("content changed since it was read")

// ConflictError carries the current etag of the file, so the caller can
// re-read it instead of overwriting somebody else's edit.
type ConflictError struct {
	Current string
}

func (e *ConflictError) Error() string { return ErrConflict.Error() }

// Unwrap lets errors.Is(err, ErrConflict) succeed.
func (e *ConflictError) Unwrap() error { return ErrConflict }

// ReadContent returns the text of an editable file plus its etag.
func (r *Registry) ReadContent(e Entry) (string, string, error) {
	if e.Dir {
		return "", "", fmt.Errorf("%w: cannot edit a directory", ErrInvalidPath)
	}
	if !Editable(e.Name) {
		return "", "", fmt.Errorf("%w: only text files can be edited online", ErrInvalidPath)
	}
	full, err := r.resolve(e)
	if err != nil {
		return "", "", ErrNotFound
	}
	info, err := os.Stat(full)
	if err != nil {
		return "", "", ErrNotFound
	}
	if info.Size() > MaxEditBytes {
		return "", "", ErrTooLarge
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return "", "", ErrNotFound
	}
	return string(data), ContentETag(data), nil
}

// WriteContent replaces the text of an editable file.
//
// The caller needs modify permission on the path. When etag is not empty it
// must match the current content hash, otherwise the write is refused with a
// ConflictError carrying the current etag: two people editing the same file
// must not silently overwrite each other.
func (r *Registry) WriteContent(identity Identity, e Entry, text, etag string) (Entry, string, error) {
	if e.Dir {
		return Entry{}, "", fmt.Errorf("%w: cannot edit a directory", ErrInvalidPath)
	}
	if !Editable(e.Name) {
		return Entry{}, "", fmt.Errorf("%w: only text files can be edited online", ErrInvalidPath)
	}
	if len(text) > MaxEditBytes {
		return Entry{}, "", ErrTooLarge
	}
	if !r.CanPath(identity, e.Source, e.Path, "modify") {
		return Entry{}, "", ErrForbidden
	}
	full, err := r.resolve(e)
	if err != nil {
		return Entry{}, "", ErrNotFound
	}
	current, err := os.ReadFile(full)
	if err != nil {
		return Entry{}, "", ErrNotFound
	}
	currentETag := ContentETag(current)
	if etag != "" && etag != currentETag {
		return Entry{}, currentETag, &ConflictError{Current: currentETag}
	}

	dir := filepath.Dir(full)
	tmp, err := os.CreateTemp(dir, ".edit-*")
	if err != nil {
		return Entry{}, "", storageError("open edit staging directory", err)
	}
	tmpName := tmp.Name()
	fail := func(err error) (Entry, string, error) {
		tmp.Close()
		os.Remove(tmpName)
		return Entry{}, "", err
	}
	if _, err := tmp.WriteString(text); err != nil {
		return fail(storageError("write staged content", err))
	}
	if err := tmp.Chmod(0o640); err != nil {
		return fail(storageError("chmod staged content", err))
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return Entry{}, "", storageError("close staged content", err)
	}
	if err := os.Rename(tmpName, full); err != nil {
		os.Remove(tmpName)
		return Entry{}, "", storageError("commit edited content", err)
	}
	if err := r.Scan(); err != nil {
		return Entry{}, "", err
	}
	newETag := ContentETag([]byte(text))
	entry, ok := r.lookup(e.Source, e.Path)
	if !ok {
		return Entry{}, newETag, ErrNotFound
	}
	return entry, newETag, nil
}
