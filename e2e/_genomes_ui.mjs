// 公共基因组页验收：登录 → /genomes → JBrowse iframe → 序列分析 → 结果
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const usersFile = readFileSync('/etc/labspace/casdoor-users.txt', 'utf8');
const line = usersFile.split('\n').find((l) => l.startsWith((process.env.LAB_USER || 'labadmin@local') + ' '));
if (!line) throw new Error('测试账号未在 casdoor-users.txt 中找到');
const [user, pass] = line.trim().split(/\s+/);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 960 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

try {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(user);
  await page.locator('input[type="password"]').first().fill(pass);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(5000);
  const loginText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  console.log('AFTER_LOGIN_URL', page.url());
  console.log('AFTER_LOGIN_TEXT', loginText.slice(0, 180));

  await page.goto(`${BASE}/genomes`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  const browseText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  console.log('GENOMES_URL', page.url());
  console.log('GENOMES_TEXT', browseText.slice(0, 220));
  const hasTitle = browseText.includes('公共基因组');
  const hasBrowser = browseText.includes('基因组浏览');
  const hasAnalysisTab = browseText.includes('序列分析');
  const iframeCount = await page.locator('iframe[title="JBrowse 2 基因组浏览器"]').count();
  console.log('TITLE', hasTitle, 'BROWSE', hasBrowser, 'ANALYZE_TAB', hasAnalysisTab, 'IFRAME', iframeCount);
  await page.screenshot({ path: '/opt/labspace/e2e/shots/genomes-browse.png', fullPage: false });
  const frame = page.frameLocator('iframe[title="JBrowse 2 基因组浏览器"]');
  const frameHasText = await frame.locator('body').innerText({ timeout: 20000 }).then((t) => /JBrowse|hg19|search|基因/i.test(t)).catch(() => false);
  console.log('JBROWSE_FRAME_LOADED', frameHasText);

  await page.getByText('序列分析', { exact: true }).first().click();
  await page.waitForTimeout(1200);
  const analyzeClicked = await page.getByRole('button', { name: /分析序列/ }).count();
  console.log('ANALYZE_BUTTON', analyzeClicked);
  await page.getByRole('button', { name: /分析序列/ }).first().click();
  await page.waitForTimeout(9000);
  const resText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  const stats = {
    length: /长度/.test(resText),
    gc: /GC 含量/.test(resText),
    gc3: /GC3/.test(resText),
    orf: /ORF 数量/.test(resText),
    revcomp: /反向互补序列/.test(resText),
    library: /rust-bio/.test(resText),
  };
  console.log('RESULT', JSON.stringify(stats));
  const err = resText.match(/分析失败：([^ ]{0,80})/);
  if (err) console.log('ANALYZE_ERROR', err[1]);
  await page.screenshot({ path: '/opt/labspace/e2e/shots/genomes-page.png', fullPage: true });
  console.log('SHOT /opt/labspace/e2e/shots/genomes-page.png');
  console.log('CONSOLE_ERRORS', errors.length ? errors.slice(0, 5).join(' | ') : 'none');
} finally {
  await ctx.close();
  await browser.close();
}