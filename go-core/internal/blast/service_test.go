package blast

import (
	"context"
	"errors"
	"testing"
)

type allow bool

func (a allow) Can(context.Context, string, string, string, string) (bool, error) {
	return bool(a), nil
}

type cat struct{}

func (cat) Resolve(context.Context, string) (Database, error) {
	return Database{Alias: "maize", ResourceID: "db-maize", Path: "/srv/blast/db/maize"}, nil
}

type run struct{ args []string }

func (r *run) Run(_ context.Context, _ string, args []string, _ string) ([]byte, error) {
	r.args = args
	return []byte("q\ts\t99.9"), nil
}
func TestBlastBuildsSafeArgvAndChecksACL(t *testing.T) {
	rr := &run{}
	s := Service{Policy: allow(true), Catalog: cat{}, Runner: rr, Binary: "/usr/bin/"}
	res, e := s.Run(context.Background(), Actor{"t", "u"}, Request{Database: "maize", Program: "blastn", QueryFASTA: ">q\nACGTACGT\n", EValue: 1e-5, MaxTargets: 10})
	if e != nil || res.Output == "" {
		t.Fatalf("%v %+v", e, res)
	}
	for _, a := range rr.args {
		if a == ";" || a == "&&" {
			t.Fatal("shell token in argv")
		}
	}
}
func TestBlastRejectsUnauthorized(t *testing.T) {
	s := Service{Policy: allow(false), Catalog: cat{}, Runner: &run{}, Binary: "/usr/bin/"}
	_, e := s.Run(context.Background(), Actor{"t", "u"}, Request{Database: "maize", Program: "blastn", QueryFASTA: ">q\nACGTACGT", EValue: 1e-5, MaxTargets: 10})
	if e == nil {
		t.Fatal("unauthorized BLAST accepted")
	}
}
func TestBlastRejectsUnknownProgram(t *testing.T) {
	s := Service{Policy: allow(true), Catalog: cat{}, Runner: &run{}, Binary: "/usr/bin/"}
	_, e := s.Run(context.Background(), Actor{"t", "u"}, Request{Database: "maize", Program: "bash", QueryFASTA: ">q\nACGTACGT", EValue: 1e-5, MaxTargets: 10})
	if e == nil || errors.Is(e, nil) {
		t.Fatal("unsupported program accepted")
	}
}
