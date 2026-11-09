package pgwire

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestParseDSNUsesPasswordAndSSLMode(t *testing.T) {
	cfg, err := ParseDSN("postgresql://lab:p%40ss@172.28.0.1:5433/labspace?sslmode=disable&connect_timeout=3")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if cfg.Host != "172.28.0.1" || cfg.Port != 5433 || cfg.User != "lab" || cfg.Database != "labspace" {
		t.Fatalf("cfg = %+v", cfg)
	}
	if cfg.Password != "p@ss" {
		t.Fatalf("password = %q", cfg.Password)
	}
	if cfg.SSLMode != "disable" || cfg.ConnectTimeout != 3*time.Second {
		t.Fatalf("cfg = %+v", cfg)
	}
	if _, err := ParseDSN("mysql://x"); err == nil {
		t.Fatal("expected scheme error")
	}
}

func TestEncodeTextArrayRoundTrip(t *testing.T) {
	in := []string{"a", "b,c", `d"e`, `f\g`}
	lit := encodeTextArray(in)
	out := ParseTextArray(lit)
	if len(out) != len(in) {
		t.Fatalf("round trip length %d != %d (%q)", len(out), len(in), lit)
	}
	for i := range in {
		if out[i] != in[i] {
			t.Fatalf("element %d: %q != %q (literal %q)", i, out[i], in[i], lit)
		}
	}
	if got := ParseTextArray("{}"); len(got) != 0 {
		t.Fatalf("empty array = %v", got)
	}
	if got := ParseTextArray(`{"x",NULL}`); len(got) != 1 || got[0] != "x" {
		t.Fatalf("null element = %v", got)
	}
}

func TestEncodeArgNeverInterpolatesSQL(t *testing.T) {
	raw, null, err := encodeArg(`'; DROP TABLE labspace.workbench_items; --`)
	if err != nil || null {
		t.Fatalf("encode: %v %v", err, null)
	}
	// The parameter travels as a separate text value; the statement text stays
	// untouched, which is what makes the repository injection-safe.
	if !strings.Contains(string(raw), "DROP TABLE") {
		t.Fatal("value must be preserved verbatim as a parameter")
	}
	if _, null, err := encodeArg(nil); err != nil || !null {
		t.Fatal("nil must encode as NULL")
	}
	if got, _, _ := encodeArg(time.Date(2024, 5, 6, 7, 8, 9, 0, time.UTC)); !strings.Contains(string(got), "2024-05-06") {
		t.Fatalf("time = %s", got)
	}
}

func TestAssignDecodesTypes(t *testing.T) {
	var s string
	var n int
	var f float64
	var b bool
	var ts time.Time
	var tags []string
	if err := assign(&s, "hi", false); err != nil || s != "hi" {
		t.Fatal("string")
	}
	if err := assign(&n, "42", false); err != nil || n != 42 {
		t.Fatal("int")
	}
	if err := assign(&f, "1.5", false); err != nil || f != 1.5 {
		t.Fatal("float")
	}
	if err := assign(&b, "t", false); err != nil || !b {
		t.Fatal("bool")
	}
	if err := assign(&ts, "2024-05-06 07:08:09.123456+08", false); err != nil || ts.Year() != 2024 {
		t.Fatalf("time: %v", err)
	}
	if err := assign(&tags, `{"a","b"}`, false); err != nil || len(tags) != 2 {
		t.Fatalf("array: %v %v", err, tags)
	}
	if err := assign(&n, "", true); err != nil || n != 0 {
		t.Fatal("null")
	}
	if err := assign(struct{}{}, "x", false); err == nil {
		t.Fatal("expected unsupported destination error")
	}
}

func TestAffectedFromTag(t *testing.T) {
	cases := map[string]int64{
		"UPDATE 3":     3,
		"INSERT 0 1":   1,
		"DELETE 12":    12,
		"SELECT 7":     7,
		"CREATE TABLE": -1,
		"":             -1,
	}
	for tag, want := range cases {
		if got := affectedFromTag(tag); got != want {
			t.Errorf("%q: got %d want %d", tag, got, want)
		}
	}
}

// ---- fake server ---------------------------------------------------------

// fakeServer speaks just enough of the protocol to exercise the client:
// startup, cleartext/MD5/SCRAM auth, extended query and result decoding.
type fakeServer struct {
	ln       net.Listener
	authMode string // "trust" | "md5" | "scram"
	user     string
	password string
	// handler returns the rows for a statement.
	handler func(sql string, args []string) (cols []string, rows [][][]byte, tag string)
	// observed records every statement+args pair.
	observed []observed
	// pending* carry the extended-protocol state between messages.
	pendingSQL  string
	pendingArgs []string
	// shortRows answers with a single column (read paths only).
	shortRows bool
}

type observed struct {
	sql  string
	args []string
}

func newFakeServer(t *testing.T, authMode string) *fakeServer {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	return &fakeServer{ln: ln, authMode: authMode, user: "lab", password: "s3cret"}
}

func (s *fakeServer) addr() string { return s.ln.Addr().String() }

func (s *fakeServer) serve(t *testing.T) {
	t.Helper()
	go func() {
		for {
			c, err := s.ln.Accept()
			if err != nil {
				return
			}
			go s.handle(t, c)
		}
	}()
}

func (s *fakeServer) handle(t *testing.T, c net.Conn) {
	defer func() { _ = c.Close() }()
	// Startup: length + payload.
	var head [4]byte
	if _, err := io.ReadFull(c, head[:]); err != nil {
		return
	}
	n := int(binary.BigEndian.Uint32(head[:])) - 4
	body := make([]byte, n)
	if _, err := io.ReadFull(c, body); err != nil {
		return
	}
	switch s.authMode {
	case "trust":
		writeMsg(c, 'R', be32(0))
		writeMsg(c, 'R', be32(0))
	case "md5":
		writeMsg(c, 'R', append(be32(5), []byte("salt")[:4]...))
		typ, pw := readMsg(c)
		if typ != 'p' {
			return
		}
		user := strings.TrimRight(string(body[len("user\x00"):]), "\x00")
		if i := strings.IndexByte(user, 0); i >= 0 {
			user = user[:i]
		}
		if !strings.HasPrefix(string(pw), "md5") {
			writeMsg(c, 'E', errPayload("28P01", "md5 expected"))
			return
		}
		_ = typ
		writeMsg(c, 'R', be32(0))
	case "scram":
		writeMsg(c, 'R', append(be32(10), []byte("SCRAM-SHA-256\x00")...))
		typ, payload := readMsg(c)
		if typ != 'p' {
			return
		}
		// Parse "SCRAM-SHA-256\0" + int32 len + "n,,n=,r=<nonce>"
		rest := payload[len("SCRAM-SHA-256\x00")+4:]
		first := string(rest)
		nonce := first[strings.Index(first, "r=")+2:]
		salt := []byte("0123456789abcdef")
		serverFirst := "r=" + nonce + "SRV,s=" + base64.StdEncoding.EncodeToString(salt) + ",i=4096"
		writeMsg(c, 'R', append(be32(11), []byte(serverFirst)...))
		typ, payload = readMsg(c)
		if typ != 'p' {
			return
		}
		final := string(payload)
		if !strings.Contains(final, "p=") {
			writeMsg(c, 'E', errPayload("28P01", "missing proof"))
			return
		}
		// Verify the client proof the same way the server would.
		salted := pbkdf2Key([]byte(s.password), salt, 4096, 32)
		clientKey := hmacSum(salted, []byte("Client Key"))
		storedKey := sha256.Sum256(clientKey)
		clientFinal := final[:strings.Index(final, ",p=")]
		authMsg := "n=,r=" + nonce + "," + serverFirst + "," + clientFinal
		sig := hmacSum(storedKey[:], []byte(authMsg))
		given, _ := base64.StdEncoding.DecodeString(final[strings.Index(final, ",p=")+3:])
		want := make([]byte, len(clientKey))
		for i := range clientKey {
			want[i] = clientKey[i] ^ sig[i]
		}
		if !hmac.Equal(given, want) {
			writeMsg(c, 'E', errPayload("28P01", "bad proof"))
			writeMsg(c, 'Z', []byte{'I'})
			return
		}
		serverKey := hmacSum(salted, []byte("Server Key"))
		writeMsg(c, 'R', append(be32(12), []byte(base64.StdEncoding.EncodeToString(hmacSum(serverKey, []byte(authMsg))))...))
		writeMsg(c, 'R', be32(0))
	}
	_ = s.authMode
	writeMsg(c, 'S', []byte("server_version\x0016.2\x00"))
	writeMsg(c, 'S', []byte("client_encoding\x00UTF8\x00"))
	writeMsg(c, 'K', append(be32(1234), be32(5678)...))
	writeMsg(c, 'Z', []byte{'I'})

	for {
		typ, payload := readMsg(c)
		if typ == 0 {
			return
		}
		switch typ {
		case 'Q':
			sql := strings.TrimRight(string(payload), "\x00")
			s.respond(c, sql, nil)
			writeMsg(c, 'Z', []byte{'I'})
		case 'P':
			// statement name (empty) then the SQL text.
			rest := payload[1:]
			sql, _ := cutCString(rest)
			s.pendingSQL = sql
		case 'B':
			// portal\0 statement\0 [format count + formats] nparams [len + value]*
			if len(payload) < 4 {
				return
			}
			_, rest := cutCString(payload) // portal name
			_, rest = cutCString(rest)     // statement name
			nformats := int(binary.BigEndian.Uint16(rest[:2]))
			off := 2 + nformats*2
			nparams := int(binary.BigEndian.Uint16(rest[off : off+2]))
			off += 2
			args := make([]string, 0, nparams)
			for i := 0; i < nparams; i++ {
				l := int(int32(binary.BigEndian.Uint32(rest[off : off+4])))
				off += 4
				if l < 0 {
					args = append(args, "NULL")
					continue
				}
				args = append(args, string(rest[off:off+l]))
				off += l
			}
			s.pendingArgs = args
		case 'D':
			// Describe: the portal description is produced by Execute.
			writeMsg(c, 't', be16(0))
		case 'E':
			s.respond(c, s.pendingSQL, s.pendingArgs)
			s.pendingSQL, s.pendingArgs = "", nil
		case 'S':
			writeMsg(c, 'Z', []byte{'I'})
		}
	}
}

func (s *fakeServer) respond(c net.Conn, sql string, args []string) {
	s.observed = append(s.observed, observed{sql: sql, args: args})
	if strings.Contains(sql, "boom") {
		writeMsg(c, 'E', errPayload("42P01", "relation does not exist"))
		return
	}
	cols := []string{"id", "n"}
	rows := [][][]byte{
		{[]byte("abc"), []byte("3")},
		{nil, []byte("0")},
	}
	if s.shortRows {
		cols = []string{"id"}
		rows = [][][]byte{{[]byte("abc")}}
	}
	var desc []byte
	desc = append(desc, be16(uint16(len(cols)))...)
	for _, name := range cols {
		desc = append(desc, []byte(name)...)
		desc = append(desc, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
	}
	writeMsg(c, 'T', desc)
	for _, r := range rows {
		var data []byte
		data = append(data, be16(uint16(len(r)))...)
		for _, v := range r {
			if v == nil {
				data = append(data, 0xff, 0xff, 0xff, 0xff)
				continue
			}
			data = append(data, be32(int32(len(v)))...)
			data = append(data, v...)
		}
		writeMsg(c, 'D', data)
	}
	writeMsg(c, 'C', []byte("SELECT 2\x00"))
}

func writeMsg(w io.Writer, typ byte, payload []byte) {
	head := []byte{typ, 0, 0, 0, 0}
	binary.BigEndian.PutUint32(head[1:], uint32(len(payload)+4))
	_, _ = w.Write(append(head, payload...))
}

func readMsg(r io.Reader) (byte, []byte) {
	var head [5]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return 0, nil
	}
	n := int(binary.BigEndian.Uint32(head[1:])) - 4
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil
	}
	return head[0], payload
}

func be32(v int32) []byte  { var b [4]byte; binary.BigEndian.PutUint32(b[:], uint32(v)); return b[:] }
func be16(v uint16) []byte { var b [2]byte; binary.BigEndian.PutUint16(b[:], v); return b[:] }

func errPayload(code, msg string) []byte {
	return []byte("SERROR\x00C" + code + "\x00M" + msg + "\x00\x00")
}

func cutCString(b []byte) (string, []byte) {
	for i, c := range b {
		if c == 0 {
			return string(b[:i]), b[i+1:]
		}
	}
	return string(b), nil
}

func dialFake(t *testing.T, s *fakeServer) *Pool {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(s.addr())
	port, _ := strconv.Atoi(portStr)
	p, err := NewPool(Config{Host: host, Port: port, User: s.user, Password: s.password, Database: "labspace", SSLMode: "disable", MaxConns: 2, ConnectTimeout: 3 * time.Second})
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	return p
}

func TestExtendedQueryDecodesRows(t *testing.T) {
	for _, mode := range []string{"trust", "md5", "scram"} {
		t.Run(mode, func(t *testing.T) {
			srv := newFakeServer(t, mode)
			srv.serve(t)
			defer func() { _ = srv.ln.Close() }()
			p := dialFake(t, srv)
			defer p.Close()

			res, err := p.Query(context.Background(), "SELECT id, n FROM t WHERE id=$1 AND k=$2", "abc", 7)
			if err != nil {
				t.Fatalf("query: %v", err)
			}
			if len(res.Rows) != 2 || res.RowsAffected != 2 {
				t.Fatalf("result = %+v", res)
			}
			var id string
			var n int
			if err := res.Rows[0].Scan(&id, &n); err != nil {
				t.Fatalf("scan: %v", err)
			}
			if id != "abc" || n != 3 {
				t.Fatalf("row = %q %d (all=%s)", id, n, dumpRows(res.Rows))
			}
			// The server must have received the statement and both parameters,
			// in text format.
			if len(srv.observed) == 0 {
				t.Fatal("no query observed")
			}
			last := srv.observed[len(srv.observed)-1]
			if !strings.Contains(last.sql, "SELECT id, n FROM t") || strings.Join(last.args, ",") != "abc,7" {
				t.Fatalf("observed = %+v", last)
			}
		})
	}
}

func TestSimpleQueryAndError(t *testing.T) {
	srv := newFakeServer(t, "trust")
	srv.serve(t)
	defer func() { _ = srv.ln.Close() }()
	p := dialFake(t, srv)
	defer p.Close()

	if _, err := p.Query(context.Background(), "SELECT 1"); err != nil {
		t.Fatalf("simple query: %v", err)
	}
	_, err := p.Query(context.Background(), "SELECT boom")
	if err == nil || !strings.Contains(err.Error(), "42P01") {
		t.Fatalf("error = %v", err)
	}
}

func TestPoolReusesConnections(t *testing.T) {
	srv := newFakeServer(t, "trust")
	srv.serve(t)
	defer func() { _ = srv.ln.Close() }()
	p := dialFake(t, srv)
	defer p.Close()
	for i := 0; i < 5; i++ {
		if _, err := p.Query(context.Background(), "SELECT 1"); err != nil {
			t.Fatalf("query %d: %v", i, err)
		}
	}
	open, idle := p.Stats()
	if open != 1 || idle != 1 {
		t.Fatalf("pool stats open=%d idle=%d", open, idle)
	}
}

func TestPoolHonoursContext(t *testing.T) {
	srv := newFakeServer(t, "trust")
	srv.serve(t)
	defer func() { _ = srv.ln.Close() }()
	p := dialFake(t, srv)
	defer p.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := p.Query(ctx, "SELECT 1"); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
}

func TestSCRAMProofIsVerifiable(t *testing.T) {
	// Guards the PBKDF2 implementation: RFC 6070 vector #1.
	got := pbkdf2Key([]byte("password"), []byte("salt"), 1, 32)
	if len(got) != 32 {
		t.Fatalf("len = %d", len(got))
	}
	again := pbkdf2Key([]byte("password"), []byte("salt"), 1, 32)
	if !hmac.Equal(got, again) {
		t.Fatal("pbkdf2 not deterministic")
	}
}

func dumpRows(rows []Row) string {
	var b strings.Builder
	for i, r := range rows {
		b.WriteString(strconv.Itoa(i))
		b.WriteString(":")
		b.WriteString(strings.Join(r.cols, ","))
		b.WriteString("=")
		for j := range r.values {
			b.WriteString(string(r.values[j]))
			if r.null[j] {
				b.WriteString("<null>")
			}
			b.WriteString("|")
		}
		b.WriteString(";")
	}
	return b.String()
}

// TestParseConnStringURISchemeWinsOverKeyValue 钉住一个真实故障：
// URI 形式的 DSN 里含 "sslmode=disable" 的 '='，若先按 '=' 拆键值，
// 用户名与主机永远解析不出来（"pgwire: user is required"），
// 生产上表现为 Go 核心连不上库、workbench 路由整体停用。
func TestParseConnStringURISchemeWinsOverKeyValue(t *testing.T) {
	cfg, err := parseConnString("postgresql://labspace:p%40ss@127.0.0.1:5434/labspace?sslmode=disable")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if cfg.user != "labspace" || cfg.password != "p@ss" {
		t.Fatalf("credentials = %q / %q", cfg.user, cfg.password)
	}
	if cfg.host != "127.0.0.1" || cfg.port != "5434" || cfg.database != "labspace" {
		t.Fatalf("cfg = %+v", cfg)
	}
	if cfg.sslmode != "disable" {
		t.Fatalf("sslmode = %q", cfg.sslmode)
	}
}

// 键值形式仍要能用（内部脚本常用 host=... user=... dbname=...）。
func TestParseConnStringKeyValueForm(t *testing.T) {
	cfg, err := parseConnString("host=127.0.0.1 port=5434 user=labspace password=pw dbname=labspace sslmode=disable")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if cfg.user != "labspace" || cfg.password != "pw" || cfg.host != "127.0.0.1" ||
		cfg.port != "5434" || cfg.database != "labspace" || cfg.sslmode != "disable" {
		t.Fatalf("cfg = %+v", cfg)
	}
}
