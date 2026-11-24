// primer3 序列预览：长序列分段渲染、换行开关与内容一致性。
import { launch, loginContext, BASE } from './_auth.mjs';

const primerUrl = process.env.PRIMER_BASE || `${BASE}/apps/primer`;
const sequence = ['>seq1_preview', ...Array.from({ length: 1004 }, () => 'ACGTACGTACGT')].join('\n');
let pass = 0, fail = 0;
const record = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
};

const b = await launch();
try {
  const ctx = await loginContext(b);
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 1440, height: 900 });
  // 发布新 chunk 后绕过浏览器长缓存，确保测到当前构建产物。
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.clearBrowserCache');

  await p.goto(`${primerUrl}/?_=${Date.now()}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await p.waitForTimeout(2000);
  if (p.url().includes('/login')) {
    await p.locator('input[autocomplete="username"]').fill(process.env.LAB_USER);
    await p.locator('input[type="password"]').fill(process.env.LAB_PASS);
    await p.locator('button.ant-btn-primary').first().click();
    await p.waitForTimeout(3500);
  }
  record('门户会话进入 primer3 同源路径', p.url().includes('/apps/primer/'), p.url().slice(0, 90));

  await p.evaluate(() => { window.location.hash = '#/primer-design'; });
  await p.waitForTimeout(3500);
  const input = p.locator('#design-sequence').first();
  await input.waitFor({ state: 'visible', timeout: 15000 });
  await input.fill(sequence);
  await p.waitForTimeout(800);
  const previewButton = p.getByRole('button', { name: /预览序列|Preview sequence/i }).first();
  record('序列预览按钮存在', await previewButton.count() === 1);
  await previewButton.click();
  await p.waitForTimeout(500);

  const pre = p.locator('pre').filter({ hasText: 'ACGTACGTACGT' }).first();
  await pre.waitFor({ state: 'visible', timeout: 10000 });
  record('预览显示 FASTA 与总行数', /FASTA · 1005 行/.test(await pre.locator('..').innerText()));
  record('首次只渲染 1000 行', await pre.locator(':scope > div').count() === 1000,
    `rows=${await pre.locator(':scope > div').count()}`);
  const more = p.getByRole('button', { name: /显示后续 5 行/ });
  record('存在“显示后续”按钮', await more.count() === 1);
  await more.click();
  await p.waitForTimeout(300);
  record('点击后渲染全部 1005 行', await pre.locator(':scope > div').count() === 1005,
    `rows=${await pre.locator(':scope > div').count()}`);
  await p.getByRole('button', { name: '自动换行' }).click();
  const wrap = await pre.locator(':scope > div > span:last-child').first().evaluate(el => getComputedStyle(el).whiteSpace);
  record('换行开关生效', wrap === 'pre-wrap', `white-space=${wrap}`);
  await p.screenshot({ path: new URL('./shots/', import.meta.url).pathname + 'primer-code-preview.png', fullPage: false });
} finally {
  await b.close();
}
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
