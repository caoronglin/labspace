package httpapi

import (
	"net/http"
	"strings"
	"time"
)

// 分档超时：全局 ReadTimeout 会把「读完整请求体」算进去，于是 15 秒的服务器级
// 超时会把一次 10 GB / 慢速上行的大文件上传直接掐断（nginx 给了 3600s，
// 客户端看到的是 502/EOF，用户只会以为网盘坏了）。
//
// 反过来，把服务器级超时整个去掉又会让慢速攻击者用一条连接占住 goroutine。
// 正确的做法是：服务器级不设读写超时（只保留 ReadHeaderTimeout），
// 由这里按路由用 http.NewResponseController 下分档 deadline。
const (
	apiReadTimeout  = 15 * time.Second
	apiWriteTimeout = 120 * time.Second

	// 大文件：上行要能撑住 10 GB / 慢链路，下行要能撑住整包下载。
	bulkTimeout = 3600 * time.Second
)

// bulkPathPrefixes 是需要长窗口的路由前缀。上传/下载/流式批处理都把时间花在
// 搬字节上，而不是花在服务端计算上，所以它们的时间和普通 API 不是一个量级。
var bulkPathPrefixes = []string{
	"/v1/files/",      // 上传、下载、分片合并
	"/api/files",      // 网盘列目录 / 上传 / 下载
	"/api/next/files", // 前端网盘走 Go 的同一套实现
	"/v1/snapotter/",  // 200MB 级多媒体批处理
	"/v1/downloads/",  // 任务产物下载
}

func isBulkPath(path string) bool {
	for _, p := range bulkPathPrefixes {
		if strings.HasPrefix(path, p) {
			return true
		}
	}
	return false
}

// WithDeadlines 给每个请求下分档的读/写 deadline。
//
// 用 ResponseController 而不是全局 ReadTimeout/WriteTimeout：
// 全局值只能一刀切，而「普通 API 15 秒」与「10GB 上传 1 小时」不可能用同一个数字。
func WithDeadlines(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		read, write := apiReadTimeout, apiWriteTimeout
		if isBulkPath(r.URL.Path) {
			read, write = bulkTimeout, bulkTimeout
		}
		rc := http.NewResponseController(w)
		now := time.Now()
		// 个别中间件/测试用的 ResponseWriter 不支持 deadline，忽略即可：
		// 服务器级的兜底（ReadHeaderTimeout + IdleTimeout）仍然生效。
		_ = rc.SetReadDeadline(now.Add(read))
		_ = rc.SetWriteDeadline(now.Add(write))
		next.ServeHTTP(w, r)
	})
}
