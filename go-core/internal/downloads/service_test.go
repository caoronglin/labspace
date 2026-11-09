package downloads

import (
	"context"
	"errors"
	"testing"
)

type pol bool

func (p pol) Can(context.Context, string, string, string, string) (bool, error) { return bool(p), nil }

type drv struct{}

func (drv) Protocol() Protocol                                           { return SFTP }
func (drv) Start(context.Context, Actor, string, string) (string, error) { return "xfer-1", nil }

type repo struct{ rows []Transfer }

func (r *repo) Insert(_ context.Context, t Transfer) error                      { r.rows = append(r.rows, t); return nil }
func (r *repo) Update(_ context.Context, t Transfer) error                      { return nil }
func (r *repo) List(_ context.Context, tenant, user string) ([]Transfer, error) { return r.rows, nil }
func TestDownloadPermissionAndStats(t *testing.T) {
	r := &repo{}
	s := New(pol(true), r)
	if err := s.Register(drv{}); err != nil {
		t.Fatal(err)
	}
	x, e := s.Start(context.Background(), Actor{"t", "u"}, "f", "source-1", SFTP)
	if e != nil || x.ID != "xfer-1" {
		t.Fatalf("%+v %v", x, e)
	}
	r.rows[0].Bytes = 42
	m, e := s.Stats(context.Background(), "t", "u")
	if e != nil || m[SFTP] != 42 {
		t.Fatalf("%v %v", m, e)
	}
}
func TestPreviewOnlyCannotDownload(t *testing.T) {
	s := New(pol(false), &repo{})
	_ = s.Register(drv{})
	_, e := s.Start(context.Background(), Actor{"t", "u"}, "f", "source", SFTP)
	if e == nil {
		t.Fatal("download allowed without permission")
	}
}
func TestMissingDriverFailsClosed(t *testing.T) {
	s := New(pol(true), &repo{})
	_, e := s.Start(context.Background(), Actor{"t", "u"}, "f", "source", HTTPS)
	if !errors.Is(e, errors.New("protocol driver unavailable")) && e == nil {
		t.Fatal("missing driver should fail")
	}
}
