// 生物医学新增适配器实测（17 个）
import { launch, BASE } from './_auth.mjs';

const NEW_ADAPTERS = [
  ['chembl', 'aspirin'],
  ['pubchem', 'aspirin'],
  ['clinvar', 'BRCA1'],
  ['opentargets', 'EGFR'],
  ['string-db', 'TP53'],
  ['hpa', 'TP53'],
  ['cellosaurus', 'Homo sapiens'],
  ['encode', 'Homo sapiens'],
  ['cbioportal', 'lung'],
  ['openfda', 'aspirin'],
  ['europepmc', 'CRISPR'],
  ['chebi', 'glucose'],
  ['taxonomy', 'Homo sapiens'],
  ['hgnc', 'TP53'],
  ['pride', 'proteome'],
  ['enrichr', 'apoptosis'],
  ['brain-atlas', 'cortex'],
];

const browser = await launch();
const ctx = await browser.newContext({ locale: 'zh-CN' });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(process.env.LAB_USER || 'student01');
await page.locator('input[type="password"]').first().fill(process.env.LAB_PASS);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(4000);
await page.goto(`${BASE}/databases`, { waitUntil: 'domcontentloaded' });

const results = await page.evaluate(async (list) => {
  const out = [];
  const csrf = (document.cookie.match(/labspace_csrf=([^;]+)/) || [])[1] || '';
  for (const [id, q] of list) {
    try {
      const res = await fetch(`/api/databases/${id}/query`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ query: q, limit: 3 }),
      });
      const data = await res.json();
      out.push({
        id,
        status: res.status,
        ok: !!data.ok,
        n: (data.items || []).length,
        first: (data.items || [])[0]?.title || '',
        error: data.error || '',
        elapsed: data.elapsedMs,
      });
    } catch (e) {
      out.push({ id, ok: false, error: String(e).slice(0, 120) });
    }
  }
  return out;
}, NEW_ADAPTERS);

let pass = 0;
for (const r of results) {
  const good = r.ok && r.n > 0;
  if (good) pass++;
  console.log(`${good ? '  ✓' : '  ✗'} ${r.id.padEnd(14)} ${r.status} n=${r.n ?? 0} ${String(r.first).slice(0, 40)} ${r.error || ''} ${r.elapsed || ''}ms`);
}
console.log(`\n结果：${pass}/${results.length} 个新增适配器返回真实数据`);
await browser.close();
process.exit(pass === results.length ? 0 : 1);
