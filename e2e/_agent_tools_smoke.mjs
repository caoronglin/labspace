import { chromium } from 'playwright';
import fs from 'node:fs';

const CRED = {};
for (const line of fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const [email, pass] = t.split(/\s+/);
  if (email && pass) CRED[email.split('@')[0]] = pass;
}

let failed = 0;
const must = (c, l, e = '') => {
  console.log(`${c ? 'ok  ' : 'FAIL'} ${l}${e ? ' — ' + e : ''}`);
  if (!c) failed++;
};

const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (err) => console.log('PAGEERROR', err.message));
await page.goto('http://192.0.2.10/login', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#password', { timeout: 40000 });
await page.locator('#username').fill('labadmin');
await page.locator('#password').fill(CRED.labadmin);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3500);
await page.evaluate(() => localStorage.setItem('d509:help:release-seen', 'v2026.11.09.1'));

const closeModals = async () => {
  for (let i = 0; i < 3; i++) {
    const wrap = page.locator('.ant-modal-wrap:visible').first();
    if (!(await wrap.count())) return;
    const btn = wrap.getByRole('button', { name: /知道了|开始使用|我知道了|关闭|稍后|确定|跳过/ }).last();
    if (await btn.count()) await btn.click().catch(() => {});
    else await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }
};

/* ---------------- Agent 记忆 ---------------- */
await page.goto('http://192.0.2.10/agent', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);
await closeModals();
const toolbar = page.getByTestId('agent-toolbar');
await toolbar.waitFor({ timeout: 30000 });
must(await toolbar.getByRole('button', { name: /记忆/ }).count() >= 1, '工具条含“记忆”入口');
must(await page.getByText('沙箱就绪').count() >= 1, '显示“沙箱就绪”状态');

await toolbar.getByRole('button', { name: /记忆/ }).first().click();
await page.waitForTimeout(1200);
must(await page.locator('.ant-drawer:visible').count() === 1, '记忆抽屉可打开');

// 通过页面上下文创建一条记忆（使用会话 Cookie + CSRF）
const created = await page.evaluate(async () => {
  const csrf = document.cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith('labspace_csrf='))?.split('=')[1] || '';
  const res = await fetch('/api/agent/memories', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) },
    body: JSON.stringify({ kind: 'note', title: 'E2E 记忆验证', content: '这是端到端验证写入的长期记忆条目。' }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
});
must(created.status === 200 && !!created.body?.memory?.id, '记忆写入 API', `status=${created.status}`);
const memId = created.body?.memory?.id;

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await closeModals();
await page.getByTestId('agent-toolbar').getByRole('button', { name: /记忆/ }).first().click();
await page.waitForTimeout(1200);
must(await page.getByText('E2E 记忆验证').count() >= 1, '抽屉内可见新记忆');

if (memId) {
  const del = await page.evaluate(async (id) => {
    const csrf = document.cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith('labspace_csrf='))?.split('=')[1] || '';
    const res = await fetch(`/api/agent/memories/${id}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'X-CSRF-Token': decodeURIComponent(csrf) },
    });
    return res.status;
  }, memId);
  must(del === 200, '记忆删除 API', `status=${del}`);
}
await page.keyboard.press('Escape');

/* ---------------- 科研工具 ---------------- */
await page.goto('http://192.0.2.10/tools', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await closeModals();
must(await page.getByText('科研工具').count() >= 1, '科研工具页加载');
must(await page.locator('iframe[title*="draw.io"], iframe[src*="drawio"]').count() >= 1, 'draw.io 以 iframe 渲染');

await page.goto('http://192.0.2.10/plot', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
must(page.url().includes('/tools?tool=plot'), '旧 /plot 跳转科研工具', page.url());
must(await page.getByText('绘图工作台').count() >= 1, '绘图工作台已挂载');

await page.goto('http://192.0.2.10/drawio', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
must(page.url().includes('/tools?tool=drawio'), '旧 /drawio 跳转科研工具', page.url());

await page.goto('http://192.0.2.10/genomes', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
must(page.url().includes('/tools?tool=genomes'), '旧 /genomes 跳转科研工具', page.url());

/* ---------------- 生信实训平台 ---------------- */
await page.goto('http://192.0.2.10/bioinfo', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
must(await page.locator('iframe').count() >= 1, '生信平台为 iframe 嵌入');
must(await page.getByRole('button', { name: /全屏/ }).count() >= 1, '提供全屏按钮');
must((await page.getByText('工作台数据加载失败').count()) === 0, '不再出现工作台数据加载失败');
must((await page.getByText('终端工作区').count()) === 0, '移除终端工作区导航');

/* ---------------- 实验记录 & 旧入口 ---------------- */
await page.goto('http://192.0.2.10/lab?tab=bookings', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);
must(page.url().includes('/agent?mode=lab'), '实验记录并入个人助手', page.url());
must(await page.getByText('实验记录').count() >= 1, '个人助手内实验记录可见');

for (const [route, label] of [['/nav', 'nav'], ['/services', 'services'], ['/favorites', 'favorites']]) {
  await page.goto(`http://192.0.2.10${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  must(page.url().includes('/start'), `旧入口 /${label} 已下线`, page.url());
}

await page.goto('http://192.0.2.10/help', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
must(await page.getByRole('heading').count() >= 1, '帮助页可加载');

await page.screenshot({ path: '/opt/labspace/e2e/_agent_tools_final.png', fullPage: false });
await b.close();
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);