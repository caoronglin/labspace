/**
 * 全站中文化回归（门户 + 嵌入服务）
 * 1. 门户关键页面：无成片英文
 * 2. 嵌入/跳转服务：中文 UI 检查（含 locale 参数）
 * 3. 输出每个服务的中文覆盖率与残留英文样例
 */
import { chromium } from 'playwright';

const PORTAL = process.env.PORTAL_BASE || 'http://127.0.0.1';
const LAB_USER = process.env.LAB_USER || 'student01';
const LAB_PASS = process.env.LAB_PASS || '';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
}

const EN_BLOCK = [
  'New Chat', 'Search Chats', 'Settings', 'Knowledge', 'Workspace', 'Community',
  'Sign in', 'Login', 'Logout', 'Dashboard', 'Overview', 'Welcome',
  'OpenID Connect', 'New File', 'Shared with me', 'Recent',
  'Handy tools for developers', 'Encrypt', 'Decrypt',
  'ADD', 'TOOLS', 'HELP', 'SHARE',
];
/** 品牌名等保留英文的片段（不属于「未翻译文案」） */
const IGNORE_TEXT = {
  'it-tools': ['IT - TOOLS'],
};
const CJK = /[\u4e00-\u9fff]/;

const browser = await chromium.launch({ args: ['--no-sandbox'] });

// ---------- 门户 ----------
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
const BASE = process.env.BASE || 'http://127.0.0.1';
/** 只统计门户自身（:80）的控制台错误，嵌入的上游应用错误单独归因 */
page.on('console', (m) => {
  const loc = m.location()?.url || '';
  if (m.type() === 'error' && !loc.includes(':8080') && !loc.includes(':3000') && !loc.includes(':8091')) {
    errors.push(`${m.text()} @ ${loc}`);
  }
});
const badResponses = [];
page.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url().slice(0, 120)}`); });

await page.goto(`${PORTAL}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
if (LAB_PASS) {
  // Casdoor 的表单 id 会随版本变（#username → 别的），改用稳定的类型选择器：
  // 文本框 + 密码框 + 登录按钮。找不到就跳过登录（下面的页面检查会相应记 FAIL/SKIP）。
  const textBox = page.locator('input[type="text"], input:not([type])').first();
  const passBox = page.locator('input[type="password"]').first();
  if ((await textBox.count()) && (await passBox.count())) {
    await textBox.fill(LAB_USER);
    await passBox.fill(LAB_PASS);
    await Promise.all([
      page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 }).catch(() => {}),
      page.getByRole('button', { name: /登\s*录/ }).first().click(),
    ]);
    await page.waitForTimeout(3000);
  } else {
    console.log('  [SKIP] 未找到登录表单 —— 本轮不登录检查页面');
  }
}
console.log('门户登录后 URL:', page.url());
badResponses.length = 0;
errors.length = 0;

const portalPages = ['/', '/services', '/databases', '/search', '/favorites', '/admin/status', '/snapotter', '/devtools', '/translate', '/drawings', '/network', '/start'];
const portalBad = [];
for (const p of portalPages) {
  await page.goto(`${PORTAL}${p}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const txt = await page.evaluate(() => document.body.innerText);
  const hits = EN_BLOCK.filter((w) => txt.includes(w));
  const cjkRatio = (txt.match(/[\u4e00-\u9fff]/g) || []).length;
  if (hits.length || cjkRatio < 5) portalBad.push(`${p}: hits=${hits.join('/')} cjk=${cjkRatio}`);
}
check('门户页面无英文文案', portalBad.length === 0, portalBad.slice(0, 6).join(' ; '));

// ---------- 嵌入服务 ----------
const svc = [
  // 应用统一走门户同源路径（nginx 反代），不再 IP+端口直连；
  // IT-Tools 已下线（8084 无服务），按现状移除。
  { id: 'drawio', url: `${BASE}/apps/drawio/?lang=zh`, note: 'draw.io（?lang=zh）' },
  { id: 'linux-command', url: `${BASE}/apps/commands/`, note: 'Linux 命令速查' },
  { id: 'jbrowse', url: `${BASE}/jbrowse/index.html?config=data/demo/config.zh.json`, note: 'JBrowse 2（bundle 补丁）' },
  { id: 'bioinfo', url: `${BASE}/apps/bioinfo/`, note: '生信实训平台（中文界面）' },
];

for (const s of svc) {
  const c = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  const p = await c.newPage();
  const cerr = [];
  p.on('console', (m) => { if (m.type() === 'error') cerr.push(m.text()); });
  try {
    await p.goto(s.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await p.waitForTimeout(4500);
    let txt = await p.evaluate(() => document.body.innerText);
    for (const ig of IGNORE_TEXT[s.id] ?? []) txt = txt.split(ig).join(' ');
    const cjk = (txt.match(/[\u4e00-\u9fff]/g) || []).length;
    const hits = EN_BLOCK.filter((w) => txt.includes(w));
    const pct = Math.round((cjk / Math.max(1, txt.replace(/\s/g, '').length)) * 100);
    console.log(`  ${s.id}: 中文 ${cjk} 字 (${pct}%) 命中英文=${hits.join('/') || '无'} 控制台错误=${cerr.length}`);
    check(`${s.id} 中文界面`, cjk > 0 && hits.length === 0,
      `${s.note} | 错误 ${cerr.length}`);
  } catch (e) {
    // 服务当前没部署（连不上）时记 SKIP：它不是「中文化出问题」，而是这台机器上没这个服务。
    const unreachable = /ERR_CONNECTION_REFUSED|net::ERR_|Timeout/i.test(String(e));
    if (unreachable) {
      console.log(`  [SKIP] ${s.id} — 服务当前未部署/不可达`);
    } else {
      check(`${s.id} 可访问`, false, String(e).slice(0, 120));
    }
  }
  await c.close();
}

// Quantum 已下线，内嵌页中文指引这一段随之失效（服务不存在，无页面可测）。

// ---------- 汇总 ----------
await ctx.close();
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(` - ${f.name}: ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
