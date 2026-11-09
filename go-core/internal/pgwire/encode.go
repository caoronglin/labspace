package pgwire

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// encodeArg renders one Go value as a PostgreSQL text-format parameter.
//
// Text format is used for every parameter: the server parses the literal in the
// context of the inferred type, so the driver never has to know the statement's
// OID list and the caller never gets to build SQL strings.
func encodeArg(v any) ([]byte, bool, error) {
	switch t := v.(type) {
	case nil:
		return nil, true, nil
	case string:
		return []byte(t), false, nil
	case []byte:
		return t, false, nil
	case bool:
		if t {
			return []byte("t"), false, nil
		}
		return []byte("f"), false, nil
	case int:
		return []byte(strconv.Itoa(t)), false, nil
	case int8:
		return []byte(strconv.FormatInt(int64(t), 10)), false, nil
	case int16:
		return []byte(strconv.FormatInt(int64(t), 10)), false, nil
	case int32:
		return []byte(strconv.FormatInt(int64(t), 10)), false, nil
	case int64:
		return []byte(strconv.FormatInt(t, 10)), false, nil
	case uint:
		return []byte(strconv.FormatUint(uint64(t), 10)), false, nil
	case uint64:
		return []byte(strconv.FormatUint(t, 10)), false, nil
	case float32:
		return []byte(strconv.FormatFloat(float64(t), 'f', -1, 32)), false, nil
	case float64:
		return []byte(strconv.FormatFloat(t, 'f', -1, 64)), false, nil
	case time.Time:
		return []byte(t.Format("2006-01-02 15:04:05.999999-07:00")), false, nil
	case []string:
		return []byte(encodeTextArray(t)), false, nil
	case json.RawMessage:
		return t, false, nil
	case fmt.Stringer:
		return []byte(t.String()), false, nil
	default:
		// Unknown scalars go through JSON, which the server accepts for jsonb
		// targets and rejects loudly for anything else.
		raw, err := json.Marshal(t)
		if err != nil {
			return nil, false, fmt.Errorf("pgwire: unsupported parameter type %T", v)
		}
		return raw, false, nil
	}
}

// encodeTextArray renders a []string as a PostgreSQL array literal with proper
// quoting, so tags containing commas or braces survive the round trip.
func encodeTextArray(values []string) string {
	var b strings.Builder
	b.WriteByte('{')
	for i, v := range values {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteByte('"')
		for _, r := range v {
			if r == '"' || r == '\\' {
				b.WriteByte('\\')
			}
			b.WriteRune(r)
		}
		b.WriteByte('"')
	}
	b.WriteByte('}')
	return b.String()
}

// ParseTextArray decodes a PostgreSQL array literal ({a,b,"c,d"}) into strings.
// It handles the escaped form returned for text[] columns and NULL elements.
func ParseTextArray(raw string) []string {
	raw = strings.TrimSpace(raw)
	if len(raw) < 2 || raw[0] != '{' {
		if raw == "" {
			return nil
		}
		return []string{raw}
	}
	inner := raw[1 : len(raw)-1]
	var out []string
	var cur strings.Builder
	inQuote := false
	escaped := false
	var elem strings.Builder
	flush := func() {
		s := elem.String()
		if s != "NULL" || inQuote {
			out = append(out, s)
		}
		elem.Reset()
	}
	for _, r := range inner {
		switch {
		case escaped:
			elem.WriteRune(r)
			escaped = false
		case inQuote && r == '\\':
			escaped = true
		case r == '"':
			inQuote = !inQuote
		case r == ',' && !inQuote:
			flush()
		default:
			elem.WriteRune(r)
		}
	}
	if elem.Len() > 0 || inQuote {
		flush()
	}
	_ = cur
	return out
}

// assign decodes one text value into a destination pointer.
func assign(dest any, raw string, isNull bool) error {
	switch d := dest.(type) {
	case *string:
		if isNull {
			*d = ""
			return nil
		}
		*d = raw
		return nil
	case *[]string:
		if isNull {
			*d = nil
			return nil
		}
		*d = ParseTextArray(raw)
		return nil
	case *int:
		if isNull {
			*d = 0
			return nil
		}
		n, err := strconv.Atoi(raw)
		if err != nil {
			return err
		}
		*d = n
		return nil
	case *int64:
		if isNull {
			*d = 0
			return nil
		}
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return err
		}
		*d = n
		return nil
	case *float64:
		if isNull {
			*d = 0
			return nil
		}
		f, err := strconv.ParseFloat(raw, 64)
		if err != nil {
			return err
		}
		*d = f
		return nil
	case *bool:
		if isNull {
			*d = false
			return nil
		}
		*d = raw == "t" || raw == "true" || raw == "1"
		return nil
	case *time.Time:
		if isNull {
			return nil
		}
		ts, err := parseTimestamp(raw)
		if err != nil {
			return err
		}
		*d = ts
		return nil
	case *json.RawMessage:
		if isNull {
			*d = nil
			return nil
		}
		*d = append((*d)[:0], raw...)
		return nil
	case *[]byte:
		if isNull {
			*d = nil
			return nil
		}
		*d = []byte(raw)
		return nil
	default:
		return fmt.Errorf("unsupported scan destination %T", dest)
	}
}

// pgTimestampLayouts covers the text timestamps the server emits with
// DateStyle=ISO (the default).
var pgTimestampLayouts = []string{
	"2006-01-02 15:04:05.999999-07:00",
	"2006-01-02 15:04:05.999999-07",
	"2006-01-02 15:04:05.999999999Z07:00",
	"2006-01-02 15:04:05.999999999",
	"2006-01-02 15:04:05",
	"2006-01-02T15:04:05.999999999Z07:00",
	"2006-01-02",
}

func parseTimestamp(raw string) (time.Time, error) {
	for _, layout := range pgTimestampLayouts {
		if ts, err := time.Parse(layout, raw); err == nil {
			return ts, nil
		}
	}
	return time.Time{}, fmt.Errorf("pgwire: unparsable timestamp %q", raw)
}
