package guard

import (
	"bytes"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func TestSignReplayAndTamper(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	v, _ := New(key)
	actor := Actor{UserID: "u", TenantID: "lab", Admin: true}
	body := []byte(`{"x":1}`)
	uri := "/internal/kb/ingest?resource=f"
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	makeReq := func(b []byte, nonce string) error {
		req := httptest.NewRequest("POST", uri, bytes.NewReader(b))
		req.Header.Set("X-Labgo-User", actor.UserID)
		req.Header.Set("X-Labgo-Tenant", actor.TenantID)
		req.Header.Set("X-Labgo-Admin", "1")
		req.Header.Set("X-Labgo-Time", ts)
		req.Header.Set("X-Labgo-Nonce", nonce)
		req.Header.Set("X-Labgo-Signature", Sign(key, "POST", uri, actor, ts, nonce, body))
		_, err := v.Check(req, b)
		return err
	}
	if e := makeReq(body, "nonce_abcdefghijklmnop"); e != nil {
		t.Fatal("valid signature rejected", e)
	}
	if e := makeReq(body, "nonce_abcdefghijklmnop"); e == nil {
		t.Fatal("replay accepted")
	}
	if e := makeReq([]byte(`{"x":2}`), "nonce_abccdefghijklmnop"); e == nil {
		t.Fatal("tampered body accepted")
	}
}
func TestShortKey(t *testing.T) {
	if _, e := New([]byte("a")); e == nil {
		t.Fatal("short key accepted")
	}
}
