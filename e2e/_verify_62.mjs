import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const line = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n').find((l) => l.startsWith('labadmin@local'));
const [user, pass] = line.trim().split(/[: ]+/).filter(Boolean);

const NAME = `E2E任务联动-${Date.now().toString(36)}`;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const failures = [];
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
const ok = (cond, msg) => { if (!cond) failures.push(msg); };

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(5000);
await page.locator('.ant-modal-close').first().click({ timeout: 2000 }).catch(() => {});

await page.goto(`${BASE}/workbench`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await page.getByRole('tab', { name: /项目/ }).click();
await page.waitForTimeout(500);

// 新建项目 + 两条任务
await page.getByRole('button', { name: /新建项目/ }).click();
await page.locator('input[placeholder*="bZIP"]').first().fill(NAME);
await page.getByRole('button', { name: '添加任务' }).click();
await page.getByRole('button', { name: '添加任务' }).click();
const titleInputs = page.locator('input[placeholder*="下载 NR"]');
await titleInputs.nth(0).fill('E2E 子任务A');
await titleInputs.nth(1).fill('E2E 子任务B');
await page.locator('.ant-modal-footer button.ant-btn-primary').last().click();
await page.waitForTimeout(2500);

// 卡片显示任务进度与任务行
const card = page.locator('.ant-row > .ant-col').filter({ hasText: NAME }).first();
ok((await card.count()) > 0, `project card missing: ${NAME}`);
ok((await card.innerText()).includes('任务 0/2'), `card did not show 任务 0/2: ${await card.innerText().catch(() => '')}`);
ok((await card.innerText()).includes('E2E 子任务A'), 'task A not listed in project card');
ok((await card.innerText()).includes('E2E 子任务B'), 'task B not listed in project card');

// 勾选完成 -> 进度 1/2
await card.locator('.ant-checkbox-input').first().click();
await page.waitForTimeout(1500);
ok((await card.innerText()).includes('任务 1/2'), `progress did not update: ${await card.innerText().catch(() => '')}`);

// 追加任务 -> 1/3
await card.getByRole('button', { name: /安排任务/ }).click();
await page.getByRole('button', { name: '添加任务' }).click();
await page.locator('input[placeholder*="下载 NR"]').first().fill('E2E 子任务C');
await page.locator('.ant-modal-footer button.ant-btn-primary').last().click();
await page.waitForTimeout(2000);
ok((await card.innerText()).includes('任务 1/3'), `added task not counted: ${await card.innerText().catch(() => '')}`);

await page.screenshot({ path: '/opt/labspace/e2e/shots/project-tasks.png' });

// 清理：删除该项目下的任务与项目本身（脚本不打印凭据）
const cleanup = await page.evaluate(async (name) => {
  const csrf = document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=')[1] ?? '';
  const headers = { 'x-csrf-token': decodeURIComponent(csrf) };
  const projects = await (await fetch('/api/workbench/projects', { headers })).json();
  const project = (projects.projects || []).find((p) => p.name === name);
  if (!project) return { removed: 0, project: false };
  const items = await (await fetch(`/api/workbench/items?project_id=${encodeURIComponent(project.id)}&limit=100`, { headers })).json();
  for (const it of items.items || []) {
    await fetch(`/api/workbench/items/${encodeURIComponent(it.id)}`, { method: 'DELETE', headers });
  }
  const res = await fetch(`/api/workbench/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE', headers });
  return { removed: (items.items || []).length, project: res.ok };
}, NAME);
ok(cleanup.removed === 3, `cleanup removed ${cleanup.removed} tasks, expected 3`);
ok(cleanup.project, 'cleanup failed to delete project');

await browser.close();
ok(errors.length === 0, `console errors: ${errors.slice(0, 3).join(' | ')}`);
if (failures.length) {
  console.log('FAIL 62:', failures.join(' | '));
  process.exit(1);
}
console.log('PASS 62: project created with tasks, progress toggles, add-task works, cleanup done');