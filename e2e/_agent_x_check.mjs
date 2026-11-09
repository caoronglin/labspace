// 临时探针：验证 Agent 页 Ant Design X 组件、默认模型、欢迎页
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const USERS = [
  { user: process.env.U1, pass: process.env.P1, label: 'student01' },
  { user: process.env.U2, pass: process.env.P2, label: 'student02' },
];

const browser = await chromium.launch({ args: ['--no-sandbox'] });

for (const { user, pass, label } of USERS) {
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e).slice(0, 160)));

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(user);
  await page.locator('input[type="password"]').first().fill(pass);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(4000);

  const before = await page.evaluate(async (base) => {
    const r = await fetch(`${base}/api/agent/sessions`, { credentials: 'include' });
    const d = await r.json();
    return (d.sessions || []).map((s) => ({ id: s.id, model: s.model }));
  }, BASE);

  await page.goto(`${BASE}/agent`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const dom = await page.evaluate(() => ({
    select: (document.querySelector('.ant-select-selector')?.textContent || '').trim(),
    welcome: document.querySelectorAll('.ant-welcome').length,
    prompts: document.querySelectorAll('.ant-prompts').length,
    conversations: document.querySelectorAll('.ant-conversations').length,
    sender: document.querySelectorAll('.ant-sender').length,
    bubbles: document.querySelectorAll('.ant-bubble').length,
  }));

  if (before.length === 0) {
    console.log(`[${label}] 无会话 → Welcome/Prompts`, JSON.stringify(dom));
    await page.screenshot({ path: new URL('./shots/_agent_welcome.png', import.meta.url).pathname });
  } else {
    console.log(`[${label}] 已有会话 →`, JSON.stringify(dom));
    await page.getByRole('button', { name: /新建会话/ }).first().click();
    await page.waitForTimeout(1800);
    const created = await page.evaluate(async ({ base, beforeIds }) => {
      const r = await fetch(`${base}/api/agent/sessions`, { credentials: 'include' });
      const d = await r.json();
      const fresh = (d.sessions || []).filter((s) => !beforeIds.includes(s.id));
      return fresh.map((s) => ({ id: s.id, model: s.model }))[0] || null;
    }, { base: BASE, beforeIds: before.map((s) => s.id) });
    console.log(`[${label}] 新建会话模型 →`, created ? created.model : 'none');
    await page.screenshot({ path: new URL('./shots/_agent_probe.png', import.meta.url).pathname });
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    if (created) {
      await page.evaluate(async ({ base, id }) => {
        await fetch(`${base}/api/agent/sessions/${id}`, {
          method: 'DELETE', credentials: 'include',
          headers: { 'X-CSRF-Token': document.cookie.split('labspace_csrf=')[1]?.split(';')[0] || '' },
        });
      }, { base: BASE, id: created.id });
    }
  }

  console.log(`[${label}] console errors:`, errors.slice(0, 4));
  await ctx.close();
}

await browser.close();
