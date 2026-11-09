// 个人工作台分栏 + 日历/甘特视图 UI 验证。脚本不打印任何凭据。
import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
let pass = 0;
const fails = [];
const ok = (name, cond, info = '') => {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}${info ? ' :: ' + info : ''}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name}${info ? ' :: ' + String(info).slice(0, 240) : ''}`);
  }
};

const creds = fs
  .readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('labadmin@local'));
const password = creds.trim().split(/\s+/)[1];

const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1680, height: 1000 } });
const page = await ctx.newPage();
const createdIds = [];

const apiCall = async (path, init) =>
  page.evaluate(
    async ({ path, init }) => {
      const csrf = document.cookie
        .split('; ')
        .find((c) => c.startsWith('labspace_csrf='))
        ?.split('=')[1];
      const res = await fetch(path, {
        credentials: 'include',
        ...init,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf || ''), ...(init?.headers || {}) },
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { path, init },
  );

try {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill('labadmin');
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(2500);

  // 造两条带截止日期的任务（逾期 + 未来），用于日历/甘特断言
  const dates = await page.evaluate(() => {
    const fmt = (d) => {
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };
    const past = new Date();
    past.setDate(past.getDate() - 2);
    const future = new Date();
    future.setDate(future.getDate() + 5);
    return { past: fmt(past), future: fmt(future) };
  });
  for (const [title, due] of [
    ['UI 验证任务·逾期', dates.past],
    ['UI 验证任务·未来', dates.future],
  ]) {
    const r = await apiCall('/api/workbench/items', {
      method: 'POST',
      body: JSON.stringify({ kind: 'task', title, due_date: due, priority: 'normal' }),
    });
    const id = r.body?.item?.id;
    if (id) createdIds.push(id);
    ok(`创建测试任务：${title}`, r.status === 200 && Boolean(id), `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  }

  await page.goto(`${BASE}/workbench`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);

  // 双栏排版：任务视图在左，AI 指挥中心在右
  const layout = await page.evaluate(() => {
    const panels = Array.from(document.querySelectorAll('.ant-card'));
    const find = (text) => panels.find((p) => p.textContent?.includes(text));
    const left = find('任务视图');
    const right = find('AI 指挥中心');
    const lr = left?.getBoundingClientRect();
    const rr = right?.getBoundingClientRect();
    return lr && rr
      ? { lx: lr.x, ly: lr.y, lw: lr.width, rx: rr.x, ry: rr.y, rw: rr.width }
      : null;
  });
  ok('桌面端呈左右双栏', Boolean(layout) && layout.rx > layout.lx + layout.lw - 20 && Math.abs(layout.ry - layout.ly) < 40, JSON.stringify(layout));

  // 日历视图
  await page.locator('.ant-segmented-item', { hasText: '日历' }).first().click();
  await page.waitForTimeout(600);
  const cal = await page.evaluate(() => {
    const grid = document.querySelector('.d509-cal-grid');
    return {
      cells: document.querySelectorAll('.d509-cal-cell').length,
      heads: document.querySelectorAll('.d509-cal-wd').length,
      chips: Array.from(document.querySelectorAll('.d509-cal-chip')).map((c) => c.textContent?.trim()),
    };
  });
  ok('日历网格渲染完整', cal.cells >= 35 && cal.heads === 7, `cells=${cal.cells} heads=${cal.heads}`);
  ok('日历出现测试任务', cal.chips.some((t) => t?.includes('UI 验证任务')), cal.chips.slice(0, 6).join(' / '));
  await page.screenshot({ path: 'shots/workbench-calendar.png' });

  // 甘特视图
  await page.locator('.ant-segmented-item', { hasText: '甘特' }).first().click();
  await page.waitForTimeout(600);
  const gantt = await page.evaluate(() => ({
    bars: document.querySelectorAll('.d509-gantt-bar').length,
    labels: Array.from(document.querySelectorAll('.d509-gantt-label')).map((n) => n.textContent?.trim()).filter(Boolean),
    todayMarker: document.querySelectorAll('.d509-gantt-now').length,
  }));
  ok('甘特条已绘制', gantt.bars >= 1, `bars=${gantt.bars}`);
  ok('甘特含测试任务标签', gantt.labels.some((t) => t?.includes('UI 验证任务')), gantt.labels.slice(0, 6).join(' / '));
  ok('甘特含今天标记线', gantt.todayMarker >= 1, `markers=${gantt.todayMarker}`);
  await page.screenshot({ path: 'shots/workbench-gantt.png' });

  // 移动端：双栏堆叠
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/workbench`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const mobile = await page.evaluate(() => {
    const panels = Array.from(document.querySelectorAll('.ant-card'));
    const find = (text) => panels.find((p) => p.textContent?.includes(text));
    const left = find('任务视图')?.getBoundingClientRect();
    const right = find('AI 指挥中心')?.getBoundingClientRect();
    return {
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      stacked: left && right ? right.y >= left.bottom - 8 : false,
    };
  });
  ok('移动端无横向溢出', mobile.scrollW <= mobile.innerW + 1, `scroll=${mobile.scrollW} viewport=${mobile.innerW}`);
  ok('移动端双栏上下堆叠', mobile.stacked, JSON.stringify(mobile));
  await page.screenshot({ path: 'shots/workbench-mobile.png' });
} finally {
  for (const id of createdIds) {
    const r = await apiCall(`/api/workbench/items/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
    if (r && r.status !== 200) console.log(`WARN 清理任务失败 ${id}: ${r.status}`);
  }
  await browser.close();
}

console.log(`\n通过 ${pass} / 失败 ${fails.length}`);
if (fails.length) console.log('失败项：' + fails.join('、'));
process.exit(fails.length ? 1 : 0);
