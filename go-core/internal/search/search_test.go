package search

import (
	"context"
	"errors"
	"testing"
)

type fake struct {
	name string
	rows []Result
	err  error
}

func (f fake) Name() string                                          { return f.name }
func (f fake) Search(context.Context, string, int) ([]Result, error) { return f.rows, f.err }
func TestFederatedSearchDeduplicatesAndLabelsSource(t *testing.T) {
	s := Service{MaxResults: 10, Providers: []Provider{fake{"local", []Result{{Title: "A", URL: "https://x"}}, nil}, fake{"searxng", []Result{{Title: "A2", URL: "https://x"}, {Title: "B", URL: "https://y"}}, nil}}}
	rows, w, e := s.Search(context.Background(), "maize")
	if e != nil || len(rows) != 2 || len(w) != 0 || rows[0].Source == "" {
		t.Fatalf("%v %v %+v", e, w, rows)
	}
}
func TestProviderFailureIsPartialNotFatal(t *testing.T) {
	s := Service{Providers: []Provider{fake{"down", nil, errors.New("offline")}, fake{"ok", []Result{{Title: "B", URL: "b"}}, nil}}}
	rows, w, e := s.Search(context.Background(), "q")
	if e != nil || len(rows) != 1 || len(w) != 1 {
		t.Fatalf("%v %v %+v", e, w, rows)
	}
}
func TestSearchRejectsEmptyQuery(t *testing.T) {
	s := Service{}
	if _, _, e := s.Search(context.Background(), "  "); e == nil {
		t.Fatal("empty query accepted")
	}
}
