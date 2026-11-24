// 最近访问回归：登录后点击真实服务卡，确认 /api/recent 写入并展示。
import { launch, loginContext, BASE } from './_auth.mjs';

let pass = 0, fail = 0;
const record = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ` - ${detail}` : ''}`);
};

const browser = await launch();
try {
  const ctx = await loginContext(browser);
  const page = ctx.pages()[0];
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const card = page.locator('.lab-service-card').first();
  await card.waitFor({ state: 'visible', timeout: 20000 });
  let before = await page.evaluate(async () => (await (await fetch('/api/recent', { credentials: 'include' })).json()).recent ?? []);
  let after = before;
  for (let i = 0; i < 3; i++) {
    await page.locator('.lab-service-card').nth(i).click();
    await page.waitForTimeout(1000);
    after = await page.evaluate(async () => (await (await fetch('/api/recent', { credentials: 'include' })).json()).recent ?? []);
    if (JSON.stringify(after) !== JSON.stringify(before)) break;
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('.lab-service-card').first().waitFor({ state: 'visible', timeout: 20000 });
    before = after;
  }
  record('点击服务卡写入最近访问', JSON.stringify(after) !== JSON.stringify(before), `${before.length} -> ${after.length}`);

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await page.getByRole('tab', { name: '动态' }).click();
  await page.getByRole('tab', { name: /最近/ }).click();
  const recentText = (await page.locator('.ant-tabs-content-active:visible').last().innerText()).replace(/\s+/g, ' ');
  record('首页显示最近访问内容', recentText.length > 0 && !recentText.includes('还没有访问记录'), recentText.slice(0, 80));
  await page.screenshot({ path: '/opt/labspace/e2e/shots/home-recent.png' });
} finally {
  await browser.close();
}
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
