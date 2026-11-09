package downloads

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"
)

type Protocol string

const (
	HTTPS Protocol = "https"
	S3    Protocol = "s3"
	SFTP  Protocol = "sftp"
	FTP   Protocol = "ftp"
)

type Actor struct{ TenantID, UserID string }
type Transfer struct {
	ID, TenantID, UserID, ResourceID string
	Protocol                         Protocol
	State                            string
	Bytes                            int64
	CreatedAt                        time.Time
}
type Policy interface {
	Can(context.Context, string, string, string, string) (bool, error)
}
type Driver interface {
	Protocol() Protocol
	Start(context.Context, Actor, string, string) (string, error)
}
type Repository interface {
	Insert(context.Context, Transfer) error
	Update(context.Context, Transfer) error
	List(context.Context, string, string) ([]Transfer, error)
}
type Service struct {
	Policy  Policy
	Repo    Repository
	drivers map[Protocol]Driver
	mu      sync.RWMutex
}

func New(p Policy, r Repository) *Service {
	return &Service{Policy: p, Repo: r, drivers: map[Protocol]Driver{}}
}
func (s *Service) Register(d Driver) error {
	if d == nil || d.Protocol() == "" {
		return errors.New("invalid driver")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.drivers[d.Protocol()]; ok {
		return errors.New("driver already registered")
	}
	s.drivers[d.Protocol()] = d
	return nil
}
func (s *Service) Start(ctx context.Context, a Actor, resource, sourceID string, p Protocol) (Transfer, error) {
	if a.TenantID == "" || a.UserID == "" || resource == "" || sourceID == "" {
		return Transfer{}, errors.New("missing transfer identity")
	}
	if s.Policy == nil || s.Repo == nil {
		return Transfer{}, errors.New("download dependencies unavailable")
	}
	ok, err := s.Policy.Can(ctx, a.TenantID, a.UserID, resource, "download")
	if err != nil {
		return Transfer{}, err
	}
	if !ok {
		return Transfer{}, errors.New("download denied")
	}
	s.mu.RLock()
	d := s.drivers[p]
	s.mu.RUnlock()
	if d == nil {
		return Transfer{}, errors.New("protocol driver unavailable")
	}
	id, err := d.Start(ctx, a, resource, sourceID)
	if err != nil {
		return Transfer{}, err
	}
	if strings.TrimSpace(id) == "" {
		return Transfer{}, errors.New("driver returned empty transfer id")
	}
	t := Transfer{ID: id, TenantID: a.TenantID, UserID: a.UserID, ResourceID: resource, Protocol: p, State: "queued", CreatedAt: time.Now().UTC()}
	if err = s.Repo.Insert(ctx, t); err != nil {
		return Transfer{}, err
	}
	return t, nil
}
func (s *Service) Stats(ctx context.Context, tenant, user string) (map[Protocol]int64, error) {
	if tenant == "" || user == "" {
		return nil, errors.New("identity required")
	}
	rows, err := s.Repo.List(ctx, tenant, user)
	if err != nil {
		return nil, err
	}
	out := map[Protocol]int64{}
	for _, r := range rows {
		if r.TenantID != tenant || r.UserID != user {
			return nil, errors.New("repository scope violation")
		}
		out[r.Protocol] += r.Bytes
	}
	return out, nil
}
