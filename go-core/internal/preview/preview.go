// Package preview parses bounded derived metadata; never returns original bytes.
// No unsandboxed arbitrary SVG, HTML, PDF bytes, or Office ZIP expansion.
package preview

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/xml"
	"errors"
	"image"
	_ "image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"
)

const MaxInput = 8 << 20
const MaxExpanded = 24 << 20
const MaxRows = 20
const MaxText = 2048

// MaxCode 是源码预览的字符数上限（按字符计数，与 Python 侧 preview_inline 的口径一致）；
// 行号与截断提示由前端 CodePreview 渲染，不在这里做行数裁剪。
const MaxCode = 60_000

type Result struct {
	Kind      string           `json:"kind"`
	Format    string           `json:"format"`
	Language  string           `json:"language,omitempty"`
	Lines     int              `json:"lines,omitempty"`
	Rows      [][]string       `json:"rows,omitempty"`
	Records   []map[string]any `json:"records,omitempty"`
	Text      string           `json:"text,omitempty"`
	Meta      map[string]any   `json:"meta,omitempty"`
	Truncated bool             `json:"truncated"`
	Notice    string           `json:"notice,omitempty"`
	// DataURL carries a derived, downscaled thumbnail (never the source bytes).
	DataURL string `json:"dataUrl,omitempty"`
}

// codeLang 按扩展名识别源码语言（与 backend/app/preview_inline.py 的 CODE_LANG 对齐）。
var codeLang = map[string]string{
	".py": "python", ".ipynb": "json", ".ts": "typescript", ".tsx": "tsx",
	".js": "javascript", ".jsx": "jsx", ".mjs": "javascript", ".cjs": "javascript",
	".go": "go", ".rs": "rust", ".java": "java", ".c": "c", ".h": "c",
	".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp", ".rb": "ruby", ".php": "php",
	".sh": "bash", ".bash": "bash", ".zsh": "bash", ".ps1": "powershell",
	".sql": "sql", ".css": "css", ".scss": "scss", ".html": "html", ".vue": "vue",
	".toml": "toml", ".ini": "ini", ".cfg": "ini", ".conf": "nginx",
	".dockerfile": "dockerfile", ".mk": "makefile", ".lua": "lua", ".r": "r",
	".pl": "perl", ".kt": "kotlin", ".swift": "swift", ".scala": "scala",
}

// codeNames 处理无扩展名（或扩展名已属文本类）但按文件名应识别为源码的情况。
var codeNames = map[string]string{
	"dockerfile": "dockerfile", "makefile": "makefile", "cmakelists.txt": "cmake",
	"requirements.txt": "text", "pyproject.toml": "toml",
}

// fillCodeText 截取前 MaxCode 个字符并统计行数；truncated 表示原文超过上限。
func fillCodeText(r *Result, data []byte) {
	text := strings.ToValidUTF8(string(data), "\ufffd")
	runes := []rune(text)
	if len(runes) > MaxCode {
		runes = runes[:MaxCode]
		r.Truncated = true
	}
	r.Text = string(runes)
	r.Lines = strings.Count(r.Text, "\n") + 1
}

// MaxThumbSide bounds the long edge of an inline image thumbnail.
const MaxThumbSide = 960

func thumbnail(img image.Image) image.Image {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return img
	}
	long := w
	if h > long {
		long = h
	}
	if long <= MaxThumbSide {
		return img
	}
	nw := w * MaxThumbSide / long
	nh := h * MaxThumbSide / long
	if nw < 1 {
		nw = 1
	}
	if nh < 1 {
		nh = 1
	}
	dst := image.NewNRGBA(image.Rect(0, 0, nw, nh))
	for y := 0; y < nh; y++ {
		sy := b.Min.Y + y*h/nh
		for x := 0; x < nw; x++ {
			dst.Set(x, y, img.At(b.Min.X+x*w/nw, sy))
		}
	}
	return dst
}

func encodeThumb(ext string, img image.Image) (string, string, error) {
	var buf bytes.Buffer
	mime := "image/jpeg"
	if ext == ".png" || ext == ".gif" {
		mime = "image/png"
		if err := png.Encode(&buf, img); err != nil {
			return "", "", err
		}
	} else if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 82}); err != nil {
		return "", "", err
	}
	if buf.Len() > 2<<20 {
		return "", "", errors.New("thumbnail exceeds inline limit")
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(buf.Bytes()), mime, nil
}

func short(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}
func unwrap(name string, raw []byte) (string, []byte, error) {
	if len(raw) > MaxInput {
		return "", nil, errors.New("input exceeds 8MiB inline preview limit")
	}
	s := strings.ToLower(name)
	if strings.HasSuffix(s, ".gz") {
		z, e := gzip.NewReader(bytes.NewReader(raw))
		if e != nil {
			return "", nil, e
		}
		defer z.Close()
		d, e := io.ReadAll(io.LimitReader(z, MaxExpanded+1))
		if e != nil {
			return "", nil, e
		}
		if len(d) > MaxExpanded {
			return "", nil, errors.New("expanded data too large")
		}
		return strings.TrimSuffix(s, ".gz"), d, nil
	}
	return s, raw, nil
}
func Render(name string, raw []byte) (Result, error) {
	lower, data, err := unwrap(name, raw)
	if err != nil {
		return Result{}, err
	}
	ext := strings.ToLower(filepath.Ext(lower))
	r := Result{Format: strings.TrimPrefix(ext, "."), Meta: map[string]any{"bytes_examined": len(data)}}
	// 源码预览：扩展名优先，其次按文件名（Dockerfile/Makefile 等）。
	// 判定先于下面的格式 switch，与 Python 侧 preview_inline 的分支顺序一致。
	if lang, ok := codeLang[ext]; ok {
		r.Kind = "code"
		r.Format = lang
		r.Language = lang
		fillCodeText(&r, data)
		return r, nil
	}
	if lang, ok := codeNames[lower]; ok {
		r.Kind = "code"
		r.Format = lang
		r.Language = lang
		fillCodeText(&r, data)
		return r, nil
	}
	switch ext {
	case ".fa", ".fna", ".faa", ".fasta":
		r.Kind = "bioinfo"
		r.Format = "fasta"
		r.Records, r.Truncated = parseFasta(data)
	case ".fq", ".fastq":
		r.Kind = "bioinfo"
		r.Format = "fastq"
		r.Records, r.Truncated, err = parseFastq(data)
	case ".sam":
		r.Kind = "bioinfo"
		r.Records, r.Truncated = parseSAM(data)
	case ".gff", ".gff3", ".gtf", ".vcf", ".bed", ".csv", ".tsv", ".wig", ".bedgraph", ".fai", ".ped", ".map":
		r.Kind = "table"
		r.Rows, r.Truncated = parseRows(data, ext)
	case ".dna":
		return parseSnapGene(data)
	case ".gb", ".gbk", ".genbank", ".embl":
		if gb, ok := parseGenBank(data, ext == ".embl"); ok {
			return gb, nil
		}
		r.Kind = "text"
		r.Text = short(strings.ToValidUTF8(string(data), "�"), MaxText)
		r.Truncated = utf8.RuneCount(data) > MaxText
	case ".pdb", ".ent":
		return parsePDB(data), nil
	case ".nwk", ".newick", ".tree", ".tre":
		return parseNewick(data), nil
	case ".phy", ".phylip":
		return parsePhylip(data), nil
	case ".nex", ".nexus", ".sto", ".stockholm", ".aln", ".clustal", ".maf":
		return bioText(strings.TrimPrefix(ext, "."), data), nil
	case ".txt", ".md", ".log", ".json", ".yaml", ".yml":
		r.Kind = "text"
		r.Text = short(strings.ToValidUTF8(string(data), "�"), MaxText)
		r.Truncated = utf8.RuneCount(data) > MaxText
	case ".docx", ".pptx", ".xlsx":
		r.Kind = "document"
		r.Text, r.Truncated, err = parseOOXML(data, ext)
	case ".png", ".jpg", ".jpeg", ".gif":
		cfg, _, e := image.DecodeConfig(bytes.NewReader(data))
		if e != nil {
			return Result{}, e
		}
		r.Meta["width"] = cfg.Width
		r.Meta["height"] = cfg.Height
		if int64(cfg.Width)*int64(cfg.Height) > 24<<20 {
			return Result{}, errors.New("image dimensions exceed the inline preview limit")
		}
		img, _, e := image.Decode(bytes.NewReader(data))
		if e != nil {
			return Result{}, e
		}
		thumb := thumbnail(img)
		dataURL, mime, e := encodeThumb(ext, thumb)
		if e != nil {
			return Result{}, e
		}
		// Only the first decoded frame is derived; source bytes never leave the server.
		r.Kind = "image"
		r.DataURL = dataURL
		r.Meta["thumbnail_mime"] = mime
		r.Notice = "已生成内联缩略图（最长边 960px），不返回原始文件。"
	case ".pdf":
		r.Kind = "requires-worker"
		r.Notice = "PDF 文本由内网 Tika 提取；不渲染脚本，也不回传原始 PDF"
	case ".bam", ".cram", ".bw", ".bigwig", ".bcf", ".ab1", ".sff", ".2bit", ".fast5", ".h5", ".hdf5", ".bigbed", ".bai", ".csi", ".tbi":
		r.Kind = "requires-worker"
		r.Notice = "二进制/索引格式需要专用工作节点解析，不进行二进制透传；可下载后用本地工具查看"
	default:
		r.Kind = "unsupported"
		r.Notice = "文件格式未纳入允许的预览器"
	}
	return r, err
}
func lines(b []byte) []string {
	return strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n")
}
func parseFasta(b []byte) ([]map[string]any, bool) {
	v := []map[string]any{}
	n := 0
	var cur map[string]any
	for _, l := range lines(b) {
		if strings.HasPrefix(l, ">") {
			n++
			if len(v) < MaxRows {
				cur = map[string]any{"header": short(strings.TrimSpace(l[1:]), 200), "length": 0, "snippet": ""}
				v = append(v, cur)
			} else {
				cur = nil
			}
		} else if cur != nil {
			seq := strings.TrimSpace(l)
			cur["length"] = cur["length"].(int) + len(seq)
			s := cur["snippet"].(string)
			cur["snippet"] = short(s+seq, 80)
		}
	}
	return v, n > MaxRows
}
func parseFastq(b []byte) ([]map[string]any, bool, error) {
	v := []map[string]any{}
	ls := lines(b)
	if len(ls) > 0 && ls[len(ls)-1] == "" {
		ls = ls[:len(ls)-1]
	}
	if len(ls)%4 != 0 {
		return nil, false, errors.New("FASTQ incomplete record")
	}
	n := len(ls) / 4
	for i := 0; i < n; i++ {
		a, seq, plus, qual := ls[i*4], ls[i*4+1], ls[i*4+2], ls[i*4+3]
		if !strings.HasPrefix(a, "@") || !strings.HasPrefix(plus, "+") || len(seq) != len(qual) {
			return nil, false, errors.New("FASTQ invalid record")
		}
		if i < MaxRows {
			v = append(v, map[string]any{"header": short(a[1:], 200), "length": len(seq), "sequence_snippet": short(seq, 80)})
		}
	}
	return v, n > MaxRows, nil
}
func parseSAM(b []byte) ([]map[string]any, bool) {
	v := []map[string]any{}
	count := 0
	for _, l := range lines(b) {
		if l == "" || strings.HasPrefix(l, "@") {
			continue
		}
		f := strings.Split(l, "\t")
		if len(f) < 11 {
			continue
		}
		count++
		if count <= MaxRows {
			v = append(v, map[string]any{"qname": short(f[0], 100), "flag": f[1], "rname": f[2], "pos": f[3], "mapq": f[4], "cigar": short(f[5], 120)})
		}
	}
	return v, count > MaxRows
}
func parseRows(b []byte, ext string) ([][]string, bool) {
	v := [][]string{}
	sep := "\t"
	if ext == ".csv" {
		sep = ","
	}
	n := 0
	for _, l := range lines(b) {
		if strings.TrimSpace(l) == "" || strings.HasPrefix(l, "##") {
			continue
		}
		n++
		if n > MaxRows {
			break
		}
		parts := strings.Split(l, sep)
		if len(parts) > 16 {
			parts = parts[:16]
		}
		for i := range parts {
			parts[i] = short(parts[i], 240)
		}
		v = append(v, parts)
	}
	return v, n > MaxRows
}
func parseOOXML(data []byte, ext string) (string, bool, error) {
	z, e := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if e != nil {
		return "", false, e
	}
	sum := int64(0)
	collected := []string{}
	extracted := 0
	truncated := false
	for _, file := range z.File {
		sum += int64(file.UncompressedSize64)
		if sum > MaxExpanded {
			return "", false, errors.New("Office ZIP expansion limit exceeded")
		}
		p := file.Name
		if ext == ".docx" && p != "word/document.xml" {
			continue
		}
		if ext == ".xlsx" && !strings.HasPrefix(p, "xl/worksheets/sheet") {
			continue
		}
		if ext == ".pptx" && !(strings.HasPrefix(p, "ppt/slides/slide") && strings.HasSuffix(p, ".xml")) {
			continue
		}
		if extracted >= MaxRows {
			truncated = true
			break
		}
		f, e := file.Open()
		if e != nil {
			return "", false, e
		}
		raw, e := io.ReadAll(io.LimitReader(f, MaxExpanded+1))
		f.Close()
		if e != nil {
			return "", false, e
		}
		if len(raw) > MaxExpanded {
			return "", false, errors.New("Office XML expansion limit exceeded")
		}
		var tokens []string
		dec := xml.NewDecoder(bytes.NewReader(raw))
		inText := false
		for {
			tok, er := dec.Token()
			if er == io.EOF {
				break
			}
			if er != nil {
				return "", false, er
			}
			switch x := tok.(type) {
			case xml.StartElement:
				if x.Name.Local == "t" || x.Name.Local == "v" {
					inText = true
				}
			case xml.EndElement:
				if x.Name.Local == "t" || x.Name.Local == "v" {
					inText = false
				}
			case xml.CharData:
				if inText {
					tokens = append(tokens, string(x))
				}
			}
			if len(tokens) > 300 {
				truncated = true
				break
			}
		}
		if len(tokens) > 0 {
			collected = append(collected, short(strings.Join(tokens, " "), MaxText))
		}
		extracted++
	}
	joined := short(strings.Join(collected, "\n"), MaxText)
	if ext == ".xlsx" {
		joined = "表格数字/inline string 摘要（未解析 sharedStrings）\n" + joined
	}
	return short(joined, MaxText), truncated || len(joined) >= MaxText, nil
}

// Suppress unused stdlib import validation and give embedders predictable dimensions.
var _ = strconv.Itoa
