// #47 文件管理多选与批量操作验证：批量下载 zip、批量删除进回收站。
// 凭据仅从本机文件读取，不打印；测试数据在 finally 中清理。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from '/opt/labspace/e2e/node_modules/playwright/index.mjs';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const STEM = `e47${Date.now().toString(36)}`;
const ZIP = `/tmp/${STEM}.zip`;

const lines = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n');
const pick = (name) => {
  const line = lines.find((l) => l.trim().startsWith(`${name} `) || l.trim().startsWith(`${name}:`));
  if (!line) throw new Error(`credential not found: ${name}`);
  const [user, pass] = line.trim().split(/[: ]+/).filter(Boolean);
  return { user, pass };
};
const ADMIN = pick('labadmin@local');

let pass = 0;
const fails = [];
const ok = (label, cond, extra = '') => {
  if (cond) pass += 1;
  else fails.push(label);
  console.log(`${cond ? '[ OK ]' : '[FAIL]'} ${label}${extra ? ' — ' + extra : ''}`);
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN',
  acceptDownloads: true,
});
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

// 页面上下文内的带 CSRF 写请求
const apiCall = (method, url, body) =>
  page.evaluate(
    async ({ method, url, body }) => {
      const cookie = document.cookie
        .split('; ')
        .find((c) => c.startsWith('labspace_csrf='));
      const csrf = cookie ? decodeURIComponent(cookie.split('=').slice(1).join('=')) : '';
      const res = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: {
          ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* non-json */
      }
      return { status: res.status, json, text };
    },
    { method, url, body },
  );

const uploadText = (dir, name, content) =>
  page.evaluate(
    async ({ dir, name, content }) => {
      const cookie = document.cookie
        .split('; ')
        .find((c) => c.startsWith('labspace_csrf='));
      const csrf = cookie ? decodeURIComponent(cookie.split('=').slice(1).join('=')) : '';
      const fd = new FormData();
      fd.append('file', new File([content], name, { type: 'text/plain' }));
      const res = await fetch(
        `/api/files/upload?source=users&dir=${encodeURIComponent(dir)}`,
        { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf }, body: fd },
      );
      return { status: res.status, text: await res.text() };
    },
    { dir, name, content },
  );

const cleanup = async () => {
  try {
    // 先删文件源里的残留（会进回收站），再清空对应回收站条目与知识库文档。
    const listing = await apiCall('GET', '/api/files?source=users');
    const home = listing.json?.home ?? '';
    const mine = (listing.json?.entries ?? []).filter(
      (e) => e.path.startsWith(`${home}/`) && /(^|\/)e47[a-z0-9]{8,}/.test(e.path),
    );
    const roots = mine.filter((e) => !mine.some((p) => p.dir && p.id !== e.id && e.path.startsWith(`${p.path}/`)));
    for (const e of roots) {
      await apiCall('DELETE', `/api/files/${encodeURIComponent(e.id)}`);
    }
    const trash = await apiCall('GET', '/api/files/trash');
    for (const it of trash.json?.items ?? []) {
      if (/e47[a-z0-9]{8,}/.test(String(it.name))) {
        await apiCall('DELETE', `/api/files/trash/${encodeURIComponent(it.id)}`);
      }
    }
    const docs = await apiCall('GET', `/api/knowledge?q=e47`);
    for (const d of docs.json?.items ?? []) {
      if (/e47[a-z0-9]{8,}/.test(String(d.title))) {
        await apiCall('DELETE', `/api/knowledge/${d.id}`);
      }
    }
  } catch (err) {
    console.log(`[WARN] 清理失败（可手动处理）：${err?.message || err}`);
  }
};

try {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(ADMIN.user.split('@')[0]);
  await page.locator('input[type="password"]').first().fill(ADMIN.pass);
  await Promise.all([
    page.waitForNavigation({ timeout: 30000 }).catch(() => {}),
    page.getByRole('button', { name: /登录|Login/i }).first().click(),
  ]);
  await page.waitForLoadState('networkidle').catch(() => {});
  ok('管理员登录', !page.url().includes('/login'), page.url());
  // 首次激活 / 版本更新弹窗会延迟出现并拦截点击，先关掉。
  await page.waitForTimeout(2200);
  const helpBtn = page.getByRole('button', { name: /开始使用|知道了/ }).first();
  if (await helpBtn.count()) {
    await helpBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  ok('引导弹窗已关闭', (await page.locator('.ant-modal-wrap:visible').count()) === 0);
  await cleanup();

  // 准备：文件 + 文件夹 + 文件夹内文件，共 3 个条目，其中 1 个是待删除文件夹的子项。
  const homeRes = await apiCall('GET', '/api/files?source=users');
  const home = homeRes.json?.home ?? '';
  ok('个人空间根目录可用', Boolean(home), home);
  const mk = await apiCall('POST', '/api/files/mkdir', { source: 'users', path: `${home}/${STEM}-dir` });
  ok('创建测试文件夹', mk.status === 200, String(mk.status));
  const up1 = await uploadText(home, `${STEM}.txt`, 'batch download probe\n');
  ok('上传测试文件', up1.status === 200, String(up1.status));
  const up2 = await uploadText(`${home}/${STEM}-dir`, 'inner.txt', 'nested batch probe\n');
  ok('上传文件夹内文件', up2.status === 200, String(up2.status));

  await page.goto(`${BASE}/files?source=users`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ant-table', { timeout: 20000 });
  await page.getByPlaceholder('在文件源中搜索名称或路径').fill(STEM);
  await page
    .waitForFunction(
      (n) => document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length === n,
      3,
      { timeout: 15000 },
    )
    .catch(() => {});
  const rowCount = await page.locator('.ant-table-tbody tr.ant-table-row').count();
  ok('搜索命中文件、文件夹及其子项', rowCount === 3, `rows=${rowCount}`);

  await page.locator('.ant-table-thead .ant-checkbox-input').first().click({ force: true });
  await page.waitForSelector('.ant-typography:has-text("已选 3 项")', { timeout: 8000 });
  const barText = await page.locator('div:has(> .ant-space)').first().textContent().catch(() => '');
  ok('全选后出现批量操作栏', (await page.getByText('已选 3 项').count()) > 0, barText ?? '');
  await page.screenshot({ path: '/opt/labspace/e2e/shots/files-47-batch-bar.png' });

  // 批量下载：捕获下载并按 zip 目录核对内容
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.getByRole('button', { name: '批量下载' }).click(),
  ]);
  await download.saveAs(ZIP);
  const listing = execFileSync('unzip', ['-Z1', ZIP], { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  ok('批量下载返回 zip', fs.existsSync(ZIP) && fs.statSync(ZIP).size > 0);
  ok('压缩包包含顶层文件', listing.includes(`${STEM}.txt`), listing.join(' | '));
  ok('压缩包包含文件夹内文件', listing.includes(`${STEM}-dir/inner.txt`), listing.join(' | '));

  // 入库知识库：全部 3 项里 2 个是文件，应有一次抽取结果反馈
  const knowledgeCalls = [];
  page.on('request', (req) => {
    if (req.url().includes('/knowledge')) knowledgeCalls.push(`REQ ${req.method()} ${req.url()}`);
  });
  page.on('response', (res) => {
    if (res.url().includes('/knowledge')) knowledgeCalls.push(`RES ${res.status()} ${res.url()}`);
  });
  const ingestBtn = page.getByRole('button', { name: '入库知识库' });
  ok('入库按钮可用（选中了文件）', await ingestBtn.isEnabled());
  await ingestBtn.click();
  // antd 消息默认 3 秒自动消失，必须点击后立即等待结果，不能先做其它轮询。
  const ingestMsg = await page
    .locator('.ant-message-notice-title')
    .filter({ hasText: /已入库|没有文件入库|入库失败/ })
    .first()
    .textContent({ timeout: 120000 })
    .catch(() => '');
  const ingestOk = /已入库|没有文件入库/.test(ingestMsg ?? '');
  ok('批量入库有明确结果反馈', ingestOk, (ingestMsg ?? '').trim());
  console.log('[DIAG] 知识库请求：', knowledgeCalls.join(' || ') || '（无）');
  // 关闭可能由抽取流程打开的模态框，避免遮挡后续操作
  if ((await page.locator('.ant-modal-wrap:visible').count()) > 0) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }

  // 批量删除：文件夹递归删除，子项不再单独提交
  await page.getByRole('button', { name: '批量删除' }).click();
  await page.waitForSelector('.ant-modal-confirm-title', { timeout: 8000 });
  const title = (await page.locator('.ant-modal-confirm-title').textContent()) ?? '';
  const content = (await page.locator('.ant-modal-confirm-content').textContent()) ?? '';
  ok('确认框统计为 2 项（子项随文件夹删除）', title.includes('删除选中的 2 项'), title.trim());
  ok('确认框提示子项不单独删除', content.includes('另有 1 项未单独删除'), content.trim());
  await page.getByRole('button', { name: '移入回收站' }).click();
  const doneMsg = await page
    .locator('.ant-message-notice-title')
    .filter({ hasText: /回收站/ })
    .first()
    .textContent({ timeout: 20000 })
    .catch(() => '');
  ok('批量删除成功提示', (doneMsg ?? '').includes('已将 2 项移入回收站'), (doneMsg ?? '').trim());

  await page
    .waitForFunction(
      () => document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length === 0,
      null,
      { timeout: 15000 },
    )
    .catch(() => {});
  ok('删除后列表不再显示测试条目', (await page.locator('.ant-table-tbody tr.ant-table-row').count()) === 0);

  const trash = await apiCall('GET', '/api/files/trash');
  const names = (trash.json?.items ?? []).map((i) => i.name);
  ok('回收站收到测试条目', names.some((n) => String(n).includes(STEM)), names.join(' | '));

  await cleanup();
  const after = await apiCall('GET', '/api/files/trash');
  const leftover = (after.json?.items ?? []).filter((i) => String(i.name).includes(STEM));
  ok('测试数据已清理', leftover.length === 0, `leftover=${leftover.length}`);

  await page.screenshot({ path: '/opt/labspace/e2e/shots/files-47-after.png' });
  ok('页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' / '));
} catch (err) {
  ok('脚本异常', false, err?.message || String(err));
  await cleanup();
} finally {
  await ctx.close().catch(() => {});
  await browser.close();
  fs.rmSync(ZIP, { force: true });
}

console.log(`\n#47 验证：通过 ${pass} / 失败 ${fails.length}`);
if (fails.length) console.log('失败项：\n- ' + fails.join('\n- '));
process.exit(fails.length ? 1 : 0);