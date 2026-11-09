import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE = 'http://198.51.100.71';
const line = readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n').find((l) => l.startsWith('labadmin@local '));
const [user, pass] = line.trim().split(/\s+/);
const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext();
const p = await ctx.newPage();
await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('input[type="password"]', { timeout: 30000 });
await p.locator('input[type="text"], input:not([type])').first().fill(user);
await p.locator('input[type="password"]').first().fill(pass);
await p.getByRole('button', { name: /登录|Login/ }).first().click();
await p.waitForTimeout(2500);
for (const label of ['开始使用', '知道了']) { const btn = p.getByRole('button', { name: label }); if (await btn.count()) { await btn.first().click(); break; } }
const out = await p.evaluate(async () => {
  const r = await fetch('/cropgenome/api/v1/species', { credentials: 'include' });
  const text = await r.text();
  let items = null; try { const j = JSON.parse(text); items = (j.items ?? j.data?.items ?? null); } catch {}
  return { status: r.status, count: Array.isArray(items) ? items.length : null, head: text.slice(0, 160) };
});
console.log(JSON.stringify(out));
await b.close();
