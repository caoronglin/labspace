//  一键登录（SSO）端到端回归：从门户进入 Open WebUI / Quantum 不再要求输入口令
//  用法: LAB_PASS=<口令> node sso-e2e-test.mjs
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://127.0.0.1';
const TS = process.env.LAB_TS_HOST || '127.0.0.1';
const USER = process.env.LAB_USER || 'student01';
const PASS = process.env.LAB_PASS || '';
let pass = 0, fail = 0;
const record = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });

const login = async (base) => {
  const ctx = await browser.newContext({ locale: 'zh-CN' });
  const page = await ctx.newPage();
  await page.goto(`${base}/api/auth/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#username', { timeout: 20000 });
  await page.locator('#username').fill(USER);
  await page.locator('#password').fill(PASS);
  await page.getByRole('button', { name: '登录' }).first().click();
  await page.waitForURL(`${base}/**`, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return { ctx, page };
};

// Quantum 已下线：它原本是唯一支持「一键登录」的第三方服务，
// 服务与容器都已清理，这一段没有可测对象；将来重新接入带 OIDC 的服务
// 时，按原样补回（断言：跳转到该服务端口、且不出现密码框）。

console.log('\n== 2. 门户 Tailscale 入口 → Quantum 一键登录 ==');
{
  const entry = `http://${TS}`;
  const { ctx, page } = await login(entry);
  await page.goto(`${entry}/services/quantum`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button:has-text("一键登录")', { timeout: 20000 });
  await page.getByRole('button', { name: '一键登录' }).first().click();
  await page.waitForURL(/8080|8090/, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const url = page.url();
  const hasPasswordBox = await page.locator('input[type="password"]').count();
  const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 160);
  record('跳转到 Quantum', /:8080/.test(url), url.slice(0, 100));
  record('未出现密码输入框（免密）', hasPasswordBox === 0, `密码框 ${hasPasswordBox} 个｜${text.replace(/\n/g, ' ').slice(0, 70)}`);
  await ctx.close();
}

await browser.close();
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
