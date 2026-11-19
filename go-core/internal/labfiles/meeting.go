package labfiles

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// 组会汇报源（meeting）的目录结构：/srv/lab/meeting/<YYYY-Www>/…
//
// 每个周目录是一份独立的授权名单：名单由后端写进 ACL，名单之外的人
// 默认看不见这个周目录（含 lab-admin 之外的任何角色）。

// weekFolderRE 匹配周目录名 "2026-W48"。
var weekFolderRE = regexp.MustCompile(`^(\d{4})-W(\d{2})$`)

// ISOWeekFolder 返回某一天所在周的目录名，例如 "2026-W48"。
//
// 规则：周一为一周之始；**包含 1 月 1 日的那一周记作该年的第 1 周**。
// 因此 2026-12-31（周四）所在的一周是 2026-12-28 ~ 2027-01-03，目录名
// 为 "2027-W01"。这条规则与 ISO-8601 只在年末最后一周不同：ISO-8601
// 把同一周记作 "2026-W53"。
func ISOWeekFolder(t time.Time) string {
	year, week := weekOf(mondayOf(t))
	return fmt.Sprintf("%04d-W%02d", year, week)
}

// mondayOf 返回某一天所在周的周一（按传入时间的时区）。
func mondayOf(t time.Time) time.Time {
	d := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
	// time.Weekday 里周日是 0，周一是 1；这里换算成"周一为一周之始"。
	offset := (int(d.Weekday()) + 6) % 7
	return d.AddDate(0, 0, -offset)
}

// weekOf 计算某个周一所属的年与周序号。
//
// 横跨元旦的那一周归入新的一年（第 1 周）；其余周按"包含 1 月 1 日的那一周
// 为第 1 周"逐周计数。
func weekOf(monday time.Time) (int, int) {
	end := monday.AddDate(0, 0, 6)
	if end.Year() != monday.Year() {
		// 这一周跨年，它包含 end 所在年份的 1 月 1 日。
		return end.Year(), 1
	}
	year := monday.Year()
	anchor := mondayOf(time.Date(year, 1, 1, 0, 0, 0, 0, monday.Location()))
	return year, int(civilDay(monday)-civilDay(anchor))/7 + 1
}

// civilDay 返回日期的天序号（UTC 正午计，避免夏令时造成 23/25 小时的一天）。
func civilDay(t time.Time) int64 {
	return time.Date(t.Year(), t.Month(), t.Day(), 12, 0, 0, 0, time.UTC).Unix() / 86400
}

// parseWeekFolder 解析周目录名，返回可比较的序号（例如 2026-W48 → 202648）。
func parseWeekFolder(name string) (int, bool) {
	m := weekFolderRE.FindStringSubmatch(name)
	if m == nil {
		return 0, false
	}
	var year, week int
	if _, err := fmt.Sscanf(m[1], "%04d", &year); err != nil {
		return 0, false
	}
	if _, err := fmt.Sscanf(m[2], "%02d", &week); err != nil {
		return 0, false
	}
	if week < 1 || week > 53 {
		return 0, false
	}
	return year*100 + week, true
}

// EnsureMeetingFolder 确保 /srv/lab/meeting/<yearWeek> 存在，返回源内相对路径
// （即 "2026-W48"）。目录不存在时按需创建，因此第一次上传汇报不会因为源目录
// 缺失而失败。
func (r *Registry) EnsureMeetingFolder(yearWeek string) (string, error) {
	week, err := cleanWeekFolder(yearWeek)
	if err != nil {
		return "", err
	}
	full := filepath.Join(r.root, "meeting", week)
	if err := os.MkdirAll(full, 0o770); err != nil {
		return "", storageError("create meeting folder", err)
	}
	return week, nil
}

// cleanWeekFolder 校验并归一化一个周目录名。
func cleanWeekFolder(yearWeek string) (string, error) {
	yearWeek = strings.TrimSpace(yearWeek)
	if !weekFolderRE.MatchString(yearWeek) {
		return "", fmt.Errorf("%w: invalid meeting week folder", ErrInvalidPath)
	}
	return yearWeek, nil
}

// CompressOldMeetingFolders 把早于 keepWeeks 的周目录压成同名 .tar.gz 并删除
// 原目录，返回被压缩的目录名列表（已排序）。
//
// 保留策略：当前周以及最近 keepWeeks-1 周保持原样，更早的才压缩。
// 已经存在同名 .tar.gz 的目录会被跳过（不重复压缩，也不删除原目录）。
func (r *Registry) CompressOldMeetingFolders(keepWeeks int) ([]string, error) {
	base := filepath.Join(r.root, "meeting")
	items, err := os.ReadDir(base)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []string{}, nil
		}
		return nil, err
	}
	cur, ok := parseWeekFolder(ISOWeekFolder(time.Now()))
	if !ok {
		return []string{}, nil
	}
	cutoff := cur - keepWeeks
	if keepWeeks < 1 {
		// 保留 0 周时至少留下当前周，其余全部压缩。
		cutoff = cur - 1
	}
	compressed := []string{}
	for _, item := range items {
		if !item.IsDir() {
			continue
		}
		number, ok := parseWeekFolder(item.Name())
		if !ok || number > cutoff {
			continue
		}
		dir := filepath.Join(base, item.Name())
		archive := dir + ".tar.gz"
		if _, err := os.Stat(archive); err == nil {
			// 已经压过：跳过，不覆盖既有压缩包，也不动原目录。
			continue
		}
		if err := compressFolder(dir, archive); err != nil {
			return compressed, err
		}
		if err := os.RemoveAll(dir); err != nil {
			return compressed, err
		}
		compressed = append(compressed, item.Name())
	}
	sort.Strings(compressed)
	return compressed, nil
}

// compressFolder 把一个目录打包成 tar.gz。成员名带目录名前缀，解压后仍是
// 原来的目录结构。符号链接与其它特殊文件跳过。
func compressFolder(dir, archivePath string) error {
	f, err := os.Create(archivePath)
	if err != nil {
		return err
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	base := filepath.Dir(dir)
	walkErr := filepath.Walk(dir, func(p string, info fs.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !info.Mode().IsRegular() {
			return nil
		}
		rel, rerr := filepath.Rel(base, p)
		if rerr != nil {
			return rerr
		}
		header, herr := tar.FileInfoHeader(info, "")
		if herr != nil {
			return herr
		}
		header.Name = filepath.ToSlash(rel)
		header.Uid, header.Gid = 0, 0
		header.Uname, header.Gname = "", ""
		if err := tw.WriteHeader(header); err != nil {
			return err
		}
		src, oerr := os.Open(p)
		if oerr != nil {
			return oerr
		}
		_, cerr := io.Copy(tw, src)
		src.Close()
		return cerr
	})
	closeErr := tw.Close()
	gzErr := gz.Close()
	fileErr := f.Close()
	if walkErr != nil {
		os.Remove(archivePath)
		return walkErr
	}
	if closeErr != nil {
		os.Remove(archivePath)
		return closeErr
	}
	if gzErr != nil {
		os.Remove(archivePath)
		return gzErr
	}
	return fileErr
}

// SetMeetingAccess 写入某个周目录的授权名单，并确保该周目录存在。
//
// 名单是"替换"语义：不在名单里的人立即失去该周的访问权。组会汇报默认
// 没有组授权，因此名单之外的人看不到任何周目录。
func (r *Registry) SetMeetingAccess(yearWeek string, people []string) ([]string, error) {
	week, err := cleanWeekFolder(yearWeek)
	if err != nil {
		return nil, err
	}
	if _, err := r.EnsureMeetingFolder(week); err != nil {
		return nil, err
	}
	names := []string{}
	seen := map[string]bool{}
	for _, person := range people {
		person = strings.ToLower(strings.TrimSpace(person))
		if person == "" || seen[person] {
			continue
		}
		seen[person] = true
		names = append(names, person)
	}
	sort.Strings(names)

	grant := Scope{Source: "meeting", Path: week, View: true, Download: true, Create: true, Modify: true}
	r.mu.Lock()
	previous := map[string][]Scope{}
	for key, scopes := range r.acl.Identities {
		previous[key] = append([]Scope(nil), scopes...)
	}
	// 先整体撤销该周的旧名单，再写入新名单。
	for key, scopes := range r.acl.Identities {
		kept := make([]Scope, 0, len(scopes))
		for _, s := range scopes {
			if s.Source == "meeting" && s.Path == week {
				continue
			}
			kept = append(kept, s)
		}
		r.acl.Identities[key] = kept
	}
	for _, name := range names {
		for _, key := range r.aclKeysFor(name) {
			r.acl.Identities[key] = mergeScope(r.acl.Identities[key], grant)
		}
	}
	if err := r.persistACLLocked(); err != nil {
		r.acl.Identities = previous
		r.mu.Unlock()
		return nil, err
	}
	r.mu.Unlock()
	return names, nil
}
