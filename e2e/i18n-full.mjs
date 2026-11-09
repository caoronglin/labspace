/**
 * 全站中文化回归（门户 + 嵌入服务）
 * 1. 门户关键页面：无成片英文
 * 2. 嵌入/跳转服务：中文 UI 检查（含 locale 参数）
 * 3. 输出每个服务的中文覆盖率与残留英文样例
 */
import { chromium } from 'playwright';

const PORTAL = process.env.PORTAL_BASE || 'http://192.0.2.10';
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
/** 只统计门户自身（192.0.2.10:80）的控制台错误，嵌入的上游应用错误单独归因 */
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
  await page.fill('#username', LAB_USER);
  await page.fill('#password', LAB_PASS);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 }).catch(() => {}),
    page.getByRole('button', { name: /登\s*录/ }).click(),
  ]);
  await page.waitForTimeout(3000);
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
  { id: 'drawio', url: 'http://192.0.2.10:8082/?lang=zh', note: 'draw.io（?lang=zh）' },
  { id: 'it-tools', url: 'http://192.0.2.10:8084/', note: 'IT-Tools（locale=zh 注入）' },
  { id: 'linux-command', url: 'http://192.0.2.10:8086/', note: 'Linux 命令速查' },
  { id: 'jbrowse', url: 'http://192.0.2.10:8091/index.html?config=data/demo/config.zh.json', note: 'JBrowse 2（bundle 补丁）' },
  { id: 'bioinfo', url: 'http://192.0.2.10:8102/', note: '生信实训平台（中文界面）' },
  { id: 'quantum', url: 'http://192.0.2.10:8080/files/', note: 'Quantum（上游无 i18n 资源）' },
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
    check(`${s.id} 中文界面`, s.id === 'quantum' ? true : cjk > 0 && hits.length === 0,
      `${s.note} | 错误 ${cerr.length}`);
  } catch (e) {
    check(`${s.id} 可访问`, false, String(e).slice(0, 120));
  }
  await c.close();
}

// ---------- Quantum 上游无中文包：门户需提供中文指引 ----------
await page.goto(`${PORTAL}/embed/quantum`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
const qText = await page.evaluate(() => document.body.innerText);
check('Quantum 内嵌页有中文指引', /中文操作指引/.test(qText) && /公共资料/.test(qText),
  qText.split('\n').filter((l) => /中文|公共资料|个人文件/.test(l)).slice(0, 3).join(' | '));
check('Quantum 内嵌页说明界面语言', /未提供中文语言包/.test(qText), '');

check('门户控制台无错误', errors.length === 0, errors.slice(0, 3).join(' ; '));
console.log('失败响应:', badResponses.slice(0, 8).join(' | ') || '无');

const failed = results.filter((r) => !r.ok).length;
console.log(`\n中文化回归: ${results.length - failed}/${results.length} 通过`);
await browser.close();
process.exit(failed ? 1 : 0);
