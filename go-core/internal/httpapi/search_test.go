package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

type searchPayload struct {
	Count      int `json:"count"`
	LocalTotal int `json:"localTotal"`
	Results    []struct {
		Title    string `json:"title"`
		URL      string `json:"url"`
		Engine   string `json:"engine"`
		Category string `json:"category"`
		Kind     string `json:"kind"`
	} `json:"results"`
}

func knowledgeBackend(t *testing.T, body string, calls *int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(calls, 1)
		if r.URL.Path != "/api/knowledge/search" {
			t.Errorf("backend path = %s", r.URL.Path)
		}
		if !strings.Contains(r.Header.Get("Cookie"), "labspace_session=") {
			t.Errorf("caller cookie was not forwarded: %q", r.Header.Get("Cookie"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, body)
	}))
}

// 知识条目按人可见，检索合并必须把调用者会话原样交给后端判定。
func TestPortalSearchMergesKnowledgeHits(t *testing.T) {
	var calls int32
	backend := knowledgeBackend(t, `{"hits":[{
		"title":"fastp 质控笔记","url":"/knowledge?doc=7","content":"接头去除与产出率",
		"engine":"知识库","category":"knowledge","kind":"local","path":"/knowledge?doc=7"
	}]}`, &calls)
	defer backend.Close()

	s := fileServer(t)
	s.BackendBase = backend.URL
	w := fileCall(t, s, "GET", "/v1/portal/search?q=fastp&scope=local", fileToken(t, "student01@local", []string{"lab-student"}))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d %s", w.Code, w.Body.String())
	}
	if calls == 0 {
		t.Fatal("backend was never consulted for knowledge hits")
	}
	var payload searchPayload
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Results) == 0 || payload.Results[0].Category != "knowledge" {
		t.Fatalf("knowledge hit should rank first: %+v", payload.Results)
	}
	if got := payload.Results[0].URL; got != "/knowledge?doc=7" {
		t.Errorf("deep link = %s", got)
	}
	if payload.LocalTotal < 1 || payload.Count < 1 {
		t.Errorf("localTotal=%d count=%d", payload.LocalTotal, payload.Count)
	}
}

func TestPortalSearchKeepsKnowledgeOutOfWebScope(t *testing.T) {
	var calls int32
	backend := knowledgeBackend(t, `{"hits":[]}`, &calls)
	defer backend.Close()

	s := fileServer(t)
	s.BackendBase = backend.URL
	fileCall(t, s, "GET", "/v1/portal/search?q=fastp&scope=web", fileToken(t, "student01@local", []string{"lab-student"}))
	if calls != 0 {
		t.Fatalf("scope=web must not query knowledge, calls=%d", calls)
	}
}

// 后端不可达时搜索照常返回本地与联网结果。
func TestPortalSearchSurvivesUnreachableBackend(t *testing.T) {
	s := fileServer(t)
	s.BackendBase = "http://127.0.0.1:1"
	w := fileCall(t, s, "GET", "/v1/portal/search?q=plasmid&scope=local", fileToken(t, "student01@local", []string{"lab-student"}))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d %s", w.Code, w.Body.String())
	}
	var payload searchPayload
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	for _, r := range payload.Results {
		if r.Category == "knowledge" {
			t.Fatalf("unexpected knowledge hit: %+v", r)
		}
	}
	if len(payload.Results) == 0 {
		t.Error("local corpus hits must survive a failed merge")
	}
}
