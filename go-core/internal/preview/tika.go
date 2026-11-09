package preview

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

// TikaText extracts bounded plain text through the internal Tika worker. The
// worker keeps the parser sandboxed; this function only receives derived text.
func TikaText(name string, raw []byte, endpoint string) (Result, error) {
	endpoint = strings.TrimRight(strings.TrimSpace(endpoint), "/")
	if endpoint == "" {
		return Result{}, errors.New("tika endpoint is not configured")
	}
	if len(raw) > MaxInput {
		return Result{}, errors.New("input exceeds 8MiB inline preview limit")
	}
	ext := strings.ToLower(filepath.Ext(name))
	contentType := mime.TypeByExtension(ext)
	if contentType == "" {
		if ext == ".pdf" {
			contentType = "application/pdf"
		} else {
			contentType = "application/octet-stream"
		}
	}
	req, err := http.NewRequest(http.MethodPut, endpoint+"/tika", bytes.NewReader(raw))
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Accept", "text/plain")
	client := &http.Client{Timeout: 25 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Result{}, fmt.Errorf("tika returned HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return Result{}, err
	}
	text := strings.ReplaceAll(strings.ToValidUTF8(string(body), "�"), "\r\n", "\n")
	text = strings.TrimSpace(strings.ReplaceAll(text, "\r", "\n"))
	notice := "由内网 Tika 提取文本；仅用于预览，不执行文档脚本。"
	if text == "" {
		text = "（未提取到文本，可能是扫描版或纯图片文档）"
		notice = "该文档没有可提取的文本层，如需查看页面请下载后用本地阅读器打开。"
	}
	return Result{
		Kind:      "text",
		Format:    strings.TrimPrefix(ext, "."),
		Text:      short(text, MaxText),
		Truncated: len([]rune(text)) > MaxText,
		Meta:      map[string]any{"extractor": "tika", "bytes_examined": len(raw)},
		Notice:    notice,
	}, nil
}
