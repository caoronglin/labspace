// 文件共享页验证：写权限、服务端排序、存储用量、时间列、递归删除。
// 全部数据由脚本自建自删，不依赖共享区里已存在的文件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const credsFor = (email) => {
  const line = fs
    .readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
    .split('\n')
    .find((l) => l.trimStart().startsWith(email));
  if (!line) throw new Error(`台账缺少 ${email}`);
  return { user: email.split('@')[0], pass: line.trim().split(/\s+/)[1] };
};

let pass = 0;
let fail = 0;
const check = (name, ok, info = '') => {
  ok ? (pass += 1, console.log(`PASS  ${name}${info ? ' :: ' + info : ''}`)) : (fail += 1, console.log(`FAIL  ${name}${info ? ' :: ' + info : ''}`));
};

// 首次引导弹窗在登录成功约 1.2s 后才挂载，早于此刻检查会漏掉它，
// 弹窗遮罩随后会挡住列表页的按钮点击，必须等它出现并关闭。
async function dismissOnboarding(page, timeoutMs = 5000) {
  const modal = page.locator('.ant-modal').filter({ hasText: /开始使用|知道了/ }).first();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await modal.isVisible().catch(() => false)) {
      await modal.getByRole('button', { name: /开始使用|知道了/ }).first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
      return true;
    }
    await page.waitForTimeout(200);
  }
  return false;
}

async function login(browser, email) {
  const { user, pass: pw } = credsFor(email);
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1680, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(user);
  await page.locator('input[type="password"]').first().fill(pw);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  // Casdoor 跳转与门户首帧渲染耗时波动，固定 5s 偶发停在授权页
  await page
    .waitForFunction(() => /工作台|全部服务|文件共享/.test(document.body.innerText), null, { timeout: 30000 })
    .catch(() => {});
  await dismissOnboarding(page);
  const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  if (!/工作台|全部服务|文件共享/.test(text)) throw new Error(`${email} 登录失败，停在 ${page.url()}`);
  return { ctx, page };
}

const ROOT = '_e2e_files';
const FILES = [
  { name: 'alpha-large.txt', bytes: 3000 },
  { name: 'mid.txt', bytes: 200 },
  { name: 'zulu-small.txt', bytes: 10 },
];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const { ctx, page } = await login(browser, 'labadmin@local');
const bad = [];
const listings = [];
page.on('response', async (res) => {
  const u = res.url();
  if (!u.includes('/api/files')) return;
  if (res.status() >= 400) bad.push(`${res.status()} ${res.request().method()} ${u.replace(BASE, '')}`);
  if (res.status() === 200 && /[?&]source=/.test(u)) {
    try {
      listings.push({ url: u, body: await res.json() });
    } catch {
      /* ignore */
    }
  }
});

const dirRows = () =>
  page.evaluate(
    async (d) => {
      const r = await fetch(`/api/files?source=public&sort=name&order=asc`, { credentials: 'include' });
      const j = await r.json();
      const prefix = `${d}/`;
      return (j.entries || [])
        .filter((e) => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes('/'))
        .map((e) => ({ name: e.name, dir: e.dir, size: e.size }));
    },
    ROOT
  );

try {
  await page.goto(`${BASE}/files?source=public`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  await dismissOnboarding(page, 2000);

  // 建目录 → 建子目录 → 上传三个不同大小的文件
  await page.getByRole('button', { name: '新建文件夹' }).click();
  await page.getByPlaceholder('文件夹名称').fill(ROOT);
  await page.getByRole('button', { name: /创\s*建/ }).click();
  await page.waitForTimeout(2200);
  check('管理员建目录成功', !bad.length && (await page.getByText(ROOT).first().isVisible()), bad.slice(0, 2).join(' | '));

  await page.locator(`tr:has-text("${ROOT}")`).getByRole('button', { name: '打开' }).click();
  await page.waitForTimeout(1800);
  await page.getByRole('button', { name: '新建文件夹' }).click();
  await page.getByPlaceholder('文件夹名称').fill('nested');
  await page.getByRole('button', { name: /创\s*建/ }).click();
  await page.waitForTimeout(2000);

  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-files-'));
  for (const f of FILES) fs.writeFileSync(path.join(tmpdir, f.name), 'x'.repeat(f.bytes));
  await page.locator('input[type="file"]').setInputFiles(FILES.map((f) => path.join(tmpdir, f.name)));
  await page.waitForTimeout(4000);
  const rows = await dirRows();
  check('三个文件上传成功', FILES.every((f) => rows.some((r) => r.name === f.name && !r.dir)), JSON.stringify(rows));
  check('子目录也在同一层', rows.some((r) => r.name === 'nested' && r.dir));

  // 列表视图按文件类型渲染对应图标（本次图标改动点）
  const iconClass = async (name) =>
    page.evaluate((target) => {
      const tr = Array.from(document.querySelectorAll('.ant-table-tbody tr')).find((r) => r.innerText.includes(target));
      const icon = tr?.querySelector('.anticon');
      return icon ? String(icon.className.baseVal || icon.className) : '';
    }, name);
  const txtIcon = await iconClass('alpha-large.txt');
  check('文本文件行显示文件类型图标', /anticon-file-text/.test(txtIcon), txtIcon);
  const dirIcon = await iconClass('nested');
  check('目录行显示文件夹图标', /anticon-folder-open/.test(dirIcon), dirIcon);
  await page.screenshot({ path: 'shots/files-write-verify-list.png', fullPage: true });

  // 用量标签
  let body = await page.evaluate(() => document.body.innerText);
  const cur = body.match(/当前目录\s*(\d+)\s*个文件\s*·\s*([\d.]+\s*[KMG]?B)/);
  check('当前目录用量真实', Boolean(cur) && Number(cur[1]) === 3, cur ? cur[0] : body.slice(0, 60));
  const tot = body.match(/共\s*(\d+)\s*个文件\s*·\s*([\d.]+\s*[KMG]?B)/);
  check('整源用量包含新文件', Boolean(tot) && Number(tot[1]) >= 3, tot ? tot[0] : '');

  // 表头
  const heads = await page.evaluate(() => Array.from(document.querySelectorAll('thead th')).map((h) => h.innerText.replace(/\s/g, '')));
  check('表头不再出现「位置」列', !heads.some((h) => h.includes('位置')), heads.join('|'));

  // 服务端排序：名称升序 与 大小升序 必须给出不同顺序（数据特意设计成反向）
  listings.length = 0;
  const grab = (key) => {
    const hit = [...listings].reverse().find((l) => new URL(l.url, BASE).searchParams.get('sort') === key);
    return hit?.body;
  };
  await page.getByRole('columnheader', { name: /名称/ }).click();
  await page.waitForTimeout(1600);
  await page.getByRole('columnheader', { name: /大小/ }).click();
  await page.waitForTimeout(1600);
  const bySize = grab('size');
  const sizeSeq = (bySize?.entries || []).filter((e) => !e.dir && e.path !== `${ROOT}`).map((e) => e.size);
  check('按大小排序为升序且单调', sizeSeq.length >= 2 && sizeSeq.every((v, i) => i === 0 || sizeSeq[i - 1] <= v), sizeSeq.join(','));
  const dirsFirst = (bySize?.entries || []).findIndex((e) => !e.dir);
  const dirCount = (bySize?.entries || []).filter((e) => e.dir).length;
  check('目录恒排在文件之前', dirsFirst < 0 || dirsFirst >= dirCount, `首个文件下标=${dirsFirst} 目录数=${dirCount}`);

  await page.getByRole('columnheader', { name: /大小/ }).click();
  await page.waitForTimeout(1600);
  const bySizeDesc = grab('size');
  const descSeq = (bySizeDesc?.entries || []).filter((e) => !e.dir && e.path !== ROOT).map((e) => e.size);
  check('再次点击切换降序', bySizeDesc?.order === 'desc' && descSeq.every((v, i) => i === 0 || descSeq[i - 1] >= v), `${bySizeDesc?.order} :: ${descSeq.join(',')}`);

  await page.getByRole('columnheader', { name: /创建时间/ }).click();
  await page.waitForTimeout(1600);
  check('支持按创建时间排序', grab('created')?.sort === 'created', `sort=${grab('created')?.sort}`);

  const cellOf = (col) =>
    page.evaluate((target) => {
      const heads = Array.from(document.querySelectorAll('thead th'));
      const idx = heads.findIndex((h) => h.innerText.includes(target));
      if (idx < 0) return `__no_column:${target}`;
      const rows = Array.from(document.querySelectorAll('tbody tr')).filter((r) => r.querySelectorAll('td').length === heads.length);
      return rows.length ? rows[rows.length - 1].querySelectorAll('td')[idx].innerText : '__norow__';
    }, col);
  const cellOk = (s) => /\d{4}[/-]\d{1,2}[/-]\d{1,2}/.test(s);
  const created = await cellOf('创建时间');
  const modified = await cellOf('修改时间');
  check('创建时间列渲染真实日期', cellOk(created), created.slice(0, 32));
  check('修改时间列渲染真实日期', cellOk(modified), modified.slice(0, 32));

  // 搜索态用名称下方的目录行区分（不再依赖「位置」列）
  await page.goto(`${BASE}/files?source=public&q=alpha`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  await dismissOnboarding(page, 2000);
  const searchBody = await page.evaluate(() => document.querySelector('.ant-table-tbody')?.innerText.replace(/\s+/g, ' ') || '');
  check('搜索结果标注所在目录', /alpha-large\.txt/.test(searchBody) && searchBody.includes(ROOT), searchBody.slice(0, 90));

  // 递归删除确认必须给出真实影响范围
  await page.goto(`${BASE}/files?source=public`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  await dismissOnboarding(page, 2000);
  await page.locator(`tr:has-text("${ROOT}")`).locator('button[aria-label="更多操作"]').click();
  await page.getByText('删除', { exact: true }).last().click();
  await page.waitForTimeout(800);
  const confirmText = await page.locator('.ant-modal-confirm').innerText();
  // 确认框措辞随回收站特性调整：语义仍是「整体（递归）移入回收站」并给出真实范围
  check(
    '删除确认统计递归范围',
    /整体移入回收站|递归删除/.test(confirmText) && /3 个文件/.test(confirmText) && /1 个子目录/.test(confirmText),
    confirmText.replace(/\s+/g, ' ').slice(0, 130)
  );
  await page.locator('.ant-modal-confirm').getByRole('button', { name: /移入回收站|删\s*除/ }).click();
  await page.waitForTimeout(3500);
  const after = await page.evaluate(
    async (name) => {
      const r = await fetch('/api/files?source=public&sort=name&order=asc', { credentials: 'include' });
      const j = await r.json();
      return (j.entries || []).filter((e) => e.path === name || e.path.startsWith(`${name}/`)).length;
    },
    ROOT
  );
  check('递归删除后磁盘上无残留', after === 0, `剩余 ${after} 项`);
  check('全程无 4xx/5xx', bad.length === 0, bad.slice(0, 4).join(' | '));
  fs.rmSync(tmpdir, { recursive: true, force: true });
} catch (e) {
  console.log(`ERROR 脚本异常：${String(e.message).split('\n')[0]}`);
  await page.screenshot({ path: 'shots/files-write-verify-error.png', fullPage: true }).catch(() => {});
  throw e;
} finally {
  // 无论断言结果如何都不留测试数据
  await page
    .evaluate(async (name) => {
      const csrf = document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=')[1] || '';
      const r = await fetch(`/api/files?source=public&sort=name&order=asc`, { credentials: 'include' });
      const j = await r.json();
      const hit = (j.entries || []).find((e) => e.path === name);
      if (!hit) return 'already-gone';
      const d = await fetch(`/api/files/${hit.id}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf }, credentials: 'include' });
      return `${d.status}`;
    }, ROOT)
    .catch(() => 'cleanup-skipped');
  await ctx.close();

  // 学生账号不存在时登录会失败；如实记为失败用例，不让异常打断汇总输出
  let stu = null;
  try {
    stu = await login(browser, 'student01@local');
  } catch (e) {
    check('学生账号可登录（student01@local）', false, String(e.message).split('\n')[0]);
  }
  if (!stu) {
    console.log('SKIP 学生只读源检查（student01@local 无法登录）');
  } else {
    const stuBad = [];
    stu.page.on('response', (res) => {
      if (res.url().includes('/api/files') && res.status() >= 400) stuBad.push(`${res.status()} ${res.url().replace(BASE, '')}`);
    });
    await stu.page.goto(`${BASE}/files?source=public`, { waitUntil: 'domcontentloaded' });
    await stu.page.waitForTimeout(2200);
    await dismissOnboarding(stu.page, 2000);
    const stuBody = await stu.page.evaluate(() => document.body.innerText);
    check('学生只读源不显示写按钮', (await stu.page.getByRole('button', { name: '新建文件夹' }).count()) === 0);
    check('学生只读源显示只读标识', /只读/.test(stuBody));
    check('学生浏览无 4xx', stuBad.length === 0, stuBad.slice(0, 3).join(' | '));
    await stu.ctx.close();
  }
}

await browser.close();
console.log(`\n合计：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
