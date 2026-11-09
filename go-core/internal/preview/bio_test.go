package preview

import (
	"encoding/binary"
	"strings"
	"testing"
)

// 按真实 SnapGene 文件布局拼一个最小样本：文件头段 + DNA 段（标志位 + 序列）。
func snapGeneFixture(seq string, circular bool) []byte {
	header := append([]byte("SnapGene"), 0x00, 0x01, 0x00, 0x0c, 0x00, 0x0b)
	buf := []byte{0x09}
	buf = binary.BigEndian.AppendUint32(buf, uint32(len(header)))
	buf = append(buf, header...)
	flags := byte(0)
	if circular {
		flags = 1
	}
	payload := append([]byte{flags}, []byte(seq)...)
	buf = append(buf, 0x00)
	buf = binary.BigEndian.AppendUint32(buf, uint32(len(payload)))
	buf = append(buf, payload...)
	// 再补一个空的特征段，验证解析会在段边界停下。
	buf = append(buf, 0x02)
	buf = binary.BigEndian.AppendUint32(buf, 3)
	buf = append(buf, 0x01, 0x00, 0x00)
	return buf
}

func TestSnapGenePreview(t *testing.T) {
	seq := strings.Repeat("ATGCGATC", 25) // 200 bp, 50% GC
	r, err := Render("pUC19.dna", snapGeneFixture(seq, true))
	if err != nil {
		t.Fatal(err)
	}
	if r.Kind != "bioinfo" || r.Format != "snapgene" {
		t.Fatalf("kind/format = %s/%s", r.Kind, r.Format)
	}
	if r.Meta["length"] != len(seq) {
		t.Errorf("length = %v", r.Meta["length"])
	}
	if r.Meta["topology"] != "环状" {
		t.Errorf("topology = %v", r.Meta["topology"])
	}
	if r.Meta["gc_percent"] != 50.0 {
		t.Errorf("gc = %v", r.Meta["gc_percent"])
	}
	if r.Meta["snapgene_version"] != "1.12.11" {
		t.Errorf("version = %v", r.Meta["snapgene_version"])
	}
	if len(r.Records) != 1 || r.Records[0]["length"] != len(seq) {
		t.Errorf("records = %v", r.Records)
	}
}

func TestSnapGeneRejectsGarbage(t *testing.T) {
	if _, err := Render("x.dna", []byte("not a snapgene file at all")); err == nil {
		t.Fatal("garbage accepted as SnapGene")
	}
}

func TestGenBankPreview(t *testing.T) {
	gb := `LOCUS       pUC19                   2686 bp    DNA     circular SYN 01-JAN-2020
DEFINITION  Cloning vector pUC19, complete sequence.
ACCESSION   M77789
FEATURES             Location/Qualifiers
     source          1..2686
                     /organism="Escherichia coli"
     CDS             100..500
                     /gene="lacZ"
ORIGIN
        1 gatcgatcga tcgatcgatc gatcgatcga tcgatcgatc gatcgatcga tcgatcgatc
       61 gatcgatcga tcgatcgatc
//
`
	r, err := Render("pUC19.gb", []byte(gb))
	if err != nil {
		t.Fatal(err)
	}
	if r.Kind != "bioinfo" || r.Format != "genbank" {
		t.Fatalf("kind/format = %s/%s", r.Kind, r.Format)
	}
	if r.Meta["name"] != "pUC19" || r.Meta["topology"] != "环状" {
		t.Errorf("meta = %v", r.Meta)
	}
	if r.Meta["length"] != 80 {
		t.Errorf("sequence length = %v", r.Meta["length"])
	}
	if !strings.Contains(r.Meta["definition"].(string), "Cloning vector") {
		t.Errorf("definition = %v", r.Meta["definition"])
	}
	if len(r.Records) != 2 || r.Records[1]["feature"] != "CDS" {
		t.Errorf("features = %v", r.Records)
	}
}

func TestNewickPreview(t *testing.T) {
	r, err := Render("tree.nwk", []byte("((A:0.1,B:0.2)90:0.3,(C:0.4,D:0.5):0.6);"))
	if err != nil {
		t.Fatal(err)
	}
	if r.Kind != "bioinfo" || r.Meta["tips"] != 4 || r.Meta["depth"] != 2 {
		t.Fatalf("meta = %v kind=%s", r.Meta, r.Kind)
	}
}

func TestPhylipPreview(t *testing.T) {
	phy := " 3 8\nAlpha    ACGTACGT\nBeta     ACGTACGA\nGamma    ACGTACGG\n"
	r, err := Render("aln.phy", []byte(phy))
	if err != nil {
		t.Fatal(err)
	}
	if r.Meta["taxa"] != 3 || r.Meta["sites"] != 8 {
		t.Fatalf("meta = %v", r.Meta)
	}
	if len(r.Records) != 3 || r.Records[0]["name"] != "Alpha" || r.Records[0]["length"] != 8 {
		t.Fatalf("records = %v", r.Records)
	}
}

func TestPDBPreview(t *testing.T) {
	pdb := `HEADER    TRANSFERASE                             01-JAN-00   1ABC
TITLE     CRYSTAL STRUCTURE OF TEST PROTEIN
REMARK   2 RESOLUTION.    1.80 ANGSTROMS.
ATOM      1  N   ALA A   1      11.104   6.134  -6.504  1.00  0.00           N
ATOM      2  CA  ALA A   1      11.639   6.071  -5.147  1.00  0.00           C
HETATM    3  O   HOH A 101      12.000   7.000  -4.000  1.00  0.00           O
END
`
	r, err := Render("1abc.pdb", []byte(pdb))
	if err != nil {
		t.Fatal(err)
	}
	if r.Meta["atoms"] != 3 || r.Meta["resolution_angstrom"] != "1.80" {
		t.Fatalf("meta = %v", r.Meta)
	}
	if len(r.Records) != 3 || r.Records[0]["residue"] != "ALA" || r.Records[0]["chain"] != "A" {
		t.Fatalf("records = %v", r.Records)
	}
}

func TestBioTextFormats(t *testing.T) {
	for _, name := range []string{"m.aln", "m.sto", "m.nexus", "m.maf"} {
		r, err := Render(name, []byte(">seq1\nACGT\n"))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if r.Kind != "text" || r.Format == "" {
			t.Errorf("%s => %s/%s", name, r.Kind, r.Format)
		}
	}
}
