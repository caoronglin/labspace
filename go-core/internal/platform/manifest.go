package platform

import (
	"errors"
	"sort"
	"strings"
)

type State string

const (
	NativePrototype State = "native-prototype"
	ExistingAdapter State = "existing-adapter"
	PreservedEngine State = "preserved-engine"
	WorkerAdapter   State = "worker-adapter"
	Planned         State = "planned"
)

type Feature struct {
	ID        string   `json:"id"`
	Group     string   `json:"group"`
	Name      string   `json:"name"`
	State     State    `json:"state"`
	Owner     string   `json:"owner"`
	Routes    []string `json:"routes,omitempty"`
	DependsOn []string `json:"depends_on,omitempty"`
	AdminOnly bool     `json:"admin_only,omitempty"`
	Notes     string   `json:"notes"`
}

type Registry struct{ features []Feature }

func Default() *Registry {
	fs := []Feature{
		{ID: "identity-casdoor", Group: "platform", Name: "Casdoor OIDC / Session / CSRF", State: ExistingAdapter, Owner: "existing portal auth gateway", Routes: []string{"/api/auth/*", "/api/me"}, Notes: "Casdoor remains the only IdP. Go must consume verified principal claims; do not create a second identity database. Sessions are stateless HS256 JWTs, so disabling, re-grouping, resetting the password or deleting an account writes labspace.session_revocation; both services refuse a token issued before that instant (15s cache)."},
		{ID: "service-catalog", Group: "portal", Name: "Service directory / health / embed", State: ExistingAdapter, Owner: "Go catalog adapter + existing services", Routes: []string{"/api/services", "/api/services/health", "/api/services/{id}/health", "/api/services/{id}/embed"}, Notes: "Keep host-adaptive links and service health; URLs come from administrator configuration, never request parameters."},
		{ID: "sso", Group: "portal", Name: "Cross-service SSO", State: ExistingAdapter, Owner: "Casdoor + existing OIDC sync during migration", Routes: []string{"/api/sso/status", "/api/sso/{service_id}/prepare"}, Notes: "Retain IP/Tailscale issuer behavior until fixed-issuer or subnet-routing migration is verified."},
		{ID: "global-search", Group: "portal", Name: "Federated search and corpus", State: ExistingAdapter, Owner: "Go orchestration + SearXNG + research API", Routes: []string{"/api/search", "/api/search/categories", "/api/search/suggest", "/api/corpus"}, Notes: "Preserve local corpus and source weighting; SearXNG and research providers remain pluggable."},
		{ID: "plant-databases", Group: "research", Name: "Plant database catalog", State: ExistingAdapter, Owner: "existing 50+/71 entry catalog + Go API adapter", Routes: []string{"/api/databases", "/api/databases/apis", "/api/databases/{db_id}/query", "/api/databases/{db_id}/probe"}, Notes: "Import the existing curated catalog and 32 database adapters; do not regenerate from guessed sources."},
		{ID: "literature", Group: "research", Name: "Literature search", State: ExistingAdapter, Owner: "existing research API / PubMed / Europe PMC / Crossref", Routes: []string{"/api/literature"}, Notes: "Keep provider-specific pagination, rate limits, provenance, and fallback behavior."},
		{ID: "research-api-mcp", Group: "research", Name: "Research API and MCP tools", State: PreservedEngine, Owner: "existing lab-research-api", Routes: []string{"/mcp/*", "/api/research/*"}, Notes: "Keep the existing 9 MCP tools and 32 provider adapters until Go equivalents pass contract tests."},
		{ID: "linux-commands", Group: "portal", Name: "Linux command reference", State: PreservedEngine, Owner: "existing static command catalog", Routes: []string{"/api/commands", "/api/commands/{name}"}, Notes: "Preserve 621 command records and localized explanations; static assets remain independently cacheable."},
		{ID: "favorites-recent", Group: "portal", Name: "Favorites and recent visits", State: ExistingAdapter, Owner: "existing portal database", Routes: []string{"/api/favorites", "/api/recent"}, Notes: "Keep user ownership and existing rows; Go repository migration requires row-count and owner mapping."},
		{ID: "drawings", Group: "portal", Name: "Drawing metadata and exports", State: ExistingAdapter, Owner: "Go metadata adapter + draw.io engine", Routes: []string{"/api/drawings", "/api/drawings/{id}/rename", "/api/drawings/{id}/export", "/api/drawings/{id}/download"}, Notes: "draw.io remains the editor; LabSpace owns metadata, permissions, and download authorization."},
		{ID: "announcements", Group: "portal", Name: "Announcements", State: ExistingAdapter, Owner: "PostgreSQL labspace.announcements", Routes: []string{"/api/announcements"}, Notes: "Administrators publish and revoke; every signed-in user reads the same list. No per-role visibility rules are implemented."},
		{ID: "workbench", Group: "portal", Name: "Personal workbench / plans / projects / briefs / quota", State: ExistingAdapter, Owner: "Go domain target + existing FastAPI contract", Routes: []string{"/api/workbench/*"}, Notes: "Preserve 16 existing endpoints and their current response semantics; do not replace with a new incompatible planner."},
		{ID: "pi-agent", Group: "ai", Name: "Pi Agent runtime and SSE", State: PreservedEngine, Owner: "existing Node 26 Pi RPC gateway", Routes: []string{"/api/agent/*"}, Notes: "Pi is the sole Agent runtime. Preserve session fork, SSE, abort, quota, auto-follow-up, and lab_* tools."},
		{ID: "pi-admin", Group: "ai", Name: "Models / MCP / Skills administration", State: NativePrototype, Owner: "Go registry + Pi-native config projection", Routes: []string{"/v1/admin/catalog", "/v1/secrets"}, AdminOnly: true, Notes: "Only administrators edit shared catalog. Users select authorized resources and store personal credentials in their own vault."},
		{ID: "files-acl", Group: "files", Name: "Shared/private/team file management and ACL", State: NativePrototype, Owner: "Go LabCore + POSIX + JSON ACL", Routes: []string{"/api/files/*", "/api/admin/accounts/*"}, Notes: "Actions are list/read/preview/download/create/modify/delete; grants are read/write per directory, resolved deny > user > group > admin. A delete moves the entry into <lab root>/.trash for LABGO_TRASH_DAYS days (30 by default): /api/files/trash lists it, POST /api/files/trash/restore puts it back, DELETE removes it for good; removing an account also clears its personal trash rows."},
		{ID: "file-preview", Group: "files", Name: "Office/image/PDF/bioinformatics preview", State: NativePrototype, Owner: "Go bounded preview + Tika worker", Routes: []string{"/api/files/{id}/preview"}, Notes: "FASTA/FASTQ/SAM/VCF/GFF/TSV native bounded parsing; PDF raster, BAM/CRAM/BigWig and complex Office rendering use isolated workers."},
		{ID: "download-center", Group: "files", Name: "Multi-protocol download center and statistics", State: Planned, Owner: "Go transfer manager + protocol drivers", Routes: []string{"/api/downloads/*"}, Notes: "Protocol registry for HTTPS/S3/SFTP/FTP; per-user/project quotas, resumability, audit and byte statistics must be backed by durable jobs."},
		{ID: "knowledge-rag", Group: "ai", Name: "Knowledge bases and RAG", State: WorkerAdapter, Owner: "Go ACL/job orchestration + Python Haystack/pgvector", Routes: []string{"/api/knowledge/*"}, Notes: "Replace OpenWebUI KB. ACL filter before retrieval and recheck before content leaves the service; preserve provenance and versioning."},
		{ID: "image-generation", Group: "ai", Name: "Image generation workspace", State: NativePrototype, Owner: "Go provider/job gateway + approved model providers", Routes: []string{"/api/images/*"}, Notes: "Personal provider keys, send_external permission, durable jobs, idempotency, output ACL and RustFS storage."},
		{ID: "lab-translate", Group: "documents", Name: "Scientific document translation", State: WorkerAdapter, Owner: "Go jobs + OXR/Docling + Hunyuan MT Python workers", Routes: []string{"/api/pdf-translate/*", "/api/translate/*"}, Notes: "PDFMathTranslate is excluded. Protect formulas, tables, citations and page layout; current G1 has contracts, not complete document reconstruction."},
		{ID: "snapotter-tools", Group: "documents", Name: "Media/file processing tools", State: ExistingAdapter, Owner: "SnapOtter retained as advanced worker; common tools native Go", Routes: []string{"/api/snapotter/*"}, Notes: "Do not claim all 243 tools rewritten. Replace high-frequency safe file operations incrementally; retain specialized video/audio pipelines."},
		{ID: "weather", Group: "portal", Name: "Weather widget", State: ExistingAdapter, Owner: "Open-Meteo adapter", Routes: []string{"/api/weather"}, Notes: "Keep as a small external data adapter; not an Agent runtime."},
		{ID: "network-diagnostics", Group: "operations", Name: "Network entry diagnostics", State: ExistingAdapter, Owner: "existing portal ops", Routes: []string{"/api/network/entries"}, Notes: "Preserve LAN/Tailscale IP-first behavior; no new domain dependency."},
		{ID: "admin-operations", Group: "operations", Name: "Admin health/config/usage", State: ExistingAdapter, Owner: "Go operations API + existing admin contract", Routes: []string{"/api/admin/*"}, AdminOnly: true, Notes: "Secrets are write-only; every administrative change is audited and revisioned."},
		{ID: "bioinfo-training", Group: "bioinfo", Name: "Bioinformatics training platform", State: PreservedEngine, Owner: "existing /opt/bioinfo-training FastAPI + React", Routes: []string{"/api/bioinfo/auth/*", "/api/bioinfo/courses/*", "/api/bioinfo/labs/*", "/api/bioinfo/datasets/*", "/api/bioinfo/workspaces/*", "/api/bioinfo/submissions/*", "/api/bioinfo/teaching/*", "/api/bioinfo/admin/*"}, Notes: "Preserve current 31-table DB, Alembic history, RBAC and teaching workflows. Integrate through contract adapter; do not silently discard it."},
		{ID: "bioinfo-terminal", Group: "bioinfo", Name: "Web terminal / PTY / cgroups", State: PreservedEngine, Owner: "existing bioinfo-terminal + cgroup helper", Routes: []string{"/api/bioinfo/terminal/*", "/ws/terminal/*"}, Notes: "Keep WebSocket/PTY and resource controls. Go must not execute arbitrary user shell outside this isolation."},
		{ID: "jbrowse", Group: "bioinfo", Name: "Genome browser", State: PreservedEngine, Owner: "JBrowse 2 static app + data adapter", Routes: []string{"/jbrowse/*"}, Notes: "Retain JBrowse 2; Go provides authenticated data manifests and signed access, not a reimplementation of genome visualization."},
		{ID: "blast", Group: "bioinfo", Name: "BLAST service", State: Planned, Owner: "Go job/API control + NCBI BLAST+ isolated worker", Routes: []string{"/api/blast/*"}, Notes: "Required capability. Needs database build registry, job queue, resource quotas, output parsing and ACL-aware result storage."},
		{ID: "drawio", Group: "tools", Name: "Diagram editor", State: PreservedEngine, Owner: "draw.io", Routes: []string{"/draw/*"}, Notes: "Retain editor; integrate SSO, save/export metadata and file ACL."},
		{ID: "searxng", Group: "research", Name: "Metasearch", State: PreservedEngine, Owner: "SearXNG", Routes: []string{"/api/search/providers/searxng"}, Notes: "Retain search backend and proxy via Go; configure safe engines and network egress."},
		{ID: "document-parsers", Group: "documents", Name: "Tika / Docling / OXR parsing", State: WorkerAdapter, Owner: "Python document workers", Routes: []string{"/api/docparse/*"}, Notes: "Keep mature parsers behind versioned worker contracts; Go owns auth, jobs, quotas and output ACL."},
		{ID: "external-models", Group: "ai", Name: "Embedding / reranker / LLM endpoints", State: PreservedEngine, Owner: "Windows model host and approved provider endpoints", Notes: "Keep model execution external; Go manages credentials, routing, quota and audit."},
		{ID: "backup-health", Group: "operations", Name: "Backup / restore drill / health timer", State: ExistingAdapter, Owner: "host ops scripts + Go health/metrics integration", Notes: "Extend backup coverage to bioinfo DB, workspaces, /srv/lab and new object storage; do not replace until restore drill passes."},
		{ID: "wecom-selective", Group: "integration", Name: "Selective WeCom task/calendar sync", State: ExistingAdapter, Owner: "existing selective sync extension", Routes: []string{"/api/workbench/wecom/*"}, Notes: "Only user-selected tasks and single events. No files, RAG, chat, docs or general WeCom features."},
	}
	sort.Slice(fs, func(i, j int) bool { return fs[i].ID < fs[j].ID })
	return &Registry{features: fs}
}

func (r *Registry) All() []Feature {
	out := make([]Feature, len(r.features))
	copy(out, r.features)
	return out
}
func (r *Registry) ForActor(admin bool) []Feature {
	out := make([]Feature, 0, len(r.features))
	for _, f := range r.features {
		if !f.AdminOnly || admin {
			out = append(out, f)
		}
	}
	return out
}
func (r *Registry) Validate() error {
	ids := map[string]bool{}
	for _, f := range r.features {
		if strings.TrimSpace(f.ID) == "" || strings.TrimSpace(f.Name) == "" {
			return errors.New("feature id/name required")
		}
		if ids[f.ID] {
			return errors.New("duplicate feature id: " + f.ID)
		}
		ids[f.ID] = true
		switch f.State {
		case NativePrototype, ExistingAdapter, PreservedEngine, WorkerAdapter, Planned:
		default:
			return errors.New("unknown feature state: " + string(f.State))
		}
		for _, route := range f.Routes {
			if !strings.HasPrefix(route, "/") {
				return errors.New("route must be absolute: " + route)
			}
		}
	}
	for _, f := range r.features {
		for _, dep := range f.DependsOn {
			if !ids[dep] {
				return errors.New("missing dependency: " + dep)
			}
		}
	}
	return nil
}
