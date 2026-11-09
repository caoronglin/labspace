// Package pgwire is a minimal PostgreSQL frontend/backend protocol (v3) client.
//
// Why hand-rolled: the Go core is deliberately dependency-free (GOPROXY=off
// must build it), so database/sql has no driver. This package implements the
// subset the portal repositories need — startup (trust / cleartext / MD5 /
// SCRAM-SHA-256), simple query, extended query with a fixed parameter type set,
// and text result decoding — and nothing else.
//
// Scope and guarantees:
//   - parameters are always sent as text-format literals through Bind, so
//     values are never concatenated into SQL (no injection surface);
//   - every statement runs on its own connection checkout of a bounded pool;
//   - a failed protocol exchange poisons the connection and closes it instead
//     of returning it to the pool;
//   - the whole package has no knowledge of the portal's domain types.
package pgwire

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"database/sql/driver"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Config describes one PostgreSQL server.
type Config struct {
	Host     string
	Port     int
	User     string
	Password string
	Database string
	// SSLMode accepts disable|prefer|require (verify-* maps to require plus
	// certificate verification).
	SSLMode string
	// ConnectTimeout bounds the TCP connect + startup handshake.
	ConnectTimeout time.Duration
	// StatementTimeout is applied per query when non-zero.
	StatementTimeout time.Duration
	// MaxConns bounds the pool (default 8).
	MaxConns int
}

// ParseDSN understands the URI form used across the platform
// (postgresql://user:pass@host:5432/db?sslmode=disable).
func ParseDSN(dsn string) (Config, error) {
	cfg := Config{Port: 5432, SSLMode: "prefer", ConnectTimeout: 10 * time.Second, MaxConns: 8}
	u, err := url.Parse(dsn)
	if err != nil {
		return cfg, fmt.Errorf("pgwire: invalid DSN: %w", err)
	}
	if u.Scheme != "postgres" && u.Scheme != "postgresql" {
		return cfg, errors.New("pgwire: DSN scheme must be postgres:// or postgresql://")
	}
	cfg.Host = u.Hostname()
	if p := u.Port(); p != "" {
		port, err := strconv.Atoi(p)
		if err != nil {
			return cfg, errors.New("pgwire: invalid port")
		}
		cfg.Port = port
	}
	if u.User != nil {
		cfg.User = u.User.Username()
		if pw, ok := u.User.Password(); ok {
			cfg.Password = pw
		}
	}
	cfg.Database = strings.TrimPrefix(u.Path, "/")
	q := u.Query()
	if v := q.Get("sslmode"); v != "" {
		cfg.SSLMode = v
	}
	if v := q.Get("connect_timeout"); v != "" {
		if secs, err := strconv.Atoi(v); err == nil {
			cfg.ConnectTimeout = time.Duration(secs) * time.Second
		}
	}
	if v := q.Get("statement_timeout"); v != "" {
		if ms, err := strconv.Atoi(v); err == nil {
			cfg.StatementTimeout = time.Duration(ms) * time.Millisecond
		}
	}
	if cfg.Database == "" {
		cfg.Database = cfg.User
	}
	return cfg, nil
}

// Pool is a bounded connection pool.
type Pool struct {
	cfg  Config
	mu   sync.Mutex
	idle []*pgconn
	open int
	cond *sync.Cond
}

// NewPool builds a pool; connections are opened lazily.
func NewPool(cfg Config) (*Pool, error) {
	if cfg.Host == "" {
		return nil, errors.New("pgwire: empty host")
	}
	if cfg.User == "" {
		return nil, errors.New("pgwire: empty user")
	}
	if cfg.Port == 0 {
		cfg.Port = 5432
	}
	if cfg.MaxConns <= 0 {
		cfg.MaxConns = 8
	}
	if cfg.ConnectTimeout <= 0 {
		cfg.ConnectTimeout = 10 * time.Second
	}
	if cfg.SSLMode == "" {
		cfg.SSLMode = "prefer"
	}
	p := &Pool{cfg: cfg}
	p.cond = sync.NewCond(&p.mu)
	return p, nil
}

// Close closes every idle connection.
func (p *Pool) Close() {
	p.mu.Lock()
	idle := p.idle
	p.idle = nil
	p.open -= len(idle)
	p.mu.Unlock()
	for _, c := range idle {
		c.close()
	}
}

// Stats reports pool occupancy.
func (p *Pool) Stats() (open, idle int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.open, len(p.idle)
}

func (p *Pool) acquire(ctx context.Context) (*pgconn, error) {
	for {
		p.mu.Lock()
		if n := len(p.idle); n > 0 {
			c := p.idle[n-1]
			p.idle = p.idle[:n-1]
			p.mu.Unlock()
			return c, nil
		}
		if p.open < p.cfg.MaxConns {
			p.open++
			p.mu.Unlock()
			c, err := dial(ctx, p.cfg.toConfig())
			if err != nil {
				p.mu.Lock()
				p.open--
				p.mu.Unlock()
				return nil, err
			}
			return c, nil
		}
		p.mu.Unlock()
		// Wait for a release, but stay cancellable.
		done := make(chan struct{})
		go func() {
			p.mu.Lock()
			p.cond.Wait()
			p.mu.Unlock()
			close(done)
		}()
		select {
		case <-ctx.Done():
			p.mu.Lock()
			p.cond.Broadcast()
			p.mu.Unlock()
			<-done
			return nil, ctx.Err()
		case <-done:
		}
	}
}

func (p *Pool) release(c *pgconn, broken bool) {
	if broken {
		c.close()
		p.mu.Lock()
		p.open--
		p.cond.Signal()
		p.mu.Unlock()
		return
	}
	p.mu.Lock()
	p.idle = append(p.idle, c)
	p.cond.Signal()
	p.mu.Unlock()
}

// Query runs a parameterised statement and returns text-decoded rows.
func (p *Pool) Query(ctx context.Context, sql string, args ...any) (Result, error) {
	c, err := p.acquire(ctx)
	if err != nil {
		return Result{}, err
	}
	res, err := p.runQuery(ctx, c, sql, args)
	p.release(c, err != nil)
	return res, err
}

// Exec runs a statement and reports the affected count.
func (p *Pool) Exec(ctx context.Context, sql string, args ...any) (int64, error) {
	res, err := p.Query(ctx, sql, args...)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected, nil
}

// Row is one decoded result row.
type Row struct {
	cols   []string
	values [][]byte
	null   []bool
}

// Result carries decoded rows.
type Result struct {
	Columns      []string
	Rows         []Row
	RowsAffected int64
}

// Value returns the raw text of column i.
func (r Row) Value(i int) (string, bool) {
	if i < 0 || i >= len(r.values) || r.null[i] {
		return "", false
	}
	return string(r.values[i]), true
}

// Raw returns the column bytes and the NULL flag (not scanned as SQL NULL when
// the flag is false, even for an empty value).
func (r Row) Raw(i int) (string, bool) {
	if i < 0 || i >= len(r.values) {
		return "", true
	}
	return string(r.values[i]), r.null[i]
}

// Column returns the column name at position i.
func (r Row) Column(i int) string {
	if i < 0 || i >= len(r.cols) {
		return ""
	}
	return r.cols[i]
}

// Get returns column i as a string, empty when NULL.
func (r Row) Get(i int) string {
	s, _ := r.Value(i)
	return s
}

// Len is the column count.
func (r Row) Len() int { return len(r.values) }

// Index returns the column position (case-insensitive), or -1.
func (r Row) Index(name string) int {
	for i, c := range r.cols {
		if strings.EqualFold(c, name) {
			return i
		}
	}
	return -1
}

// Scan decodes positional columns into the given destinations. Supported
// destinations: *string, *int, *int64, *float64, *bool, *time.Time and
// *[]string (PostgreSQL array literal).
func (r Row) Scan(dest ...any) error {
	if len(dest) != len(r.values) {
		return fmt.Errorf("pgwire: scan %d targets into %d columns", len(dest), len(r.values))
	}
	for i, d := range dest {
		raw, isNull := r.Raw(i)
		if err := assign(d, raw, isNull); err != nil {
			return fmt.Errorf("pgwire: column %d (%s): %w", i, r.cols[i], err)
		}
	}
	return nil
}

// ---- connection ----------------------------------------------------------

type conn struct {
	net  net.Conn
	r    *bufio.Reader
	w    *bufio.Writer
	pid  int32
	key  int32
	dead bool
	// SCRAM state carried between the two SASL exchanges.
	cfgUser   string
	cfgPass   string
	serverSig string
}

func (c *conn) close() {
	if c.dead {
		return
	}
	c.dead = true
	_ = c.net.Close()
}

func (c *conn) negotiateTLS(cfg Config) error {
	switch cfg.SSLMode {
	case "disable", "", "allow":
		return nil
	}
	// SSLRequest: int32 length 8, int32 code 80877103.
	msg := make([]byte, 8)
	binary.BigEndian.PutUint32(msg[0:4], 8)
	binary.BigEndian.PutUint32(msg[4:8], 80877103)
	if _, err := c.net.Write(msg); err != nil {
		return fmt.Errorf("pgwire: ssl request: %w", err)
	}
	reply, err := c.r.ReadByte()
	if err != nil {
		return fmt.Errorf("pgwire: ssl reply: %w", err)
	}
	if reply != 'S' {
		if cfg.SSLMode == "prefer" || cfg.SSLMode == "allow" {
			return nil // server does not speak TLS, continue in clear
		}
		return errors.New("pgwire: server refused TLS but sslmode requires it")
	}
	var tcfg *tls.Config
	if strings.HasPrefix(cfg.SSLMode, "verify") {
		tcfg = &tls.Config{ServerName: cfg.Host, MinVersion: tls.VersionTLS12}
	} else {
		// require: encrypt without certificate verification (libpq semantics).
		tcfg = &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS12} //nolint:gosec
	}
	tc := tls.Client(c.net, tcfg)
	if err := tc.Handshake(); err != nil {
		return fmt.Errorf("pgwire: tls handshake: %w", err)
	}
	c.net = tc
	c.r = bufio.NewReaderSize(tc, 32*1024)
	c.w = bufio.NewWriterSize(tc, 32*1024)
	return nil
}

func (c *conn) startup(cfg Config) error {
	var body []byte
	body = append(body, 0, 3, 0, 0) // protocol 3.0
	body = appendKV(body, "user", cfg.User)
	if cfg.Database != "" {
		body = appendKV(body, "database", cfg.Database)
	}
	body = appendKV(body, "application_name", "labgo")
	if cfg.StatementTimeout > 0 {
		body = appendKV(body, "statement_timeout", strconv.Itoa(int(cfg.StatementTimeout.Milliseconds())))
	}
	body = appendKV(body, "client_encoding", "UTF8")
	body = append(body, 0)

	head := make([]byte, 4)
	binary.BigEndian.PutUint32(head, uint32(len(body)+4))
	if _, err := c.w.Write(append(head, body...)); err != nil {
		return fmt.Errorf("pgwire: startup: %w", err)
	}
	if err := c.w.Flush(); err != nil {
		return fmt.Errorf("pgwire: startup flush: %w", err)
	}
	return c.authenticate(cfg)
}

func appendKV(dst []byte, k, v string) []byte {
	dst = append(dst, k...)
	dst = append(dst, 0)
	dst = append(dst, v...)
	return append(dst, 0)
}

// scrambleState for SCRAM-SHA-256.
type scram struct {
	clientNonce string
	firstBare   string
	saltedPW    []byte
}

func (c *conn) authenticate(cfg Config) error {
	var scramState *scram
	for {
		typ, payload, err := c.readMessage()
		if err != nil {
			return err
		}
		switch typ {
		case 'E':
			return fmt.Errorf("pgwire: server error: %w", parseError(payload))
		case 'R':
			if len(payload) < 4 {
				return errors.New("pgwire: short authentication message")
			}
			code := binary.BigEndian.Uint32(payload[:4])
			switch code {
			case 0: // AuthenticationOk
				continue
			case 3: // cleartext
				if err := c.sendPassword(cfg.Password); err != nil {
					return err
				}
			case 5: // MD5
				if len(payload) < 8 {
					return errors.New("pgwire: short md5 salt")
				}
				if err := c.sendPassword(md5Password(cfg.User, cfg.Password, payload[4:8])); err != nil {
					return err
				}
			case 10: // SASL
				scramState, err = c.startSCRAM(cfg, payload[4:])
				if err != nil {
					return err
				}
			case 11: // SASL continue
				if scramState == nil {
					return errors.New("pgwire: unexpected SASL continue")
				}
				if err := c.continueSCRAM(scramState, payload[4:]); err != nil {
					return err
				}
			case 12, 13: // SASL final / SASL continue codes after success
				continue
			default:
				return fmt.Errorf("pgwire: unsupported authentication method %d", code)
			}
		case 'S': // ParameterStatus
			continue
		case 'K': // BackendKeyData
			if len(payload) >= 8 {
				c.pid = int32(binary.BigEndian.Uint32(payload[:4]))
				c.key = int32(binary.BigEndian.Uint32(payload[4:8]))
			}
		case 'Z': // ReadyForQuery
			return nil
		case 'N': // NoticeResponse
			continue
		default:
			return fmt.Errorf("pgwire: unexpected message %q during startup", typ)
		}
	}
}

func (c *conn) sendPassword(pw string) error {
	return c.writeMessage('p', append([]byte(pw), 0))
}

func md5Password(user, password string, salt []byte) string {
	inner := md5.Sum([]byte(password + user))                               //nolint:gosec // protocol requirement
	outer := md5.Sum(append([]byte(hex.EncodeToString(inner[:])), salt...)) //nolint:gosec
	return "md5" + hex.EncodeToString(outer[:])
}

func (c *conn) startSCRAM(cfg Config, mechanisms []byte) (*scram, error) {
	offered := strings.Split(strings.TrimRight(string(mechanisms), "\x00"), "\x00")
	found := false
	for _, m := range offered {
		if m == "SCRAM-SHA-256" {
			found = true
			break
		}
	}
	if !found {
		return nil, errors.New("pgwire: server does not offer SCRAM-SHA-256")
	}
	nonceRaw := make([]byte, 18)
	if _, err := rand.Read(nonceRaw); err != nil {
		return nil, err
	}
	st := &scram{clientNonce: base64.RawStdEncoding.EncodeToString(nonceRaw)}
	st.firstBare = "n=,r=" + st.clientNonce
	first := "n,," + st.firstBare
	n := len(first)
	msg := append([]byte("SCRAM-SHA-256\x00"), byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
	msg = append(msg, first...)
	if err := c.writeMessage('p', msg); err != nil {
		return nil, err
	}
	st.saltedPW = nil
	c.cfgUser = cfg.User
	c.cfgPass = cfg.Password
	return st, nil
}

func (c *conn) continueSCRAM(st *scram, serverFirst []byte) error {
	fields := map[string]string{}
	for _, part := range strings.Split(string(serverFirst), ",") {
		if len(part) >= 2 && part[1] == '=' {
			fields[part[:1]] = part[2:]
		}
	}
	nonce, saltB64, iterStr := fields["r"], fields["s"], fields["i"]
	if !strings.HasPrefix(nonce, st.clientNonce) {
		return errors.New("pgwire: SCRAM nonce mismatch")
	}
	iter, err := strconv.Atoi(iterStr)
	if err != nil || iter < 4096 || iter > 1000000 {
		return errors.New("pgwire: SCRAM iteration count out of range")
	}
	salt, err := base64.StdEncoding.DecodeString(saltB64)
	if err != nil {
		return errors.New("pgwire: SCRAM salt encoding")
	}
	salted := pbkdf2Key([]byte(c.cfgPass), salt, iter, 32)
	clientKey := hmacSum(salted, []byte("Client Key"))
	storedKey := sha256.Sum256(clientKey)
	finalBare := "c=biws,r=" + nonce
	authMessage := st.firstBare + "," + string(serverFirst) + "," + finalBare
	clientSig := hmacSum(storedKey[:], []byte(authMessage))
	proof := make([]byte, len(clientKey))
	for i := range clientKey {
		proof[i] = clientKey[i] ^ clientSig[i]
	}
	serverKey := hmacSum(salted, []byte("Server Key"))
	want := base64.StdEncoding.EncodeToString(hmacSum(serverKey, []byte(authMessage)))
	c.serverSig = want
	final := finalBare + ",p=" + base64.StdEncoding.EncodeToString(proof)
	payload := []byte(final)
	if err := c.writeMessage('p', payload); err != nil {
		return err
	}
	return nil
}

func hmacSum(key, msg []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(msg)
	return m.Sum(nil)
}

// ---- query ---------------------------------------------------------------

func (c *conn) query(ctx context.Context, cfg Config, sql string, args []any) (Result, error) {
	if c.dead {
		return Result{}, errors.New("pgwire: connection closed")
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	if len(args) == 0 {
		return c.simpleQuery(ctx, sql)
	}
	return c.extendedQuery(ctx, sql, args)
}

func (c *conn) simpleQuery(ctx context.Context, sql string) (Result, error) {
	if err := c.writeMessage('Q', append([]byte(sql), 0)); err != nil {
		return Result{}, err
	}
	return c.collect(ctx, nil)
}

func (c *conn) extendedQuery(ctx context.Context, sql string, args []any) (Result, error) {
	var buf []byte
	// Parse
	buf = append(buf, 0) // unnamed statement
	buf = appendCString(buf, sql)
	buf = append(buf, 0, 0) // no parameter type OIDs: everything arrives as text
	if err := c.writeMessage('P', buf); err != nil {
		return Result{}, err
	}
	// Bind
	buf = buf[:0]
	buf = append(buf, 0, 0) // unnamed portal, unnamed statement
	buf = append(buf, 0, 0) // all parameters in text format
	buf = appendUint16(buf, uint16(len(args)))
	for _, a := range args {
		enc, null, err := encodeArg(a)
		if err != nil {
			return Result{}, err
		}
		if null {
			buf = appendInt32(buf, -1)
			continue
		}
		buf = appendInt32(buf, int32(len(enc)))
		buf = append(buf, enc...)
	}
	buf = append(buf, 0, 0) // result formats: all text
	if err := c.writeMessage('B', buf); err != nil {
		return Result{}, err
	}
	// Describe portal
	if err := c.writeMessage('D', append([]byte{'P'}, 0)); err != nil {
		return Result{}, err
	}
	// Execute
	if err := c.writeMessage('E', append([]byte{0}, 0, 0, 0, 0)); err != nil {
		return Result{}, err
	}
	// Sync
	if err := c.writeMessage('S', nil); err != nil {
		return Result{}, err
	}
	return c.collect(ctx, args)
}

func (c *conn) collect(ctx context.Context, _ []any) (Result, error) {
	var res Result
	var pending []Row
	var cols []string
	for {
		if err := ctx.Err(); err != nil {
			c.close()
			return Result{}, err
		}
		typ, payload, err := c.readMessage()
		if err != nil {
			c.close()
			return Result{}, err
		}
		switch typ {
		case 'T': // RowDescription
			desc, derr := parseRowDescription(payload)
			if derr != nil {
				c.close()
				return Result{}, derr
			}
			cols = make([]string, len(desc))
			for i, d := range desc {
				cols[i] = d.name
			}
		case 'D': // DataRow
			vals, derr := parseDataRow(payload, textFields(cols))
			if derr != nil {
				c.close()
				return Result{}, derr
			}
			row := Row{cols: cols, values: make([][]byte, len(vals)), null: make([]bool, len(vals))}
			for i, v := range vals {
				if v == nil {
					row.null[i] = true
					continue
				}
				if b, ok := v.([]byte); ok {
					row.values[i] = b
				} else {
					row.values[i] = []byte(fmt.Sprint(v))
				}
			}
			pending = append(pending, row)
		case 'C': // CommandComplete
			tag := strings.TrimSpace(strings.TrimRight(string(payload), "\x00"))
			if n := affectedFromTag(tag); n >= 0 {
				res.RowsAffected = n
			}
		case 'I': // EmptyQueryResponse
		case 'E':
			perr := parseError(payload)
			// The server is ready for the next message after Sync, but a
			// failed exchange can leave the session in an odd state; the
			// caller closes this connection (see Pool.Query).
			return Result{}, fmt.Errorf("pgwire: %w", perr)
		case 'N', 'S', 'A': // notices / parameter status / notification
		case 'Z': // ReadyForQuery
			res.Columns = cols
			res.Rows = pending
			return res, nil
		case '1', '2', '3', 'n', 's', 't': // parse/bind/close completion
		default:
			c.close()
			return Result{}, fmt.Errorf("pgwire: unexpected message %q", typ)
		}
	}
}

// affectedFromTag extracts n from "UPDATE 3" / "INSERT 0 1" / "DELETE 2".
func affectedFromTag(tag string) int64 {
	parts := strings.Fields(tag)
	if len(parts) == 0 {
		return -1
	}
	switch parts[0] {
	case "INSERT":
		if len(parts) == 3 {
			if n, err := strconv.ParseInt(parts[2], 10, 64); err == nil {
				return n
			}
		}
	case "UPDATE", "DELETE", "SELECT", "MOVE", "FETCH", "COPY", "MERGE":
		if len(parts) >= 2 {
			if n, err := strconv.ParseInt(parts[len(parts)-1], 10, 64); err == nil {
				return n
			}
		}
	}
	return -1
}

func (c *conn) writeMessage(typ byte, payload []byte) error {
	head := make([]byte, 5)
	head[0] = typ
	binary.BigEndian.PutUint32(head[1:], uint32(len(payload)+4))
	if _, err := c.w.Write(head); err != nil {
		return fmt.Errorf("pgwire: write: %w", err)
	}
	if len(payload) > 0 {
		if _, err := c.w.Write(payload); err != nil {
			return fmt.Errorf("pgwire: write: %w", err)
		}
	}
	if err := c.w.Flush(); err != nil {
		return fmt.Errorf("pgwire: flush: %w", err)
	}
	return nil
}

func (c *conn) readMessage() (byte, []byte, error) {
	typ, err := c.r.ReadByte()
	if err != nil {
		return 0, nil, fmt.Errorf("pgwire: read: %w", err)
	}
	var lenBuf [4]byte
	if _, err := io.ReadFull(c.r, lenBuf[:]); err != nil {
		return 0, nil, fmt.Errorf("pgwire: read length: %w", err)
	}
	n := int(int32(binary.BigEndian.Uint32(lenBuf[:]))) - 4
	if n < 0 || n > 1<<24 {
		return 0, nil, errors.New("pgwire: invalid message length")
	}
	payload := make([]byte, n)
	if n > 0 {
		if _, err := io.ReadFull(c.r, payload); err != nil {
			return 0, nil, fmt.Errorf("pgwire: read payload: %w", err)
		}
	}
	return typ, payload, nil
}

func appendUint16(b []byte, v uint16) []byte {
	return append(b, byte(v>>8), byte(v))
}

func appendInt32(b []byte, v int32) []byte {
	return append(b, byte(v>>24), byte(v>>16), byte(v>>8), byte(v))
}

func appendCString(b []byte, s string) []byte {
	b = append(b, s...)
	return append(b, 0)
}

// toConfig adapts the exported Config to the internal (string-port) shape the
// low-level connection code uses.
func (c Config) toConfig() config {
	return config{
		host:            c.Host,
		port:            strconv.Itoa(c.Port),
		user:            c.User,
		password:        c.Password,
		database:        c.Database,
		connectTimeout:  c.ConnectTimeout,
		sslmode:         c.SSLMode,
		applicationName: "labgo-core",
	}
}

// runQuery adapts the pool's variadic arguments to the driver-level query and
// decodes the driver.Rows it returns into the package's own text-only Result.
func (p *Pool) runQuery(ctx context.Context, c *pgconn, query string, args []any) (Result, error) {
	named := make([]driver.NamedValue, len(args))
	for i, a := range args {
		named[i] = driver.NamedValue{Ordinal: i + 1, Value: a}
	}
	rows, err := c.query(ctx, query, named)
	if err != nil {
		return Result{}, err
	}
	defer rows.Close()

	cols := rows.Columns()
	out := Result{Columns: cols}
	for {
		dest := make([]driver.Value, len(cols))
		if err := rows.Next(dest); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return Result{}, err
		}
		row := Row{cols: cols, values: make([][]byte, len(dest)), null: make([]bool, len(dest))}
		for i, v := range dest {
			if v == nil {
				row.null[i] = true
				continue
			}
			row.values[i] = []byte(fmt.Sprint(v))
		}
		out.Rows = append(out.Rows, row)
	}
	out.RowsAffected = c.lastCommandTag
	return out, nil
}

// textFields rebuilds the minimal field descriptors parseDataRow needs when a
// DataRow is decoded straight from the wire instead of via database/sql.
func textFields(cols []string) []fieldDesc {
	out := make([]fieldDesc, len(cols))
	for i, c := range cols {
		out[i] = fieldDesc{name: c, format: 0}
	}
	return out
}
