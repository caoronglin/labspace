package pgwire

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
)

// gs2Header is the SCRAM GS2 channel-binding header: "n,," means
// "client does not support channel binding, no authzid".
const gs2Header = "n,,"

// pbkdf2Key implements PBKDF2-HMAC-SHA256. The Go standard library has no
// PBKDF2, but SCRAM-SHA-256 (PostgreSQL's default since PG10) requires it.
// Keeping it here preserves the zero-external-dependency constraint.
func pbkdf2Key(password, salt []byte, iter, keyLen int) []byte {
	const hLen = sha256.Size
	blocks := (keyLen + hLen - 1) / hLen
	var c [4]byte
	out := make([]byte, 0, blocks*hLen)
	for i := 1; i <= blocks; i++ {
		mac := hmac.New(sha256.New, password)
		mac.Write(salt)
		binary.BigEndian.PutUint32(c[:], uint32(i))
		mac.Write(c[:])
		u := mac.Sum(nil)
		t := append([]byte(nil), u...)
		for n := 1; n < iter; n++ {
			mac = hmac.New(sha256.New, password)
			mac.Write(u)
			u = mac.Sum(nil)
			for j := range t {
				t[j] ^= u[j]
			}
		}
		out = append(out, t...)
	}
	return out[:keyLen]
}

func hmacSHA256(key, msg []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(msg)
	return m.Sum(nil)
}

func sha256Sum(b []byte) []byte {
	s := sha256.Sum256(b)
	return s[:]
}

func scramNonce() (string, error) {
	b := make([]byte, 18)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawStdEncoding.EncodeToString(b), nil
}

// saslInitialResponse builds the body of the first SASL 'p' message:
// mechanism\0 + int32 length + client-first-message.
//
// 注意 client-first-message = gs2-header + client-first-bare-message，
// gs2-header 是 "n,,"（无 channel binding、无 authzid）。只发 bare 会被真实
// PostgreSQL 判为 "malformed SCRAM message (08P01)"——本地 mock 若不校验
// 这一段就会把 bug 放过去。
func saslInitialResponse(bare string) []byte {
	var out []byte
	out = append(out, []byte("SCRAM-SHA-256")...)
	out = append(out, 0)
	msg := gs2Header + bare
	var l [4]byte
	binary.BigEndian.PutUint32(l[:], uint32(len(msg)))
	out = append(out, l[:]...)
	out = append(out, []byte(msg)...)
	return out
}

// scramClientFinal consumes the server-first-message and returns the
// client-final-message plus the expected ServerSignature for verification.
func scramClientFinal(password, serverFirst, nonce string) (clientFinal string, expectedServerSig []byte, err error) {
	fields := map[string]string{}
	for _, part := range strings.Split(serverFirst, ",") {
		if i := strings.IndexByte(part, '='); i > 0 {
			fields[part[:i]] = part[i+1:]
		}
	}
	combinedNonce := fields["r"]
	if !strings.HasPrefix(combinedNonce, nonce) {
		return "", nil, errors.New("SCRAM server nonce mismatch")
	}
	salt, e := base64.StdEncoding.DecodeString(fields["s"])
	if e != nil {
		return "", nil, fmt.Errorf("SCRAM salt decode: %w", e)
	}
	var iter int
	if _, e := fmt.Sscan(fields["i"], &iter); e != nil || iter < 1 || iter > 1<<20 {
		return "", nil, errors.New("SCRAM invalid iteration count")
	}
	withoutProof := "c=biws,r=" + combinedNonce // base64("n,,") == "biws"
	authMessage := "n=,r=" + nonce + "," + serverFirst + "," + withoutProof
	salted := pbkdf2Key([]byte(password), salt, iter, 32)
	clientKey := hmacSHA256(salted, []byte("Client Key"))
	storedKey := sha256Sum(clientKey)
	clientSig := hmacSHA256(storedKey, []byte(authMessage))
	proof := make([]byte, 32)
	for i := range proof {
		proof[i] = clientKey[i] ^ clientSig[i]
	}
	serverKey := hmacSHA256(salted, []byte("Server Key"))
	expectedServerSig = hmacSHA256(serverKey, []byte(authMessage))
	clientFinal = withoutProof + ",p=" + base64.StdEncoding.EncodeToString(proof)
	return clientFinal, expectedServerSig, nil
}
