// Package vault encrypts personal environment variables. The memory store is
// for integration tests; a durable DB backend + KMS/key rotation is required.
package vault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"io"
	"regexp"
	"sync"
)

var envName = regexp.MustCompile(`^[A-Z][A-Z0-9_]{1,63}$`)

type Vault struct {
	mu         sync.RWMutex
	key        []byte
	ciphertext map[string][]byte
}

func New(key []byte) (*Vault, error) {
	if len(key) != 32 {
		return nil, errors.New("vault master key must be exactly 32 bytes")
	}
	return &Vault{key: append([]byte{}, key...), ciphertext: map[string][]byte{}}, nil
}
func slot(t, u, name string) string { return t + "\x00" + u + "\x00" + name }
func (v *Vault) Save(tenant, user, name, value string) error {
	if tenant == "" || user == "" || !envName.MatchString(name) || value == "" || len(value) > 8192 {
		return errors.New("invalid secret")
	}
	block, _ := aes.NewCipher(v.key)
	gcm, _ := cipher.NewGCM(block)
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return err
	}
	// Bind ciphertext to tenant+user+key; copying DB record across users fails authentication.
	id := slot(tenant, user, name)
	encrypted := gcm.Seal(nonce, nonce, []byte(value), []byte(id))
	v.mu.Lock()
	defer v.mu.Unlock()
	v.ciphertext[id] = encrypted
	return nil
}
func (v *Vault) Get(tenant, user, name string) (string, error) {
	id := slot(tenant, user, name)
	v.mu.RLock()
	raw, ok := v.ciphertext[id]
	data := append([]byte(nil), raw...)
	v.mu.RUnlock()
	if !ok {
		return "", errors.New("secret not configured")
	}
	block, _ := aes.NewCipher(v.key)
	gcm, _ := cipher.NewGCM(block)
	if len(data) < gcm.NonceSize() {
		return "", errors.New("corrupted ciphertext")
	}
	val, e := gcm.Open(nil, data[:gcm.NonceSize()], data[gcm.NonceSize():], []byte(id))
	if e != nil {
		return "", e
	}
	return string(val), nil
}
func (v *Vault) Delete(tenant, user, name string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	delete(v.ciphertext, slot(tenant, user, name))
}
func (v *Vault) Names(tenant, user string) []string {
	v.mu.RLock()
	defer v.mu.RUnlock()
	prefix := tenant + "\x00" + user + "\x00"
	items := []string{}
	for k := range v.ciphertext {
		if len(k) > len(prefix) && k[:len(prefix)] == prefix {
			items = append(items, k[len(prefix):])
		}
	}
	return items
}
