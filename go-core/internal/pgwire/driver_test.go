package pgwire

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------- tests

func TestDriverRoundTrip(t *testing.T) {
	for _, auth := range []string{"trust", "cleartext", "md5", "scram"} {
		t.Run(auth, func(t *testing.T) {
			m := NewMockServer(t, auth)
			defer m.Close()
			db, err := sql.Open(driverName, m.DSN())
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := db.PingContext(ctx); err != nil {
				t.Fatalf("ping: %v (server err: %v)", err, m.err)
			}
			rows, err := db.QueryContext(ctx, "SELECT id, name FROM users WHERE name = ? AND id > ?", "alice", 0)
			if err != nil {
				t.Fatalf("query: %v (server err: %v)", err, m.err)
			}
			var got []string
			for rows.Next() {
				var id int64
				var name string
				if err := rows.Scan(&id, &name); err != nil {
					t.Fatal(err)
				}
				got = append(got, fmt.Sprintf("%d:%s", id, name))
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
			rows.Close()
			if strings.Join(got, ",") != "1:alice,2:bob" {
				t.Fatalf("rows = %v", got)
			}
			if len(m.queries) == 0 || !strings.Contains(m.queries[len(m.queries)-1], "$1") || !strings.Contains(m.queries[len(m.queries)-1], "$2") {
				t.Fatalf("placeholders not converted: %q", m.queries)
			}
			last := m.params[len(m.params)-1]
			if len(last) != 2 || last[0] != "alice" || last[1] != "0" {
				t.Fatalf("params = %v", last)
			}
			if m.err != nil {
				t.Fatalf("server-side protocol error: %v", m.err)
			}
		})
	}
}

func TestNullParam(t *testing.T) {
	m := NewMockServer(t, "trust")
	defer m.Close()
	db, _ := sql.Open(driverName, m.DSN())
	defer db.Close()
	if _, err := db.Exec("INSERT INTO t (a, b) VALUES (?, ?)", nil, "x"); err != nil {
		t.Fatal(err)
	}
	last := m.params[len(m.params)-1]
	if len(last) != 2 || last[0] != "<NULL>" || last[1] != "x" {
		t.Fatalf("NULL param not encoded: %v", last)
	}
}

func TestExecAndTransaction(t *testing.T) {
	m := NewMockServer(t, "trust")
	defer m.Close()
	db, _ := sql.Open(driverName, m.DSN())
	defer db.Close()
	ctx := context.Background()
	res, err := db.ExecContext(ctx, "UPDATE items SET title=? WHERE id=?", "new", 7)
	if err != nil {
		t.Fatal(err)
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		t.Fatalf("RowsAffected=%d", n)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM items WHERE id=?", 7); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(m.queries, "|")
	for _, want := range []string{"BEGIN", "ROLLBACK", "UPDATE items SET title=$1 WHERE id=$2"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in %q", want, joined)
		}
	}
}

func TestToDollar(t *testing.T) {
	cases := []struct{ in, want string }{
		{"SELECT ? , ?", "SELECT $1 , $2"},
		{"SELECT 'a?b' , ?", "SELECT 'a?b' , $1"},
		{"SELECT 'it''s ?' , ?", "SELECT 'it''s ?' , $1"},
		{"SELECT 1", "SELECT 1"},
	}
	for _, c := range cases {
		if got := toDollar(c.in); got != c.want {
			t.Fatalf("toDollar(%q)=%q want %q", c.in, got, c.want)
		}
	}
}

func TestSCRAMClientFinal(t *testing.T) {
	// Cross-check the client proof against an independently computed value.
	bare := "n=,r=clientNonce123"
	serverFirst := "r=clientNonce123serverNonce,s=c2FsdGJ5dGVz,i=4096"
	cf, sig, err := scramClientFinal("secret", serverFirst, "clientNonce123")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(cf, "c=biws,r=clientNonce123serverNonce,p=") {
		t.Fatal(cf)
	}
	if !verifyProofForTest(cf, bare, serverFirst, "secret") {
		t.Fatal("client proof invalid")
	}
	if len(sig) != 32 {
		t.Fatal("server signature length")
	}
}
