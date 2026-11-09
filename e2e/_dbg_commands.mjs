import { chromium } from 'playwright';
const BASE = 'http://192.0.2.10';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('console', m => { if (m.type()==='error') errs.push('CONSOLE: '+m.text().slice(0,200)); });
page.on('pageerror', e => errs.push('PAGEERROR: '+e.message.slice(0,300)));
await page.goto(BASE+'/login', { waitUntil:'domcontentloaded', timeout:30000 });
await page.waitForSelector('#username', { timeout: 20000 });
await page.fill('#username','labadmin@local'); await page.fill('#password', process.env.LAB_ADMIN_PASS);
await page.click('button[type=submit]'); await page.waitForTimeout(3000);
await page.goto(BASE+'/commands', { waitUntil:'networkidle', timeout:30000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: 'shots/_dbg_commands.png', fullPage: false });
const info = await page.evaluate(() => {
  const root = document.querySelector('#root') || document.body;
  const cs = getComputedStyle(root);
  const antd = document.querySelector('.ant-app') || document.querySelector('[class*=ant-]');
  const body = document.body;
  return {
    title: document.title,
    htmlClass: document.documentElement.className,
    bodyClass: body.className,
    bodyBg: getComputedStyle(body).backgroundColor,
    bodyColor: getComputedStyle(body).color,
    rootChildren: root.children.length,
    firstChildClass: root.firstElementChild?.className,
    firstChildTag: root.firstElementChild?.tagName,
    antdFound: !!antd,
    antdClass: antd?.className,
    antdBg: antd ? getComputedStyle(antd).backgroundColor : null,
    hasAntCssVars: !!document.getElementById('antd') || document.querySelector('style[data-css-hash]') !== null,
    styleTags: document.querySelectorAll('style').length,
    linkTags: Array.from(document.querySelectorAll('link[rel=stylesheet]')).map(l=>l.href.split('/').pop()).slice(0,8),
    textHead: document.body.innerText.slice(0, 300),
  };
});
console.log(JSON.stringify(info, null, 2));
console.log('--- 错误 ---'); errs.slice(0,15).forEach(e=>console.log(e));
await b.close();
