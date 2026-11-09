package workbench

import (
	"context"
	"database/sql"
	"encoding/json"
	"net"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"labspace.local/go-core/internal/pgwire"
)

// newStore wires a real *sql.DB through the pgwire driver to the in-process
// mock backend. This exercises the full SQL path without a live PostgreSQL.
func newStore(t *testing.T) (*Store, *pgwire.MockServer) {
	t.Helper()
	m := pgwire.NewMockServer(t, "trust")
	db, err := sql.Open("pgwire", m.DSN())
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close(); m.Close() })
	return &Store{DB: db, Now: func() time.Time {
		return time.Date(2026, 11, 4, 9, 0, 0, 0, time.UTC)
	}}, m
}

type col struct {
	Name string
	OID  uint32
}

func replyWith(t *testing.T, cols []col, rows ...[]any) func(string, net.Conn) error {
	return func(_ string, conn net.Conn) error {
		cc := make([]struct {
			Name string
			OID  uint32
		}, len(cols))
		for i, c := range cols {
			cc[i] = struct {
				Name string
				OID  uint32
			}{c.Name, c.OID}
		}
		if err := pgwire.WriteMock(conn, pgwire.MockRowDescription(cc...)); err != nil {
			return err
		}
		for _, r := range rows {
			if err := pgwire.WriteMock(conn, pgwire.MockDataRow(r...)); err != nil {
				return err
			}
		}
		tag := "SELECT " + itoa(len(rows))
		if err := pgwire.WriteMock(conn, pgwire.MockCommandComplete(tag)); err != nil {
			return err
		}
		return pgwire.WriteMock(conn, pgwire.MockReadyForQuery())
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	b := []byte{}
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

var itemColSpec = []col{
	{"id", 25}, {"user_id", 25}, {"kind", 25}, {"title", 25}, {"content", 25},
	{"status", 25}, {"priority", 25}, {"tags", 25}, {"project_id", 25}, {"plan_id", 25},
	{"due_date", 25}, {"source", 25}, {"ai_class", 25}, {"ai_reason", 25},
	{"confidence", 701}, {"created_at", 25}, {"updated_at", 25},
}

func itemRow(id, kind, title string) []any {
	return []any{id, "u1", kind, title, "content", "active", "normal",
		`{"tag1","tag2"}`, nil, nil, "2026-11-05", "manual", nil, nil, 0.55,
		"2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z"}
}

func TestListItems(t *testing.T) {
	s, m := newStore(t)
	m.SetReply(func(q string, conn net.Conn) error {
		// count(*) query returns one int8 column with one row.
		if strings.Contains(q, "count(*)") {
			cc := []struct {
				Name string
				OID  uint32
			}{{"n", 20}}
			_ = pgwire.WriteMock(conn, pgwire.MockRowDescription(cc...))
			_ = pgwire.WriteMock(conn, pgwire.MockDataRow(int64(2)))
			_ = pgwire.WriteMock(conn, pgwire.MockCommandComplete("SELECT 1"))
			return pgwire.WriteMock(conn, pgwire.MockReadyForQuery())
		}
		return replyWith(t, itemColSpec, itemRow("i1", "task", "A"), itemRow("i2", "note", "B"))(q, conn)
	})
	items, total, err := s.ListItems(context.Background(), "u1", ItemFilter{Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if total != 2 || len(items) != 2 {
		t.Fatalf("total=%d items=%d", total, len(items))
	}
	if items[0].Tags[0] != "tag1" || items[0].DueDate == nil || *items[0].DueDate != "2026-11-05" || items[0].Confidence != 0.55 {
		t.Fatalf("scan mismatch: %+v", items[0])
	}
	// Every query must be scoped by user_id.
	for _, q := range m.Queries() {
		if !strings.Contains(q, "user_id=$1") && !strings.Contains(q, "user_id=?") {
			t.Fatalf("query not user-scoped: %s", q)
		}
	}
}

func TestCreateAndPatchItem(t *testing.T) {
	s, m := newStore(t)
	m.SetReply(replyWith(t, itemColSpec, itemRow("i9", "task", "New")))
	it, err := s.CreateItem(context.Background(), "u1", ItemCreate{Kind: "task", Content: "line1\nline2"}, "manual", nil)
	if err != nil {
		t.Fatal(err)
	}
	if it.ID != "i9" || it.Title != "New" {
		t.Fatalf("item=%+v", it)
	}
	if len(m.Queries()) == 0 || !strings.Contains(m.Queries()[0], "RETURNING") {
		t.Fatalf("expected RETURNING insert, got %v", m.Queries())
	}
	// Sparse patch: only the provided columns appear in SET.
	m.SetReply(replyWith(t, itemColSpec, itemRow("i9", "task", "Updated")))
	_, err = s.PatchItem(context.Background(), "u1", "i9", PatchFields{"title": "Updated"})
	if err != nil {
		t.Fatal(err)
	}
	last := m.Queries()[len(m.Queries())-1]
	if !strings.Contains(last, "SET title=$1") {
		t.Fatalf("patch should only SET provided columns: %s", last)
	}
	if strings.Contains(last, "content=CASE") || strings.Contains(last, "priority=") {
		t.Fatalf("patch rewrote untouched columns (write amplification): %s", last)
	}
}

func TestPatchItemNoFields(t *testing.T) {
	s, _ := newStore(t)
	if _, err := s.PatchItem(context.Background(), "u1", "x", PatchFields{}); err == nil {
		t.Fatal("expected error for empty patch")
	}
}

func TestDeleteNotFound(t *testing.T) {
	s, m := newStore(t)
	m.SetReply(func(_ string, conn net.Conn) error {
		_ = pgwire.WriteMock(conn, pgwire.MockCommandComplete("DELETE 0"))
		return pgwire.WriteMock(conn, pgwire.MockReadyForQuery())
	})
	if err := s.DeleteItem(context.Background(), "u1", "missing"); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestBriefUpsert(t *testing.T) {
	s, m := newStore(t)
	briefCols := []col{{"brief_date", 25}, {"content", 25}, {"payload", 25}}
	m.SetReply(replyWith(t, briefCols, []any{"2026-11-04", "hello", `{"k":1}`}))
	b, err := s.CreateBrief(context.Background(), "u1", "hello", json.RawMessage(`{"k":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if b.Content != "hello" || b.Payload["k"] != float64(1) {
		t.Fatalf("brief=%+v", b)
	}
	q := m.Queries()[0]
	if !strings.Contains(q, "ON CONFLICT") || !strings.Contains(q, "jsonb") {
		t.Fatalf("upsert malformed: %s", q)
	}
}

// ---------------------------------------------------------------- handler tests

func handlerCall(t *testing.T, h *Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	w := httptest.NewRecorder()
	h.Serve(w, r, "u1")
	return w
}

func TestHandlerRoutes(t *testing.T) {
	s, m := newStore(t)
	m.SetReply(func(q string, conn net.Conn) error {
		switch {
		case strings.Contains(q, "count(*)"):
			cc := []struct {
				Name string
				OID  uint32
			}{{"n", 20}}
			_ = pgwire.WriteMock(conn, pgwire.MockRowDescription(cc...))
			_ = pgwire.WriteMock(conn, pgwire.MockDataRow(int64(1)))
			_ = pgwire.WriteMock(conn, pgwire.MockCommandComplete("SELECT 1"))
			return pgwire.WriteMock(conn, pgwire.MockReadyForQuery())
		case strings.Contains(q, "workbench_items") && !strings.Contains(q, "count(*)"):
			return replyWith(t, itemColSpec, itemRow("i1", "task", "A"))(q, conn)
		default:
			// projects / plans / briefs / stats: empty result set with one column.
			cc := []struct {
				Name string
				OID  uint32
			}{{"v", 25}}
			_ = pgwire.WriteMock(conn, pgwire.MockRowDescription(cc...))
			_ = pgwire.WriteMock(conn, pgwire.MockCommandComplete("SELECT 0"))
			return pgwire.WriteMock(conn, pgwire.MockReadyForQuery())
		}
	})
	h := &Handler{Store: s}

	for _, tc := range []struct {
		method, path, body string
		want               int
	}{
		{"GET", "/v1/workbench/items", "", 200},
		{"POST", "/v1/workbench/items", `{"kind":"task","title":"x"}`, 200},
		{"POST", "/v1/workbench/items", `{"kind":"INVALID"}`, 400},
		{"POST", "/v1/workbench/items", `{"kind":"task","status":"bogus"}`, 400},
		{"GET", "/v1/workbench/summary", "", 200},
		{"POST", "/v1/workbench/capture", `{"text":""}`, 400},
		{"GET", "/v1/workbench/unknown", "", 404},
	} {
		w := handlerCall(t, h, tc.method, tc.path, tc.body)
		if w.Code != tc.want {
			t.Fatalf("%s %s => %d (want %d) %s", tc.method, tc.path, w.Code, tc.want, w.Body.String())
		}
	}
}

func TestCaptureHandler(t *testing.T) {
	s, m := newStore(t)
	m.SetReply(replyWith(t, itemColSpec, itemRow("ic", "task", "提交论文")))
	h := &Handler{Store: s}
	w := handlerCall(t, h, "POST", "/v1/workbench/capture", `{"text":"记得明天提交论文 #论文 紧急"}`)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var payload map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &payload)
	if payload["ai_class"] != "task" {
		t.Fatalf("ai_class=%v", payload["ai_class"])
	}
	ex := payload["extracted"].(map[string]any)
	if ex["priority"] != "high" || ex["due_date"] != "2026-11-05" {
		t.Fatalf("extracted=%v", ex)
	}
	// The INSERT must carry source=capture + ai metadata.
	q := m.Queries()[0]
	for _, want := range []string{"ai_class", "confidence", "RETURNING"} {
		if !strings.Contains(q, want) {
			t.Fatalf("capture insert missing %q: %s", want, q)
		}
	}
	// The source and ai metadata travel as bound parameters (SQL injection safe),
	// not as string literals spliced into the query.
	bound := m.Params()[0]
	if len(bound) < 14 || bound[10] != "capture" || bound[11] != "task" {
		t.Fatalf("capture bound params wrong: %v", bound)
	}
}

// POST bodies arrive in the portal's snake_case contract. Without explicit json
// tags, fields whose Go name differs from the key by an underscore (next_step,
// due_date, project_id) are silently dropped, so this guards the tags themselves.
func TestRequestBodiesBindSnakeCase(t *testing.T) {
	var pb projectBody
	if err := json.Unmarshal([]byte(`{"name":"玉米 bZIP","description":"d","next_step":"跑建树","health":"at_risk","status":"paused","due_date":"2026-11-09"}`), &pb); err != nil {
		t.Fatal(err)
	}
	if pb.NextStep != "跑建树" || pb.DueDate == nil || *pb.DueDate != "2026-11-09" {
		t.Fatalf("projectBody lost fields: %+v", pb)
	}

	var lb planBody
	if err := json.Unmarshal([]byte(`{"kind":"stage","title":"t","outcome":"o","metrics":"m","horizon":"h","next_step":"ns","due_date":"2026-12-01","progress":40}`), &lb); err != nil {
		t.Fatal(err)
	}
	if lb.Outcome != "o" || lb.Metrics != "m" || lb.Horizon != "h" || lb.NextStep != "ns" {
		t.Fatalf("planBody lost fields: %+v", lb)
	}
	if lb.DueDate == nil || *lb.DueDate != "2026-12-01" || lb.Progress != 40 {
		t.Fatalf("planBody lost fields: %+v", lb)
	}

	var ib itemBody
	if err := json.Unmarshal([]byte(`{"kind":"task","title":"x","due_date":"2026-11-05","project_id":"p1","plan_id":"l1","tags":["论文"]}`), &ib); err != nil {
		t.Fatal(err)
	}
	if ib.DueDate == nil || *ib.DueDate != "2026-11-05" {
		t.Fatalf("itemBody lost due_date: %+v", ib)
	}
	if ib.ProjectID == nil || *ib.ProjectID != "p1" || ib.PlanID == nil || *ib.PlanID != "l1" {
		t.Fatalf("itemBody lost links: %+v", ib)
	}
	if len(ib.Tags) != 1 || ib.Tags[0] != "论文" {
		t.Fatalf("itemBody lost tags: %+v", ib)
	}

	// Defaults applied by UnmarshalJSON must survive the tags.
	var pb2 projectBody
	if err := json.Unmarshal([]byte(`{"name":"n"}`), &pb2); err != nil {
		t.Fatal(err)
	}
	if pb2.Health != "on_track" || pb2.Status != "active" {
		t.Fatalf("projectBody defaults lost: %+v", pb2)
	}
	var ib2 itemBody
	if err := json.Unmarshal([]byte(`{"title":"x"}`), &ib2); err != nil {
		t.Fatal(err)
	}
	if ib2.Kind != "note" || ib2.Priority != "normal" {
		t.Fatalf("itemBody defaults lost: %+v", ib2)
	}
}
