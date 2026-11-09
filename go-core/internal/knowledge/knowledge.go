// Package knowledge provides ACL-gated ingestion and retrieval orchestration.
// The MemoryIndex is for smoke tests only; production must supply a durable
// PostgreSQL/pgvector or Haystack-backed implementation.
package knowledge

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"
)

type Chunk struct {
	TenantID   string `json:"tenant_id"`
	ResourceID string `json:"resource_id"`
	Position   int    `json:"position"`
	Text       string `json:"text"`
}
type Hit struct {
	ResourceID string `json:"resource_id"`
	Position   int    `json:"position"`
	Snippet    string `json:"snippet"`
	Score      int    `json:"score"`
}
type Policy interface {
	Can(ctx context.Context, tenant, user, resource, action string) (bool, error)
}
type Index interface {
	Replace(ctx context.Context, tenant, resource string, chunks []Chunk) error
	Candidates(ctx context.Context, tenant, query string, limit int) ([]Hit, error)
	Delete(ctx context.Context, tenant, resource string) error
}
type Service struct {
	Index  Index
	Policy Policy
}

func Split(tenant, resource, text string) ([]Chunk, error) {
	if tenant == "" || resource == "" {
		return nil, errors.New("missing resource identity")
	}
	if utf8.RuneCountInString(text) > 250000 {
		return nil, errors.New("inline ingest exceeds limit")
	}
	raw := []rune(text)
	parts := []Chunk{}
	for i := 0; i < len(raw); i += 450 {
		end := i + 450
		if end > len(raw) {
			end = len(raw)
		}
		s := strings.TrimSpace(string(raw[i:end]))
		if s != "" {
			parts = append(parts, Chunk{TenantID: tenant, ResourceID: resource, Position: len(parts), Text: s})
		}
	}
	return parts, nil
}
func (s *Service) Ingest(ctx context.Context, tenant, user, resource, text string) (int, error) {
	for _, a := range []string{"read", "index"} {
		ok, err := s.Policy.Can(ctx, tenant, user, resource, a)
		if err != nil {
			return 0, err
		}
		if !ok {
			return 0, errors.New("permission denied")
		}
	}
	c, err := Split(tenant, resource, text)
	if err != nil {
		return 0, err
	}
	for _, a := range []string{"read", "index"} {
		ok, checkErr := s.Policy.Can(ctx, tenant, user, resource, a)
		if checkErr != nil {
			return 0, checkErr
		}
		if !ok {
			return 0, errors.New("permission revoked before indexing")
		}
	}
	if err = s.Index.Replace(ctx, tenant, resource, c); err != nil {
		return 0, err
	}
	return len(c), nil
}
func (s *Service) Search(ctx context.Context, tenant, user, q string, limit int) ([]Hit, error) {
	if limit < 1 || limit > 20 {
		return nil, errors.New("limit must be 1..20")
	}
	if strings.TrimSpace(q) == "" {
		return []Hit{}, nil
	}
	candidates, err := s.Index.Candidates(ctx, tenant, q, 100)
	if err != nil {
		return nil, err
	}
	out := []Hit{}
	for _, hit := range candidates {
		if len(out) >= limit {
			break
		}
		ok, err := s.Policy.Can(ctx, tenant, user, hit.ResourceID, "use_ai")
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		ok, err = s.Policy.Can(ctx, tenant, user, hit.ResourceID, "read")
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		out = append(out, hit)
	}
	return out, nil
}
func (s *Service) Delete(ctx context.Context, tenant, user, resource string) error {
	ok, err := s.Policy.Can(ctx, tenant, user, resource, "index")
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("permission denied")
	}
	return s.Index.Delete(ctx, tenant, resource)
}

type MemoryIndex struct {
	mu     sync.RWMutex
	chunks map[string][]Chunk
}

func NewMemoryIndex() *MemoryIndex { return &MemoryIndex{chunks: make(map[string][]Chunk)} }
func key(t, r string) string       { return t + "\x00" + r }
func (m *MemoryIndex) Replace(_ context.Context, t, r string, cs []Chunk) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, c := range cs {
		if c.TenantID != t || c.ResourceID != r {
			return errors.New("incorrect resource scope")
		}
	}
	m.chunks[key(t, r)] = append([]Chunk(nil), cs...)
	return nil
}
func (m *MemoryIndex) Delete(_ context.Context, t, r string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.chunks, key(t, r))
	return nil
}
func (m *MemoryIndex) Candidates(_ context.Context, t, q string, max int) ([]Hit, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	terms := strings.Fields(strings.ToLower(q))
	out := []Hit{}
	for _, cs := range m.chunks {
		for _, c := range cs {
			if c.TenantID != t {
				continue
			}
			score := 0
			for _, term := range terms {
				if strings.Contains(strings.ToLower(c.Text), term) {
					score++
				}
			}
			if score > 0 {
				snippet := []rune(c.Text)
				if len(snippet) > 300 {
					snippet = snippet[:300]
				}
				out = append(out, Hit{ResourceID: c.ResourceID, Position: c.Position, Snippet: string(snippet), Score: score})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		if out[i].ResourceID != out[j].ResourceID {
			return out[i].ResourceID < out[j].ResourceID
		}
		return out[i].Position < out[j].Position
	})
	if len(out) > max {
		out = out[:max]
	}
	return out, nil
}
