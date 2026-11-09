// 管理员：调整 Agent 配额（max_sessions），验证 /api/agent/admin/config 写回生效
import { launch, BASE } from './_auth.mjs';

const browser = await launch();
const ctx = await browser.newContext({ locale: 'zh-CN' });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(process.env.LAB_ADMIN_USER || 'labadmin');
await page.locator('input[type="password"]').first().fill(process.env.LAB_ADMIN_PASS || process.env.LAB_PASS);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(4000);
await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

const out = await page.evaluate(async () => {
  const get = await fetch('/api/agent/admin/config', { credentials: 'include' });
  const cfg = await get.json();
  const body = {
    models: cfg.models,
    default_model: cfg.default_model,
    quotas: { ...(cfg.quotas || {}), max_sessions: 8 },
    plugins: cfg.plugins,
    system_prompt: cfg.system_prompt,
  };
  const put = await fetch('/api/agent/admin/config', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': (document.cookie.match(/labspace_csrf=([^;]+)/) || [])[1] || '' },
    body: JSON.stringify(body),
  });
  const saved = await put.json();
  return { status: put.status, before: cfg.quotas, after: saved?.quotas, models: (saved?.models || []).length };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
process.exit(out.status === 200 && out.after?.max_sessions === 8 ? 0 : 1);
