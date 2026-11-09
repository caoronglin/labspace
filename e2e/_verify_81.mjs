import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const line = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n').find((l) => l.startsWith('labadmin@local'));
const [user, pass] = line.trim().split(/[: ]+/).filter(Boolean);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const fail = (m) => { console.error('FAIL', m); process.exitCode = 1; };

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(5000);

const cookies = await ctx.cookies();
const csrf = cookies.find((c) => c.name === 'labspace_csrf')?.value || '';
const headers = { 'x-csrf-token': csrf };

const st = await ctx.request.get(`${BASE}/api/mt/status`);
const status = await st.json();
console.log('status', st.status(), status.provider, status.available, status.model, 'fallback=', status.fallback?.available);
if (!status.available) fail('local hy-mt2 not available');

const tr = await ctx.request.post(`${BASE}/api/mt/translate`, {
  headers,
  data: { source: 'The quick brown fox jumps over the lazy dog.', targetLang: '中文' },
});
const trj = await tr.json();
console.log('translate', tr.status(), trj.provider, trj.model, JSON.stringify(trj.translation));
if (tr.status() !== 200 || trj.provider !== 'hy-mt2') fail('text translation not via hy-mt2');

const buf = fs.readFileSync('/tmp/mt-test.pdf');
const job = await ctx.request.post(`${BASE}/api/pdf-translate/jobs`, {
  headers,
  multipart: { file: { name: 'mt-test.pdf', mimeType: 'application/pdf', buffer: buf } },
});
const jobj = await job.json();
console.log('job', job.status(), jobj.job_id);
if (!jobj.job_id) fail('job submit failed');

let meta = null;
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(2000);
  const r = await ctx.request.get(`${BASE}/api/pdf-translate/jobs/${jobj.job_id}`);
  meta = await r.json();
  if (!['queued', 'processing'].includes(meta.status)) break;
}
console.log('pdf job final', JSON.stringify(meta));
if (meta?.status !== 'done') fail('pdf translation did not finish');

await browser.close();