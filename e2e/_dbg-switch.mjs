import { launch } from './_auth.mjs';
const BASE = process.env.LAB_BASE || 'http://127.0.0.1';
const b = await launch();
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
// 1) 打开 primer3（未登录）→ 应跳门户登录页
await p.goto(`http://127.0.0.1:8097/?_=${Date.now()}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
await p.waitForTimeout(1500);
console.log('1) primer 未登录 →', p.url().slice(0, 90));
// 2) 门户登录页有口令表单？
const hasUser = await p.locator('input[autocomplete="username"]').count();
const hasPwd = await p.locator('input[type="password"]').count();
console.log('2) 登录页账号框:', hasUser, '口令框:', hasPwd);
// 3) 填口令登录
await p.locator('input[autocomplete="username"]').fill(process.env.LAB_USER);
await p.locator('input[type="password"]').fill(process.env.LAB_PASS);
await p.locator('button.ant-btn-primary').first().click();
await p.waitForTimeout(4000);
console.log('3) 登录后 →', p.url().slice(0, 100));
await p.waitForTimeout(2000);
const primerBody = (await p.locator('body').innerText().catch(()=>'')).replace(/\s+/g,' ').slice(0, 120);
console.log('4) primer 页面文本:', primerBody);
await p.screenshot({ path: '/tmp/primer-after-login.png', fullPage: false });
await b.close();
