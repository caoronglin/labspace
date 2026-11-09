package preview

import (
	"bytes"
	"testing"
)

func BenchmarkFASTA64K(b *testing.B) {
	raw := append([]byte(">chr1\n"), bytes.Repeat([]byte("ACGTACGTACGTACGT\n"), 4000)...)
	for n := 0; n < b.N; n++ {
		_, err := Render("chr1.fa", raw)
		if err != nil {
			b.Fatal(err)
		}
	}
}
