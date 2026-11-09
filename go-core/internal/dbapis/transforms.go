package dbapis

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

type transformFn func(ctx context.Context, c *Client, spec Spec, q string, limit int, p map[string]string) ([]Row, error)

var transforms = map[string]transformFn{
	"ncbi_gene": tNCBIGene, "ncbi_sra": tNCBISRA, "blast_submit": tBlastSubmit,
	"ena": tENA, "uniprot": tUniProt, "interpro": tInterPro, "alphafold": tAlphaFold,
	"kegg": tKEGG, "atlas": tAtlas, "rcsb": tRCSB, "panther": tPanther,
	"ols": tOLS, "chembl": tChEMBL, "pubchem": tPubChem, "clinvar": tClinVar,
	"opentargets": tOpenTargets, "string": tSTRING, "hpa": tHPA,
	"cellosaurus": tCellosaurus, "encode": tENCODE, "cbioportal": tCBioPortal,
	"openfda": tOpenFDA, "europepmc": tEuropePMC, "ols_chebi": tOLSChEBI,
	"taxonomy": tTaxonomy, "hgnc": tHGNC, "pride": tPRIDE,
	"enrichr": tEnrichr, "brain_atlas": tBrainAtlas,
}

func (c *Client) runTransform(ctx context.Context, spec Spec, q string, limit int, p map[string]string) ([]Row, error) {
	fn, ok := transforms[spec.Transform]
	if !ok {
		return nil, fmt.Errorf("未知转换器 %s", spec.Transform)
	}
	return fn(ctx, c, spec, q, limit, p)
}

func (c *Client) jsonAt(ctx context.Context, u string, timeout float64, retries int) (any, error) {
	return c.getJSON(ctx, u, timeoutFor(u, timeout), retries)
}
func (c *Client) rawAt(ctx context.Context, u string, timeout float64) (string, error) {
	body, _, _, err := c.get(ctx, u, timeoutFor(u, timeout), 0)
	return string(body), err
}

func obj(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}
func arr(v any) []any                  { return asList(v) }
func s(v any) string                   { return str(v) }
func nested(v any, path string) string { return str(dig(v, path)) }

// ---------------------------------------------------------------- NCBI family

func esearchIDs(ctx context.Context, c *Client, spec Spec, q string, limit int) ([]string, error) {
	u := render(spec.Endpoint, q, limit, nil)
	data, err := c.jsonAt(ctx, u, 20, 1)
	if err != nil {
		return nil, err
	}
	raw := arr(dig(data, "esearchresult.idlist"))
	ids := make([]string, 0, len(raw))
	for _, v := range raw {
		if id := s(v); id != "" {
			ids = append(ids, id)
		}
	}
	return ids, nil
}

func esummary(ctx context.Context, c *Client, db string, ids []string) (map[string]any, error) {
	if len(ids) == 0 {
		return map[string]any{}, nil
	}
	u := "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=" + db +
		"&retmode=json&id=" + strings.Join(ids, ",")
	data, err := c.jsonAt(ctx, u, 20, 1)
	if err != nil {
		return nil, err
	}
	return obj(dig(data, "result")), nil
}

func tNCBIGene(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	ids, err := esearchIDs(ctx, c, spec, q, limit)
	if err != nil || len(ids) == 0 {
		return []Row{}, err
	}
	if len(ids) > limit {
		ids = ids[:limit]
	}
	result, err := esummary(ctx, c, "gene", ids)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, gid := range ids {
		item := obj(result[gid])
		name := s(item["name"])
		if name == "" {
			name = gid
		}
		out = append(out, row(
			name+"（"+gid+"）", str(item["description"]),
			"https://www.ncbi.nlm.nih.gov/gene/"+gid, "NCBI Gene",
			[]Field{f("物种", nested(item, "organism.scientificname")), f("定位", s(item["maplocation"])), f("基因类型", s(item["genetype"]))},
		))
	}
	return out, nil
}

func tNCBISRA(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	ids, err := esearchIDs(ctx, c, spec, q, limit)
	if err != nil || len(ids) == 0 {
		return []Row{}, err
	}
	if len(ids) > limit {
		ids = ids[:limit]
	}
	result, err := esummary(ctx, c, "sra", ids)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, rid := range ids {
		item := obj(result[rid])
		acc := s(item["accession"])
		if acc == "" {
			acc = rid
		}
		out = append(out, row(acc, s(item["title"]),
			"https://www.ncbi.nlm.nih.gov/sra/"+acc, "NCBI SRA",
			[]Field{f("物种", s(item["taxon"])), f("平台", s(item["platform"]))}))
	}
	return out, nil
}

var ridRe = regexp.MustCompile(`RID\s*=\s*"?([A-Za-z0-9_]+)`)

func tBlastSubmit(ctx context.Context, c *Client, spec Spec, q string, limit int, p map[string]string) ([]Row, error) {
	u := render(spec.Endpoint, q, limit, p)
	text, err := c.rawAt(ctx, u, 20)
	if err != nil {
		return nil, err
	}
	m := ridRe.FindStringSubmatch(text)
	if m == nil {
		return []Row{row("任务已提交", "BLAST 返回内容未包含 RID，请稍后重试",
			"https://blast.ncbi.nlm.nih.gov/", "NCBI BLAST", nil)}, nil
	}
	rid := m[1]
	program := param(p, "program", "blastn")
	database := param(p, "database", "refseq_plant")
	return []Row{row("BLAST 任务 RID "+rid,
		"程序 "+program+"，数据库 "+database+"；远程排队约需数十秒",
		"https://blast.ncbi.nlm.nih.gov/Blast.cgi?CMD=Get&RID="+rid+"&FORMAT_TYPE=Text",
		"NCBI BLAST", []Field{f("RID", rid), f("程序", program), f("数据库", database)})}, nil
}

func tENA(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	qexpr := q
	if !strings.Contains(q, "=") {
		qexpr = `study_title="*` + q + `*"`
	}
	u := render(spec.Endpoint, qexpr, limit, nil)
	data, err := c.jsonAt(ctx, u, 20, 1)
	if err != nil {
		return nil, err
	}
	list, _ := data.([]any)
	out := []Row{}
	for _, v := range list {
		item := obj(v)
		acc := s(item["run_accession"])
		if acc == "" {
			acc = s(item["study_accession"])
		}
		if acc == "" {
			acc = "—"
		}
		sub := s(item["study_title"])
		if sub == "" {
			sub = s(item["scientific_name"])
		}
		out = append(out, row(acc, sub,
			"https://www.ebi.ac.uk/ena/browser/view/"+s(item["run_accession"]), "ENA",
			[]Field{f("研究编号", s(item["study_accession"])), f("物种", s(item["scientific_name"])), f("平台", s(item["instrument_platform"]))}))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func tUniProt(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	data, err := c.jsonAt(ctx, render(spec.Endpoint, q, limit, nil), 20, 1)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, v := range arr(dig(data, "results")) {
		item := obj(v)
		acc := s(item["primaryAccession"])
		gene := ""
		if genes := arr(item["genes"]); len(genes) > 0 {
			gene = nested(genes[0], "geneName.value")
		}
		title := gene
		if title == "" {
			title = acc
		}
		out = append(out, row(title+"（"+acc+"）", nested(item, "proteinDescription.recommendedName"),
			"https://www.uniprot.org/uniprotkb/"+acc+"/entry", "UniProtKB",
			[]Field{f("物种", nested(item, "organism.scientificName")), f("长度", nested(item, "sequence.length")), f("基因", gene)}))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func tInterPro(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	data, err := c.jsonAt(ctx, render(spec.Endpoint, q, limit, nil), 20, 1)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, v := range arr(dig(data, "results")) {
		meta := obj(obj(v)["metadata"])
		acc := s(meta["accession"])
		title := s(meta["name"])
		if title == "" {
			title = acc
		}
		members := []string{}
		for k := range obj(meta["member_databases"]) {
			members = append(members, k)
		}
		out = append(out, row(title+"（"+acc+"）", s(meta["description"]),
			"https://www.ebi.ac.uk/interpro/entry/"+acc+"/", "InterPro",
			[]Field{f("类型", s(meta["type"])), f("成员库", strings.Join(members, ", "))}))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func tAlphaFold(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	u := render(spec.Endpoint, strings.ToUpper(strings.TrimSpace(q)), limit, nil)
	data, err := c.jsonAt(ctx, u, 20, 1)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, v := range arr(data) {
		item := obj(v)
		acc := s(item["uniprotAccession"])
		title := s(item["modelEntityId"])
		if title == "" {
			title = acc
		}
		sub := s(item["cifUrl"])
		if sub == "" {
			sub = s(item["paeDocUrl"])
		}
		out = append(out, row(title, sub, "https://alphafold.ebi.ac.uk/entry/"+acc, "AlphaFold DB",
			[]Field{f("UniProt", acc), f("版本", s(item["modelCreatedDate"])), f("工具", s(item["toolUsed"]))}))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func tKEGG(ctx context.Context, c *Client, spec Spec, q string, limit int, p map[string]string) ([]Row, error) {
	u := render(spec.Endpoint, q, limit, p)
	text, err := c.rawAt(ctx, u, 20)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, line := range strings.Split(text, "\n") {
		if len(out) >= limit {
			break
		}
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		ident := parts[0]
		desc := ""
		if len(parts) > 1 {
			desc = parts[1]
		}
		link := "https://www.genome.jp/kegg/"
		for _, prefix := range []string{"ko", "k", "ec", "map", "rn"} {
			if strings.HasPrefix(ident, prefix) {
				link = "https://www.genome.jp/entry/" + ident
				break
			}
		}
		out = append(out, row(ident, desc, link, "KEGG", []Field{f("编号", ident)}))
	}
	return out, nil
}

func tAtlas(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	data, err := c.jsonAt(ctx, render(spec.Endpoint, q, limit, nil), 20, 1)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, v := range arr(dig(data, "entries")) {
		item := obj(v)
		fields := obj(item["fields"])
		gene := ""
		for _, fv := range fields {
			fm := obj(fv)
			if s(fm["name"]) == "Gene" && s(fm["value"]) != "" {
				gene = s(fm["value"])
				break
			}
		}
		title := gene
		if title == "" {
			title = s(item["id"])
		}
		if title == "" {
			title = "—"
		}
		link := "https://www.ebi.ac.uk/gxa/home"
		if gene != "" {
			link = "https://www.ebi.ac.uk/gxa/genes/" + gene
		}
		out = append(out, row(title, s(fields["Description"]), link, "Expression Atlas",
			[]Field{f("物种", s(fields["Species"])), f("实验", s(item["id"]))}))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func tRCSB(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	payload := map[string]any{
		"query":           map[string]any{"type": "terminal", "service": "full_text", "parameters": map[string]any{"value": q}},
		"return_type":     "entry",
		"request_options": map[string]any{"paginate": map[string]any{"start": 0, "rows": limit}},
	}
	// RCSB accepts the JSON query as a URL parameter; encode it via net/url.
	u := "https://search.rcsb.org/rcsbsearch/v2/query?json=" + quote(marshalCompact(payload))
	data, err := c.getJSON(ctx, u, 15, 0)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, v := range arr(obj(data)["result_set"]) {
		acc := s(obj(v)["identifier"])
		out = append(out, row(acc, "RCSB 结构数据库条目", "https://www.rcsb.org/structure/"+acc,
			"RCSB PDB", []Field{f("编号", acc)}))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func tPanther(ctx context.Context, c *Client, spec Spec, q string, limit int, p map[string]string) ([]Row, error) {
	u := render(spec.Endpoint, q, limit, p)
	data, err := c.jsonAt(ctx, u, 20, 1)
	if err != nil {
		return nil, err
	}
	genes := dig(data, "search.mapped_genes.gene")
	list := asList(genes)
	if m, ok := genes.(map[string]any); ok {
		if gl, exists := m["gene_list"]; exists {
			list = asList(gl)
		} else if _, exists := m["family_id"]; exists {
			list = []any{m}
		} else {
			list = []any{}
			for _, v := range m {
				list = append(list, v)
			}
		}
	}
	out := []Row{}
	for _, gv := range list {
		gene := obj(gv)
		family := s(gene["family_id"])
		subfamily := s(gene["sf_id"])
		names := []string{}
		for _, ev := range arr(dig(gene, "annotation_type_list.annotation_data_type")) {
			for _, av := range arr(dig(ev, "annotation_list.annotation")) {
				if n := s(obj(av)["name"]); n != "" {
					names = append(names, n)
				}
			}
		}
		if len(names) > 3 {
			names = names[:3]
		}
		title := subfamily
		if title == "" {
			title = family
		}
		if title == "" {
			title = "—"
		}
		out = append(out, row(title, strings.Join(names, "；"),
			"http://www.pantherdb.org/panther/family.do?clsAccession="+family, "PANTHER",
			[]Field{f("家族", family), f("亚家族", subfamily), f("物种编号", param(p, "organism", "3702"))}))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func tOLS(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	return olsRows(ctx, c, spec, q, limit, "Plant Ontology")
}

func tOLSChEBI(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	return olsRows(ctx, c, spec, q, limit, "ChEBI")
}

func olsRows(ctx context.Context, c *Client, spec Spec, q string, limit int, source string) ([]Row, error) {
	data, err := c.jsonAt(ctx, render(spec.Endpoint, q, limit, nil), 20, 1)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, v := range arr(dig(data, "response.docs")) {
		doc := obj(v)
		label := s(doc["label"])
		if label == "" {
			label = s(doc["short_form"])
		}
		iri := s(doc["iri"])
		if iri == "" {
			iri = "https://www.ebi.ac.uk/ols4/"
		}
		out = append(out, row(label+"（"+s(doc["short_form"])+"）", s(doc["description"]), iri, source,
			[]Field{f("本体", s(doc["ontology_name"]))}))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func tChEMBL(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	u := render(spec.Endpoint, q, limit, nil)
	// ChEMBL is slow in this机房; give it a long timeout with one retry.
	data, err := c.getJSON(ctx, u, 70, 1)
	if err != nil {
		return chemblFallback(ctx, c, q, limit, err)
	}
	out := []Row{}
	for _, v := range arr(obj(data)["molecules"]) {
		item := obj(v)
		acc := s(obj(item["molecule_chembl_id"])["x"])
		if acc == "" {
			acc = s(item["molecule_chembl_id"])
		}
		out = append(out, row(acc, s(item["pref_name"]),
			"https://www.ebi.ac.uk/chembl/compound_report_card/"+acc+"/", "ChEMBL",
			[]Field{f("分子式", nested(item, "molecule_properties.full_molformula")),
				f("分子量", nested(item, "molecule_properties.full_mwt")),
				f("ATC", strings.Join(stringsFromAny(nested(item, "molecule_synonyms.synonym")), ", "))}))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func chemblFallback(ctx context.Context, c *Client, q string, limit int, cause error) ([]Row, error) {
	// Python falls back to EBI Search when the ChEMBL endpoint fails.
	u := "https://www.ebi.ac.uk/ebisearch/ws/rest/chembl?query=" + quote(q) + "&format=json&size=" + fmt.Sprint(limit)
	data, err := c.getJSON(ctx, u, 20, 1)
	if err != nil {
		return nil, cause
	}
	out := []Row{}
	for _, v := range arr(dig(data, "entries")) {
		item := obj(v)
		out = append(out, row(s(item["id"]), s(item["description"]),
			"https://www.ebi.ac.uk/chembl/", "ChEMBL (EBI Search)", nil))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func stringsFromAny(v any) []string {
	s := str(v)
	if s == "" {
		return nil
	}
	return []string{s}
}

func tPubChem(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	data, err := c.jsonAt(ctx, render(spec.Endpoint, q, limit, nil), 20, 1)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, v := range arr(dig(data, "PropertyTable.Properties")) {
		item := obj(v)
		cid := s(item["CID"])
		out = append(out, row(cid, s(item["IUPACName"]),
			"https://pubchem.ncbi.nlm.nih.gov/compound/"+cid, "PubChem",
			[]Field{f("分子式", s(item["MolecularFormula"])), f("分子量", s(item["MolecularWeight"]))}))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func tClinVar(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	ids, err := esearchIDs(ctx, c, spec, q, limit)
	if err != nil || len(ids) == 0 {
		return []Row{}, err
	}
	if len(ids) > limit {
		ids = ids[:limit]
	}
	result, err := esummary(ctx, c, "clinvar", ids)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, id := range ids {
		item := obj(result[id])
		out = append(out, row(s(item["accession"]), nested(item, "germline_classification.description"),
			"https://www.ncbi.nlm.nih.gov/clinvar/variation/"+id+"/", "ClinVar",
			[]Field{f("VCV", s(item["accession"])), f("类型", s(item["obj_type"])),
				f("致病分级", nested(item, "germline_classification.description"))}))
	}
	return out, nil
}

func tOpenTargets(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	body := map[string]any{"query": fmt.Sprintf(`query { search(queryString: %q, page: {index: 0, size: %d}) { hits { id name entity } } }`, q, limit)}
	data, err := c.post(ctx, spec.Endpoint, body, 20)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, v := range arr(dig(data, "data.search.hits")) {
		hit := obj(v)
		out = append(out, row(s(hit["name"]), s(hit["entity"]),
			"https://platform.opentargets.org/", "Open Targets",
			[]Field{f("ID", s(hit["id"])), f("实体", s(hit["entity"]))}))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func tSTRING(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	data, err := c.jsonAt(ctx, render(spec.Endpoint, q, limit, nil), 20, 1)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, v := range arr(data) {
		item := obj(v)
		out = append(out, row(s(item["preferredName_A"])+" ↔ "+s(item["preferredName_B"]), s(item["ncbiTaxonId"]),
			"https://string-db.org/", "STRING",
			[]Field{f("蛋白 A", s(item["preferredName_A"])), f("蛋白 B", s(item["preferredName_B"])),
				f("综合分数", s(item["score"]))}))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func tHPA(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	data, err := c.jsonAt(ctx, render(spec.Endpoint, q, limit, nil), 20, 1)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, v := range arr(data) {
		item := obj(v)
		gene := s(item["g"])
		out = append(out, row(gene, s(item["gs"]),
			"https://www.proteinatlas.org/"+gene, "Human Protein Atlas",
			[]Field{f("基因", gene), f("Ensembl", s(item["eg"]))}))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func tCellosaurus(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	data, err := c.jsonAt(ctx, render(spec.Endpoint, q, limit, nil), 20, 1)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, v := range arr(dig(data, "Cellosaurus.cell-line-list")) {
		item := obj(v)
		out = append(out, row(s(item["accession"]), s(item["name"]),
			"https://www.cellosaurus.org/"+s(item["accession"]), "Cellosaurus",
			[]Field{f("CVCL", s(item["accession"])), f("类别", s(item["category"])), f("物种", s(item["species"]))}))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func tENCODE(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	data, err := c.jsonAt(ctx, render(spec.Endpoint, q, limit, nil), 15, 1)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, v := range arr(dig(data, "@graph")) {
		item := obj(v)
		out = append(out, row(s(item["accession"]), nested(item, "target.label"),
			"https://www.encodeproject.org/experiments/"+s(item["accession"])+"/", "ENCODE",
			[]Field{f("实验类型", s(item["assay_title"])), f("靶点", nested(item, "target.label")),
				f("生物样本", nested(item, "biosample_ontology.term_name"))}))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func tCBioPortal(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	data, err := c.jsonAt(ctx, render(spec.Endpoint, q, limit, nil), 20, 1)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, v := range arr(data) {
		item := obj(v)
		out = append(out, row(s(item["studyId"]), s(item["name"]),
			"https://www.cbioportal.org/study/summary?id="+s(item["studyId"]), "cBioPortal",
			[]Field{f("研究编号", s(item["studyId"])), f("癌症类型", s(item["cancerTypeId"])),
				f("样本数", s(item["allSampleCount"]))}))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func tOpenFDA(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	data, err := c.jsonAt(ctx, render(spec.Endpoint, q, limit, nil), 20, 1)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, v := range arr(dig(data, "results")) {
		item := obj(v)
		open := obj(item["openfda"])
		out = append(out, row(strings.Join(stringsFromAny(open["generic_name"]), ", "), s(item["description"]),
			"https://open.fda.gov/", "openFDA",
			[]Field{f("通用名", strings.Join(stringsFromAny(open["generic_name"]), ", ")),
				f("品牌名", strings.Join(stringsFromAny(open["brand_name"]), ", ")),
				f("给药途径", strings.Join(stringsFromAny(open["route"]), ", "))}))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func tEuropePMC(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	data, err := c.jsonAt(ctx, render(spec.Endpoint, q, limit, nil), 20, 1)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, v := range arr(dig(data, "resultList.result")) {
		item := obj(v)
		pmid := s(item["pmid"])
		link := "https://europepmc.org/article/MED/" + pmid
		out = append(out, row(s(item["title"]), s(item["authorString"]), link, "Europe PMC",
			[]Field{f("期刊", s(item["journalTitle"])), f("年份", s(item["pubYear"])), f("PMID", pmid)}))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func tTaxonomy(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	ids, err := esearchIDs(ctx, c, spec, q, limit)
	if err != nil || len(ids) == 0 {
		return []Row{}, err
	}
	if len(ids) > limit {
		ids = ids[:limit]
	}
	result, err := esummary(ctx, c, "taxonomy", ids)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, id := range ids {
		item := obj(result[id])
		out = append(out, row(s(item["scientificname"]), s(item["commonname"]),
			"https://www.ncbi.nlm.nih.gov/Taxonomy/Browser/wwwtax.cgi?id="+id, "NCBI Taxonomy",
			[]Field{f("TaxID", id), f("等级", s(item["rank"])), f("学名", s(item["scientificname"]))}))
	}
	return out, nil
}

func tHGNC(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	data, err := c.jsonAt(ctx, render(spec.Endpoint, q, limit, nil), 20, 1)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, v := range arr(dig(data, "response.docs")) {
		doc := obj(v)
		out = append(out, row(s(doc["symbol"]), s(doc["name"]),
			"https://www.genenames.org/data/gene-symbol-report/#!/hgnc_id/"+s(doc["hgnc_id"]), "HGNC",
			[]Field{f("标准名", s(doc["name"])), f("染色体", s(doc["location"])),
				f("Entrez ID", s(doc["entrez_id"]))}))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func tPRIDE(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	data, err := c.jsonAt(ctx, render(spec.Endpoint, q, limit, nil), 20, 1)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, v := range arr(data) {
		item := obj(v)
		out = append(out, row(s(item["accession"]), s(item["title"]),
			"https://www.ebi.ac.uk/pride/archive/projects/"+s(item["accession"]), "PRIDE",
			[]Field{f("项目编号", s(item["accession"])), f("提交日期", s(item["submissionDate"]))}))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func tEnrichr(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	data, err := c.jsonAt(ctx, spec.Endpoint, 20, 1)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, v := range arr(dig(data, "statistics")) {
		item := obj(v)
		name := s(item["libraryName"])
		if !strings.Contains(strings.ToLower(name+" "+s(item["category"])), strings.ToLower(q)) && q != "" {
			continue
		}
		out = append(out, row(name, s(item["category"]), "https://maayanlab.cloud/Enrichr/", "Enrichr",
			[]Field{f("术语数", s(item["numTerms"])), f("基因覆盖率", s(item["geneCoverage"]))}))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func tBrainAtlas(ctx context.Context, c *Client, spec Spec, q string, limit int, _ map[string]string) ([]Row, error) {
	data, err := c.jsonAt(ctx, spec.Endpoint, 20, 1)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for _, v := range arr(dig(data, "msg")) {
		item := obj(v)
		name := s(item["name"])
		if !strings.Contains(strings.ToLower(name+" "+s(item["description"])), strings.ToLower(q)) && q != "" {
			continue
		}
		out = append(out, row(name, s(item["description"]), "http://brain-map.org/", "Allen Brain Atlas",
			[]Field{f("图谱", name), f("图像类型", s(item["image_type"]))}))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

// marshalCompact is a thin wrapper used by transforms that must embed JSON in
// a URL. encoding/json is stdlib; keeping it here avoids an import in every fn.
func marshalCompact(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
