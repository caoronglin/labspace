package preview

import (
	"encoding/binary"
	"errors"
	"sort"
	"strconv"
	"strings"
)

// 生信常见格式的结构化预览。所有解析都限制在 MaxInput / MaxExpanded 之内，
// 只返回派生信息（长度、拓扑、序号片段），绝不回传原始字节。

func gcPercent(seq []byte) float64 {
	if len(seq) == 0 {
		return 0
	}
	gc, at := 0, 0
	for _, c := range seq {
		switch c {
		case 'G', 'g', 'C', 'c':
			gc++
		case 'A', 'a', 'T', 't', 'U', 'u':
			at++
		}
	}
	den := gc + at
	if den == 0 {
		return 0
	}
	return float64(int(float64(gc)/float64(den)*1000+0.5)) / 10
}

// parseSnapGene 解析 SnapGene .dna：9 字节文件头段 + 若干「类型 + 长度 + 负载」段，
// DNA 段负载首字节是拓扑等标志位，其后是序列。
func parseSnapGene(b []byte) (Result, error) {
	if len(b) < 19 || b[0] != 0x09 || string(b[5:13]) != "SnapGene" {
		return Result{}, errors.New("not a SnapGene file")
	}
	headerLen := int(binary.BigEndian.Uint32(b[1:5]))
	if headerLen < 8 || 5+headerLen > len(b) {
		return Result{}, errors.New("bad SnapGene header")
	}
	version := ""
	if headerLen >= 14 {
		h := b[13 : 5+headerLen]
		parts := make([]string, 0, len(h)/2)
		for i := 0; i+1 < len(h); i += 2 {
			parts = append(parts, strconv.Itoa(int(binary.BigEndian.Uint16(h[i:i+2]))))
		}
		version = strings.Join(parts, ".")
	}
	off := 5 + headerLen
	segments := map[byte]int{}
	var seq []byte
	topology := ""
	for i := 0; i < 64 && off+5 <= len(b); i++ {
		kind := b[off]
		n := int(binary.BigEndian.Uint32(b[off+1 : off+5]))
		start := off + 5
		end := start + n
		if n < 0 || end > len(b) {
			return Result{}, errors.New("truncated SnapGene segment")
		}
		segments[kind]++
		if kind == 0x00 && n >= 1 && seq == nil {
			flags := b[start]
			seq = b[start+1 : end]
			if flags&1 == 1 {
				topology = "环状"
			} else {
				topology = "线状"
			}
		}
		off = end
	}
	if seq == nil {
		return Result{}, errors.New("SnapGene file has no DNA segment")
	}
	kinds := make([]string, 0, len(segments))
	for k := range segments {
		kinds = append(kinds, "0x"+strings.ToUpper(strconv.FormatInt(int64(k), 16)))
	}
	sort.Strings(kinds)
	r := Result{Kind: "bioinfo", Format: "snapgene"}
	r.Meta = map[string]any{
		"length":     len(seq),
		"topology":   topology,
		"gc_percent": gcPercent(seq),
		"segments":   kinds,
	}
	if version != "" {
		r.Meta["snapgene_version"] = version
	}
	r.Records = []map[string]any{{
		"header":  "DNA 序列",
		"length":  len(seq),
		"snippet": short(string(seq), 120),
	}}
	r.Notice = "SnapGene 偏好文件：仅提取序列段；特征注释请在 SnapGene 中查看。"
	return r, nil
}

// parseGenBank 解析 GenBank / EMBL 的 LOCUS 元数据、FEATURES 列表与 ORIGIN 序列长度。
func parseGenBank(b []byte, embl bool) (Result, bool) {
	ls := lines(b)
	meta := map[string]any{}
	features := []map[string]any{}
	var seq []byte
	name, definition, topology := "", "", ""
	inFeatures, inOrigin, collectingDefinition := false, false, false
	for _, raw := range ls {
		line := strings.TrimRight(raw, " ")
		if inOrigin {
			if strings.HasPrefix(line, "//") {
				inOrigin = false
				continue
			}
			for _, c := range []byte(line) {
				switch c {
				case 'a', 'c', 'g', 't', 'n', 'A', 'C', 'G', 'T', 'N':
					seq = append(seq, c)
				}
			}
			continue
		}
		switch {
		case strings.HasPrefix(line, "LOCUS"):
			f := strings.Fields(line)
			if len(f) >= 2 {
				name = f[1]
			}
			for i, tok := range f {
				if tok == "bp" && i > 0 {
					if v, err := strconv.Atoi(f[i-1]); err == nil {
						meta["declared_length"] = v
					}
				}
				if tok == "circular" || tok == "linear" {
					topology = map[string]string{"circular": "环状", "linear": "线状"}[tok]
				}
			}
		case strings.HasPrefix(line, "ID ") && embl:
			f := strings.Fields(line)
			if len(f) >= 2 {
				name = strings.TrimSuffix(f[1], ";")
			}
			for i, tok := range f {
				if tok == "BP;" && i > 0 {
					if v, err := strconv.Atoi(f[i-1]); err == nil {
						meta["declared_length"] = v
					}
				}
				if tok == "circular;" || tok == "linear;" {
					topology = map[string]string{"circular;": "环状", "linear;": "线状"}[tok]
				}
			}
		case strings.HasPrefix(line, "DEFINITION"):
			definition = strings.TrimSpace(line[len("DEFINITION"):])
			collectingDefinition = true
		case collectingDefinition && strings.HasPrefix(line, " ") && strings.TrimSpace(line) != "":
			if definition != "" {
				definition += " "
			}
			definition += strings.TrimSpace(line)
		case strings.HasPrefix(line, "FEATURES"):
			inFeatures = true
			collectingDefinition = false
		case strings.HasPrefix(line, "ORIGIN"), strings.HasPrefix(line, "SQ "):
			inFeatures = false
			inOrigin = true
		case inFeatures && strings.HasPrefix(line, "     ") && !strings.HasPrefix(line, "      "):
			f := strings.Fields(line)
			if len(f) > 0 && len(features) < MaxRows {
				loc := ""
				if len(f) > 1 {
					loc = short(f[1], 60)
				}
				features = append(features, map[string]any{"feature": f[0], "location": loc})
			}
		}
		if !strings.HasPrefix(line, " ") {
			collectingDefinition = strings.HasPrefix(line, "DEFINITION")
		}
	}
	if name == "" && len(seq) == 0 {
		return Result{}, false
	}
	if name != "" {
		meta["name"] = name
	}
	if definition != "" {
		meta["definition"] = short(definition, 160)
	}
	if topology != "" {
		meta["topology"] = topology
	}
	meta["length"] = len(seq)
	if len(seq) > 0 {
		meta["gc_percent"] = gcPercent(seq)
	}
	format := "genbank"
	if embl {
		format = "embl"
	}
	r := Result{Kind: "bioinfo", Format: format, Meta: meta, Records: features}
	return r, true
}

// parsePDB 统计原子/链信息，列出前 20 个原子。
func parsePDB(b []byte) Result {
	meta := map[string]any{}
	atoms := []map[string]any{}
	count := 0
	chains := map[string]bool{}
	title := ""
	for _, line := range lines(b) {
		switch {
		case strings.HasPrefix(line, "TITLE"):
			title += strings.TrimSpace(line[10:]) + " "
		case strings.HasPrefix(line, "ATOM  "), strings.HasPrefix(line, "HETATM"):
			count++
			if len(line) >= 27 {
				if c := strings.TrimSpace(line[21:22]); c != "" {
					chains[c] = true
				}
			}
			if count <= MaxRows && len(line) >= 26 {
				atoms = append(atoms, map[string]any{
					"atom":    strings.TrimSpace(line[12:16]),
					"residue": strings.TrimSpace(line[17:20]),
					"chain":   strings.TrimSpace(line[21:22]),
					"resseq":  strings.TrimSpace(line[22:26]),
				})
			}
		case strings.HasPrefix(line, "REMARK   2 RESOLUTION."):
			f := strings.Fields(line)
			for i, tok := range f {
				if tok == "RESOLUTION." && i+1 < len(f) {
					if _, err := strconv.ParseFloat(f[i+1], 64); err == nil {
						meta["resolution_angstrom"] = f[i+1]
					}
				}
			}
		}
	}
	if strings.TrimSpace(title) != "" {
		meta["title"] = short(strings.TrimSpace(title), 160)
	}
	chainList := make([]string, 0, len(chains))
	for c := range chains {
		chainList = append(chainList, c)
	}
	sort.Strings(chainList)
	if len(chainList) > 8 {
		chainList = chainList[:8]
	}
	meta["atoms"] = count
	meta["chains"] = chainList
	r := Result{Kind: "bioinfo", Format: "pdb", Meta: meta, Records: atoms}
	r.Truncated = count > MaxRows
	return r
}

// parseNewick 统计叶子数与最大嵌套深度，并保留文本片段。
func parseNewick(b []byte) Result {
	text := strings.TrimSpace(strings.ToValidUTF8(string(b), "�"))
	commas, depth, maxDepth := 0, 0, 0
	labels := 0
	prevDelim := true
	for _, c := range text {
		switch c {
		case '(':
			depth++
			if depth > maxDepth {
				maxDepth = depth
			}
			prevDelim = true
		case ',':
			commas++
			prevDelim = true
		case ')':
			depth--
			prevDelim = true
		case ':', ';', ' ':
			prevDelim = true
		default:
			if prevDelim {
				labels++
			}
			prevDelim = false
		}
	}
	tips := commas + 1
	if labels > 0 && labels < tips {
		tips = labels
	}
	r := Result{Kind: "bioinfo", Format: "newick", Meta: map[string]any{
		"tips":  tips,
		"depth": maxDepth,
	}}
	r.Text = short(text, MaxText)
	r.Truncated = len([]rune(text)) > MaxText
	return r
}

// parsePhylip 读取首行 taxa/sites 与对齐块中的前 20 条序列。
func parsePhylip(b []byte) Result {
	ls := lines(b)
	r := Result{Kind: "bioinfo", Format: "phylip", Meta: map[string]any{}}
	if len(ls) == 0 {
		return r
	}
	head := strings.Fields(ls[0])
	if len(head) >= 2 {
		if n, err := strconv.Atoi(head[0]); err == nil {
			r.Meta["taxa"] = n
		}
		if n, err := strconv.Atoi(head[1]); err == nil {
			r.Meta["sites"] = n
		}
	}
	records := []map[string]any{}
	for _, line := range ls[1:] {
		if strings.TrimSpace(line) == "" {
			continue
		}
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		seq := strings.Join(f[1:], "")
		records = append(records, map[string]any{
			"name":    short(f[0], 40),
			"length":  len(seq),
			"snippet": short(seq, 120),
		})
		if len(records) >= MaxRows {
			break
		}
	}
	r.Records = records
	if declared, ok := r.Meta["taxa"].(int); ok && declared > len(records) {
		r.Truncated = true
	}
	return r
}

func bioText(format string, b []byte) Result {
	r := Result{Kind: "text", Format: format}
	r.Text = short(strings.ToValidUTF8(string(b), "�"), MaxText)
	r.Truncated = len([]rune(string(b))) > MaxText
	return r
}
