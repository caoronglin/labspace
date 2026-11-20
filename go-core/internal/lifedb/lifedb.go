// Package lifedb queries public plant-science APIs so the unified search can
// return live records instead of only the curated database directory.
//
// All providers are best-effort: a slow or failing upstream is reported as a
// warning and never blocks the rest of the portal search. Only HTTP GET is
// used and every response is size-limited.
package lifedb

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	viridiplantaeTaxID = "33090"
	maxBodyBytes       = 2 << 20
)

// Hit is one live record shown in the “数据库 API” group.
type Hit struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
	Source  string `json:"source"`
	Type    string `json:"type"`
}

// Searcher fans out to the public plant databases.
type Searcher struct {
	Client *http.Client
	// Providers can be disabled in tests or when an upstream is unreachable
	// from the deployment network.
	EnableUniProt, EnableGBIF, EnableEuropePMC, EnableNCBIGene bool
}

// New returns a searcher with a short shared timeout budget.
func New() *Searcher {
	return &Searcher{
		Client:          &http.Client{Timeout: 8 * time.Second},
		EnableUniProt:   true,
		EnableGBIF:      true,
		EnableEuropePMC: true,
		EnableNCBIGene:  true,
	}
}

type providerFunc func(context.Context, string, int) ([]Hit, error)

// Search queries every enabled provider concurrently.
func (s *Searcher) Search(ctx context.Context, query string, limit int) ([]Hit, []string) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, nil
	}
	if limit < 1 || limit > 20 {
		limit = 4
	}
	ctx, cancel := context.WithTimeout(ctx, 9*time.Second)
	defer cancel()

	providers := []struct {
		name string
		fn   providerFunc
	}{}
	if s.EnableUniProt {
		providers = append(providers, struct {
			name string
			fn   providerFunc
		}{"UniProt", s.uniProt})
	}
	if s.EnableGBIF {
		providers = append(providers, struct {
			name string
			fn   providerFunc
		}{"GBIF", s.gbif})
	}
	if s.EnableEuropePMC {
		providers = append(providers, struct {
			name string
			fn   providerFunc
		}{"Europe PMC", s.europePMC})
	}
	if s.EnableNCBIGene {
		providers = append(providers, struct {
			name string
			fn   providerFunc
		}{"NCBI Gene", s.ncbiGene})
	}

	type result struct {
		hits []Hit
		name string
		err  error
	}
	ch := make(chan result, len(providers))
	var wg sync.WaitGroup
	for _, p := range providers {
		wg.Add(1)
		go func(name string, fn providerFunc) {
			defer wg.Done()
			hits, err := fn(ctx, query, limit)
			ch <- result{hits: hits, name: name, err: err}
		}(p.name, p.fn)
	}
	go func() {
		wg.Wait()
		close(ch)
	}()

	bySource := map[string][]Hit{}
	warnings := []string{}
	for r := range ch {
		if r.err != nil {
			warnings = append(warnings, r.name+": 暂时不可用")
			continue
		}
		bySource[r.name] = r.hits
	}

	// 轮转合并，避免快接口（例如 UniProt）占满名额，保证每个
	// 可用数据源在前几条结果中都有代表。总条数限制为 limit 的两倍。
	out := []Hit{}
	for i := 0; i < limit; i++ {
		for _, p := range providers {
			hits := bySource[p.name]
			if i < len(hits) {
				out = append(out, hits[i])
			}
		}
	}
	if max := limit * 2; len(out) > max {
		out = out[:max]
	}
	return out, warnings
}

func (s *Searcher) getJSON(ctx context.Context, endpoint string, dst any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "D509-LabSpace/1.0 (plant-science search)")
	req.Header.Set("Accept", "application/json")
	// UniProt may ignore negotiated encodings; ask for identity explicitly.
	req.Header.Set("Accept-Encoding", "identity")
	resp, err := s.client().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("upstream %s: status %d", endpoint, resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, maxBodyBytes)).Decode(dst)
}

// fallbackTimeout 是没配 Client 时的兜底上限。
// 不用 http.DefaultClient：它没有超时，上游偶发卡住就会把 handler 的
// goroutine 永久占住（请求方早已断开），几次之后整个搜索都排不上号。
const fallbackTimeout = 15 * time.Second

func (s *Searcher) client() *http.Client {
	if s.Client != nil {
		return s.Client
	}
	return &http.Client{Timeout: fallbackTimeout}
}

func clip(v string, n int) string {
	v = strings.Join(strings.Fields(v), " ")
	if len([]rune(v)) <= n {
		return v
	}
	return string([]rune(v)[:n]) + "…"
}

// ---- UniProt -------------------------------------------------------------

func (s *Searcher) uniProt(ctx context.Context, q string, limit int) ([]Hit, error) {
	query := fmt.Sprintf("(%s) AND (taxonomy_id:%s)", q, viridiplantaeTaxID)
	endpoint := "https://rest.uniprot.org/uniprotkb/search?" + url.Values{
		"query":  {query},
		"format": {"json"},
		"size":   {strconv.Itoa(limit)},
		"fields": {"accession,protein_name,organism_name,gene_names"},
	}.Encode()
	var body struct {
		Results []struct {
			PrimaryAccession   string `json:"primaryAccession"`
			ProteinDescription struct {
				RecommendedName struct {
					FullName struct {
						Value string `json:"value"`
					} `json:"fullName"`
				} `json:"recommendedName"`
			} `json:"proteinDescription"`
			Organism struct {
				ScientificName string `json:"scientificName"`
			} `json:"organism"`
			Genes []struct {
				GeneName struct {
					Value string `json:"value"`
				} `json:"geneName"`
			} `json:"genes"`
		} `json:"results"`
	}
	if err := s.getJSON(ctx, endpoint, &body); err != nil {
		return nil, err
	}
	out := make([]Hit, 0, len(body.Results))
	for _, r := range body.Results {
		if r.PrimaryAccession == "" {
			continue
		}
		title := r.ProteinDescription.RecommendedName.FullName.Value
		if title == "" {
			title = r.PrimaryAccession
		}
		gene := ""
		if len(r.Genes) > 0 {
			gene = r.Genes[0].GeneName.Value
		}
		snippet := strings.TrimSpace(strings.Join([]string{gene, r.Organism.ScientificName}, " · "))
		out = append(out, Hit{
			ID:      "uniprot:" + r.PrimaryAccession,
			Title:   clip(title, 140),
			URL:     "https://www.uniprot.org/uniprotkb/" + url.PathEscape(r.PrimaryAccession) + "/entry",
			Snippet: snippet,
			Source:  "UniProt",
			Type:    "protein",
		})
	}
	return out, nil
}

// ---- GBIF ----------------------------------------------------------------

func (s *Searcher) gbif(ctx context.Context, q string, limit int) ([]Hit, error) {
	endpoint := "https://api.gbif.org/v1/species/search?" + url.Values{
		"q":     {q},
		"limit": {strconv.Itoa(limit)},
		"rank":  {"SPECIES"},
	}.Encode()
	var body struct {
		Results []struct {
			Key            int    `json:"key"`
			ScientificName string `json:"scientificName"`
			Kingdom        string `json:"kingdom"`
			Family         string `json:"family"`
			Genus          string `json:"genus"`
		} `json:"results"`
	}
	if err := s.getJSON(ctx, endpoint, &body); err != nil {
		return nil, err
	}
	out := make([]Hit, 0, len(body.Results))
	for _, r := range body.Results {
		if r.ScientificName == "" {
			continue
		}
		if r.Kingdom != "" && !strings.EqualFold(r.Kingdom, "Plantae") {
			continue
		}
		parts := []string{}
		for _, v := range []string{r.Kingdom, r.Family, r.Genus} {
			if v != "" {
				parts = append(parts, v)
			}
		}
		out = append(out, Hit{
			ID:      "gbif:" + strconv.Itoa(r.Key),
			Title:   r.ScientificName,
			URL:     "https://www.gbif.org/species/" + strconv.Itoa(r.Key),
			Snippet: clip(strings.Join(parts, " · "), 160),
			Source:  "GBIF",
			Type:    "species",
		})
	}
	return out, nil
}

// ---- Europe PMC ----------------------------------------------------------

func (s *Searcher) europePMC(ctx context.Context, q string, limit int) ([]Hit, error) {
	endpoint := "https://www.ebi.ac.uk/europepmc/webservices/rest/search?" + url.Values{
		"query":      {q},
		"format":     {"json"},
		"pageSize":   {strconv.Itoa(limit)},
		"resultType": {"lite"},
	}.Encode()
	var body struct {
		ResultList struct {
			Result []struct {
				ID           string `json:"id"`
				Source       string `json:"source"`
				Title        string `json:"title"`
				AuthorString string `json:"authorString"`
				JournalTitle string `json:"journalTitle"`
				PubYear      string `json:"pubYear"`
				DOI          string `json:"doi"`
			} `json:"result"`
		} `json:"resultList"`
	}
	if err := s.getJSON(ctx, endpoint, &body); err != nil {
		return nil, err
	}
	out := make([]Hit, 0, len(body.ResultList.Result))
	for _, r := range body.ResultList.Result {
		if r.Title == "" {
			continue
		}
		link := ""
		if r.DOI != "" {
			link = "https://doi.org/" + url.PathEscape(r.DOI)
		} else if r.ID != "" {
			link = "https://europepmc.org/article/" + url.PathEscape(r.Source) + "/" + url.PathEscape(r.ID)
		}
		snippet := strings.TrimSpace(strings.Join([]string{r.AuthorString, r.JournalTitle, r.PubYear}, " · "))
		out = append(out, Hit{
			ID:      "epmc:" + r.Source + ":" + r.ID,
			Title:   clip(r.Title, 160),
			URL:     link,
			Snippet: clip(snippet, 200),
			Source:  "Europe PMC",
			Type:    "paper",
		})
	}
	return out, nil
}

// ---- NCBI Gene -----------------------------------------------------------

func (s *Searcher) ncbiGene(ctx context.Context, q string, limit int) ([]Hit, error) {
	term := fmt.Sprintf("(%s[All Fields]) AND txid%s[Organism]", q, viridiplantaeTaxID)
	searchURL := "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?" + url.Values{
		"db":      {"gene"},
		"term":    {term},
		"retmode": {"json"},
		"retmax":  {strconv.Itoa(limit)},
	}.Encode()
	var search struct {
		ESearchResult struct {
			IDList []string `json:"idlist"`
		} `json:"esearchresult"`
	}
	if err := s.getJSON(ctx, searchURL, &search); err != nil {
		return nil, err
	}
	if len(search.ESearchResult.IDList) == 0 {
		return nil, nil
	}
	summaryURL := "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?" + url.Values{
		"db":      {"gene"},
		"id":      {strings.Join(search.ESearchResult.IDList, ",")},
		"retmode": {"json"},
	}.Encode()
	var summary struct {
		Result map[string]json.RawMessage `json:"result"`
	}
	if err := s.getJSON(ctx, summaryURL, &summary); err != nil {
		return nil, err
	}
	out := []Hit{}
	for _, id := range search.ESearchResult.IDList {
		raw, ok := summary.Result[id]
		if !ok {
			continue
		}
		var gene struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Organism    struct {
				ScientificName string `json:"scientificname"`
			} `json:"organism"`
		}
		if err := json.Unmarshal(raw, &gene); err != nil || gene.Name == "" {
			continue
		}
		out = append(out, Hit{
			ID:      "ncbi:" + id,
			Title:   clip(gene.Name+" — "+gene.Description, 160),
			URL:     "https://www.ncbi.nlm.nih.gov/gene/" + url.PathEscape(id),
			Snippet: clip(gene.Organism.ScientificName, 160),
			Source:  "NCBI Gene",
			Type:    "gene",
		})
	}
	return out, nil
}
