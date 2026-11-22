package preview

import (
	"bytes"
	"compress/gzip"
	"testing"
)

func TestBioFormats(t *testing.T) {
	for _, x := range []struct{ name, data, kind string }{{"a.fa", ">gene1\nATCG\n", "bioinfo"}, {"b.fastq", "@r1\nACGT\n+\nIIII\n", "bioinfo"}, {"c.sam", "@HD\tVN:1.6\nr1\t0\tchr1\t15\t60\t4M\t*\t0\t0\tACGT\tIIII\n", "bioinfo"}, {"d.vcf", "##fileformat=VCFv4.3\n#CHROM\tPOS\nchr1\t2\n", "table"}, {"pUC19.gb", "LOCUS       pUC19                   2686 bp    DNA     circular\nORIGIN\n", "bioinfo"}, {"x.pdf", "%PDF-1.7", "requires-worker"}, {"x.bam", "x", "requires-worker"}} {
		r, e := Render(x.name, []byte(x.data))
		if e != nil || r.Kind != x.kind {
			t.Fatalf("%s: %+v %v", x.name, r, e)
		}
	}
	if _, e := Render("bad.fastq", []byte("@x\nACT\n+\nII\n")); e == nil {
		t.Fatal("bad fastq accepted")
	}
}
func TestGzipLimit(t *testing.T) {
	var b bytes.Buffer
	w := gzip.NewWriter(&b)
	w.Write(bytes.Repeat([]byte("A"), MaxExpanded+1))
	w.Close()
	if _, e := Render("a.fasta.gz", b.Bytes()); e == nil {
		t.Fatal("expansion attack accepted")
	}
}

func TestCodePreview(t *testing.T) {
	// 扩展名识别：kind=code + language + 行数统计
	r, e := Render("demo.py", []byte("import os\ndef main():\n    pass\n"))
	if e != nil || r.Kind != "code" || r.Language != "python" || r.Format != "python" {
		t.Fatalf("demo.py: %+v %v", r, e)
	}
	if r.Lines != 4 || r.Truncated {
		t.Fatalf("demo.py lines=%d truncated=%v", r.Lines, r.Truncated)
	}
	// 文件名识别（无扩展名）
	r, _ = Render("Dockerfile", []byte("FROM alpine\n"))
	if r.Kind != "code" || r.Language != "dockerfile" {
		t.Fatalf("Dockerfile: %+v", r)
	}
	// requirements.txt 扩展名是 .txt（文本类），但按文件名应识别为 code/text
	r, _ = Render("requirements.txt", []byte("fastapi\n"))
	if r.Kind != "code" || r.Language != "text" {
		t.Fatalf("requirements.txt: %+v", r)
	}
	// 截断：超过 MaxCode 字符时 truncated=true 且文本正好 MaxCode 个字符
	big := bytes.Repeat([]byte("x\n"), MaxCode) // 2*MaxCode 个字符
	r, e = Render("big.go", big)
	if e != nil {
		t.Fatalf("big.go: %v", e)
	}
	if !r.Truncated || len([]rune(r.Text)) != MaxCode {
		t.Fatalf("big.go truncated=%v len=%d", r.Truncated, len([]rune(r.Text)))
	}
	// 非法 UTF-8 字节不应导致预览失败
	r, e = Render("weird.rs", []byte{0xff, 0xfe, '\n', 'A'})
	if e != nil || r.Kind != "code" || r.Language != "rust" {
		t.Fatalf("weird.rs: %+v %v", r, e)
	}
}
