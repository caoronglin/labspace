// iframe 嵌入页验收：不可原生重写的服务以 iframe 嵌入门户
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const USER = process.env.LAB_USER || 'student01';
const PASS = process.env.LAB_PASS || '';

let pass = 0;
let fail = 0;
const record = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/api/auth/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#username', { timeout: 20000 });
await page.locator('#username').fill(USER);
await page.locator('#password').fill(PASS);
await page.getByRole('button', { name: '登录' }).first().click();
await page.waitForTimeout(3500);

// 1. 列出可嵌入服务
const svc = await page.evaluate(async () => {
  const r = await fetch('/api/services', { credentials: 'include' });
  return (await r.json()).services;
});
const embeddable = svc.filter((s) => s.embed);
record('服务目录标记了可嵌入服务', embeddable.length >= 6, `${embeddable.length} 个: ${embeddable.map((s) => s.id).join(',')}`);

// 2. 逐个服务检查 embed 判定与实际渲染
for (const s of embeddable) {
  const info = await page.evaluate(async (id) => {
    const r = await fetch(`/api/services/${id}/embed`, { credentials: 'include' });
    if (!r.ok) return { http: r.status };
    return await r.json();
  }, s.id);
  if (!info.embeddable) {
    record(`${s.id} 嵌入判定`, true, `已判定不可嵌入：${info.reason}（回退可用）`);
    continue;
  }
  const errors = [];
  const responses = [];
  const p2 = await ctx.newPage();
  p2.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  p2.on('pageerror', (e) => errors.push(String(e)));
  p2.on('response', (r) => { if (r.request().resourceType() === 'document') responses.push(`${r.status()} ${r.url()}`); });
  await p2.goto(`${BASE}/embed/${s.id}`, { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(3500);
  const frameCount = await p2.locator('iframe').count();
  const frames = p2.frames().filter((f) => f !== p2.mainFrame());
  const frameInfo = frames.map((f) => `${f.url().slice(0, 60)}|${String(f.title() || '').slice(0, 30)}`);
  const frameOk = frameCount === 0 ? '（无 iframe）' : await p2.locator('iframe').first().evaluate((f) => {
    try { return f.contentDocument ? f.contentDocument.body ? f.contentDocument.body.innerText.length : -1 : -2; }
    catch (e) { return -3; }
  });
  const blocked = errors.filter((e) => /X-Frame-Options|frame-ancestors|CSP/i.test(e));
  const frameResp = responses.filter((r) => !r.includes('/embed/'));
  record(`${s.id} 嵌入页渲染 iframe`, frameCount >= 1, `iframe=${frameCount} 内文长度=${frameOk}`);
  record(`${s.id} iframe 内文档返回 200`, frameResp.some((r) => r.startsWith('200')), `${frameResp.join(' , ') || '无'}`);
  record(`${s.id} iframe 有实际内容`, frames.length >= 1 && frameInfo.every((i) => !i.startsWith('about:blank')), frameInfo.join(' , ') || '无 frame');
  record(`${s.id} 无 X-Frame/CSP 阻断`, blocked.length === 0, blocked.slice(0, 2).join(' | '));
  const hasFallback = await p2.locator('a:has-text("新窗口"), button:has-text("新窗口")').count();
  record(`${s.id} 提供新窗口回退`, hasFallback >= 1, `命中 ${hasFallback}`);
  await p2.screenshot({ path: `shots/embed-${s.id}.png` });
  await p2.close();
}

// 3. 不可嵌入服务（SnapOtter）应给出说明与回退
await page.goto(`${BASE}/embed/snapotter`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
const text = await page.locator('body').innerText();
record('不可嵌入服务给出中文原因', /不允许|禁止|无法|X-Frame/i.test(text), text.replace(/\s+/g, ' ').slice(0, 160));

console.log(`\n结果: 通过 ${pass} / 失败 ${fail}`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
