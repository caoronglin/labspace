package labfiles

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ACL 巡检：把「配置里写着、但现实中已经不成立」的授权找出来。
//
// 为什么需要它：ACL 是 JSON 文件，账号删了、目录改名了、组调整了，条目都还留在
// 里面。这类残留平时不疼，出事时最难查 —— 一个已删账号的授权，会让「这个人
// 明明删了还能访问」变成灵异事件。巡检把三类可判定的异常变成一份清单：
//
//  1. orphan_identity —— 授权对象是已不存在的账号（家目录没了）；
//  2. dangling_scope  —— 指向不存在目录的授权（目录被删/改名）；
//  3. group_scope_too_broad —— 非教师组对 research/meeting 拥有写权限
//     （课题资料与组会汇报的写权限只该给教师组，否则谁都能改别人的材料）。
type AuditFinding struct {
	Kind     string `json:"kind"`
	Identity string `json:"identity,omitempty"`
	Group    string `json:"group,omitempty"`
	Source   string `json:"source,omitempty"`
	Path     string `json:"path,omitempty"`
	Detail   string `json:"detail"`
}

// AuditReport 是一次巡检的结果。Counts 用整数而不是「全量条目回传」：
// 巡检面向的是「有没有异常」，不是把整份 ACL 再抄一遍。
type AuditReport struct {
	Identities int            `json:"identities"`
	Groups     int            `json:"groups"`
	Findings   []AuditFinding `json:"findings"`
	CheckedAt  time.Time      `json:"checkedAt"`
}

// HasFindings 便于调用方与测试快速判断。
func (r AuditReport) HasFindings() bool { return len(r.Findings) > 0 }

// teacherGroups 是「本来就该看到课题/组会目录」的组。
// 直授（identities）里出现这些目录而该用户又不属于这些组，才值得报出来。
var teacherGroups = []string{"lab-teacher", "lab-admin", "lab-superadmin"}

func isTeacherGroup(name string) bool {
	for _, g := range teacherGroups {
		if strings.EqualFold(g, name) {
			return true
		}
	}
	return false
}

// AuditACL 扫一遍当前 ACL 与磁盘，返回可判定的异常。只读、不修改任何东西。
func (r *Registry) AuditACL() AuditReport {
	r.mu.RLock()
	acl := r.acl
	r.mu.RUnlock()

	report := AuditReport{
		Identities: len(acl.Identities),
		Groups:     len(acl.Groups),
		CheckedAt:  time.Now().UTC(),
	}

	names := make([]string, 0, len(acl.Identities))
	for name := range acl.Identities {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		scopes := acl.Identities[name]
		home := filepath.Join(r.root, "users", name)
		_, statErr := os.Stat(home)
		if statErr != nil {
			report.Findings = append(report.Findings, AuditFinding{
				Kind:     "orphan_identity",
				Identity: name,
				Detail:   "授权对象没有家目录（账号多半已删除）",
			})
		}
		for _, sc := range scopes {
			if detail := r.scopeProblem(sc); detail != "" {
				report.Findings = append(report.Findings, AuditFinding{
					Kind:     "dangling_scope",
					Identity: name,
					Source:   sc.Source,
					Path:     sc.Path,
					Detail:   detail,
				})
				continue
			}
		}
	}

	for group, scopes := range acl.Groups {
		for _, sc := range scopes {
			if detail := r.scopeProblem(sc); detail != "" {
				report.Findings = append(report.Findings, AuditFinding{
					Kind:   "dangling_scope",
					Group:  group,
					Source: sc.Source,
					Path:   sc.Path,
					Detail: detail,
				})
				continue
			}
			// 课题资料/组会汇报的写权限只该给教师组：学生组拿到 modify/delete，
			// 等于任何人都能改别人的课题材料，而界面上看不出来。
			if isSharedScope(sc) && (sc.Delete || sc.Modify || sc.Create) && !isTeacherGroup(group) {
				report.Findings = append(report.Findings, AuditFinding{
					Kind:   "group_scope_too_broad",
					Group:  group,
					Source: sc.Source,
					Path:   sc.Path,
					Detail: "非教师组对课题/组会目录拥有写权限",
				})
			}
		}
	}

	return report
}

// scopeProblem 返回该授权指向的目录是否真实存在；空串表示没问题。
func (r *Registry) scopeProblem(sc Scope) string {
	base, ok := r.sourceDir(sc.Source)
	if !ok {
		return "未知的存储源：" + sc.Source
	}
	if _, err := os.Stat(base); err != nil {
		return "存储源目录不存在：" + base
	}
	if strings.TrimSpace(sc.Path) == "" {
		return "" // 整源授权，源在就算有效
	}
	clean, err := cleanRelative(sc.Path)
	if err != nil {
		return "路径非法：" + sc.Path
	}
	if _, err := os.Stat(filepath.Join(base, clean)); err != nil {
		return "授权目录不存在：" + sc.Path
	}
	return ""
}

func isSharedScope(sc Scope) bool {
	return sc.Source == "research" || sc.Source == "meeting"
}
