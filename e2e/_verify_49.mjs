// #49 验证：文献检索结果、Docparse 解析结果一键保存到知识库。
// 凭据仅从本机文件读取，不打印；生成的文档在 finally 中按标题/ID 清理。
import fs from 'node:fs';
import { chromium } from '/opt/labspace/e2e/node_modules/playwright/index.mjs';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const STEM = `e49${Date.now().toString(36)}`;
const DOC_PATH = `/tmp/${STEM}.txt`;

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

fs.writeFileSync(
  DOC_PATH,
  `# ${STEM} 文档解析验证\n\n这是用于验证 Docparse 一键入库的文本样本。\n\n- 关键词：${STEM}\n- 目的：保存到知识库后可检索\n`,
);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

const apiCall = (method, url, body) =>
  page.evaluate(
    async ({ method, url, body }) => {
      const cookie = document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='));
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

const created = [];
const cleanup = async () => {
  try {
    for (const id of created.splice(0)) {
      await apiCall('DELETE', `/api/knowledge/${id}`);
    }
    const docs = await apiCall('GET', `/api/knowledge?q=${encodeURIComponent(STEM)}`);
    for (const d of docs.json?.items ?? []) {
      if (String(d.title).includes(STEM)) await apiCall('DELETE', `/api/knowledge/${d.id}`);
    }
  } catch (err) {
    console.log(`[WARN] 清理失败（可手动处理）：${err?.message || err}`);
  }
};

const saveModal = async () => {
  // 模态框底部按钮文案为「保存」，antd 会在两字中文间插空格（保 存）。
  await page.locator('.ant-modal-footer').getByRole('button', { name: /保\s*存/ }).click();
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
  await page.waitForTimeout(2200);
  const helpBtn = page.getByRole('button', { name: /开始使用|知道了/ }).first();
  if (await helpBtn.count()) {
    await helpBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
  }

  // ---------- 文献结果一键入库 ----------
  await page.goto(`${BASE}/literature`, { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('关键词，例如：fastp RNA-seq quality control').fill('crispr');
  await page.getByPlaceholder('关键词，例如：fastp RNA-seq quality control').press('Enter');
  await page.waitForSelector('text=结果（', { timeout: 40000 }).catch(() => {});
  const litButtons = page.getByRole('button', { name: '存入知识库' });
  const litCount = await litButtons.count();
  ok('文献检索返回可入库结果', litCount > 0, `count=${litCount}`);

  if (litCount > 0) {
    await litButtons.first().click();
    await page.waitForSelector('.ant-modal-title:has-text("保存到知识库")', { timeout: 8000 });
    const defaultTitle = await page.locator('.ant-modal input').first().inputValue();
    ok('文献入库弹窗带默认标题', defaultTitle.trim().length > 0, defaultTitle.slice(0, 80));
    await saveModal();
    const litMsg = await page
      .locator('.ant-message-notice-title')
      .filter({ hasText: /已保存到知识库|保存失败/ })
      .first()
      .textContent({ timeout: 20000 })
      .catch(() => '');
    ok('文献保存成功提示', (litMsg ?? '').includes('已保存到知识库'), (litMsg ?? '').trim());
    const found = await apiCall('GET', `/api/knowledge?q=${encodeURIComponent(defaultTitle.slice(0, 40))}`);
    const doc = (found.json?.items ?? []).find((d) => d.title === defaultTitle);
    ok('知识库可检索到文献条目', Boolean(doc), `total=${found.json?.total ?? '?'}`);
    if (doc) {
      created.push(doc.id);
      const full = await apiCall('GET', `/api/knowledge/${doc.id}`);
      ok('文献正文含来源信息', /来源[:：]/.test(full.json?.item?.body ?? ''));
      ok('文献条目默认私有', full.json?.item?.visibility === 'private', String(full.json?.item?.visibility));
    }
  }

  // ---------- Docparse 结果一键入库 ----------
  await page.goto(`${BASE}/docparse`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ant-upload-drag input[type="file"]', { state: 'attached', timeout: 20000 });
  await page.locator('.ant-upload-drag input[type="file"]').first().setInputFiles(DOC_PATH);
  await page.getByRole('button', { name: '开始解析' }).click();
  const saveBtn = page.getByRole('button', { name: '保存到知识库' });
  await saveBtn.waitFor({ state: 'visible', timeout: 240000 });
  await page
    .waitForFunction(
      () => {
        const btns = [...document.querySelectorAll('button')];
        const b = btns.find((x) => x.textContent?.trim() === '保存到知识库');
        return b && !b.disabled;
      },
      null,
      { timeout: 240000 },
    )
    .catch(() => {});
  ok('解析完成后「保存到知识库」可用', await saveBtn.isEnabled());
  await saveBtn.click();
  await page.waitForSelector('.ant-modal-title:has-text("保存到知识库")', { timeout: 8000 });
  const docTitle = await page.locator('.ant-modal input').first().inputValue();
  ok('解析入库默认标题为文件名', docTitle === STEM, docTitle);
  await saveModal();
  // 消息 3 秒后自动消失，点击后立即等待结果。
  const parseMsg = await page
    .locator('.ant-message-notice-title')
    .filter({ hasText: /已保存到知识库|保存失败/ })
    .first()
    .textContent({ timeout: 20000 })
    .catch(() => '');
  ok('解析结果保存成功提示', (parseMsg ?? '').includes('已保存到知识库'), (parseMsg ?? '').trim());
  const found2 = await apiCall('GET', `/api/knowledge?q=${encodeURIComponent(STEM)}`);
  const doc2 = (found2.json?.items ?? []).find((d) => d.title === STEM);
  ok('知识库可检索到解析文档', Boolean(doc2), `total=${found2.json?.total ?? '?'}`);
  if (doc2) {
    created.push(doc2.id);
    const full2 = await apiCall('GET', `/api/knowledge/${doc2.id}`);
    ok('解析文档正文已保存', (full2.json?.item?.body ?? '').includes(STEM));
  }

  ok('页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' / '));
} catch (err) {
  ok('脚本异常', false, err?.message || String(err));
} finally {
  await cleanup();
  const after = await apiCall('GET', `/api/knowledge?q=${encodeURIComponent(STEM)}`).catch(() => null);
  const leftover = (after?.json?.items ?? []).filter((d) => String(d.title).includes(STEM));
  if (after) ok('测试文档已清理', leftover.length === 0, `leftover=${leftover.length}`);
  await ctx.close().catch(() => {});
  await browser.close();
  fs.rmSync(DOC_PATH, { force: true });
}

console.log(`\n#49 验证：通过 ${pass} / 失败 ${fails.length}`);
if (fails.length) console.log('失败项：\n- ' + fails.join('\n- '));
process.exit(fails.length ? 1 : 0);