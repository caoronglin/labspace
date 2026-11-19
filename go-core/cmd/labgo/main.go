// Command labgo is the LabSpace Go core reference server.
//
// It binds loopback only and is an incremental bridge behind the existing
// nginx/Casdoor gateway. Every capability is opt-in via environment variables;
// a missing dependency never widens permissions (fail closed).
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"labspace.local/go-core/internal/catalog"
	"labspace.local/go-core/internal/colorlab"
	"labspace.local/go-core/internal/commands"
	"labspace.local/go-core/internal/corpus"
	"labspace.local/go-core/internal/dbapis"
	"labspace.local/go-core/internal/embed"
	"labspace.local/go-core/internal/endpoints"
	"labspace.local/go-core/internal/fileaudit"
	"labspace.local/go-core/internal/guard"
	"labspace.local/go-core/internal/health"
	"labspace.local/go-core/internal/httpapi"
	"labspace.local/go-core/internal/labfiles"
	"labspace.local/go-core/internal/lifedb"
	_ "labspace.local/go-core/internal/pgwire" // registers database/sql driver "pgwire"
	"labspace.local/go-core/internal/platform"
	"labspace.local/go-core/internal/plot"
	"labspace.local/go-core/internal/portal"
	"labspace.local/go-core/internal/registry"
	"labspace.local/go-core/internal/search"
	"labspace.local/go-core/internal/session"
	"labspace.local/go-core/internal/snapotter"
	"labspace.local/go-core/internal/vault"
	"labspace.local/go-core/internal/websearch"
	"labspace.local/go-core/internal/workbench"
)

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func main() {
	// --- PostgreSQL (labspace database). Opened first because the session
	// verifier needs it to enforce revocation; the workbench and the portal
	// favorites/recent share the same pool.
	var labDB *sql.DB
	if dsn := os.Getenv("LABGO_PG_DSN"); dsn != "" {
		if db, err := sql.Open("pgwire", dsn); err == nil {
			if n, _ := strconv.Atoi(env("LABGO_PG_MAX_CONNS", "8")); n > 0 {
				db.SetMaxOpenConns(n)
			}
			if err := db.Ping(); err == nil {
				labDB = db
			} else {
				db.Close()
			}
		}
	}

	// --- session (browser) authentication: REQUIRED. Without the portal
	// secret the process must not accept browser traffic.
	var sess *session.Verifier
	if secret := os.Getenv("LABSPACE_SESSION_SECRET"); secret != "" {
		opts := session.Options{
			AdminRoles:     splitEnv("LABSPACE_ADMIN_ROLES", "lab-admin"),
			TeacherRoles:   splitEnv("LABSPACE_TEACHER_ROLES", "lab-teacher"),
			AllowedOrigins: splitEnv("LABSPACE_ALLOWED_ORIGINS", ""),
		}
		if labDB != nil {
			opts.Revoked = revokedSessions(labDB)
		} else {
			log.Print("WARN: no PostgreSQL connection; disabling and deleting an account will not revoke live sessions on Go routes")
		}
		v, err := session.New([]byte(secret), opts)
		if err != nil {
			log.Fatal("invalid LABSPACE_SESSION_SECRET: ", err)
		}
		sess = v
	} else {
		log.Print("WARN: LABSPACE_SESSION_SECRET unset; browser routes are disabled (internal HMAC/token only)")
	}

	// --- internal service-to-service HMAC authentication.
	var verifier *guard.Verifier
	if key := os.Getenv("LABGO_HMAC_KEY"); key != "" {
		v, err := guard.New([]byte(key))
		if err != nil {
			log.Fatal("invalid LABGO_HMAC_KEY: ", err)
		}
		verifier = v
	}

	// --- search (SearXNG) is optional.
	var searchSvc *search.Service
	if searx := os.Getenv("SEARXNG_BASE_URL"); searx != "" {
		searchSvc = &search.Service{Providers: []search.Provider{search.SearXNG{BaseURL: searx}}, MaxResults: 50, PerProvider: 20}
	}

	// --- corpus (unified index) is optional.
	// The shared JSON data file carries the database directory, the portal
	// pages and the browser tools; the live services come from the Go
	// catalog, the Linux commands from the command index and the file
	// processing tools from SnapOtter.
	var corpusIdx *corpus.Index
	corpusDataPath := strings.TrimSpace(os.Getenv("LABGO_CORPUS_DATA"))
	corpusCommandsPath := strings.TrimSpace(os.Getenv("LABGO_COMMANDS_FILE"))
	if corpusDataPath == "" {
		corpusDataPath = "/srv/labdata/labgo/corpus-data.json"
	}
	if corpusCommandsPath == "" {
		corpusCommandsPath = "/opt/labspace/frontend/linux-command/src/dist/data.json"
	}
	corpusData, corpusErr := corpus.LoadData(corpusDataPath)
	if corpusErr != nil {
		log.Printf("WARN: corpus data %q: %v", corpusDataPath, corpusErr)
	} else {
		corpusIdx = corpus.New(corpusData)
	}

	// --- workbench (16 endpoints) + portal favorites/recent, both on labDB.
	var wbHandler *workbench.Handler
	var portalHandler *portal.Handler
	if labDB != nil {
		wbHandler = &workbench.Handler{Store: &workbench.Store{DB: labDB}}
		portalHandler = &portal.Handler{
			Store:         &portal.Store{DB: labDB},
			ServiceExists: catalogHasService,
		}
		log.Print("workbench: 16 endpoints enabled; favorites/recent enabled")
	}
	if wbHandler == nil {
		log.Print("workbench: disabled (LABGO_PG_DSN unset or unreachable)")
	}

	// --- plot studio: Go owns job state, Python renders allow-listed templates.
	var plotHandler *plot.Handler
	if labDB != nil {
		plotHandler = plot.New(labDB)
		initCtx, cancelInit := context.WithTimeout(context.Background(), 10*time.Second)
		if err := plotHandler.Init(initCtx); err != nil {
			log.Printf("WARN: plot studio disabled: %v", err)
			plotHandler = nil
		} else {
			log.Printf("plot: enabled (root=%s)", plotHandler.Root)
		}
		cancelInit()
	}

	// --- SnapOtter REST proxy.
	var snapHandler *snapotter.Handler
	if base := os.Getenv("SNAPOTTER_BASE_URL"); base != "" {
		key := os.Getenv("SNAPOTTER_API_KEY")
		if f := os.Getenv("SNAPOTTER_API_KEY_FILE"); f != "" && key == "" {
			if b, err := os.ReadFile(f); err == nil {
				key = strings.TrimSpace(string(b))
			}
		}
		cfg := snapotter.Config{BaseURL: base, APIKey: key}
		if n, _ := strconv.ParseInt(env("SNAPOTTER_MAX_UPLOAD", "209715200"), 10, 64); n > 0 {
			cfg.MaxUpload = n
		}
		if sec, _ := strconv.Atoi(env("SNAPOTTER_TIMEOUT", "120")); sec > 0 {
			cfg.Timeout = time.Duration(sec) * time.Second
		}
		snapHandler = &snapotter.Handler{Client: snapotter.New(cfg)}
		log.Print("snapotter: REST proxy enabled")
	}

	// --- research database adapters (32). Always available (outbound only).
	dbClient := dbapis.New()
	if f := os.Getenv("LABGO_DATABASES_FILE"); f != "" {
		if b, err := os.ReadFile(f); err == nil {
			var items []dbapis.Database
			if json.Unmarshal(b, &items) == nil {
				dbapis.SetDatabases(items)
			}
		}
	}
	dbHandler := &dbapis.Handler{Client: dbClient, Prober: dbapis.NewProber()}

	// --- endpoints / health / embed / lab files / catalog.
	var epMap endpoints.Map
	endpointsPath := strings.TrimSpace(os.Getenv("LABGO_ENDPOINTS_FILE"))
	if endpointsPath != "" {
		if m, err := endpoints.Load(endpointsPath); err == nil {
			epMap = m
		}
	}
	var healthProber *health.Prober
	if ttl, _ := strconv.Atoi(env("LABGO_HEALTH_TTL", "30")); ttl > 0 {
		healthProber = health.New(time.Duration(ttl) * time.Second)
	}
	embedProber := embed.New(60 * time.Second)
	_ = embedProber

	// --- live lab file registry over /srv/lab. The ACL file carries the same
	// scopes the portal edits, so the browser and the disk agree.
	var fileRegistry *labfiles.Registry
	{
		root := env("LABGO_LAB_ROOT", "/srv/lab")
		aclPath := env("LABGO_ACL_FILE", "/etc/lab-go/acl/labgo-acl.json")
		acl, err := labfiles.LoadACL(aclPath)
		if err != nil {
			log.Printf("WARN: lab file ACL %q: %v (fail closed)", aclPath, err)
			acl = labfiles.ACL{}
		}
		fileRegistry = labfiles.NewWithACL(root, acl, aclPath)
		if err := fileRegistry.Scan(); err != nil {
			log.Printf("WARN: lab file scan: %v", err)
		} else {
			log.Printf("lab file registry: root=%s entries=%d", root, fileRegistry.Count())
		}
		// 回收站目录必须先可用，否则删除会整批失败；启动时探测一次并给出修复命令。
		if err := fileRegistry.PrepareTrash(); err != nil {
			log.Printf("WARN: lab trash unavailable (%v); fix with: install -d -m 0700 -o %d -g %d %s",
				err, os.Getuid(), os.Getgid(), fileRegistry.TrashDir())
		} else {
			log.Printf("lab trash: dir=%s retention=%d days", fileRegistry.TrashDir(), labfiles.TrashRetentionDays())
			// 保留期一过就没人再有权恢复了，留着只是白占磁盘，所以启动即清一次。
			if _, err := fileRegistry.PurgeExpired(); err != nil {
				log.Printf("WARN: trash sweep: %v", err)
			}
		}
	}

	// The corpus needs the SnapOtter catalogue, so it is built after the
	// service clients exist.
	if corpusIdx != nil {
		corpusIdx.Build(
			corpusServices(catalog.Default()),
			corpusCommands(corpusCommandsPath),
			corpusTools(snapHandler),
		)
		log.Printf("corpus: %d entries (services+commands+tools+databases)", corpusIdx.Size())
	}

	// --- file access audit (preview/download history for the admin panel).
	var auditStore *fileaudit.Store
	if labDB != nil {
		auditStore = &fileaudit.Store{DB: labDB}
	}

	server := &httpapi.Server{
		Verify:       verifier,
		Session:      sess,
		Files:        fileRegistry,
		FileAudit:    auditStore,
		LifeDB:       lifedb.New(),
		Registry:     registry.New(),
		Platform:     platform.Default(),
		Catalog:      catalog.Default(),
		Search:       searchSvc,
		Vault:        newVault(),
		Health:       healthProber,
		Embed:        embedProber,
		Corpus:       corpusIdx,
		WebSearch:    websearch.New(os.Getenv("SEARXNG_BASE_URL")),
		ServiceToken: os.Getenv("LABSPACE_SERVICE_TOKEN"),
		BackendBase:  env("LABSPACE_BACKEND_BASE", "http://127.0.0.1:8088"),
		Endpoints:    epMap,
		Workbench:    wbHandler,
		Plot:         plotHandler,
		Portal:       portalHandler,
		SnapOtter:    snapHandler,
		DBAPIs:       dbHandler,
		Colors:       colorLab(),
		CropGenome:   cropGenomeProxy(),
	}

	addr := env("LABGO_ADDR", "127.0.0.1:8122")
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           server,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      120 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 16,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	// --- background refresh: re-index the lab files, re-export the shared
	// service catalogue and reload the endpoint map. The Python side reads
	// the export file, so it has to stay fresh.
	catalogExportPath := env("LABGO_CATALOG_EXPORT", "/srv/labdata/labgo/catalog.json")
	writeCatalogExport := func() {
		if catalogExportPath == "" {
			return
		}
		if err := catalog.WriteExport(catalog.Default(), catalogExportPath); err != nil {
			log.Printf("WARN: catalogue export: %v", err)
		}
	}
	writeCatalogExport()
	go func() {
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if fileRegistry != nil {
					if err := fileRegistry.Scan(); err != nil {
						log.Printf("WARN: lab file scan: %v", err)
					}
					// 保留期到期是回收站唯一的自动出口，靠这个心跳生效。
					if _, err := fileRegistry.PurgeExpired(); err != nil {
						log.Printf("WARN: trash sweep: %v", err)
					}
				}
				if endpointsPath != "" {
					if m, err := endpoints.Load(endpointsPath); err == nil {
						server.Endpoints = m
					}
				}
				writeCatalogExport()
			}
		}
	}()

	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(c)
	}()
	log.Printf("LabGo reference server on %s (loopback only; fail-closed)", addr)

	// --- 组会汇报的周目录定期压缩：老周目录打包成 tar.gz，省空间。
	// 保留窗口由 LABGO_MEETING_KEEP_WEEKS 决定（默认 8 周）。
	meetingKeepWeeks := 8
	if n, err := strconv.Atoi(env("LABGO_MEETING_KEEP_WEEKS", "8")); err == nil && n >= 0 {
		meetingKeepWeeks = n
	}
	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if fileRegistry == nil {
					continue
				}
				compressed, err := fileRegistry.CompressOldMeetingFolders(meetingKeepWeeks)
				if err != nil {
					log.Printf("WARN: meeting archive: %v", err)
					continue
				}
				if len(compressed) > 0 {
					log.Printf("meeting archive: compressed %d week folders", len(compressed))
				}
			}
		}
	}()

	// --- Docker bridge listener: containers reach the core through the
	// host bridge address (the portal backend calls the core this way).
	bridgeAddr := strings.TrimSpace(os.Getenv("LABGO_BRIDGE_ADDR"))
	var bridgeServer *http.Server
	if bridgeAddr != "" {
		bridgeServer = &http.Server{
			Addr:              bridgeAddr,
			Handler:           server,
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       15 * time.Second,
			WriteTimeout:      120 * time.Second,
			IdleTimeout:       60 * time.Second,
			MaxHeaderBytes:    1 << 16,
		}
		go func() {
			log.Printf("LabGo docker-bridge listener on %s", bridgeAddr)
			if err := bridgeServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Printf("WARN: bridge listener: %v", err)
			}
		}()
		defer func() {
			c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = bridgeServer.Shutdown(c)
		}()
	}

	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// revokedSessions reads the portal's session-revocation table. A subject is
// invalid from revoked_at onward, which is how 禁用/删除 reaches a cookie that
// was issued earlier and is still inside its validity window.
func revokedSessions(db *sql.DB) session.RevocationSource {
	return func(ctx context.Context, subject string) (int64, bool, error) {
		var at int64
		err := db.QueryRowContext(ctx,
			`SELECT extract(epoch FROM revoked_at)::bigint
			   FROM labspace.session_revocation WHERE subject = ?`, subject).Scan(&at)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			return 0, false, nil
		case err != nil:
			// The portal owns this table's DDL; before its first start the
			// table may not exist, which is the same as "nobody revoked".
			if strings.Contains(err.Error(), "session_revocation") &&
				strings.Contains(err.Error(), "does not exist") {
				return 0, false, nil
			}
			return 0, false, err
		}
		return at, true, nil
	}
}

// catalogHasService reports whether id is a known service (any role).
// Favorites accept the same set the Python route accepted.
func catalogHasService(id string) bool {
	for _, it := range catalog.Default().Items() {
		if it.ID == id {
			return true
		}
	}
	return false
}

// corpusServices maps the live service catalogue onto corpus entries.
func corpusServices(cat *catalog.Service) []corpus.Service {
	if cat == nil {
		return nil
	}
	out := make([]corpus.Service, 0, len(cat.Items()))
	for _, it := range cat.Items() {
		out = append(out, corpus.Service{
			ID:          it.ID,
			Name:        it.Name,
			Description: it.Description,
			URL:         it.URL,
			Tags:        it.Tags,
			Enabled:     it.Enabled,
		})
	}
	return out
}

// corpusCommands loads the Linux command index (621 entries).
func corpusCommands(path string) []corpus.Command {
	if path == "" {
		return nil
	}
	cmds, err := commands.Load(path)
	if err != nil {
		log.Printf("WARN: command index %q: %v", path, err)
		return nil
	}
	return cmds
}

// corpusTools returns the SnapOtter file-processing catalogue.
func corpusTools(h *snapotter.Handler) []corpus.Tool {
	if h == nil || h.Client == nil || !h.Client.Configured() {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tools, err := h.Client.Catalog(ctx)
	if err != nil {
		log.Printf("WARN: snapotter catalogue: %v", err)
		return h.Client.Snapshot()
	}
	return tools
}

// cropGenomeProxy wires the CropGenome Toolkit behind the core. The toolkit
// is optional: without CROPGENOME_URL the route stays disabled.
func cropGenomeProxy() *httpapi.CropGenome {
	base := strings.TrimSpace(os.Getenv("CROPGENOME_URL"))
	if base == "" {
		return nil
	}
	return &httpapi.CropGenome{
		BaseURL:  base,
		Issuer:   env("CROPGENOME_ISSUER", "http://192.0.2.10:8090"),
		Audience: env("CROPGENOME_AUDIENCE", "cropgenome"),
		Timeout:  120 * time.Second,
	}
}

func colorLab() *colorlab.Service {
	svc, err := colorlab.New()
	if err != nil {
		log.Print("WARN: color lab disabled: ", err)
		return nil
	}
	log.Printf("colorlab: %d palettes loaded", svc.Total())
	return svc
}

func newVault() *vault.Vault {
	key := []byte(env("LABGO_VAULT_KEY", ""))
	// vault.New 要求密钥恰好 32 字节（AES-256-GCM）；之前用 <16 判断，
	// 任何非 32 字节的密钥都会在这里静默变成「vault 未启用」。
	if len(key) != 32 {
		if len(key) != 0 {
			log.Printf("WARN: LABGO_VAULT_KEY 必须恰好 32 字节（当前 %d 字节），vault 已禁用", len(key))
		}
		return nil
	}
	v, err := vault.New(key)
	if err != nil {
		log.Printf("WARN: vault disabled: %v", err)
		return nil
	}
	return v
}

func splitEnv(key, def string) []string {
	raw := env(key, def)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
