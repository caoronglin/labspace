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

const csrf = (await ctx.cookies()).find((c) => c.name === 'labspace_csrf')?.value;
const api = async (path, init = {}) => {
  const headers = { ...(init.headers || {}) };
  if (csrf && init.method && init.method !== 'GET') headers['X-CSRF-Token'] = csrf;
  const r = await ctx.request.fetch(`${BASE}${path}`, { ...init, headers });
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
ok(!!sem, 'rag status missing semantic');
console.log('semantic.status =', JSON.stringify(sem));

// 3. 新建一条知识条目，等待后台建索引
const unique = '量子纠缠雪花算法';
const created = await api('/api/knowledge/', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  data: {
    title: '实验室内部测试条目',
    body: `这是一条用于验证语义检索的条目。它讨论 ${unique}，以及低温超导材料在量子计算中的相干性问题。`,
    visibility: 'public',
    category: 'note',
  },
});
ok(created.status === 200 || created.status === 201, `create doc http ${created.status}`);
const docId = created.body?.item?.id;
ok(!!docId, `create doc missing id: ${JSON.stringify(created.body)?.slice(0, 200)}`);

let hits = [];
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(1500);
  const ks = await api('/api/knowledge/search?q=' + encodeURIComponent(unique) + '&limit=5');
  hits = ks.body?.hits ?? [];
  if (hits.some((h) => Number(h.id) === Number(docId))) break;
}
const target = hits.find((h) => Number(h.id) === Number(docId));
console.log('search hits =', hits.map((h) => ({ id: h.id, fusion: h.fusion, mt: h.matchType, vs: h.vectorScore, rs: h.rerankScore })));
ok(!!target, 'new doc not recalled by knowledge search');
ok(hits.every((h) => h.fusion !== undefined), 'hits missing fusion');
ok(hits.every((h) => h.matchType !== undefined), 'hits missing matchType');
if (target) {
  ok(target.fusion === 'hybrid' || target.fusion === 'semantic' || target.fusion === 'keyword', `bad fusion ${target.fusion}`);
  ok(typeof target.rerankScore === 'number', 'target missing rerankScore');
}

await page.waitForTimeout(3000);

// 4. 纯语义查询（与正文无直接子串重合）
const semantic = await api('/api/knowledge/search?q=' + encodeURIComponent('超导体量子位退相干') + '&limit=10');
const semHits = semantic.body?.hits ?? [];
console.log('semantic query hits =', semHits.map((h) => ({ id: h.id, fusion: h.fusion, vs: h.vectorScore })));
ok(semHits.some((h) => Number(h.id) === Number(docId)), 'semantic-only query missed the doc');

// 5. 统一搜索 scope=local 也应合并语义结果
const us = await api('/api/search?q=' + encodeURIComponent(unique) + '&scope=local');
ok(us.status === 200, `unified search http ${us.status}`);
const local = (us.body?.results ?? []).filter((r) => r.kind === 'local');
ok(local.some((r) => Number(r.id) === Number(docId) || (r.title || '').includes('实验室内部测试条目')),
  'unified search missed semantic doc');

// 6. /aikit 必须是 404 页面
await page.goto(`${BASE}/aikit`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const body = await page.evaluate(() => document.body.innerText);
ok(body.includes('页面不存在'), '/aikit did not render 404 page');

// 7. 起始页不再出现「本地 AI」
await page.goto(`${BASE}/start`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const startBody = await page.evaluate(() => document.body.innerText);
ok(!startBody.includes('本地 AI'), '/start still shows 本地 AI tile');

// 清理
if (docId) {
  const del = await api(`/api/knowledge/${docId}`, { method: 'DELETE' });
  console.log('cleanup delete =', del.status);
}

if (failures.length) {
  console.log('FAIL\n- ' + failures.join('\n- '));
  process.exitCode = 1;
} else {
  console.log('ALL_OK');
}
await browser.close();