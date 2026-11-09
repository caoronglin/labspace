// Package pgwire provides a protocol-level mock PostgreSQL backend. It is used
// by integration tests (both in this package and by packages built on top of
// the driver) to exercise the real wire protocol without a live database.
package pgwire

import (
	"crypto/md5"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"
)

func md5sum(b []byte) []byte        { s := md5.Sum(b); return s[:] }
func base64Std(b []byte) string     { return base64.StdEncoding.EncodeToString(b) }
func fromBase64Std(s string) []byte { b, _ := base64.StdEncoding.DecodeString(s); return b }

type MockServer struct {
	ln      net.Listener
	t       *testing.T
	auth    string // trust | cleartext | md5 | scram
	queries []string
	params  [][]string
	err     error
	// replyFn lets a test customize the result set for a given query.
	replyFn func(query string, conn net.Conn) error
}

func NewMockServer(t *testing.T, auth string) *MockServer {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	m := &MockServer{ln: ln, t: t, auth: auth}
	go m.serve()
	return m
}

func (m *MockServer) DSN() string {
	return fmt.Sprintf("host=127.0.0.1 port=%d user=lab password=secret dbname=labspace sslmode=disable", m.ln.Addr().(*net.TCPAddr).Port)
}
func (m *MockServer) Close() { _ = m.ln.Close() }

func msg(typ byte, body []byte) []byte {
	b := make([]byte, 5+len(body))
	b[0] = typ
	binary.BigEndian.PutUint32(b[1:5], uint32(4+len(body)))
	copy(b[5:], body)
	return b
}
func cstr(s string) []byte { return append([]byte(s), 0) }

func readStartup(r io.Reader) ([]byte, error) {
	h := make([]byte, 4)
	if _, err := io.ReadFull(r, h); err != nil {
		return nil, err
	}
	n := int(binary.BigEndian.Uint32(h)) - 4
	if n < 4 || n > 1<<20 {
		return nil, fmt.Errorf("bad startup len %d", n)
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, err
	}
	return body, nil
}

// SetReply installs a custom result-set writer for subsequent Sync messages.
// The callback receives the last Parse'd query text.
func (m *MockServer) SetReply(fn func(query string, conn net.Conn) error) { m.replyFn = fn }

// Queries returns the SQL text of every Parse message seen so far.
func (m *MockServer) Queries() []string { return append([]string(nil), m.queries...) }

// Params returns the bound parameters of every Bind message seen so far.
func (m *MockServer) Params() [][]string { return append([][]string(nil), m.params...) }

func (m *MockServer) serve() {
	for {
		conn, err := m.ln.Accept()
		if err != nil {
			return
		}
		go func() {
			defer conn.Close()
			if e := m.handle(conn); e != nil && !errors.Is(e, io.EOF) {
				m.err = e
			}
		}()
	}
}

func (m *MockServer) handle(conn net.Conn) error {
	buf := make([]byte, 0)
	_ = buf
	// Startup (no type byte).
	sb, err := readStartup(conn)
	if err != nil {
		return err
	}
	ver := binary.BigEndian.Uint32(sb[0:4])
	if ver == sslRequestCode {
		if _, err := conn.Write([]byte{'N'}); err != nil {
			return err
		}
		sb, err = readStartup(conn)
		if err != nil {
			return err
		}
		ver = binary.BigEndian.Uint32(sb[0:4])
	}
	if ver != protocolVersion {
		return fmt.Errorf("unexpected protocol version %d", ver)
	}
	if !strings.Contains(string(sb[4:]), "user\x00lab\x00") {
		return fmt.Errorf("startup missing user param: %q", string(sb[4:]))
	}

	// Auth exchange.
	switch m.auth {
	case "trust":
		_, err = conn.Write(msg('R', []byte{0, 0, 0, 0}))
	case "cleartext":
		_, err = conn.Write(msg('R', []byte{0, 0, 0, 3}))
		if err == nil {
			var hdr [5]byte
			if _, err = io.ReadFull(conn, hdr[:]); err == nil {
				n := int(binary.BigEndian.Uint32(hdr[1:5])) - 4
				pw := make([]byte, n)
				_, err = io.ReadFull(conn, pw)
				if err == nil && strings.TrimRight(string(pw), "\x00") != "secret" {
					err = fmt.Errorf("wrong cleartext password %q", pw)
				}
			}
		}
		if err == nil {
			_, err = conn.Write(msg('R', []byte{0, 0, 0, 0}))
		}
	case "md5":
		salt := []byte{1, 2, 3, 4}
		body := append([]byte{0, 0, 0, 5}, salt...)
		_, err = conn.Write(msg('R', body))
		if err == nil {
			var hdr [5]byte
			if _, err = io.ReadFull(conn, hdr[:]); err == nil {
				n := int(binary.BigEndian.Uint32(hdr[1:5])) - 4
				pw := make([]byte, n)
				_, err = io.ReadFull(conn, pw)
				// md5(md5(secret+lab)+salt) computed by the driver.
				expect := "md5" + hex.EncodeToString(md5ForTest("secret", "lab", salt))
				if err == nil && strings.TrimRight(string(pw), "\x00") != expect {
					err = fmt.Errorf("wrong md5 password got %q want %q", pw, expect)
				}
			}
		}
		if err == nil {
			_, err = conn.Write(msg('R', []byte{0, 0, 0, 0}))
		}
	case "scram":
		nonce := "serverNonceXYZ"
		// AuthenticationSASL offering SCRAM-SHA-256.
		sasl := []byte{0, 0, 0, 10}
		sasl = append(sasl, cstr("SCRAM-SHA-256")...)
		sasl = append(sasl, 0)
		_, err = conn.Write(msg('R', sasl))
		if err != nil {
			return err
		}
		// Read SASLInitialResponse: "SCRAM-SHA-256\0" + int32 len + bare.
		var hdr [5]byte
		if _, err = io.ReadFull(conn, hdr[:]); err != nil {
			return err
		}
		n := int(binary.BigEndian.Uint32(hdr[1:5])) - 4
		init := make([]byte, n)
		if _, err = io.ReadFull(conn, init); err != nil {
			return err
		}
		// init = mech\0 + len(4) + client-first-message（gs2-header + bare）
		off := 0
		for off < len(init) && init[off] != 0 {
			off++
		}
		off++ // skip NUL
		if off+4 > len(init) {
			return fmt.Errorf("malformed SASLInitialResponse")
		}
		bareLen := int(binary.BigEndian.Uint32(init[off : off+4]))
		off += 4
		if off+bareLen > len(init) {
			return fmt.Errorf("malformed SASLInitialResponse length")
		}
		first := string(init[off : off+bareLen])
		// 剥掉 GS2 头（"n,," / "y,," / "p=...,"），后面才是 client-first-bare。
		if !strings.HasPrefix(first, gs2Header) {
			return fmt.Errorf("malformed client-first-message %q", first)
		}
		bare := first[len(gs2Header):]
		clientNonce := strings.TrimPrefix(bare, "n=,r=")
		if clientNonce == "" || clientNonce == bare {
			return fmt.Errorf("malformed client-first-bare %q", bare)
		}
		combined := clientNonce + nonce
		salt := []byte("saltbytes")
		iter := 4096
		serverFirst := fmt.Sprintf("r=%s,s=%s,i=%d", combined, b64(salt), iter)
		cont := append([]byte{0, 0, 0, 11}, []byte(serverFirst)...)
		if _, err = conn.Write(msg('R', cont)); err != nil {
			return err
		}
		// Read SASLResponse (client-final-message).
		if _, err = io.ReadFull(conn, hdr[:]); err != nil {
			return err
		}
		n = int(binary.BigEndian.Uint32(hdr[1:5])) - 4
		final := make([]byte, n)
		if _, err = io.ReadFull(conn, final); err != nil {
			return err
		}
		cf := string(final)
		if !strings.HasPrefix(cf, "c=biws,r="+combined+",p=") {
			return fmt.Errorf("malformed client-final %q", cf)
		}
		// Verify the client proof against the password.
		if !verifyProofForTest(cf, bare, serverFirst, "secret") {
			return fmt.Errorf("SCRAM client proof mismatch")
		}
		sig := serverSigForTest(bare, serverFirst, "secret")
		saslFinal := append([]byte{0, 0, 0, 12}, []byte("v="+sig)...)
		if _, err = conn.Write(msg('R', saslFinal)); err != nil {
			return err
		}
		_, err = conn.Write(msg('R', []byte{0, 0, 0, 0}))
	default:
		return fmt.Errorf("unknown auth mode %q", m.auth)
	}
	if err != nil {
		return err
	}
	// BackendKeyData + ParameterStatus + ReadyForQuery.
	if _, err = conn.Write(msg('K', []byte{0, 0, 0, 42, 0, 0, 0, 7})); err != nil {
		return err
	}
	paramStatus := append(cstr("server_version"), cstr("17.0")...)
	if _, err = conn.Write(msg('S', paramStatus)); err != nil {
		return err
	}
	if _, err = conn.Write(msg('Z', []byte{'I'})); err != nil {
		return err
	}

	// Query loop.
	for {
		h := make([]byte, 5)
		if _, err := io.ReadFull(conn, h); err != nil {
			return err // client closed
		}
		n := int(binary.BigEndian.Uint32(h[1:5])) - 4
		if n < 0 || n > 1<<20 {
			return fmt.Errorf("bad msg len")
		}
		body := make([]byte, n)
		if _, err := io.ReadFull(conn, body); err != nil {
			return err
		}
		switch h[0] {
		case 'P': // Parse: "" + query + 0,0
			q := readCString(body, 1) // skip statement name cstring
			m.queries = append(m.queries, q)
		case 'B': // Bind: collect text params
			m.params = append(m.params, parseBindParams(body))
		case 'D': // Describe: portal/statement kind + name; no reply until Sync
		case 'E': // Execute: portal name (cstring) + max rows (int32)
			// Execute 的 body 必须至少 5 字节：portal 名（含结尾 0）+ max rows。
			// 少一个字节，服务端就会报 "insufficient data left in message"；
			// 这里显式校验，避免同样的编码错误再溜过去。
			if len(body) < 5 {
				return fmt.Errorf("bad Execute message: %d bytes", len(body))
			}
		case 'S': // Sync: reply with a result set + ReadyForQuery
			last := ""
			if len(m.queries) > 0 {
				last = m.queries[len(m.queries)-1]
			}
			if m.replyFn != nil {
				if err := m.replyFn(last, conn); err != nil {
					return err
				}
			} else if err := m.reply(conn, last); err != nil {
				return err
			}
		case 'X': // Terminate
			return nil
		}
	}
}

func readCString(b []byte, off int) string {
	if off > len(b) {
		return ""
	}
	end := off
	for end < len(b) && b[end] != 0 {
		end++
	}
	return string(b[off:end])
}

func parseBindParams(b []byte) []string {
	// portal\0 stmt\0 + int16 fmtCount + int16 paramCount + (len+bytes)* + int16 resultFmt
	off := 0
	off = skipCString(b, off)
	off = skipCString(b, off)
	if off+4 > len(b) {
		return nil
	}
	nfmt := int(binary.BigEndian.Uint16(b[off : off+2]))
	off += 2
	n := int(binary.BigEndian.Uint16(b[off : off+2]))
	off += 2 + nfmt*2
	out := []string{}
	for i := 0; i < n && off+4 <= len(b); i++ {
		ln := int(int32(binary.BigEndian.Uint32(b[off : off+4])))
		off += 4
		if ln < 0 {
			out = append(out, "<NULL>")
			continue
		}
		if off+ln > len(b) {
			break
		}
		out = append(out, string(b[off:off+ln]))
		off += ln
	}
	return out
}

func skipCString(b []byte, off int) int {
	for off < len(b) && b[off] != 0 {
		off++
	}
	return off + 1
}

func (m *MockServer) reply(conn net.Conn, query string) error {
	// RowDescription with two columns: id (int4, OID 23) and name (text, OID 25).
	rd := make([]byte, 2)
	binary.BigEndian.PutUint16(rd, 2)
	f := func(name string, oid uint32) []byte {
		b := cstr(name)
		tmp := make([]byte, 18)
		binary.BigEndian.PutUint32(tmp[6:10], oid)
		binary.BigEndian.PutUint16(tmp[16:18], 0) // text format
		return append(b, tmp...)
	}
	rd = append(rd, f("id", 23)...)
	rd = append(rd, f("name", 25)...)
	if _, err := conn.Write(msg('T', rd)); err != nil {
		return err
	}
	// Two DataRows.
	for _, row := range [][2]string{{"1", "alice"}, {"2", "bob"}} {
		dr := make([]byte, 2)
		binary.BigEndian.PutUint16(dr, 2)
		for _, v := range row {
			l := make([]byte, 4)
			binary.BigEndian.PutUint32(l, uint32(len(v)))
			dr = append(dr, l...)
			dr = append(dr, []byte(v)...)
		}
		if _, err := conn.Write(msg('D', dr)); err != nil {
			return err
		}
	}
	tag := "SELECT 2"
	if strings.HasPrefix(strings.ToUpper(query), "INSERT") || strings.HasPrefix(strings.ToUpper(query), "UPDATE") || strings.HasPrefix(strings.ToUpper(query), "DELETE") {
		tag = "UPDATE 1"
	}
	if _, err := conn.Write(msg('C', cstr(tag))); err != nil {
		return err
	}
	_, err := conn.Write(msg('Z', []byte{'I'}))
	return err
}

// ---- test helpers (SCRAM math on the server side) ----

func md5ForTest(password, user string, salt []byte) []byte {
	inner := md5sum([]byte(password + user))
	h := hex.EncodeToString(inner)
	outer := md5sum([]byte(h + string(salt)))
	return outer
}
func b64(b []byte) string { return base64Std(b) }

func serverSigForTest(bare, serverFirst, password string) string {
	clientFinalBare := "c=biws," + strings.Split(serverFirst, ",")[0] // r=<combined>
	authMessage := bare + "," + serverFirst + "," + clientFinalBare
	salt := []byte("saltbytes")
	salted := pbkdf2Key([]byte(password), salt, 4096, 32)
	serverKey := hmacSHA256(salted, []byte("Server Key"))
	return base64Std(hmacSHA256(serverKey, []byte(authMessage)))
}

func verifyProofForTest(clientFinal, bare, serverFirst, password string) bool {
	combined := ""
	for _, p := range strings.Split(serverFirst, ",") {
		if strings.HasPrefix(p, "r=") {
			combined = p[2:]
		}
	}
	withoutProof := "c=biws,r=" + combined
	authMessage := bare + "," + serverFirst + "," + withoutProof
	proofB64 := ""
	for _, p := range strings.Split(clientFinal, ",") {
		if strings.HasPrefix(p, "p=") {
			proofB64 = p[2:]
		}
	}
	proof := fromBase64Std(proofB64)
	salted := pbkdf2Key([]byte(password), []byte("saltbytes"), 4096, 32)
	clientKey := hmacSHA256(salted, []byte("Client Key"))
	storedKey := sha256Sum(clientKey)
	clientSig := hmacSHA256(storedKey, []byte(authMessage))
	expect := make([]byte, 32)
	for i := range expect {
		expect[i] = clientKey[i] ^ clientSig[i]
	}
	return constantTimeEqual(proof, expect)
}

func constantTimeEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := range a {
		v |= a[i] ^ b[i]
	}
	return v == 0
}

// ---- exported wire helpers for cross-package integration tests ----

// MockMsg builds a backend wire message (type byte + int32 length + body).
func MockMsg(typ byte, body []byte) []byte { return msg(typ, body) }

// MockRowDescription builds a RowDescription message for the given
// (name, typeOID) columns. Text format is used for every column.
func MockRowDescription(cols ...struct {
	Name string
	OID  uint32
}) []byte {
	b := make([]byte, 2)
	binary.BigEndian.PutUint16(b, uint16(len(cols)))
	for _, c := range cols {
		tmp := make([]byte, 18)
		binary.BigEndian.PutUint32(tmp[6:10], c.OID)
		binary.BigEndian.PutUint16(tmp[16:18], 0)
		b = append(b, cstr(c.Name)...)
		b = append(b, tmp...)
	}
	return msg('T', b)
}

// MockDataRow builds a DataRow message. Nil values are encoded as SQL NULL.
func MockDataRow(values ...any) []byte {
	b := make([]byte, 2)
	binary.BigEndian.PutUint16(b, uint16(len(values)))
	for _, v := range values {
		if v == nil {
			l := make([]byte, 4)
			binary.BigEndian.PutUint32(l, ^uint32(0))
			b = append(b, l...)
			continue
		}
		s := fmt.Sprint(v)
		l := make([]byte, 4)
		binary.BigEndian.PutUint32(l, uint32(len(s)))
		b = append(b, l...)
		b = append(b, []byte(s)...)
	}
	return msg('D', b)
}

// MockCommandComplete builds CommandComplete with a tag such as "UPDATE 1".
func MockCommandComplete(tag string) []byte { return msg('C', cstr(tag)) }

// MockReadyForQuery builds ReadyForQuery (idle transaction status).
func MockReadyForQuery() []byte { return msg('Z', []byte{'I'}) }

// WriteMock writes raw bytes to a connection.
func WriteMock(conn net.Conn, b []byte) error { _, err := conn.Write(b); return err }
