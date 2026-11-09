// Package imagegen controls generation jobs, provider calls, result validation,
// and ACLs. It does not expose provider URLs or raw generated image bytes.
package imagegen

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

var safeName = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,95}$`)

type Policy interface {
	Can(ctx context.Context, tenant, user, resource, action string) (bool, error)
}
type Provider interface {
	Generate(ctx context.Context, model, prompt, key string) ([]byte, error)
}
type BlobStore interface {
	Put(ctx context.Context, tenant, objectID string, data []byte) error
}
type KeyResolver interface {
	Key(ctx context.Context, tenant, user, provider string) (string, error)
}
type Request struct {
	TenantID       string
	UserID         string
	FolderID       string
	Prompt         string
	Model          string
	Provider       string
	IdempotencyKey string
}
type Receipt struct {
	ObjectID string `json:"object_id"`
	Model    string `json:"model"`
	Status   string `json:"status"`
	Reused   bool   `json:"reused"`
}
type Service struct {
	Policy   Policy
	Provider Provider
	Store    BlobStore
	Keys     KeyResolver
	mu       sync.Mutex
	done     map[string]Receipt
}

func New(p Policy, g Provider, s BlobStore, k KeyResolver) *Service {
	return &Service{Policy: p, Provider: g, Store: s, Keys: k, done: map[string]Receipt{}}
}
func (s *Service) Generate(ctx context.Context, req Request) (Receipt, error) {
	if !safeName.MatchString(req.TenantID) || !safeName.MatchString(req.UserID) || !safeName.MatchString(req.FolderID) || !safeName.MatchString(req.IdempotencyKey) || len(strings.TrimSpace(req.Prompt)) < 3 || len(req.Prompt) > 4000 || req.IdempotencyKey == "" || len(req.IdempotencyKey) > 100 {
		return Receipt{}, errors.New("invalid image generation request")
	}
	for _, action := range []string{"use_ai", "write", "send_external"} {
		ok, err := s.Policy.Can(ctx, req.TenantID, req.UserID, req.FolderID, action)
		if err != nil {
			return Receipt{}, err
		}
		if !ok {
			return Receipt{}, errors.New("permission denied: " + action)
		}
	}
	id := req.TenantID + "\x00" + req.UserID + "\x00" + req.FolderID + "\x00" + req.IdempotencyKey
	// Lock deliberately serializes simple in-process jobs. Production uses DB
	// unique constraints + durable queue, see documentation.
	s.mu.Lock()
	defer s.mu.Unlock()
	if v, ok := s.done[id]; ok {
		v.Reused = true
		return v, nil
	}
	key, err := s.Keys.Key(ctx, req.TenantID, req.UserID, req.Provider)
	if err != nil {
		return Receipt{}, err
	}
	if key == "" {
		return Receipt{}, errors.New("personal credential unavailable")
	}
	raw, err := s.Provider.Generate(ctx, req.Model, req.Prompt, key)
	if err != nil {
		return Receipt{}, err
	}
	if len(raw) == 0 || len(raw) > 6<<20 {
		return Receipt{}, errors.New("invalid generated image size")
	}
	if _, _, err = image.DecodeConfig(bytes.NewReader(raw)); err != nil {
		return Receipt{}, errors.New("provider did not return a supported raster image")
	}
	// Recheck permission after the potentially lengthy provider call.
	for _, action := range []string{"use_ai", "write"} {
		ok, err := s.Policy.Can(ctx, req.TenantID, req.UserID, req.FolderID, action)
		if err != nil {
			return Receipt{}, err
		}
		if !ok {
			return Receipt{}, errors.New("permission revoked before saving image")
		}
	}
	objectID := "generated/" + req.TenantID + "/" + fmt.Sprintf("%d", time.Now().UnixNano()) + "-" + req.IdempotencyKey
	if err = s.Store.Put(ctx, req.TenantID, objectID, raw); err != nil {
		return Receipt{}, err
	}
	v := Receipt{ObjectID: objectID, Model: req.Model, Status: "stored"}
	s.done[id] = v
	return v, nil
}

// ImageAPIProvider is one controlled endpoint adapter for an OpenAI-compatible
// image API. Base URL must be admin-configured; never accept it from a request.
type ImageAPIProvider struct {
	URL    string
	Client *http.Client
}

func (p ImageAPIProvider) Generate(ctx context.Context, model, prompt, key string) ([]byte, error) {
	if p.URL == "" || (!strings.HasPrefix(p.URL, "https://") && !strings.HasPrefix(p.URL, "http://127.0.0.1:") && !strings.HasPrefix(p.URL, "http://[::1]:")) {
		return nil, errors.New("unsafe provider URL")
	}
	data, _ := json.Marshal(map[string]any{"model": model, "prompt": prompt, "n": 1, "output_format": "png"})
	r, e := http.NewRequestWithContext(ctx, "POST", p.URL, bytes.NewReader(data))
	if e != nil {
		return nil, e
	}
	r.Header.Set("Authorization", "Bearer "+key)
	r.Header.Set("Content-Type", "application/json")
	client := p.Client
	if client == nil {
		client = &http.Client{Timeout: 60 * time.Second}
	}
	resp, e := client.Do(r)
	if e != nil {
		return nil, e
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("image provider returned HTTP %d", resp.StatusCode)
	}
	limited, e := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if e != nil {
		return nil, e
	}
	var body struct {
		Data []struct {
			Base64 string `json:"b64_json"`
		} `json:"data"`
	}
	if e = json.Unmarshal(limited, &body); e != nil {
		return nil, e
	}
	if len(body.Data) != 1 || body.Data[0].Base64 == "" {
		return nil, errors.New("missing base64 image")
	}
	out, e := base64.StdEncoding.DecodeString(body.Data[0].Base64)
	if e != nil {
		return nil, e
	}
	return out, nil
}
