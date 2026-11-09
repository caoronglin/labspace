package blast

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var aliasRE = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$`)

type Database struct{ Alias, ResourceID, Path string }
type Actor struct{ TenantID, UserID string }
type Policy interface {
	Can(context.Context, string, string, string, string) (bool, error)
}
type Catalog interface {
	Resolve(context.Context, string) (Database, error)
}
type Runner interface {
	Run(context.Context, string, []string, string) ([]byte, error)
}
type Request struct {
	Database   string
	Program    string
	QueryFASTA string
	EValue     float64
	MaxTargets int
}
type Result struct {
	Database   string    `json:"database"`
	Program    string    `json:"program"`
	Output     string    `json:"output"`
	FinishedAt time.Time `json:"finished_at"`
}
type Service struct {
	Policy        Policy
	Catalog       Catalog
	Runner        Runner
	Binary        string
	MaxQueryBytes int
}

func (s *Service) Run(ctx context.Context, a Actor, r Request) (Result, error) {
	if s.Policy == nil || s.Catalog == nil || s.Runner == nil {
		return Result{}, errors.New("blast dependencies unavailable")
	}
	if a.TenantID == "" || a.UserID == "" || !aliasRE.MatchString(r.Database) {
		return Result{}, errors.New("invalid identity/database")
	}
	if r.Program != "blastn" && r.Program != "blastp" && r.Program != "blastx" && r.Program != "tblastn" {
		return Result{}, errors.New("unsupported BLAST program")
	}
	maxQuery := s.MaxQueryBytes
	if maxQuery <= 0 {
		maxQuery = 1 << 20
	}
	if len(r.QueryFASTA) < 8 || len(r.QueryFASTA) > maxQuery || !strings.HasPrefix(strings.TrimSpace(r.QueryFASTA), ">") {
		return Result{}, errors.New("invalid or oversized FASTA query")
	}
	if r.EValue <= 0 || r.EValue > 1000 {
		return Result{}, errors.New("invalid evalue")
	}
	if r.MaxTargets < 1 || r.MaxTargets > 500 {
		return Result{}, errors.New("max_targets must be 1..500")
	}
	db, err := s.Catalog.Resolve(ctx, r.Database)
	if err != nil {
		return Result{}, err
	}
	if db.ResourceID == "" || db.Path == "" || !filepath.IsAbs(db.Path) {
		return Result{}, errors.New("invalid BLAST database catalog entry")
	}
	ok, err := s.Policy.Can(ctx, a.TenantID, a.UserID, db.ResourceID, "execute")
	if err != nil {
		return Result{}, err
	}
	if !ok {
		return Result{}, errors.New("BLAST database execute permission denied")
	}
	args := []string{"-db", db.Path, "-evalue", formatFloat(r.EValue), "-max_target_seqs", itoa(r.MaxTargets), "-outfmt", "6 qseqid sseqid pident length mismatch gapopen qstart qend sstart send evalue bitscore"}
	out, err := s.Runner.Run(ctx, s.Binary+filepath.Base(r.Program), args, r.QueryFASTA)
	if err != nil {
		return Result{}, err
	}
	return Result{Database: r.Database, Program: r.Program, Output: string(out), FinishedAt: time.Now().UTC()}, nil
}
func formatFloat(f float64) string {
	return strings.TrimRight(strings.TrimRight(fmtFloat(f), "0"), ".")
}
func fmtFloat(f float64) string { return strconv.FormatFloat(f, 'g', -1, 64) }
func itoa(i int) string         { return strconv.Itoa(i) }

type ExecRunner struct{ MaxOutput int }

func (r ExecRunner) Run(ctx context.Context, binary string, args []string, query string) ([]byte, error) {
	if binary == "" {
		return nil, errors.New("BLAST binary not configured")
	}
	if r.MaxOutput <= 0 {
		r.MaxOutput = 8 << 20
	}
	// Use a temporary FASTA file, not a shell command. The runner receives only server-built arguments.
	f, err := os.CreateTemp("", "labblast-*.fa")
	if err != nil {
		return nil, err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.WriteString(query); err != nil {
		f.Close()
		return nil, err
	}
	if err = f.Close(); err != nil {
		return nil, err
	}
	args = append(args, "-query", name)
	cmd := exec.CommandContext(ctx, binary, args...)
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	if len(out) > r.MaxOutput {
		return nil, errors.New("BLAST output exceeds limit")
	}
	return out, nil
}
