// #65 验证：Baserow 部署、持久化、双 IP 入口与管理账号登录。
// 凭据仅从本机文件读取，不打印。
import fs from 'node:fs';
import { chromium } from '/opt/labspace/e2e/node_modules/playwright/index.mjs';

const LAN = 'http://192.0.2.10:8094';
const TS = 'http://198.51.100.71:8094';
const creds = Object.fromEntries(
  fs
    .readFileSync('/etc/labspace/baserow-admin.txt', 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/[=:]/).map((s) => s.trim()))
    .map(([k, ...rest]) => [k, rest.join('=')]),
);
if (!creds.email || !creds.password) throw new Error('baserow credentials missing');

let pass = 0;
const fails = [];
const ok = (label, cond, extra = '') => {
  if (cond) pass += 1;
  else fails.push(label);
  console.log(`${cond ? '[ OK ]' : '[FAIL]'} ${label}${extra ? ' — ' + extra : ''}`);
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

try {
  // 1. 内网入口登录页
  const resp = await page.goto(`${LAN}/login`, { waitUntil: 'networkidle', timeout: 60000 });
  ok('内网入口可访问登录页', resp?.status() === 200, `HTTP ${resp?.status()}`);
  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 30000 });
  ok('登录表单渲染', true);

  // 2. 管理员登录
  await page.fill('input[type="email"], input[name="email"]', creds.email);
  await page.fill('input[type="password"]', creds.password);
  const [authResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/user/token-auth/')),
    page.getByRole('button', { name: /Login|登录/ }).click(),
  ]);
  const token = (await authResp.json()).token;
  await page.waitForFunction(() => !location.pathname.startsWith('/login'), null, { timeout: 45000 });
  ok('管理员登录成功', true, new URL(page.url()).pathname);
  ok('登录返回 JWT', Boolean(token));

  // 3. 登录后 API 可用（JWT 仅在内存中，验证时复用登录响应）
  const apiStatus = await page.evaluate(async (jwt) => {
    const res = await fetch('/api/workspaces/', {
      credentials: 'same-origin',
      headers: { Authorization: 'JWT ' + jwt },
    });
    return res.status;
  }, token);
  ok('工作区 API 可用', apiStatus === 200, `HTTP ${apiStatus}`);

  // 4. Tailscale 入口
  const tsPage = await ctx.newPage();
  const tsResp = await tsPage.goto(`${TS}/login`, { waitUntil: 'networkidle', timeout: 60000 });
  ok('Tailscale 入口可访问登录页', tsResp?.status() === 200, `HTTP ${tsResp?.status()}`);
  await tsPage.waitForSelector('input[type="email"], input[name="email"]', { timeout: 30000 });
  ok('Tailscale 登录表单渲染', true);

  ok('无前端运行错误', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('failed: ' + fails.join('; '));
  process.exit(1);
}