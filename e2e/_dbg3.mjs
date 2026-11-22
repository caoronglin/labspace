import { launch, loginContext, BASE } from './_auth.mjs';
const b = await launch();
const ctx = await loginContext(b);
const p = await ctx.newPage();
const reqs = [];
p.on('response', (r) => { if (r.url().includes('preview')) reqs.push(`${r.status()} ${r.url().slice(0,110)}`); });
await p.goto(`${BASE}/files?source=users&dir=student01`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('.ant-table-row', { timeout: 15000 });
const nameLink = p.locator('.ant-table-row a').filter({ hasText: 'demo_preview.py' }).first();
await nameLink.click();
await p.waitForTimeout(3500);
console.log('preview 请求:', reqs);
const n = await p.locator('.ant-modal, .ant-drawer').count();
console.log('modal/drawer 数:', n);
for (let i = 0; i < n; i++) {
  const t = (await p.locator('.ant-modal, .ant-drawer').nth(i).innerText().catch(()=>'')).replace(/\s+/g,' ');
  console.log(`弹窗[${i}]:`, t.slice(0, 300));
}
await p.screenshot({ path: '/tmp/code-preview3.png' });
await b.close();
