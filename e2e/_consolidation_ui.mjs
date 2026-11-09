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
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://192.0.2.10/login', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#password', { timeout: 40000 });
await page.locator('#username').fill('labadmin');
await page.locator('#password').fill(CRED.labadmin);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
try {
  await page.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 });
} catch {}
await page.waitForTimeout(2000);

const text = async () => (await page.locator('body').innerText()).replace(/\s+/g, ' ');

// 站点导航
await page.goto('http://192.0.2.10/nav', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
let body = await text();
must(body.includes('站点导航'), '导航页渲染');
must(body.includes('Agent 与知识库') && body.includes('翻译中心') && body.includes('绘图与图形'), '导航页包含合并后的入口');
must(!body.includes('文本翻译') && !body.includes('访问与诊断') && !body.includes('文档解析'), '导航页无重复入口');

// 翻译中心双模式
await page.goto('http://192.0.2.10/translate', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);
body = await text();
must(body.includes('翻译中心') && body.includes('论文 PDF') && body.includes('文本段落'), '翻译中心含双模式');
await page.getByText('文本段落', { exact: true }).first().click();
await page.waitForTimeout(800);
must(page.url().includes('mode=text'), '文本翻译模式切换写入 URL', page.url());
body = await text();
must(/翻译|目标语言/.test(body), '文本翻译界面可用');
await page.goto('http://192.0.2.10/translate', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
must((await text()).includes('PDF 论文翻译'), 'PDF 翻译模式默认展示');

// 绘图与图形
await page.goto('http://192.0.2.10/drawio', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);
must((await text()).includes('图形库'), '绘图页提供图形库入口');

// Agent + 知识库
await page.goto('http://192.0.2.10/agent?mode=kb', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
body = await text();
must(body.includes('Agent 个人助手') && body.includes('知识库问答'), 'Agent 页知识库模式直达');

// 帮助中心内嵌诊断
await page.goto('http://192.0.2.10/help', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
body = await text();
must(body.includes('访问与诊断') && body.includes('入口清单'), '帮助中心含访问与诊断');

// 起始页无旧入口
await page.goto('http://192.0.2.10/start', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
body = await text();
must(!body.includes('文档解析') && !body.includes('我的图形'), '起始页已清理旧入口');
must(body.includes('知识库问答') && body.includes('翻译中心'), '起始页入口已更新');

// 生信实训门户壳
await page.goto('http://192.0.2.10/bioinfo', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
body = await text();
must(body.includes('生信实验实训平台'), '生信实训标题正确');
must(body.includes('公共基因组') && body.includes('文件共享') && body.includes('知识库'), '生信实训快捷联动齐全');
const iframeSrc = await page.locator('iframe[title="生信实验实训平台"]').getAttribute('src').catch(() => '');
must(!!iframeSrc && iframeSrc.includes(':8102'), '内嵌 iframe 指向 8102', iframeSrc || 'none');

await page.screenshot({ path: '/opt/labspace/e2e/shots/_consolidation.png', fullPage: false });
must(errors.length === 0, '无脚本异常', errors.join('; '));
await b.close();
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);