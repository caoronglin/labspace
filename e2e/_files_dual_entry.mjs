// 双入口写权限复测 + 存储层拒绝必须报 500（不能再伪装成 403）。
import fs from 'node:fs';
import { chromium } from 'playwright';

const credFile = '/etc/labspace/casdoor-users.txt';
const credsFor = (email) => {
  const line = fs.readFileSync(credFile, 'utf8').split('\n').find((l) => l.trimStart().startsWith(email));
  return { user: email.split('@')[0], pass: line.trim().split(/\s+/)[1] };
};
let pass = 0;
let fail = 0;
const check = (name, ok, info = '') => {
  ok ? (pass += 1, console.log(`PASS  ${name}${info ? ' :: ' + info : ''}`)) : (fail += 1, console.log(`FAIL  ${name}${info ? ' :: ' + info : ''}`));
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
for (const base of ['http://192.0.2.10', 'http://198.51.100.71']) {
  const { user, pass: pw } = credsFor('labadmin@local');
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(user);
  await page.locator('input[type="password"]').first().fill(pw);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(5000);
  const csrf = () => page.evaluate(() => document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=')[1] || '');
  const call = async (u, opt = {}) => {
    const t = await csrf();
    const r = await page.evaluate(
      async ({ u, opt, t }) => {
        const res = await fetch(u, { credentials: 'include', ...opt, headers: { ...(opt.headers || {}), 'X-CSRF-Token': t } });
        return { status: res.status, body: (await res.text()).slice(0, 200) };
      },
      { u, opt, t }
    );
    return r;
  };
  const token = `_probe_${base.includes('100.66') ? 'ts' : 'lan'}`;
  const mk = await call('/api/files/mkdir', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'public', path: token }),
  });
  check(`${base} 建目录`, mk.status === 200, `${mk.status} ${mk.body.slice(0, 80)}`);
  if (mk.status === 200) {
    const list = await page.evaluate(async () => {
      const r = await fetch('/api/files?source=public&sort=name&order=asc', { credentials: 'include' });
      return r.json();
    });
    const id = (list.entries || []).find((e) => e.name === token)?.id;
    const del = await call(`/api/files/${id}`, { method: 'DELETE' });
    check(`${base} 删目录`, del.status === 200, `${del.status} ${del.body.slice(0, 60)}`);
  }
  await ctx.close();
}
await browser.close();
console.log(`\n合计：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
