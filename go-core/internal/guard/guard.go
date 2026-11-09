// Package guard verifies short-lived, one-use MAC signatures from the existing
// FastAPI gateway. It is transport authentication, NOT file ACL authorization.
package guard

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const MaxBody = 10 << 20

type Actor struct {
	UserID, TenantID string
	Admin            bool
}
type Verifier struct {
	key  []byte
	mu   sync.Mutex
	seen map[string]time.Time
	now  func() time.Time
}

func New(key []byte) (*Verifier, error) {
	if len(key) < 32 {
		return nil, errors.New("LABGO_HMAC_KEY must be >=32 bytes")
	}
	return &Verifier{key: append([]byte{}, key...), seen: map[string]time.Time{}, now: time.Now}, nil
}
func canonical(method, path, user, tenant, admin, timestamp, nonce string, body []byte) string {
	sum := sha256.Sum256(body)
	return strings.Join([]string{method, path, user, tenant, admin, timestamp, nonce, hex.EncodeToString(sum[:])}, "\n")
}
func Sign(key []byte, method, path string, a Actor, timestamp, nonce string, body []byte) string {
	b := "0"
	if a.Admin {
		b = "1"
	}
	m := hmac.New(sha256.New, key)
	m.Write([]byte(canonical(method, path, a.UserID, a.TenantID, b, timestamp, nonce, body)))
	return hex.EncodeToString(m.Sum(nil))
}
func (v *Verifier) Check(r *http.Request, body []byte) (Actor, error) {
	a := Actor{UserID: r.Header.Get("X-Labgo-User"), TenantID: r.Header.Get("X-Labgo-Tenant"), Admin: r.Header.Get("X-Labgo-Admin") == "1"}
	ts := r.Header.Get("X-Labgo-Time")
	nonce := r.Header.Get("X-Labgo-Nonce")
	sig := r.Header.Get("X-Labgo-Signature")
	if a.UserID == "" || a.TenantID == "" || len(nonce) < 16 || len(nonce) > 100 || len(sig) != 64 || (r.Header.Get("X-Labgo-Admin") != "0" && r.Header.Get("X-Labgo-Admin") != "1") {
		return Actor{}, errors.New("invalid authentication headers")
	}
	var sec int64
	if _, err := fmt.Sscan(ts, &sec); err != nil {
		return Actor{}, errors.New("invalid timestamp")
	}
	now := v.now()
	t := time.Unix(sec, 0)
	if t.Before(now.Add(-2*time.Minute)) || t.After(now.Add(2*time.Minute)) {
		return Actor{}, errors.New("signature expired")
	}
	expected := Sign(v.key, r.Method, r.URL.RequestURI(), a, ts, nonce, body)
	x, err := hex.DecodeString(sig)
	if err != nil {
		return Actor{}, errors.New("bad signature")
	}
	y, _ := hex.DecodeString(expected)
	if !hmac.Equal(x, y) {
		return Actor{}, errors.New("bad signature")
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	for n, exp := range v.seen {
		if exp.Before(now) {
			delete(v.seen, n)
		}
	}
	replayKey := a.TenantID + "\x00" + a.UserID + "\x00" + nonce
	if _, ok := v.seen[replayKey]; ok {
		return Actor{}, errors.New("replayed nonce")
	}
	if len(v.seen) > 50000 {
		return Actor{}, errors.New("nonce cache full")
	}
	v.seen[replayKey] = now.Add(3 * time.Minute)
	return a, nil
}
func ReadBounded(r *http.Request) ([]byte, error) {
	defer r.Body.Close()
	data, err := io.ReadAll(io.LimitReader(r.Body, MaxBody+1))
	if err != nil {
		return nil, err
	}
	if len(data) > MaxBody {
		return nil, errors.New("request body exceeds 10MiB")
	}
	return data, nil
}
