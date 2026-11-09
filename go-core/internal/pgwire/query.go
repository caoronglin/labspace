package pgwire

import (
	"context"
	"database/sql/driver"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// query executes a parameterized statement using the extended query protocol.
// Parse/Bind/Describe/Execute/Sync are pipelined; the driver uses unnamed
// statements and portals so no explicit Close/Deallocate is needed.
func (c *pgconn) query(ctx context.Context, sql string, args []driver.NamedValue) (driver.Rows, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, driver.ErrBadConn
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = c.conn.SetDeadline(deadline)
		defer func() { _ = c.conn.SetDeadline(time.Time{}) }()
	}

	params := encodeParams(args)
	if err := c.sendParse(sql); err != nil {
		return nil, err
	}
	if err := c.sendBindDescribeExecute(params); err != nil {
		return nil, err
	}
	if err := c.writeMessage('S', nil); err != nil { // Sync
		return nil, err
	}

	cols, rows, err := c.collectResult()
	if err != nil {
		return nil, err
	}
	return &pgRows{cols: cols, rows: rows}, nil
}

func (c *pgconn) exec(ctx context.Context, sql string, args []driver.NamedValue) (driver.Result, error) {
	r, err := c.query(ctx, sql, args)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	// Consume any rows; CommandComplete arrived inside collectResult.
	for {
		if err := r.Next(nil); err != nil {
			break
		}
	}
	return &pgResult{rowsAffected: c.lastCommandTag}, nil
}

func (c *pgconn) sendParse(sql string) error {
	body := make([]byte, 0, len(sql)+8)
	body = putCString(body, "") // unnamed statement
	body = putCString(body, sql)
	body = append(body, 0, 0) // no parameter types: let the server infer
	return c.writeMessage('P', body)
}

// encodeParams converts driver values to PostgreSQL text-format parameters.
// Named ordinals are normalized by database/sql before reaching here.
type param struct {
	text string
	null bool
}

func encodeParams(args []driver.NamedValue) []param {
	out := make([]param, len(args))
	for i, a := range args {
		if a.Value == nil {
			out[i] = param{null: true}
			continue
		}
		out[i] = param{text: paramText(a.Value)}
	}
	return out
}

func paramText(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case []byte:
		return string(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case int:
		return strconv.Itoa(x)
	case int32:
		return strconv.FormatInt(int64(x), 10)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(x), 'f', -1, 32)
	case bool:
		if x {
			return "t"
		}
		return "f"
	case time.Time:
		return x.Format("2006-01-02T15:04:05.999999999Z07:00")
	case []string:
		// PostgreSQL text array literal.
		return "{" + strings.Join(escapeArray(x), ",") + "}"
	default:
		return fmt.Sprint(x)
	}
}

func escapeArray(items []string) []string {
	out := make([]string, len(items))
	for i, s := range items {
		s = strings.ReplaceAll(s, `\`, `\\`)
		s = strings.ReplaceAll(s, `"`, `\"`)
		out[i] = `"` + s + `"`
	}
	return out
}

func (c *pgconn) sendBindDescribeExecute(params []param) error {
	// Bind
	body := make([]byte, 0, 64)
	body = putCString(body, "") // unnamed portal
	body = putCString(body, "") // unnamed statement
	var h [2]byte
	binary.BigEndian.PutUint16(h[:], 0) // format code 0 = text for all
	body = append(body, h[:]...)
	binary.BigEndian.PutUint16(h[:], uint16(len(params)))
	body = append(body, h[:]...)
	var l [4]byte
	for _, p := range params {
		if p.null {
			binary.BigEndian.PutUint32(l[:], ^uint32(0)) // -1 length = SQL NULL
			body = append(body, l[:]...)
			continue
		}
		binary.BigEndian.PutUint32(l[:], uint32(len(p.text)))
		body = append(body, l[:]...)
		body = append(body, []byte(p.text)...)
	}
	binary.BigEndian.PutUint16(h[:], 0) // result format 0 = text
	body = append(body, h[:]...)
	if err := c.writeMessage('B', body); err != nil {
		return err
	}
	if err := c.writeMessage('D', []byte{'P', 0}); err != nil { // Describe portal
		return err
	}
	// Execute: portal name (cstring) + max rows (int32).
	// 少写 portal name 的那个 0 字节，服务端就会把 max rows 读短一字节，
	// 报 "insufficient data left in message (08P01)"。
	return c.writeMessage('E', []byte{0, 0, 0, 0, 0}) // Execute, no max rows
}

// collectResult reads up to ReadyForQuery, returning the columns and all rows.
// Errors from any backend message abort the pipeline; Sync resets the protocol.
func (c *pgconn) collectResult() ([]string, [][]driver.Value, error) {
	cols := []string{}
	rows := [][]driver.Value{}
	var desc []fieldDesc
	var perr error
	c.lastCommandTag = 0
	for {
		t, b, err := c.readMessage()
		if err != nil {
			return nil, nil, err
		}
		switch t {
		case 'T': // RowDescription
			desc, err = parseRowDescription(b)
			if err != nil {
				return nil, nil, err
			}
			cols = make([]string, len(desc))
			for i, d := range desc {
				cols[i] = d.name
			}
		case 'D': // DataRow
			row, err := parseDataRow(b, desc)
			if err != nil {
				return nil, nil, err
			}
			rows = append(rows, row)
		case 'C': // CommandComplete
			c.lastCommandTag = commandTagRows(string(b))
		case 'E': // ErrorResponse
			// 记下错误但继续读到 ReadyForQuery：出错后服务端仍在等 Sync，
			// 直接返回会把残留报文留在 socket 里，连接复用时下一条查询会
			// 读到过期的 'Z'，表现为“no rows in result set”这类假故障。
			if perr == nil {
				perr = parseError(b)
			}
		case 'Z': // ReadyForQuery
			c.txStatus = b[0]
			if perr != nil {
				return nil, nil, perr
			}
			return cols, rows, nil
		case 'N': // NoticeResponse
		case '1', '2', '3': // ParseComplete/BindComplete/CloseComplete
		case 'n': // NoData
		case 's': // PortalSuspended
		case 'I': // EmptyQueryResponse
		default:
		}
	}
}

func parseRowDescription(b []byte) ([]fieldDesc, error) {
	if len(b) < 2 {
		return nil, io.ErrUnexpectedEOF
	}
	n := int(binary.BigEndian.Uint16(b[0:2]))
	off := 2
	out := make([]fieldDesc, 0, n)
	for i := 0; i < n; i++ {
		name, err := cstring(b, &off)
		if err != nil {
			return nil, err
		}
		if off+18 > len(b) {
			return nil, io.ErrUnexpectedEOF
		}
		d := fieldDesc{name: name}
		d.tableOID = binary.BigEndian.Uint32(b[off : off+4])
		d.attr = binary.BigEndian.Uint16(b[off+4 : off+6])
		d.typeOID = binary.BigEndian.Uint32(b[off+6 : off+10])
		d.typeSize = int16(binary.BigEndian.Uint16(b[off+10 : off+12]))
		d.typeMod = int32(binary.BigEndian.Uint32(b[off+12 : off+16]))
		d.format = binary.BigEndian.Uint16(b[off+16 : off+18])
		off += 18
		out = append(out, d)
	}
	return out, nil
}

func parseDataRow(b []byte, desc []fieldDesc) ([]driver.Value, error) {
	if len(b) < 2 {
		return nil, io.ErrUnexpectedEOF
	}
	n := int(binary.BigEndian.Uint16(b[0:2]))
	off := 2
	row := make([]driver.Value, n)
	for i := 0; i < n; i++ {
		if off+4 > len(b) {
			return nil, io.ErrUnexpectedEOF
		}
		ln := int32(binary.BigEndian.Uint32(b[off : off+4]))
		off += 4
		if ln == -1 {
			row[i] = nil
			continue
		}
		if ln < 0 || off+int(ln) > len(b) {
			return nil, io.ErrUnexpectedEOF
		}
		raw := string(b[off : off+int(ln)])
		off += int(ln)
		row[i] = convertValue(raw, desc, i)
	}
	return row, nil
}

// OIDs of the types whose text representation maps naturally to a Go value.
const (
	oidBool        = 16
	oidInt8        = 20
	oidInt2        = 21
	oidInt4        = 23
	oidFloat4      = 700
	oidFloat8      = 701
	oidNumeric     = 1700
	oidDate        = 1082
	oidTimestamp   = 1114
	oidTimestamptz = 1184
)

func convertValue(raw string, desc []fieldDesc, i int) driver.Value {
	if i >= len(desc) {
		return raw
	}
	switch desc[i].typeOID {
	case oidInt2, oidInt4, oidInt8:
		if v, err := strconv.ParseInt(raw, 10, 64); err == nil {
			return v
		}
	case oidFloat4, oidFloat8, oidNumeric:
		if v, err := strconv.ParseFloat(raw, 64); err == nil {
			return v
		}
	case oidBool:
		return raw == "t" || raw == "true" || raw == "1"
	case oidDate, oidTimestamp, oidTimestamptz:
		// database/sql only scans a timestamp into *time.Time when the driver
		// hands back a time.Time, so the text form is parsed here.
		if ts, err := parseTimestamp(raw); err == nil {
			return ts
		}
	}
	return raw
}

func commandTagRows(tag string) int64 {
	tag = strings.TrimRight(tag, "\x00")
	parts := strings.Fields(tag)
	if len(parts) < 2 {
		return 0
	}
	n, err := strconv.ParseInt(parts[len(parts)-1], 10, 64)
	if err != nil {
		return 0
	}
	return n
}

type pgRows struct {
	cols []string
	rows [][]driver.Value
	pos  int
}

func (r *pgRows) Columns() []string { return r.cols }
func (r *pgRows) Close() error      { return nil }
func (r *pgRows) Next(dest []driver.Value) error {
	if r.pos >= len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.pos])
	r.pos++
	return nil
}

type pgResult struct{ rowsAffected int64 }

func (r *pgResult) LastInsertId() (int64, error) {
	return 0, errors.New("pgwire: LastInsertId is not supported")
}
func (r *pgResult) RowsAffected() (int64, error) { return r.rowsAffected, nil }
