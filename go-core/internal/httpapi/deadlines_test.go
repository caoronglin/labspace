package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// fakeDeadlineWriter 记录下发的 deadline：httptest.ResponseRecorder 不支持
// ResponseController，用它才能验证「真的按路由分了档」。
type fakeDeadlineWriter struct {
	http.ResponseWriter
	read, write time.Time
}

func (f *fakeDeadlineWriter) SetReadDeadline(t time.Time) error  { f.read = t; return nil }
func (f *fakeDeadlineWriter) SetWriteDeadline(t time.Time) error { f.write = t; return nil }

func serveWithDeadline(t *testing.T, path string) *fakeDeadlineWriter {
	t.Helper()
	w := &fakeDeadlineWriter{ResponseWriter: httptest.NewRecorder()}
	r := httptest.NewRequest("POST", path, nil)
	WithDeadlines(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})).ServeHTTP(w, r)
	return w
}

// TestBulkUploadsGetLongDeadline 锁死 BUG-04：大文件路由必须拿到小时级窗口，
// 否则 80MB / 2MB/s（约 40 秒）的上传会被服务器级 15 秒兜底掐断。
func TestBulkUploadsGetLongDeadline(t *testing.T) {
	cases := []struct {
		path string
		bulk bool
	}{
		{"/v1/files/upload", true},
		{"/api/files", true},
		{"/api/next/files", true},
		{"/v1/snapotter/run", true},
		{"/v1/workbench/summary", false},
		{"/v1/services", false},
		{"/api/next/v1/workbench", false},
	}

	for _, c := range cases {
		w := serveWithDeadline(t, c.path)
		if w.read.IsZero() || w.write.IsZero() {
			t.Fatalf("%s: 没有下发 deadline", c.path)
		}
		readWindow := time.Until(w.read)
		if c.bulk && readWindow < 30*time.Minute {
			t.Fatalf("%s: 大文件窗口过短（%v），慢速上传会被掐断", c.path, readWindow)
		}
		if !c.bulk && readWindow > time.Minute {
			t.Fatalf("%s: 普通 API 的读窗口过大（%v），慢速攻击可以占住连接", c.path, readWindow)
		}
	}
}

func TestIsBulkPath(t *testing.T) {
	if isBulkPath("/v1/files/upload") != true {
		t.Fatal("上传应属于大文件路由")
	}
	if isBulkPath("/v1/services/health") != false {
		t.Fatal("健康检查不该走小时级窗口")
	}
}
