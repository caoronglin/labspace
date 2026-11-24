package integrationmap

type Binding struct{ ID, Surface, Owner, Mode, Status, Contract string }

func All() []Binding {
	return []Binding{
		{"portal-auth", "/api/auth/*", "Portal native auth + OIDC provider", "preserve", "existing", "OIDC code+PKCE; labspace_session; double-submit CSRF"},
		{"portal-catalog", "/api/services/*", "Go catalog + configured health probes", "adapter", "partial", "existing service IDs and host-adaptive URLs"},
		{"portal-search", "/api/search*", "Go aggregator + SearXNG + research API", "adapter", "planned", "keep source labels, type caps, ranking and fallback"},
		{"plant-db", "/api/databases/*", "existing curated catalog + 32 research adapters", "preserve", "existing", "import real catalog and provider schemas"},
		{"literature", "/api/literature", "research API providers", "preserve", "existing", "PubMed/Europe PMC/Crossref and provider provenance"},
		{"personal-workbench", "/api/workbench/*", "Go target + existing Postgres rows", "compatibility", "partial", "16 endpoints; plans/projects/briefs/notifications/quota/models"},
		{"agent", "/api/agent/*", "Node Pi RPC gateway", "preserve", "existing", "SSE, abort, sessions, quota, lab_* tools"},
		{"files", "/api/files/*", "Go ACL + POSIX", "replace", "active", "native list/preview/upload/mkdir/rename/delete"},
		{"knowledge", "/api/knowledge/*", "Go ACL/jobs + Haystack pgvector worker", "replace", "prototype", "old OpenWebUI KB read-only migration first"},
		{"translation", "/api/pdf-translate/*", "Go jobs + OXR/Docling + Hy-MT2 worker", "replace", "contract", "no PDFMathTranslate; output layout QA pending"},
		{"image-tools", "/api/images/* and /api/snapotter/*", "Go native safe tools + model providers + SnapOtter worker", "hybrid", "partial", "do not claim all 243 SnapOtter tools rewritten"},
		{"bioinfo", "/api/bioinfo/*", "existing bioinfo-training API", "preserve", "existing", "31-table schema, course/lab/dataset/submission/admin APIs"},
		{"terminal", "/ws/terminal/*", "existing terminal/PTY/cgroup helper", "preserve", "existing", "resource profiles and per-user workspace isolation"},
		{"genome", "/jbrowse/* and /api/blast/*", "JBrowse2 + NCBI BLAST+ worker", "hybrid", "partial", "JBrowse preserved; BLAST adapter still requires DB/job integration"},
		{"drawio", "/draw/* and /api/drawings/*", "draw.io + Go metadata/ACL", "hybrid", "partial", "save/export/download must check ACL"},
		{"downloads", "/api/downloads/*", "Go transfer manager", "new", "planned", "HTTPS/S3/SFTP/FTP drivers, resume, statistics and quotas"},
		{"wecom", "/api/workbench/wecom/*", "selective WeCom adapter", "optional", "partial", "only opt-in tasks and single events"},
		{"ops", "/api/admin/* and /metrics", "Go ops + host scripts", "hybrid", "partial", "backup/restore, health, audit, metrics, nftables untouched"},
	}
}
