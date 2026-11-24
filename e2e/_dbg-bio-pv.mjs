import { launch, loginContext, BASE } from './_auth.mjs';
const b = await launch();
const ctx = await loginContext(b);
const p = await ctx.newPage();
await p.setViewportSize({ width: 1440, height: 900 });
await p.goto(`${BASE}/apps/bioinfo/api/v1/auth/login?redirect=${encodeURIComponent('/apps/bioinfo/workspace')}`, { waitUntil: 'commit' }).catch(() => {});
for (let i = 0; i < 15; i++) { await p.waitForTimeout(1000); if (p.url().includes('/apps/bioinfo/') && !p.url().includes('/auth/')) break; }
await p.waitForTimeout(4000);
const frame = p.frames().find(f => f.url().includes('/apps/bioinfo/workspace'));
console.log('workspace frame:', frame ? '有' : '无');
if (!frame) { await b.close(); process.exit(1); }
const btn = frame.locator('button', { hasText: '预览' }).first();
console.log('预览按钮数:', await frame.locator('button', { hasText: '预览' }).count());
await btn.click();
await p.waitForTimeout(2500);
const modal = frame.locator('.ant-modal').first();
const txt = (await modal.innerText().catch(() => '')).replace(/\s+/g, ' ');
console.log('弹窗文本:', txt.slice(0, 220));
console.log('行号渲染:', /1\s+2\s+3/.test(txt) ? '✓' : (await modal.locator('pre div span').count()) + ' 个行号元素');
await p.screenshot({ path: '/tmp/bio-preview.png' });
await b.close();
