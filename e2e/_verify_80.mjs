import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const line = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n').find((l) => l.startsWith('labadmin@local'));
const [user, pass] = line.trim().split(/[: ]+/).filter(Boolean);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); };

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(5000);
ok(/工作台|全部服务/.test(await page.evaluate(() => document.body.innerText)), 'login failed');
await page.locator('.ant-modal-close').first().click({ timeout: 2000 }).catch(() => {});

const csrf = await ctx.cookies().then((cs) => cs.find((c) => c.name === 'labspace_csrf')?.value || '');
ok(!!csrf, 'missing labspace_csrf cookie');

const call = (path, init = {}) =>
  page.evaluate(
    async ({ path, init, csrf }) => {
      const r = await fetch(path, {
        credentials: 'same-origin',
        ...init,
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, ...(init.headers || {}) },
      });
      let body = null;
      try { body = await r.json(); } catch { body = await r.text(); }
      return { status: r.status, body };
    },
    { path, init, csrf },
  );

const st = await call('/api/aikit/status');
ok(st.status === 200, `aikit status ${st.status}`);
ok(st.body?.reachable === true, `model service unreachable: ${JSON.stringify(st.body?.reason)}`);
ok(/P100|Tesla/i.test(st.body?.gpu?.device || ''), `gpu not reported: ${st.body?.gpu?.device}`);
ok(Array.isArray(st.body?.loaded), 'status.loaded missing');

const emb = await call('/api/aikit/embeddings', {
  method: 'POST',
  body: JSON.stringify({ texts: ['水稻耐盐基因挖掘', '基因组测序分析'], return_sparse: false, return_colbert: false }),
});
ok(emb.status === 200, `embeddings ${emb.status}: ${JSON.stringify(emb.body).slice(0, 160)}`);
ok(emb.body?.dimension === 1024, `embedding dimension ${emb.body?.dimension}`);
ok(emb.body?.dense?.length === 2 && emb.body.dense[0].length === 1024, 'embedding vector shape wrong');

const rk = await call('/api/aikit/rerank', {
  method: 'POST',
  body: JSON.stringify({ query: '耐盐基因', documents: ['水稻耐盐相关基因 OsNHX1', '小麦产量性状 QTL 定位', '拟南芥开花时间调控'], return_text: true }),
});
ok(rk.status === 200, `rerank ${rk.status}: ${JSON.stringify(rk.body).slice(0, 160)}`);
ok(Array.isArray(rk.body?.results) && rk.body.results.length === 3, 'rerank results missing');
if (Array.isArray(rk.body?.results)) {
  const scores = rk.body.results.map((r) => r.score);
  ok(scores.every((s, i) => i === 0 || s <= scores[i - 1]), `rerank not sorted: ${scores}`);
}

const tr = await call('/api/aikit/translate', {
  method: 'POST',
  body: JSON.stringify({ texts: ['The salt tolerance of rice is regulated by multiple genes.'], target_lang: '中文', engine: 'fp16' }),
});
ok(tr.status === 200, `translate ${tr.status}: ${JSON.stringify(tr.body).slice(0, 160)}`);
ok(/[\u4e00-\u9fa5]/.test(tr.body?.translations?.[0] || ''), `translate output not Chinese: ${tr.body?.translations?.[0]}`);

// 使用本地 fixture 通过 Playwright request 上传
const fixture = fs.readFileSync('/opt/labspace/e2e/fixtures/e2e-preview.png');
const resp = await ctx.request.post(`${BASE}/api/aikit/parse`, {
  multipart: {
    file: { name: 'e2e-preview.png', mimeType: 'image/png', buffer: fixture },
    engine: 'mineru',
    mode: 'fast',
  },
  headers: { 'x-csrf-token': csrf },
});
ok(resp.status() === 200, `parse ${resp.status()}`);
const pbody = await resp.json().catch(() => ({}));
ok(typeof pbody?.markdown === 'string' && pbody.markdown.length > 0, 'parse returned empty markdown');
ok(typeof pbody?.engine === 'string' && pbody.engine.length > 0, 'parse engine missing');

const dp = await call('/api/docparse/status');
ok(dp.status === 200, `docparse status ${dp.status}`);
ok(!!dp.body?.mineru, 'docparse status missing mineru block');

// UI
await page.goto(`${BASE}/aikit`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);
await page.locator('.ant-modal-close').first().click({ timeout: 2000 }).catch(() => {});
const bodyText = await page.evaluate(() => document.body.innerText);
ok(/本地 AI|语义向量|重排序/.test(bodyText), 'aikit page did not render');
const tabs = ['语义向量', '重排序', '翻译', '图像识别'];
for (const t of tabs) ok(bodyText.includes(t), `missing tab ${t}`);

await page.screenshot({ path: '/opt/labspace/e2e/shots/aikit.png', fullPage: true });

await browser.close();
if (failures.length) {
  console.log('FAIL 80:', failures.join(' | '));
  process.exit(1);
}
console.log('PASS 80: aikit status/embeddings/rerank/translate/parse + docparse mineru + UI');