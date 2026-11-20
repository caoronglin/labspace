import { chromium } from 'playwright';

const BASE = 'http://198.51.100.71';
const cases = [
  { name: 'teacher', account: 'teacher01', tok: process.env.TEACHER_TOK },
  { name: 'student', account: 'student02', tok: process.env.STUDENT_TOK },
  { name: 'adminstudent', account: 'admin01', tok: process.env.ADMIN_TOK },
];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
for (const c of cases) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, locale: 'zh-CN' });
  await ctx.addCookies([{ name: 'labspace_session', value: c.tok, domain: '198.51.100.71', path: '/' }]);
  await ctx.addInitScript((acc) => {
    localStorage.setItem(`d509:tour:v1:${acc}`, '1');
    localStorage.setItem('d509:whatsnew:v1', 'seen');
  }, c.account);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/files`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  // 关掉新手引导的遮罩（它盖住整页，点击会被拦截）
  for (let i = 0; i < 4; i += 1) {
    const close = page.locator('.ant-tour-close, .ant-modal-close').first();
    if (await close.count()) { await close.click({ force: true }).catch(() => {}); await page.waitForTimeout(400); }
  }
  await page.waitForTimeout(600);
  const tabs = (await page.locator('.ant-segmented-item-label').allInnerTexts()).filter(Boolean);
  const out = { tabs };

  for (const tab of ['课题资料', '组会汇报', '个人文件']) {
    const t = page.locator('.ant-segmented-item-label', { hasText: tab }).first();
    if (!(await t.count())) { out[tab] = 'ABSENT'; continue; }
    await t.click();
    await page.waitForTimeout(1100);
    const rows = (await page.locator('tbody tr td:nth-child(1)').allInnerTexts()).slice(0, 8);
    out[tab] = rows;
  }
  // 个人文件 -> 共享给我
  const shared = page.getByText('共享给我', { exact: false }).first();
  if (await shared.count()) {
    await shared.click();
    await page.waitForTimeout(1000);
    out['共享给我'] = (await page.locator('tbody tr').allInnerTexts()).slice(0, 6).map((s) => s.replace(/\s+/g, ' ').slice(0, 60));
    await page.screenshot({ path: `/tmp/files-${c.name}-shared.png` });
  }
  out.errors = errors;
  console.log(c.name, JSON.stringify(out, null, 1));
  await ctx.close();
}
await browser.close();
