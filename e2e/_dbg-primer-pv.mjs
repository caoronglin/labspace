import { launch, loginContext } from './_auth.mjs';
const b = await launch();
const ctx = await loginContext(b);
const p = await ctx.newPage();
await p.setViewportSize({ width: 1440, height: 900 });
// 关掉浏览器缓存：assets 是 immutable 长缓存，发布新 chunk 后老页面仍拿旧 chunk
const cdp = await ctx.newCDPSession(p);
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
await cdp.send('Network.clearBrowserCache');
await p.goto('http://127.0.0.1:8097/?_=' + Date.now(), { waitUntil: 'domcontentloaded' }).catch(() => {});
await p.waitForTimeout(2500);
// 若被弹到门户登录页：填口令登录
if (p.url().includes('/login')) {
  await p.locator('input[autocomplete="username"]').fill(process.env.LAB_USER);
  await p.locator('input[type="password"]').fill(process.env.LAB_PASS);
  await p.locator('button.ant-btn-primary').first().click();
  await p.waitForTimeout(3500);
}
console.log('当前:', p.url().slice(0, 70));
// 用 hash 切换（避免整页导航丢状态）
await p.evaluate(() => { window.location.hash = '#/primer-design'; });
await p.evaluate(() => window.location.reload());
await p.waitForTimeout(4000);
console.log('textarea:', await p.locator('textarea').count());
const ta = p.locator('#design-sequence').first();
if (await ta.count()) {
  await ta.fill('>seq1 demo\nATGCATGCATGCATGCATGC\nATGCATGCATGCATGCATGC\n');
  await p.waitForTimeout(900);
  const btn = p.getByRole('button', { name: /预览序列|Preview sequence/i }).first();
  console.log('预览按钮:', await btn.count());
  if (await btn.count()) {
    await btn.click();
    await p.waitForTimeout(800);
    const txt = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
    console.log('含 FASTA 行数:', /FASTA · \d+ 行/.test(txt) ? '✓' : '✗');
    console.log('含序列内容:', txt.includes('ATGCATGCATGCATGCATGC') ? '✓' : '✗');
    await p.screenshot({ path: '/tmp/primer-preview.png', fullPage: false });
  }
} else {
  const t = (await p.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 200);
  console.log('页面:', t);
}
await b.close();
