// Package catalog holds the authoritative lab service registry.
//
// The Go core is the single source of truth for the portal service catalog:
// the Python portal used to own this list, and the exported JSON file lets
// other components (search corpus, embed checks) read the same data.
package catalog

import (
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"os"
	"sort"
	"strings"
)

// DefaultHost is the LAN address used as the placeholder host in service URLs.
const DefaultHost = "192.0.2.10"

// Item is one catalog entry. The JSON shape matches the portal contract so the
// existing frontend needs no change.
type Item struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Category    string   `json:"category"`
	URL         string   `json:"url"`
	Icon        string   `json:"icon"`
	OpenMode    string   `json:"openMode"`
	Embed       bool     `json:"embed"`
	EmbedURL    string   `json:"embedUrl"`
	SSOURL      string   `json:"ssoUrl"`
	LangNote    string   `json:"langNote"`
	Tags        []string `json:"tags"`
	Roles       []string `json:"roles"`
	Notes       string   `json:"notes"`
	Guide       []string `json:"guide"`
	External    bool     `json:"external"`

	// Health describes how to probe the service from the host.
	Health     HealthSpec `json:"-"`
	Enabled    bool       `json:"-"`
	AdminOnly  bool       `json:"-"`
	Engine     string     `json:"-"`
	Status     string     `json:"-"`
	NativeOnly bool       `json:"-"`
}

// HealthSpec is the internal probe configuration of one service.
type HealthSpec struct {
	URL          string
	Kind         string
	Host         string
	MaxAgeSecond int
	// Container is the Docker container name the URL belongs to (resolved by
	// the endpoint sync job when the container has no published port).
	Container string
}

// NativeItem describes a Go-native module exposed by the core itself.
type NativeItem struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Category  string `json:"category"`
	URL       string `json:"url"`
	AdminOnly bool   `json:"admin_only,omitempty"`
	Engine    string `json:"engine"`
	Status    string `json:"status"`
}

// Service is the registry of live services plus Go-native entries.
type Service struct {
	items  []Item
	native []NativeItem
}

// Default returns the live lab service catalog.
func Default() *Service {
	return &Service{
		items: []Item{
			{
				ID: "drawio", Name: "draw.io", Category: "draw",
				Description: "科研流程图绘制与导出 SVG/PNG",
				URL:         "/drawio", Icon: "PartitionOutlined",
				OpenMode: "link",
				Tags:     []string{"流程图", "绘图"},
				Guide:    []string{"门户 /drawio 以 Embed Mode 打开绘图器，可直接保存到个人目录。"},
				Enabled:  true, Status: "preserved", Engine: "draw.io",
				Health: HealthSpec{URL: "http://127.0.0.1:8082/", Kind: "http"},
			},
			{
				ID: "linux-command", Name: "Linux Command", Category: "learn",
				Description: "Linux 命令速查（中文说明、离线可查）",
				URL:         "/commands", Icon: "ConsoleSquareOutlined",
				OpenMode: "link",
				Tags:     []string{"Linux", "命令", "教程"},
				Guide:    []string{"grep / awk / sed / find / sort / xargs / rsync / tar 等常用命令。"},
				Enabled:  true, Status: "preserved", Engine: "static command catalog",
				Health: HealthSpec{URL: "http://192.0.2.10:8086/", Kind: "http"},
			},
			{
				ID: "literature-search", Name: "科研文献搜索", Category: "research",
				Description: "PubMed / Europe PMC / Crossref 文献检索",
				URL:         "/literature", Icon: "BookOutlined",
				OpenMode: "link",
				Tags:     []string{"文献", "PubMed", "DOI"},
				Guide:    []string{"门户内检索 PubMed / Europe PMC / Crossref，结果可复制 DOI 或交给 Agent 助手继续分析。"},
				Enabled:  true, Status: "preserved", Engine: "research API",
				Health: HealthSpec{URL: "http://${research-api}:8000/health", Kind: "http", Container: "lab-research-api"},
			},
			{
				ID: "docling", Name: "文档解析", Category: "research",
				Description: "Docling 复杂 PDF 结构化解析（双栏 / 表格 / 扫描件），结果可存入知识库",
				URL:         "/docparse", Icon: "FileSearchOutlined",
				OpenMode: "link",
				Tags:     []string{"PDF", "OCR", "解析", "Markdown"},
				Guide: []string{
					"门户 /docparse 是统一入口：上传 PDF → 解析为 Markdown，可一键存入知识库。",
					"由 AI 助手显式调用时同样走 Docling 引擎，无需另开页面。",
				},
				Enabled: true, Status: "preserved", Engine: "Docling",
				Health: HealthSpec{URL: "http://${docling}:5001/health", Kind: "http", Container: "lab-docling"},
			},
			{
				ID: "searxng", Name: "SearXNG 检索", Category: "research",
				Description: "中英文网页、学术与教学视频统一检索",
				URL:         "/search", Icon: "GlobalOutlined",
				OpenMode: "link",
				Tags:     []string{"搜索", "学术", "视频"},
				Guide:    []string{"门户统一搜索与 Agent 助手共用同一 SearXNG 实例。"},
				Enabled:  true, Status: "preserved", Engine: "SearXNG",
				Health: HealthSpec{URL: "http://127.0.0.1:8081/", Kind: "http"},
			},
			{
				ID: "pdf-translate", Name: "PDF 论文翻译", Category: "research",
				Description: "PDFMathTranslate 论文翻译：上传 PDF，输出中文译文",
				URL:         "/translate", Icon: "TranslationOutlined",
				OpenMode: "link",
				Roles:    []string{"lab-admin", "lab-teacher", "lab-student"},
				Tags:     []string{"PDF", "翻译", "论文"},
				Guide: []string{
					"上传 PDF 后排队翻译，完成后下载译文压缩包。",
					"单文件上限 30MB，队列串行处理，优先保障其它服务资源。",
					"服务容器内存上限 2GB、CPU 1 核，翻译期间不影响其它组件。",
				},
				Enabled: true, Status: "preserved", Engine: "PDFMathTranslate",
				Health: HealthSpec{URL: "/srv/labdata/translate/worker.heartbeat", Kind: "file", MaxAgeSecond: 90},
			},
			{
				ID: "bioinfo-training", Name: "生信实验实训平台", Category: "learn",
				Description: "课程、实验环境、终端工作区、提交与批阅（门户内嵌统一入口）",
				URL:         "/bioinfo", Icon: "CodeOutlined",
				OpenMode: "link",
				Tags:     []string{"生信", "实训", "终端", "课程"},
				Guide: []string{
					"门户 /bioinfo 是统一入口，按「总览 / 课程 / 实验 / 终端工作区 / 提交记录」分区内嵌平台。",
					"统一使用 Casdoor 账号登录；教师可发布课程与实验，学生在受控终端里完成作业。",
					"每个会话分配独立 cgroup（standard：1 核 / 1.5GiB / 256 进程），用完自动回收。",
				},
				Enabled: true, Status: "preserved", Engine: "bioinfo-training",
				Health: HealthSpec{URL: "http://192.0.2.10:8102/api/v1/health", Kind: "http"},
			},
			{
				ID: "drawing-board", Name: "图纸平台", Category: "draw",
				Description: "实验图纸与流程图协作平台（独立主机，经门户反向代理接入）",
				URL:         "http://192.0.2.10:8093/", Icon: "ApartmentOutlined",
				OpenMode: "link", Embed: true,
				EmbedURL: "http://192.0.2.10:8093/",
				External: true,
				Tags:     []string{"图纸", "协作"},
				Guide: []string{
					"由门户 8093 端口反向代理到 192.0.2.29:5244，内网与 Tailscale 两个入口均可访问。",
					"反代保留访问方 Host 并改写上游重定向，图纸平台生成的链接不会跳回内网地址。",
					"与 LabSpace 共用 Casdoor 账号体系（如该平台已接入）。",
				},
				Enabled: true, Status: "external", Engine: "external drawing platform",
				Health: HealthSpec{URL: "http://192.0.2.10:8093/", Kind: "http"},
			},
			{
				ID: "jbrowse", Name: "公共基因组", Category: "research",
				Description: "JBrowse 2 基因组浏览器 + CropGenome / rust-bio 成对比对、基序检索、区域重叠、序列提取、基因检索、ID 解析与 BLAST",
				URL:         "/genomes", Icon: "ExperimentOutlined",
				OpenMode: "link",
				Tags:     []string{"基因组", "JBrowse", "变异", "序列", "ORF", "GC", "BLAST", "比对", "注释", "作物"},
				Guide: []string{
					"门户 /genomes 是统一入口：浏览 JBrowse 2 轨道，对 FASTA 做 ORF / GC 分析，或使用「比对与注释工具」。",
					"比对与注释工具包含：成对比对、基序检索、区域重叠、序列提取、基因检索、ID 解析、BLAST 任务。",
					"数据来自「公共基因组」文件源，按 ACL 过滤；注释相关功能需先导入并发布参考物种。",
					"浏览器轨道经 /jbrowse/ 同源反代，分析请求经 /cropgenome/api/ 以你的身份代理，均不暴露服务令牌。",
				},
				Enabled: true, Status: "preserved", Engine: "JBrowse 2 + CropGenome / rust-bio",
				Health: HealthSpec{URL: "http://192.0.2.10:8091/index.html", Kind: "host", Host: "192.0.2.10:8091"},
			},
			{
				ID: "snapotter", Name: "文件工坊（SnapOtter）", Category: "files",
				Description: "图片 / 视频 / 音频 / PDF / 文档 200+ 工具箱：OCR、压缩、格式转换、去背景",
				URL:         "/snapotter", Icon: "ThunderboltOutlined",
				OpenMode: "link",
				Tags:     []string{"文件", "图片", "OCR", "转换", "音视频"},
				Guide: []string{
					"门户 /snapotter 是统一入口：按图片 / PDF / 文件 / 视频 / 音频分区，用原生界面调用 REST API。",
					"所有处理都在本机执行，文件不出内网，无需登录官方后台。",
				},
				Enabled: true, Status: "preserved", Engine: "SnapOtter",
				Health: HealthSpec{URL: "http://127.0.0.1:8092/api/v1/health", Kind: "http"},
			},
		},
		native: []NativeItem{
			{ID: "portal", Name: "D509 工作台", Category: "platform", URL: "/", Engine: "Go LabCore + React", Status: "active"},
			{ID: "files", Name: "实验室文件空间", Category: "files", URL: "/files", Engine: "Go Files（原生文件网盘）", Status: "active"},
			{ID: "admin", Name: "平台管理", Category: "admin", URL: "/admin/", AdminOnly: true, Engine: "Go LabCore", Status: "active"},
		},
	}
}

// Items returns the live catalog entries.
func (s *Service) Items() []Item { return s.items }

// Native returns the Go-native catalog entries.
func (s *Service) Native() []NativeItem { return s.native }

// Live returns the enabled services visible to the given roles.
func (s *Service) Live(host string, roles []string) []Item {
	out := []Item{}
	for _, it := range s.items {
		if !it.Enabled {
			continue
		}
		if len(it.Roles) > 0 && !hasAnyRole(roles, it.Roles) {
			continue
		}
		out = append(out, adaptItem(it, host))
	}
	return out
}

// Find returns the catalog entry with the given id.
// AdaptItem rewrites the host dependent fields of a single catalog entry.
//
// The catalog entries are shared, so the adaptation always works on a copy.
func AdaptItem(it Item, host string) Item {
	return adaptItem(it, host)
}

func (s *Service) Find(id string) (Item, bool) {
	for _, it := range s.items {
		if it.ID == id {
			return it, true
		}
	}
	return Item{}, false
}

// Catalog renders the Go-native catalog view (live + native entries).
func (s *Service) Catalog(host string, admin bool) []NativeItem {
	out := []NativeItem{}
	for _, n := range s.native {
		if n.AdminOnly && !admin {
			continue
		}
		n.URL = adaptHost(n.URL, host)
		out = append(out, n)
	}
	for _, it := range s.items {
		if !it.Enabled {
			continue
		}
		out = append(out, NativeItem{
			ID: it.ID, Name: it.Name, Category: it.Category,
			URL: adaptHost(it.URL, host), Engine: it.Engine, Status: it.Status,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func hasAnyRole(roles, required []string) bool {
	for _, r := range roles {
		for _, need := range required {
			if r == need {
				return true
			}
		}
	}
	return false
}

// adaptItem rewrites every host-dependent string for the request host.
//
// The slices are copied first: adapting must never mutate the shared catalog
// entries (otherwise one request host would leak into every later response).
func adaptItem(it Item, host string) Item {
	it.Tags = append([]string{}, it.Tags...)
	it.Roles = append([]string{}, it.Roles...)
	it.Guide = append([]string{}, it.Guide...)
	it.URL = adaptText(it.URL, host)
	if it.EmbedURL == "" {
		it.EmbedURL = it.URL
	}
	it.EmbedURL = adaptText(it.EmbedURL, host)
	it.SSOURL = adaptText(it.SSOURL, host)
	it.LangNote = adaptText(it.LangNote, host)
	it.Notes = adaptText(it.Notes, host)
	for i := range it.Guide {
		it.Guide[i] = adaptText(it.Guide[i], host)
	}
	return it
}

// AdaptText replaces the placeholder LAN host with the request host.
func AdaptText(value, requestHost string) string { return adaptText(value, requestHost) }

// adaptText replaces the placeholder LAN host with the request host.
func adaptText(value, requestHost string) string {
	if value == "" || requestHost == "" {
		return value
	}
	hostname := requestHost
	if h, _, err := net.SplitHostPort(requestHost); err == nil {
		hostname = h
	}
	hostname = strings.TrimSpace(hostname)
	if hostname == "" || hostname == DefaultHost {
		return value
	}
	return strings.ReplaceAll(value, "http://"+DefaultHost, "http://"+hostname)
}

// adaptHost rewrites a full URL so it points at the request host.
func adaptHost(raw, requestHost string) string {
	if strings.HasPrefix(raw, "/") || requestHost == "" {
		return raw
	}
	u, e := url.Parse(raw)
	if e != nil || u.Host == "" {
		return raw
	}
	host := requestHost
	if h, _, err := net.SplitHostPort(requestHost); err == nil {
		host = h
	}
	if net.ParseIP(host) == nil {
		return raw
	}
	oldHost, oldPort, err := net.SplitHostPort(u.Host)
	if err == nil {
		_ = oldHost
		u.Host = net.JoinHostPort(host, oldPort)
	} else {
		u.Host = host
	}
	return u.String()
}

// Validate rejects an empty or duplicated catalog.
func Validate(s *Service) error {
	if s == nil {
		return errors.New("catalog is nil")
	}
	seen := map[string]bool{}
	for _, it := range s.items {
		if it.ID == "" || it.Name == "" || seen[it.ID] {
			return errors.New("invalid/duplicate catalog item")
		}
		seen[it.ID] = true
		if it.URL == "" {
			return errors.New("empty service URL")
		}
	}
	return nil
}

// Export renders the catalog as the JSON document shared with other components.
func Export(s *Service) ([]byte, error) {
	type entry struct {
		ID          string   `json:"id"`
		Name        string   `json:"name"`
		Description string   `json:"description"`
		Category    string   `json:"category"`
		URL         string   `json:"url"`
		Icon        string   `json:"icon"`
		OpenMode    string   `json:"open_mode"`
		Embed       bool     `json:"embed"`
		EmbedURL    string   `json:"embed_url"`
		SSOURL      string   `json:"sso_url"`
		LangNote    string   `json:"lang_note"`
		Tags        []string `json:"tags"`
		Roles       []string `json:"roles"`
		Notes       string   `json:"notes"`
		Guide       []string `json:"guide"`
		External    bool     `json:"external"`
		Enabled     bool     `json:"enabled"`
		HealthURL   string   `json:"health_url"`
		HealthKind  string   `json:"health_kind"`
		HealthHost  string   `json:"health_host"`
		Engine      string   `json:"engine"`
		Status      string   `json:"status"`
	}
	out := struct {
		Version  int          `json:"version"`
		Source   string       `json:"source"`
		Services []entry      `json:"services"`
		Native   []NativeItem `json:"native"`
	}{
		Version: 2,
		Source:  "go-core/catalog",
		Native:  s.native,
	}
	for _, it := range s.items {
		out.Services = append(out.Services, entry{
			ID: it.ID, Name: it.Name, Description: it.Description, Category: it.Category,
			URL: it.URL, Icon: it.Icon, OpenMode: it.OpenMode, Embed: it.Embed,
			EmbedURL: it.EmbedURL, SSOURL: it.SSOURL, LangNote: it.LangNote,
			Tags: it.Tags, Roles: it.Roles, Notes: it.Notes, Guide: it.Guide,
			External: it.External, Enabled: it.Enabled,
			HealthURL: it.Health.URL, HealthKind: it.Health.Kind, HealthHost: it.Health.Host,
			Engine: it.Engine, Status: it.Status,
		})
	}
	return json.MarshalIndent(out, "", "  ")
}

// WriteExport writes the shared catalog JSON document.
func WriteExport(s *Service, path string) error {
	data, err := Export(s)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}
