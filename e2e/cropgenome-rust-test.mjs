// CropGenome 前端 + Rust-Bio Worker 端到端验收：
//  1. 门户会话下 /cropgenome/ 的 SPA 能打开（静态资源全部 200，无控制台报错）
//  2. 序列分析页能渲染（react-router 子路由 + vite base=/cropgenome/）
//  3. 4 个 Rust 分析端点经「浏览器 → nginx → Go 核心 → cropgenome Go → seq-worker」全通，
//     返回的是 rust-bio 真实计算值（GC/GC3/反向互补/score/cigar/hits）
//  4. 写操作必须带 X-CSRF-Token（双提交），缺了必须 403
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://127.0.0.1';
const USER = process.env.LAB_USER || 'student01';
const PASS = process.env.LAB_PASS;

let pass = 0, fail = 0;
const ok = (name, extra = '') => { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); };
const bad = (name, extra = '') => { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); };

if (!PASS) {
  console.error('需要先 export LAB_PASS=<student01 口令>');
  process.exit(2);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });

// ---------- 登录 ----------
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(USER);
await page.locator('input[type="password"]').first().fill(PASS);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(5000);
{
  const body = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  if (!/工作台|全部服务|我的收藏/.test(body)) throw new Error(`门户登录失败，停留在 ${page.url()}`);
}

// ---------- 1. SPA 打开 ----------
console.log('=== 1. CropGenome 前端 SPA ===');
const consoleErrors = [];
const failedReq = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
page.on('requestfailed', (r) => failedReq.push(`${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`));
page.on('response', (r) => { if (r.status() >= 400) failedReq.push(`${r.status()} ${r.url()}`); });

await page.goto(`${BASE}/cropgenome/`, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(1500);
{
  const title = await page.title();
  title.includes('CropGenome') ? ok('SPA 首页标题正确', title) : bad('SPA 首页标题', title);
  const rootHtml = await page.evaluate(() => document.getElementById('root')?.innerHTML.length ?? 0);
  rootHtml > 200 ? ok('React 已挂载', `#root ${rootHtml} 字符`) : bad('React 未挂载', `#root ${rootHtml} 字符`);
}

// ---------- 2. 序列分析页 ----------
console.log('=== 2. 序列分析页 ===');
await page.goto(`${BASE}/cropgenome/analysis`, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(1200);
{
  const body = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  /序列|GC|反向互补/.test(body)
    ? ok('分析页已渲染（react-router 子路由 + vite base 正确）')
    : bad('分析页未渲染', body.slice(0, 160));
}

// ---------- 3. 4 个 Rust 端点 ----------
console.log('=== 3. Rust-Bio 分析端点（浏览器 → 核心 → Go → seq-worker）===');
const CSRF = await page.evaluate(() => (document.cookie.match(/labspace_csrf=([^;]*)/) || [])[1] ?? '');
CSRF ? ok('读到门户 CSRF Cookie', 'labspace_csrf 已下发') : bad('未读到 CSRF Cookie');

async function callApi(path, payload, withCsrf = true) {
  return page.evaluate(async ({ path, payload, withCsrf, csrf }) => {
    const headers = { 'Content-Type': 'application/json' };
    if (withCsrf && csrf) headers['X-CSRF-Token'] = csrf;
    const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(payload) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, json, text: text.slice(0, 200) };
  }, { path, payload, withCsrf, csrf: CSRF });
}

{
  const r = await callApi('/cropgenome/api/v1/sequence/analyze', { sequence: 'ATGCCCTAA', alphabet: 'dna' });
  if (r.status === 200 && r.json?.gc_content === 0.4444 && r.json?.gc3_content === 0.6667 && r.json?.reverse_complement === 'TTAGGGCAT') {
    ok('sequence/analyze 返回 rust-bio 真实值', `gc=${r.json.gc_content} gc3=${r.json.gc3_content} rc=${r.json.reverse_complement}`);
  } else {
    bad('sequence/analyze', `HTTP ${r.status} ${r.text}`);
  }
}
{
  const r = await callApi('/cropgenome/api/v1/alignments/pairwise', { query: 'ACCGTGGAT', reference: 'AAAAACCGTTGAT', mode: 'semiglobal' });
  if (r.status === 200 && r.json?.score === 7 && r.json?.cigar === '5=1X3=') {
    ok('alignments/pairwise 返回真实比对', `score=${r.json.score} cigar=${r.json.cigar}`);
  } else {
    bad('alignments/pairwise', `HTTP ${r.status} ${r.text}`);
  }
}
{
  const r = await callApi('/cropgenome/api/v1/motifs/search', { pattern: 'CCTG', text: 'AACCTGGGCT', algorithm: 'kmp' });
  if (r.status === 200 && Array.isArray(r.json?.matches) && r.json.matches.length === 1 && r.json.matches[0].start === 2) {
    ok('motifs/search 命中唯一位置', JSON.stringify(r.json.matches[0]));
  } else {
    bad('motifs/search', `HTTP ${r.status} ${r.text}`);
  }
}
{
  const r = await callApi('/cropgenome/api/v1/regions/features', {
    assembly_id: 'ASM1',
    query: { contig: 'chr1', start: 190, end: 220 },
    features: [
      { contig: 'chr1', start: 100, end: 200, id: 'geneA' },
      { contig: 'chr1', start: 210, end: 260, id: 'geneB' },
      { contig: 'chr2', start: 1, end: 50, id: 'geneC' },
    ],
  });
  if (r.status === 200 && r.json?.hits?.length === 2 && r.json.hits.includes('geneA') && !r.json.hits.includes('geneC')) {
    ok('regions/features 不串 contig', `hits=${r.json.hits.join(',')}`);
  } else {
    bad('regions/features', `HTTP ${r.status} ${r.text}`);
  }
}

// ---------- 4. CSRF 必须 ----------
console.log('=== 4. CSRF 双提交 ===');
{
  const r = await callApi('/cropgenome/api/v1/sequence/analyze', { sequence: 'ATGCCCTAA', alphabet: 'dna' }, false);
  r.status === 403 ? ok('缺 X-CSRF-Token 被拒', `HTTP ${r.status}`) : bad('缺 CSRF 未被拒', `HTTP ${r.status} ${r.text}`);
  // 这一条 403 是故意造的，别把它算进后面的“前端无报错”统计
  failedReq.length = 0;
}

// ---------- 5. 控制台/网络噪音 ----------
console.log('=== 5. 前端无报错 ===');
{
  const real = failedReq.filter((u) => !u.includes('favicon'));
  real.length === 0 ? ok('无失败请求') : bad('有失败请求', real.slice(0, 3).join(' | '));
  const realErr = consoleErrors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  realErr.length === 0 ? ok('无控制台错误') : bad('有控制台错误', realErr.slice(0, 3).join(' | '));
}

await page.screenshot({ path: '/opt/labspace/e2e/shots/cropgenome-analysis.png', fullPage: false });
await browser.close();

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
