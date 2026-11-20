package lifedb

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestFallbackClientHasTimeout 锁死 BUG-07 的一半：没配 Client 时不能再回落到
// http.DefaultClient。那个客户端没有超时，上游卡住会把 handler 的 goroutine
// 永久占住，而调用方通常早已断开连接。
func TestFallbackClientHasTimeout(t *testing.T) {
	s := &Searcher{}
	c := s.client()
	if c == http.DefaultClient {
		t.Fatal("兜底客户端不能是 http.DefaultClient（它没有超时）")
	}
	if c.Timeout <= 0 {
		t.Fatalf("兜底客户端必须有正超时，实际 %v", c.Timeout)
	}
	if c.Timeout > 30*time.Second {
		t.Fatalf("兜底超时过长（%v），一个卡住的上游会拖垮整页搜索", c.Timeout)
	}
}

// TestSlowUpstreamIsCancelled 用真实连接验证：上游一直不响应时，请求会按
// 上下文/超时返回，而不是永久挂住。
func TestSlowUpstreamIsCancelled(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
	}))
	defer srv.Close()
	defer close(release)

	s := &Searcher{Client: &http.Client{Timeout: 150 * time.Millisecond}}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() {
		var out struct{}
		done <- s.getJSON(ctx, srv.URL+"/slow", &out)
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("上游永不响应时必须返回超时错误")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("请求没有在超时内返回：goroutine 会一直挂在这里")
	}
}
