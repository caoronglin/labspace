// Package pgwire implements a minimal PostgreSQL v3 wire-protocol driver for
// database/sql using only the Go standard library.
//
// Why this exists: the Go core deliberately ships with zero external
// dependencies (GOPROXY=off builds must work). PostgreSQL however needs a
// driver. Rather than vendoring pgx/libpq (which would break that constraint),
// we implement the subset of the frontend/backend protocol that the portal
// actually uses: startup, cleartext/MD5/SCRAM-SHA-256 auth, and the extended
// query protocol with text-format parameters and results.
//
// Supported: parameterized SELECT/INSERT/UPDATE/DELETE, transactions,
// context cancellation/deadline, $1-style placeholders (converted from ?).
// Not supported: TLS (terminate upstream or use a Unix socket), binary format,
// COPY, LISTEN/NOTIFY, server-side prepared statement caching, arrays returned
// as native Go slices (they arrive as text). These are documented limitations,
// not silently dropped features.
//
// Register the driver from main with pgwire.Register() or call sql.Open with
// the name "pgwire"; business code only ever depends on *sql.DB.
package pgwire

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"strings"
	"sync"
)

// driverName is the name used with sql.Open / sql.Register.
const driverName = "pgwire"

var registerOnce sync.Once

// Register installs the driver with database/sql. Calling it more than once is
// harmless. It is also called from init() so sql.Open("pgwire", ...) works
// without an explicit call.
func Register() {
	registerOnce.Do(func() { sql.Register(driverName, &pgDriver{}) })
}

func init() { Register() }

type pgDriver struct{}

func (d *pgDriver) Open(name string) (driver.Conn, error) {
	return d.OpenConnector(name).Connect(context.Background())
}

func (d *pgDriver) OpenConnector(name string) driver.Connector {
	return &connector{dsn: name}
}

type connector struct{ dsn string }

func (c *connector) Connect(ctx context.Context) (driver.Conn, error) {
	cfg, err := parseConnString(c.dsn)
	if err != nil {
		return nil, err
	}
	nc, err := dial(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return &pgConnWrapper{pg: nc}, nil
}

func (c *connector) Driver() driver.Driver { return &pgDriver{} }

// pgConnWrapper adapts the wire connection to database/sql interfaces.
// database/sql serializes access to a single Conn, so the extra mutex on pgconn
// is only defensive.
type pgConnWrapper struct {
	pg     *pgconn
	closed bool
}

func (w *pgConnWrapper) Prepare(query string) (driver.Stmt, error) {
	return &pgStmt{pg: w.pg, query: query}, nil
}
func (w *pgConnWrapper) Close() error {
	if w.closed {
		return nil
	}
	w.closed = true
	w.pg.mu.Lock()
	w.pg.closed = true
	w.pg.mu.Unlock()
	return w.pg.conn.Close()
}
func (w *pgConnWrapper) Begin() (driver.Tx, error) {
	if _, err := w.pg.exec(context.Background(), "BEGIN", nil); err != nil {
		return nil, err
	}
	return &pgTx{pg: w.pg}, nil
}
func (w *pgConnWrapper) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	if opts.ReadOnly {
		if _, err := w.pg.exec(ctx, "BEGIN READ ONLY", nil); err != nil {
			return nil, err
		}
	} else {
		if _, err := w.pg.exec(ctx, "BEGIN", nil); err != nil {
			return nil, err
		}
	}
	return &pgTx{pg: w.pg}, nil
}

// QueryContext/ExecContext are preferred by database/sql when available.
func (w *pgConnWrapper) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	return w.pg.query(ctx, toDollar(query), args)
}
func (w *pgConnWrapper) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	return w.pg.exec(ctx, toDollar(query), args)
}
func (w *pgConnWrapper) Ping(ctx context.Context) error {
	_, err := w.pg.query(ctx, "SELECT 1", nil)
	return err
}

var _ driver.QueryerContext = (*pgConnWrapper)(nil)
var _ driver.ExecerContext = (*pgConnWrapper)(nil)
var _ driver.Pinger = (*pgConnWrapper)(nil)
var _ driver.ConnBeginTx = (*pgConnWrapper)(nil)

// toDollar converts the ? placeholders used by portable SQL into PostgreSQL's
// $1, $2, ... form. It skips ? inside single-quoted string literals so that
// JSON operators or literal question marks are not mangled.
func toDollar(q string) string {
	var b strings.Builder
	inQuote := false
	n := 0
	for i := 0; i < len(q); i++ {
		ch := q[i]
		if ch == '\'' {
			if inQuote && i+1 < len(q) && q[i+1] == '\'' {
				b.WriteByte(ch)
				b.WriteByte(q[i+1])
				i++
				continue
			}
			inQuote = !inQuote
			b.WriteByte(ch)
			continue
		}
		if ch == '?' && !inQuote {
			n++
			b.WriteByte('$')
			b.WriteString(itoa(n))
			continue
		}
		b.WriteByte(ch)
	}
	return b.String()
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

type pgStmt struct {
	pg    *pgconn
	query string
}

func (s *pgStmt) Close() error  { return nil }
func (s *pgStmt) NumInput() int { return -1 } // let the driver count
func (s *pgStmt) Exec(args []driver.Value) (driver.Result, error) {
	return s.pg.exec(context.Background(), toDollar(s.query), named(args))
}
func (s *pgStmt) Query(args []driver.Value) (driver.Rows, error) {
	return s.pg.query(context.Background(), toDollar(s.query), named(args))
}
func (s *pgStmt) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	return s.pg.exec(ctx, toDollar(s.query), args)
}
func (s *pgStmt) QueryContext(ctx context.Context, args []driver.NamedValue) (driver.Rows, error) {
	return s.pg.query(ctx, toDollar(s.query), args)
}

var _ driver.StmtExecContext = (*pgStmt)(nil)
var _ driver.StmtQueryContext = (*pgStmt)(nil)

func named(args []driver.Value) []driver.NamedValue {
	out := make([]driver.NamedValue, len(args))
	for i, a := range args {
		out[i] = driver.NamedValue{Ordinal: i + 1, Value: a}
	}
	return out
}

type pgTx struct{ pg *pgconn }

func (t *pgTx) Commit() error {
	_, err := t.pg.exec(context.Background(), "COMMIT", nil)
	return err
}
func (t *pgTx) Rollback() error {
	_, err := t.pg.exec(context.Background(), "ROLLBACK", nil)
	return err
}

// ConvertError maps backend errors to database/sql sentinel values so callers
// can use errors.Is(...). Unknown SQLSTATEs are returned unchanged.
func ConvertError(err error) error {
	if err == nil {
		return nil
	}
	var pe *pgError
	if errors.As(err, &pe) {
		switch pe.code {
		case "23505": // unique_violation
			return errors.Join(err, errUnique)
		case "40001": // serialization_failure
			return err
		}
	}
	return err
}

var errUnique = errors.New("duplicate key")

// ErrUnsupportedTLS lets the caller produce a clear startup message rather
// than a cryptic network error when sslmode=require is configured.
var ErrUnsupportedTLS = errors.New("pgwire: TLS must be terminated upstream (sslmode=disable or prefer)")

var _ = io.EOF
