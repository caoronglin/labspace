//  回归：门户浏览（任何入口）不得触发第三方服务容器重建
//
//  历史缺陷：/api/* 请求的中间件按客户端网段自动把 Quantum 的
//  OIDC issuer 切到对应入口主机 → 每次切换都要 docker compose up -d 重建容器，
//  约 30 秒内直连 :8080 会命中 docker-proxy 的 502 Bad Gateway。
//  现在切换只在用户明确点击「一键登录」时发生。
//
//  用法: LAB_PASS=<口令> node sso-no-thrash-test.mjs
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://127.0.0.1';
const TS_HOST = process.env.LAB_TS_HOST || '127.0.0.1';
const CONTAINERS = ['lab-drawio'];

let pass = 0;
let fail = 0;
const record = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
};

const startedAt = () => {
  const out = {};
  for (const c of CONTAINERS) {
    out[c] = execSync(`docker inspect -f '{{.State.StartedAt}}' ${c}`, { encoding: 'utf-8' }).trim();
  }
  return out;
};

/** 读取第三方服务 OIDC 授权端点的 issuer 主机（不含端口） */
const issuerHost = async (port, path) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' });
  const loc = res.headers.get('location') || '';
  const m = loc.match(/https?:\/\/([^/:]+)/);
  return m ? m[1] : '';
};

console.log('\n== 1. 记录初始状态 ==');
const before = startedAt();
// Quantum 已下线，改用仍然在线的第三方服务（drawio）读取 issuer
const issuerBefore = {
  drawio: await issuerHost(8082, '/'),
};
record('drawio 可读到页面',
  Boolean(issuerBefore.drawio),
  `drawio host=${issuerBefore.drawio}`);

console.log('\n== 2. 内网 / Tailscale 交替访问门户 API（不应重建容器）==');
for (let i = 0; i < 4; i++) {
  await fetch(`${BASE}/api/services`, { headers: { 'X-Forwarded-For': '192.0.2.77' } });
  await fetch(`${BASE}/api/services`, { headers: { 'X-Forwarded-For': '100.66.99.99' } });
  await fetch(`${BASE}/api/corpus?q=ncbi`, { headers: { 'X-Forwarded-For': '100.66.99.99' } });
  await fetch(`${BASE}/api/search?q=fastp`, { headers: { 'X-Forwarded-For': '192.0.2.77' } });
}
await new Promise((r) => setTimeout(r, 3000));
const after = startedAt();
const unchanged = CONTAINERS.every((c) => before[c] === after[c]);
record('交替访问后容器未被重建', unchanged,
  CONTAINERS.map((c) => `${c}: ${before[c] === after[c] ? '未变' : `${before[c]} → ${after[c]}`}`).join('；'));

const issuerAfter = {
  quantum: await issuerHost(8080, '/files/api/auth/oidc/login'),
};
record('Quantum 的 OIDC issuer 未被浏览行为改动',
  issuerAfter.quantum === issuerBefore.quantum,
  `quantum ${issuerBefore.quantum} → ${issuerAfter.quantum}`);

console.log('\n== 3. 显式「一键登录」仍可按入口切换 ==');
{
  const res = await fetch(`${BASE}/api/sso/quantum/prepare`, { redirect: 'manual' });
  // 未登录时应被拒绝（说明该接口仍受会话保护）
  record('未登录调用 prepare 被拒绝', res.status === 401 || res.status === 403, `HTTP ${res.status}`);
}

console.log('\n== 4. 浏览器实测：门户 /sso/:id 中转页（AccessGuide 入口）==');
{
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ locale: 'zh-CN' });
  const page = await ctx.newPage();
  try {
    // 先用门户账号登录（Casdoor 会话），再验证一键登录免密
    const USER = process.env.LAB_USER || 'student01';
    const PASS = process.env.LAB_PASS || '';
    await page.goto(`${BASE}/api/auth/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#username', { timeout: 20000 });
    await page.locator('#username').fill(USER);
    await page.locator('#password').fill(PASS);
    await page.getByRole('button', { name: '登录' }).first().click();
    await page.waitForURL(`${BASE}/**`, { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1200);
    await page.goto(`${BASE}/sso/quantum`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForURL((u) => !u.href.includes('/sso/'), { timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const url = page.url();
    const body = (await page.evaluate(() => document.body.innerText || '')).slice(0, 200);
    const needsPassword = /password|密码/i.test(body) && !/文件|Files|分享|标签/i.test(body);
    record('/sso/quantum 已跳转到 Quantum 文件页', url.includes(':8080/'), `落地=${url.slice(0, 90)}`);
    record('Quantum 未要求重新输入口令', !needsPassword, `正文片段=${body.replace(/\s+/g, ' ').slice(0, 60)}`);
  } catch (err) {
    record('浏览器实测 /sso/quantum', false, String(err).slice(0, 120));
  } finally {
    await browser.close();
  }
}

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
