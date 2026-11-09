// 植物数据库真实 API 集成体检
// 用法: LAB_PASS=<口令> node db-api-integration.mjs
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const USER = process.env.LAB_USER || 'student01';
const PASS = process.env.LAB_PASS || '';

let pass = 0;
let fail = 0;
const record = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN' });
const page = await ctx.newPage();
await page.goto(`${BASE}/api/auth/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#username', { timeout: 20000 });
await page.locator('#username').fill(USER);
await page.locator('#password').fill(PASS);
await page.getByRole('button', { name: '登录' }).first().click();
await page.waitForTimeout(4000);

const api = async (path, init = {}) => {
  const res = await page.evaluate(
    async ([p, i]) => {
      if (i.method && i.method !== 'GET') {
        const csrf = (document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf=')) || '').split('=')[1] || '';
        i = { ...i, headers: { ...(i.headers || {}), 'X-CSRF-Token': decodeURIComponent(csrf) } };
      }
      const r = await fetch(p, { credentials: 'include', ...i });
      const t = await r.text();
      try { return { status: r.status, body: JSON.parse(t) }; }
      catch { return { status: r.status, body: t.slice(0, 200) }; }
    },
    [path, init],
  );
  return res;
};

// 1. 目录 API 清单
const apis = await api('/api/databases/apis');
record('GET /api/databases/apis 返回 200', apis.status === 200, `HTTP ${apis.status}`);
record('API 化数据库 ≥ 15 个', (apis.body?.withApi || 0) >= 15, `withApi=${apis.body?.withApi} / total=${apis.body?.total}`);
record('清单覆盖全部 71 个数据库', (apis.body?.items?.length || 0) === (apis.body?.total || 0), `items=${apis.body?.items?.length}`);
const noApiWithReason = (apis.body?.items || []).filter((i) => !i.hasApi && i.note && i.note.length > 6).length;
record('无 API 的库均写明原因', noApiWithReason >= 40, `已说明 ${noApiWithReason} 个`);

// 2. 目录接口带 api 字段
const dbs = await api('/api/databases');
record('GET /api/databases 正常', dbs.status === 200 && (dbs.body?.items?.length || 0) > 0, `items=${dbs.body?.items?.length}`);
const withApiFlag = (dbs.body?.items || []).filter((i) => i.api && i.api.hasApi).length;
record('目录条目带 API 标记', withApiFlag >= 15, `hasApi=${withApiFlag}`);

// 3. 逐个真实查询
const QUERIES = {
  ncbi: { q: 'AP1 Arabidopsis', params: {} },
  'ncbi-sra': { q: 'maize RNA-seq', params: {} },
  'ncbi-blast': { q: 'AT1G01010', params: { program: 'blastn', database: 'refseq_plant' } },
  ebi: { q: 'kinase', params: {} },
  ena: { q: 'maize', params: {} },
  uniprotkb: { q: 'kinase AND organism_id:3702', params: {} },
  interpro: { q: 'kinase', params: {} },
  pfam: { q: 'WRKY', params: {} },
  alphafold: { q: 'P00533', params: {} },
  kegg: { q: 'kinase', params: { space: 'genes' } },
  'expression-atlas': { q: 'AT1G01010', params: {} },
  pdb: { q: 'phytochrome', params: {} },
  panther: { q: 'AP1', params: { organism: '3702' } },
  'plant-ontology': { q: 'leaf', params: {} },
  rnacentral: { q: 'MIR166', params: {} },
};

console.log('\n  —— 真实 API 查询 ——');
const results = [];
for (const [id, cfg] of Object.entries(QUERIES)) {
  const t0 = Date.now();
  const res = await api(`/api/databases/${id}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: cfg.q, limit: 3, params: cfg.params }),
  });
  const ok = res.status === 200 && res.body?.ok === true && Array.isArray(res.body?.items) && res.body.items.length > 0;
  const first = res.body?.items?.[0];
  results.push({ id, ok, n: res.body?.items?.length || 0, ms: Date.now() - t0, err: res.body?.error });
  record(
    `查询 ${id}`,
    ok,
    ok ? `${res.body.items.length} 条 / ${res.body.items[0].title.slice(0, 40)} / ${res.body.elapsedMs}ms` : `HTTP ${res.status} ${res.body?.error || ''}`,
  );
  if (first) {
    const shape = first.title && typeof first.subtitle === 'string' && typeof first.url === 'string' && Array.isArray(first.fields);
    if (!shape) record(`${id} 返回结构归一化`, false, JSON.stringify(first).slice(0, 120));
  }
}
record('全部 15 个适配器均返回结果', results.filter((r) => r.ok).length === Object.keys(QUERIES).length,
  `${results.filter((r) => r.ok).length}/${Object.keys(QUERIES).length}`);

// 4. 无 API 的库应明确报错
const noApiRes = await api('/api/databases/tair/query', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'AP1' }),
});
record('无 API 库给出明确原因', noApiRes.status === 200 && noApiRes.body?.ok === false && /没有可用的公开 API/.test(noApiRes.body?.error || ''),
  noApiRes.body?.error);

// 5. 探活接口
const probe = await api('/api/databases/ncbi/probe');
record('GET /api/databases/{id}/probe 可用', probe.status === 200 && typeof probe.body?.ok === 'boolean', `ok=${probe.body?.ok} ${probe.body?.detail}`);

console.log(`\n结果: 通过 ${pass} / 失败 ${fail}`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
