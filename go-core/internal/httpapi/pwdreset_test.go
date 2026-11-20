package httpapi

import (
	"net/http/httptest"
	"testing"

	"labspace.local/go-core/internal/session"
)

// TestPwdResetGateBlocksEverythingButPasswordChange 锁死 BUG-02 的 Go 侧行为：
// 带 pwd_reset 的会话只能看自己的资料、改密码，其余一律 428。
// 修复前强制改密只挂在 FastAPI 中间件上，直连 Go 的 /api/files、/api/next/*
// 完全绕过 —— 那就是后门。
func TestPwdResetGateBlocksEverythingButPasswordChange(t *testing.T) {
	s := &Server{}
	flagged := session.Actor{UserID: "uuid-1", Email: "student09@local", PwdReset: true}
	normal := session.Actor{UserID: "uuid-1", Email: "student09@local"}

	cases := []struct {
		path     string
		pwdReset bool
		wantCode int // 0 = 放行
	}{
		{"/api/files", true, 428},
		{"/api/next/v1/workbench", true, 428},
		{"/v1/files/upload", true, 428},
		{"/api/me", true, 0},
		{"/api/me/password", true, 0},
		{"/api/auth/logout", true, 0},
		{"/api/files", false, 0},
	}

	for _, c := range cases {
		r := httptest.NewRequest("GET", c.path, nil)
		actor := normal
		if c.pwdReset {
			actor = flagged
		}
		err := s.pwdResetGate(r, actor)
		switch {
		case c.wantCode == 0 && err != nil:
			t.Fatalf("%s: 不该拦截，却返回 %d (%s)", c.path, err.code, err.reason)
		case c.wantCode != 0 && err == nil:
			t.Fatalf("%s: 未改密会话必须被拦（期望 %d）", c.path, c.wantCode)
		case c.wantCode != 0 && err.code != c.wantCode:
			t.Fatalf("%s: 状态码应为 %d，实际 %d", c.path, c.wantCode, err.code)
		}
	}
}
