// 统一搜索与数据库目录：生物医学条目覆盖验证
import { launch, BASE } from './_auth.mjs';

const TERMS = ['ClinVar', 'ChEMBL', 'STRING 蛋白互作', '细胞系', 'GWAS', 'KEGG 通路', 'Reactome', 'UniProt'];
const browser = await launch();
const ctx = await browser.newContext({ locale: 'zh-CN' });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(process.env.LAB_USER || 'student01');
await page.locator('input[type="password"]').first().fill(process.env.LAB_PASS);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(4000);

// 目录概览
const overview = await page.evaluate(async () => {
  const res = await fetch('/api/databases/apis', { credentials: 'include' });
  const data = await res.json();
  const cats = await (await fetch('/api/databases', { credentials: 'include' })).json();
  return {
    total: data.total, withApi: data.withApi, withoutApi: data.withoutApi,
    categories: (cats.categories || []).map((c) => c.name || c),
    items: (cats.items || []).length,
  };
});
console.log(`目录：共 ${overview.total} 个资源，已接入 API ${overview.withApi} 个，仅网页 ${overview.withoutApi} 个，分类 ${overview.categories.length} 个`);
console.log(`分类：${overview.categories.join(' / ')}`);

const hits = [];
for (const t of TERMS) {
  const r = await page.evaluate(async (q) => {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&scope=all`, { credentials: 'include' });
    const data = await res.json();
    const local = (data.results || []).filter((x) => x.kind === 'local' || x.engine === 'd509');
    return { total: local.length, local: local.map((x) => `${x.category}:${x.title}`).slice(0, 4), engines: (data.results || []).map((x) => x.engine).slice(0, 3) };
  }, t);
  hits.push([t, r]);
  console.log(`  ${t.padEnd(16)} 本地命中 ${r.total} 条 → ${r.local.join(' | ') || '（无）'}`);
}

// 目录页 UI
await page.goto(`${BASE}/databases`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const ui = await page.evaluate(() => {
  const text = document.body.innerText;
  const cards = document.querySelectorAll('[data-db-id]').length;
  const apiBadges = (text.match(/已接入 API/g) || []).length;
  return { cards, apiBadges, hasClinVar: text.includes('ClinVar'), hasChembl: text.includes('ChEMBL') };
});
console.log(`目录页：卡片 ${ui.cards}，API 徽标 ${ui.apiBadges}，含 ClinVar ${ui.hasClinVar}，含 ChEMBL ${ui.hasChembl}`);
await page.screenshot({ path: new URL('./shots/databases-biomed.png', import.meta.url).pathname });

const ok = overview.total >= 100 && overview.withApi >= 30 && ui.cards > 0 && hits.filter(([, r]) => r.total > 0).length >= TERMS.length - 1;
console.log(ok ? '\n结果：生物医学扩充验证通过' : '\n结果：验证未通过');
await browser.close();
process.exit(ok ? 0 : 1);
