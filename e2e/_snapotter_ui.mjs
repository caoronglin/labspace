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
await page.waitForTimeout(1200);

await page.goto('http://192.0.2.10/snapotter', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const start = page.getByRole('button', { name: '开始使用' });
if (await start.count()) {
  await start.first().click();
  await page.waitForTimeout(500);
}
await page.waitForSelector('.so-tool-item', { timeout: 30000 });

const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
must(body.includes('文件工坊'), '页面标题为「文件工坊」');
must(body.includes('服务在线'), '显示服务在线状态');
must(body.includes('图片处理') && body.includes('PDF 处理') && body.includes('音频处理'), '分区总览卡片渲染');
must(body.includes('去除背景') && body.includes('压缩图片'), '工具目录显示中文名称');
must(!body.includes('Remove Background'), '不再展示英文工具名');

const toolCount = await page.locator('.so-tool-item').count();
must(toolCount > 20, '目录渲染工具条目', `count=${toolCount}`);

// 分区筛选
await page.locator('.so-section-card', { hasText: '图片处理' }).first().click();
await page.waitForTimeout(700);
const bodyImg = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
must(bodyImg.includes('图片处理 ·'), '分区筛选后目录按图片分组');
must(!bodyImg.includes('PDF 处理 ·'), '分区筛选后隐藏其他分区');

// 搜索
await page.locator('input[placeholder*="搜索工具"]').fill('抠出');
await page.waitForTimeout(600);
const hits = await page.locator('.so-tool-item').count();
must(hits >= 1, '中文关键词搜索有结果', `count=${hits}`);
must((await page.locator('body').innerText()).includes('去除背景'), '搜索「抠出」命中「去除背景」');

// 选择工具 + 参数提示
await page.goto('http://192.0.2.10/snapotter?section=image&tool=resize', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2200);
let panel = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
must(panel.includes('开始处理'), '选中工具后出现处理面板');
must(panel.includes('可用参数') && panel.includes('percentage'), '高级设置自动展开并展示参数提示');

// 真实执行：压缩图片无需额外参数
await page.goto('http://192.0.2.10/snapotter?section=image&tool=compress', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2200);
panel = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
must(panel.includes('压缩图片') && panel.includes('开始处理'), '切换到「压缩图片」');

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
await page.locator('input[type="file"]').first().setInputFiles({
  name: 'pixel.png',
  mimeType: 'image/png',
  buffer: png,
});
await page.waitForTimeout(400);
await page.getByRole('button', { name: '开始处理' }).first().click();
try {
  await page.getByText('处理完成', { exact: false }).first().waitFor({ timeout: 60000 });
  must(true, '上传文件并完成一次真实处理');
  const dl = page.getByRole('button', { name: '下载结果' }).first();
  must(await dl.count() > 0, '处理结果显示下载按钮');
  must((await page.locator('body').innerText()).includes('体积变化'), '处理结果展示体积变化');
} catch {
  must(false, '上传文件并完成一次真实处理', '超时未出现处理完成');
}

// 深链接
await page.goto('http://192.0.2.10/snapotter?section=pdf&tool=merge-pdf', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2200);
must((await page.locator('body').innerText()).includes('合并 PDF'), '深链接直接打开「合并 PDF」');

// 最近使用
must((await page.locator('body').innerText()).includes('最近使用'), '记录最近使用的工具');

must(errors.length === 0, '无前端脚本错误', errors.slice(0, 2).join(' | '));
await page.screenshot({ path: '/opt/labspace/e2e/shots/_snapotter_ui.png', fullPage: true });
await b.close();
console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
process.exit(failed ? 1 : 0);