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
