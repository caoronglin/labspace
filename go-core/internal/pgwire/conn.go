package pgwire

import (
	"context"
	"crypto/md5"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	protocolVersion = 196608 // 3 << 16
	sslRequestCode  = 80877103
)

type config struct {
	host, port, user, password, database string
	connectTimeout                       time.Duration
	sslmode                              string // disable | prefer | require
	applicationName                      string
}

func parseConnString(dsn string) (config, error) {
	c := config{host: "127.0.0.1", port: "5432", sslmode: "disable", applicationName: "labgo-core"}
	c.connectTimeout = 5 * time.Second
	for _, part := range strings.Fields(dsn) {
		// URI 形式必须先判：postgresql://user:pass@host/db?sslmode=disable 里
		// 含 "sslmode=disable" 的 '='。若先按 '=' 拆键值，整串会被当成一个键，
		// URI 分支永远走不到，用户名与主机都解析不出来（"user is required"）。
		if strings.HasPrefix(part, "postgres://") || strings.HasPrefix(part, "postgresql://") {
			parsed, err := ParseDSN(part)
			if err != nil {
				return c, err
			}
			c.user = parsed.User
			c.password = parsed.Password
			c.database = parsed.Database
			if parsed.Host != "" {
				c.host = parsed.Host
			}
			c.port = strconv.Itoa(parsed.Port)
			c.sslmode = parsed.SSLMode
			c.connectTimeout = parsed.ConnectTimeout
			// 没显式写 sslmode 时保持直连：本平台的 PG 只在容器网络里用明文，
			// 默认的 prefer 会先去试 TLS，多一次握手失败。
			if !strings.Contains(part, "sslmode=") {
				c.sslmode = "disable"
			}
			continue
		}
		if i := strings.IndexByte(part, '='); i > 0 {
			k, v := part[:i], part[i+1:]
			switch strings.ToLower(k) {
			case "host":
				c.host = v
			case "port":
				c.port = v
			case "user":
				c.user = v
			case "password":
				c.password = v
			case "dbname":
				c.database = v
			case "connect_timeout":
				if n, e := strconv.Atoi(v); e == nil && n > 0 {
					c.connectTimeout = time.Duration(n) * time.Second
				}
			case "sslmode":
				c.sslmode = v
			case "application_name":
				c.applicationName = v
			}
			continue
		}
	}
	if c.user == "" {
		return c, errors.New("pgwire: user is required")
	}
	if c.database == "" {
		c.database = c.user
	}
	return c, nil
}

// ---------------------------------------------------------------- wire types

type fieldDesc struct {
	name     string
	tableOID uint32
	attr     uint16
	typeOID  uint32
	typeSize int16
	typeMod  int32
	format   uint16
}

type pgconn struct {
	conn net.Conn
	cfg  config
	mu   sync.Mutex

	// process/secret keys used by CancelRequest (best-effort)
	pid       int32
	secretKey int32

	txStatus       byte
	closed         bool
	lastCommandTag int64 // rows affected by the most recent CommandComplete
}

func (c *pgconn) writeMessage(typ byte, body []byte) error {
	buf := make([]byte, 5+len(body))
	buf[0] = typ
	binary.BigEndian.PutUint32(buf[1:5], uint32(4+len(body)))
	copy(buf[5:], body)
	_, err := c.conn.Write(buf)
	return err
}

func readExact(r io.Reader, n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := io.ReadFull(r, b); err != nil {
		return nil, err
	}
	return b, nil
}

// readMessage reads one backend message (type + length + body).
func (c *pgconn) readMessage() (byte, []byte, error) {
	hdr, err := readExact(c.conn, 5)
	if err != nil {
		return 0, nil, err
	}
	typ := hdr[0]
	n := int(binary.BigEndian.Uint32(hdr[1:5])) - 4
	if n < 0 || n > 64<<20 {
		return 0, nil, fmt.Errorf("pgwire: invalid message length %d", n)
	}
	body, err := readExact(c.conn, n)
	if err != nil {
		return 0, nil, err
	}
	return typ, body, nil
}

func putCString(b []byte, s string) []byte {
	b = append(b, []byte(s)...)
	return append(b, 0)
}

func cstring(b []byte, off *int) (string, error) {
	if *off >= len(b) {
		return "", io.ErrUnexpectedEOF
	}
	i := *off
	for i < len(b) && b[i] != 0 {
		i++
	}
	if i >= len(b) {
		return "", io.ErrUnexpectedEOF
	}
	s := string(b[*off:i])
	*off = i + 1
	return s, nil
}

// ---------------------------------------------------------------- handshake

func dial(ctx context.Context, cfg config) (*pgconn, error) {
	d := net.Dialer{Timeout: cfg.connectTimeout}
	nc, err := d.DialContext(ctx, "tcp", net.JoinHostPort(cfg.host, cfg.port))
	if err != nil {
		return nil, err
	}
	c := &pgconn{conn: nc, cfg: cfg}
	if deadline, ok := ctx.Deadline(); ok {
		_ = nc.SetDeadline(deadline)
		defer func() { _ = nc.SetDeadline(time.Time{}) }()
	}
	if err := c.startup(); err != nil {
		_ = nc.Close()
		return nil, err
	}
	return c, nil
}

func (c *pgconn) startup() error {
	// SSL negotiation first. We only support sslmode=disable/prefer: TLS for
	// the loopback/Unix-socket deployments is terminated by the existing
	// pgbouncer or is not required; 'require' is rejected explicitly rather
	// than silently downgrading to plaintext.
	switch c.cfg.sslmode {
	case "disable":
	case "prefer", "allow":
		// Try an SSLRequest; if the server answers 'N' we continue plaintext.
		var b [8]byte
		binary.BigEndian.PutUint32(b[0:4], 8)
		binary.BigEndian.PutUint32(b[4:8], sslRequestCode)
		if _, err := c.conn.Write(b[:]); err != nil {
			return err
		}
		resp, err := readExact(c.conn, 1)
		if err != nil {
			return err
		}
		if resp[0] == 'S' {
			return errors.New("pgwire: TLS not supported (set sslmode=disable or terminate TLS upstream)")
		}
	default:
		return fmt.Errorf("pgwire: unsupported sslmode %q", c.cfg.sslmode)
	}

	params := map[string]string{
		"user":             c.cfg.user,
		"database":         c.cfg.database,
		"client_encoding":  "UTF8",
		"application_name": c.cfg.applicationName,
	}
	body := make([]byte, 0, 128)
	var v [4]byte
	binary.BigEndian.PutUint32(v[:], protocolVersion)
	body = append(body, v[:]...)
	for k, val := range params {
		body = putCString(body, k)
		body = putCString(body, val)
	}
	body = append(body, 0)
	// StartupMessage has NO type byte: only int32 length followed by the body.
	pkt := make([]byte, 4+len(body))
	binary.BigEndian.PutUint32(pkt[0:4], uint32(4+len(body)))
	copy(pkt[4:], body)
	if _, err := c.conn.Write(pkt); err != nil {
		return err
	}
	return c.authenticate()
}

// authenticate drives the startup-time auth exchange as a single state
// machine. In particular SCRAM-SHA-256 spans several 'R' messages followed by
// AuthenticationOk and ReadyForQuery; consuming Z inside a nested helper would
// leave the outer loop blocking forever waiting for a message the backend will
// never send (it is our turn to talk). All backend messages are consumed here.
func (c *pgconn) authenticate() error {
	scramNonceVal := ""
	scramExpect := []byte(nil)
	for {
		t, b, err := c.readMessage()
		if err != nil {
			return err
		}
		switch t {
		case 'R': // Authentication*
			code := binary.BigEndian.Uint32(b[0:4])
			switch code {
			case 0: // AuthenticationOk
				// keep reading until ReadyForQuery
			case 3: // AuthenticationCleartextPassword
				if err := c.writePassword(c.cfg.password); err != nil {
					return err
				}
			case 5: // AuthenticationMD5Password
				salt := b[4:8]
				inner := md5.Sum([]byte(c.cfg.password + c.cfg.user))
				h := hex.EncodeToString(inner[:])
				outer := md5.Sum([]byte(h + string(salt)))
				if err := c.writePassword("md5" + hex.EncodeToString(outer[:])); err != nil {
					return err
				}
			case 10: // AuthenticationSASL: choose SCRAM-SHA-256
				mechs := []string{}
				off := 4
				for off < len(b) {
					m, e := cstring(b, &off)
					if e != nil || m == "" {
						break
					}
					mechs = append(mechs, m)
				}
				supported := false
				for _, m := range mechs {
					if m == "SCRAM-SHA-256" {
						supported = true
					}
				}
				if !supported {
					return errors.New("pgwire: server did not offer SCRAM-SHA-256")
				}
				scramNonceVal, err = scramNonce()
				if err != nil {
					return err
				}
				bare := "n=,r=" + scramNonceVal
				if err := c.writeMessage('p', saslInitialResponse(bare)); err != nil {
					return err
				}
			case 11: // AuthenticationSASLContinue: server-first-message
				serverFirst := string(b[4:])
				clientFinal, expectSig, e := scramClientFinal(c.cfg.password, serverFirst, scramNonceVal)
				if e != nil {
					return e
				}
				scramExpect = expectSig
				if err := c.writeMessage('p', []byte(clientFinal)); err != nil {
					return err
				}
			case 12: // AuthenticationSASLFinal: verify ServerSignature
				for _, part := range strings.Split(string(b[4:]), ",") {
					if strings.HasPrefix(part, "e=") {
						return fmt.Errorf("pgwire: SCRAM error %s", part[2:])
					}
					if strings.HasPrefix(part, "v=") {
						got, e := base64.StdEncoding.DecodeString(part[2:])
						if e != nil {
							return e
						}
						if subtle.ConstantTimeCompare(got, scramExpect) != 1 {
							return errors.New("pgwire: SCRAM server signature mismatch")
						}
					}
				}
			default:
				return fmt.Errorf("pgwire: unsupported authentication code %d", code)
			}
		case 'S': // ParameterStatus (ignored)
		case 'K': // BackendKeyData
			if len(b) >= 8 {
				c.pid = int32(binary.BigEndian.Uint32(b[0:4]))
				c.secretKey = int32(binary.BigEndian.Uint32(b[4:8]))
			}
		case 'Z': // ReadyForQuery: handshake complete
			c.txStatus = b[0]
			return nil
		case 'E':
			return parseError(b)
		}
	}
}

func (c *pgconn) writePassword(pw string) error {
	return c.writeMessage('p', putCString(nil, pw))
}

// pgError mirrors the SQLSTATE fields PostgreSQL returns in ErrorResponse.
type pgError struct {
	severity, code, message, detail, hint string
}

func (e *pgError) Error() string {
	if e.code != "" {
		return fmt.Sprintf("pgwire: %s (%s)", e.message, e.code)
	}
	return "pgwire: " + e.message
}

func parseError(b []byte) error {
	e := &pgError{}
	off := 0
	for off < len(b) && b[off] != 0 {
		field := b[off]
		off++
		s, err := cstring(b, &off)
		if err != nil {
			break
		}
		switch field {
		case 'S':
			e.severity = s
		case 'C':
			e.code = s
		case 'M':
			e.message = s
		case 'D':
			e.detail = s
		case 'H':
			e.hint = s
		}
	}
	if e.message == "" {
		e.message = "backend error"
	}
	return e
}

// close shuts the socket down once; safe to call from the pool.
func (c *pgconn) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	if c.conn != nil {
		_ = c.conn.Close()
	}
}
