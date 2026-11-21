import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://192.168.5.12';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await (await b.newContext({ locale: 'zh-CN', viewport: { width: 1400, height: 900 } })).newPage();
await p.goto(`${BASE}/api/auth/login`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('#username', { timeout: 20000 });
await p.locator('#username').fill(process.env.LAB_USER || 'student01');
await p.locator('#password').fill(process.env.LAB_PASS);
await p.getByRole('button', { name: '登录' }).first().click();
await p.waitForURL(`${BASE}/**`, { timeout: 25000 }).catch(() => {});
await p.waitForTimeout(2500);
await p.screenshot({ path: '/tmp/sidebar.png', fullPage: false });
const text = await p.locator('body').innerText();
for (const g of ['工作区', '文件与课题', '分析与写作', '科研工具']) {
  console.log(`  ${text.includes(g) ? 'OK  ' : 'MISS'} ${g}`);
}
await b.close();
