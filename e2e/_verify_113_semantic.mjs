import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const line = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
  .split('\n').find((l) => l.startsWith('labadmin@local'));
const [user, pass] = line.trim().split(/[: ]+/).filter(Boolean);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN' });
const page = await ctx.newPage();
const failures = [];
const ok = (c, m) => { if (!c) failures.push(m); };

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(5000);
ok(/工作台|全部服务/.test(await page.evaluate(() => document.body.innerText)), 'login failed');

const api = async (path, init) => {
  const r = await ctx.request.fetch(`${BASE}${path}`, init);
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status(), body };
};

// 1. /api/aikit/* 必须已下线
const aikit = await api('/api/aikit/status');
ok(aikit.status === 404, `aikit status still mounted: ${aikit.status}`);

// 2. 语义索引状态
const rag = await api('/api/knowledge/rag/status');
ok(rag.status === 200, `rag status http ${rag.status}`);
const sem = rag.body?.semantic;
ok(!!sem, `rag status missing semantic: ${JSON.stringify(rag.body)?.slice(0, 300)}`);
console.log('semantic.status =', JSON.stringify(sem));

// 3. 知识库检索：应有融合字段
const ks = await api('/api/knowledge/search?q=' + encodeURIComponent('基因组') + '&limit=5');
ok(ks.status === 200, `knowledge search http ${ks.status}`);
const hits = ks.body?.hits ?? [];
console.log('knowledge hits =', hits.length,
  hits.slice(0, 3).map((h) => ({ t: h.title, fusion: h.fusion, mt: h.matchType, vs: h.vectorScore })));
ok(hits.every((h) => h.fusion !== undefined), 'knowledge hits missing fusion');
ok(hits.every((h) => h.matchType !== undefined), 'knowledge hits missing matchType');

// 4. 统一搜索 scope=local
const us = await api('/api/search?q=' + encodeURIComponent('基因组') + '&scope=local');
ok(us.status === 200, `unified search http ${us.status}`);
const local = (us.body?.results ?? []).filter((r) => r.kind === 'local');
console.log('unified local results =', local.length,
  local.slice(0, 3).map((r) => ({ t: r.title, fusion: r.fusion, mt: r.matchType, rs: r.rerankScore })));
ok(us.body?.results?.length > 0, 'unified search returned no results');

// 5. /aikit 前端页面不能是 AI 工作台
await page.goto(`${BASE}/aikit`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const body = await page.evaluate(() => document.body.innerText);
ok(!/语义向量|bge-m3|嵌入向量|重排序测试/.test(body), '/aikit page still renders AI toolkit');

// 6. 侧栏/起始页不再出现「本地 AI」
await page.goto(`${BASE}/start`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const startBody = await page.evaluate(() => document.body.innerText);
ok(!startBody.includes('本地 AI'), '/start still shows 本地 AI tile');

if (failures.length) {
  console.log('FAIL\n- ' + failures.join('\n- '));
  process.exitCode = 1;
} else {
  console.log('ALL_OK');
}
await browser.close();