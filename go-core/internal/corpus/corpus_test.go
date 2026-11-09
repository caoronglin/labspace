package corpus

import (
	"os"
	"path/filepath"
	"testing"
)

func testData(t *testing.T) *Data {
	t.Helper()
	return &Data{
		Version: 1,
		Databases: []Database{
			{ID: "ncbi", Name: "NCBI", CN: "美国国家生物技术信息中心", Desc: "全球最大的生物信息学数据库", URL: "https://www.ncbi.nlm.nih.gov/", Category: "通用", Tags: []string{"序列", "文献"}, Featured: true},
			{ID: "tair", Name: "TAIR", CN: "拟南芥信息资源", Desc: "拟南芥基因组注释", URL: "https://www.arabidopsis.org/", Category: "基因组与注释", Tags: []string{"拟南芥"}},
			{ID: "chembl", Name: "ChEMBL", CN: "药物化学数据库", Desc: "生物活性数据", URL: "https://www.ebi.ac.uk/chembl/", Category: "代谢与通路", Tags: []string{"药物"}, Biomed: true},
		},
		Pages:       []Page{{ID: "/databases", Name: "植物数据库速查", Keywords: "植物 数据库 生信"}},
		SectionCN:   map[string]string{"image": "图片处理"},
		ToolAliases: map[string]string{"image/compress": "图片 压缩"},
		HotKeywords: []string{"单细胞", "拟南芥"},
	}
}

func sampleServices() []Service {
	return []Service{
		{ID: "drawio", Name: "draw.io", Description: "绘图", URL: "http://192.0.2.10:8082/", Tags: []string{"绘图"}, Enabled: true},
		{ID: "hidden", Name: "隐藏服务", Description: "不启用", URL: "http://192.0.2.10:9999/", Enabled: false},
	}
}

func sampleCommands() []Command {
	return []Command{{Name: "ls", Desc: "列出目录内容"}, {Name: "grep", Desc: "在文件中搜索匹配行"}}
}

func sampleTools() []Tool {
	return []Tool{{Section: "image", ID: "compress", Name: "Compress Image", Description: "Reduce image size", Accept: "Image file to process"}}
}

func TestBuildSkipsDisabledServices(t *testing.T) {
	ix := New(testData(t))
	ix.Build(sampleServices(), sampleCommands(), sampleTools())
	for _, e := range ix.entries {
		if e.ID == "hidden" {
			t.Fatalf("disabled service must not be indexed")
		}
	}
	if ix.Size() != 8 {
		t.Fatalf("expected 8 entries, got %d", ix.Size())
	}
}

func TestSearchRanksTitleFirst(t *testing.T) {
	ix := New(testData(t))
	ix.Build(sampleServices(), sampleCommands(), sampleTools())
	hits := ix.Search("NCBI", 10, nil)
	if len(hits) == 0 {
		t.Fatal("expected a hit for NCBI")
	}
	if hits[0].Type != "database" || hits[0].Title != "NCBI" {
		t.Fatalf("unexpected top hit: %+v", hits[0])
	}
}

func TestSearchRequiresAllTokens(t *testing.T) {
	ix := New(testData(t))
	ix.Build(sampleServices(), sampleCommands(), sampleTools())
	if hits := ix.Search("不存在的东西", 10, nil); len(hits) != 0 {
		t.Fatalf("expected no hits, got %d", len(hits))
	}
}

func TestSearchTypeCapsPushOverflowBehindOtherTypes(t *testing.T) {
	data := testData(t)
	for i := 0; i < 20; i++ {
		data.Databases = append(data.Databases, Database{ID: "dup", Name: "重复库", Desc: "重复", Category: "通用"})
	}
	ix := New(data)
	ix.Build(sampleServices(), []Command{{Name: "重复", Desc: "重复命令"}}, sampleTools())
	hits := ix.Search("重复", 50, nil)
	if len(hits) == 0 {
		t.Fatal("expected hits")
	}
	// The exact title match ranks first, the database flood is capped and the
	// overflow only lands after the first pass.
	if hits[0].Type != "command" {
		t.Fatalf("expected the command first, got %s", hits[0].Type)
	}
	count := 0
	for _, h := range hits {
		if h.Type == "database" {
			count++
		}
	}
	if count != 20 {
		t.Fatalf("expected all 20 databases to be returned eventually, got %d", count)
	}
}

func TestSuggestAndHot(t *testing.T) {
	ix := New(testData(t))
	ix.Build(sampleServices(), sampleCommands(), sampleTools())
	if s := ix.Suggest("", 3); len(s) != 1 || s[0] != "NCBI" {
		t.Fatalf("unexpected featured suggestions: %v", s)
	}
	if s := ix.Suggest("拟南芥", 5); len(s) == 0 {
		t.Fatal("expected a suggestion for 拟南芥")
	}
	if h := ix.Hot(); len(h) != 2 || h[0] != "单细胞" {
		t.Fatalf("unexpected hot keywords: %v", h)
	}
}

func TestBucketsBalanced(t *testing.T) {
	ix := New(testData(t))
	ix.Build(sampleServices(), sampleCommands(), sampleTools())
	items := ix.Buckets(50)
	if len(items) == 0 {
		t.Fatal("expected bucket items")
	}
	if items[0].Type != "page" {
		t.Fatalf("expected page first, got %s", items[0].Type)
	}
}

func TestDatabasesRankingAndFilter(t *testing.T) {
	ix := New(testData(t))
	rows := ix.Databases("", "通用", 10)
	if len(rows) != 1 || rows[0].ID != "ncbi" {
		t.Fatalf("unexpected category filter result: %+v", rows)
	}
	rows = ix.Databases("chembl", "", 10)
	if len(rows) != 1 || rows[0].ID != "chembl" {
		t.Fatalf("unexpected keyword result: %+v", rows)
	}
}

func TestLoadData(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "corpus.json")
	if err := os.WriteFile(path, []byte(`{"version":1,"databases":[{"id":"a","name":"A"}],"hot_keywords":["x"]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	d, err := LoadData(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Databases) != 1 || d.Databases[0].Name != "A" {
		t.Fatalf("unexpected data: %+v", d.Databases)
	}
	if _, err := LoadData(filepath.Join(dir, "missing.json")); err == nil {
		t.Fatal("expected an error for a missing file")
	}
}
