// SSO 实测：门户登录后，Open WebUI / Quantum 是否免密进入
import { launch, loginContext } from './_auth.mjs';

const b = await launch();
const ctx = await loginContext(b);
console.log('门户登录 OK');

async function check(name, url, clickTexts) {
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });
  await p.goto(url, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  let clicked = null;
  for (const t of clickTexts) {
    const btn = p.getByRole('button', { name: new RegExp(t, 'i') }).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click().catch(() => {});
      clicked = t;
      break;
    }
    const txt = p.getByText(new RegExp(t, 'i')).first();
    if (await txt.count().catch(() => 0)) {
      await txt.click().catch(() => {});
      clicked = `text:${t}`;
      break;
    }
  }
  await p.waitForTimeout(6000);
  const finalUrl = p.url();
  const body = (await p.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  const passwordInputs = await p.locator('input[type="password"]').count();
  const ok = !passwordInputs && !/请先登录|Sign in|用户名/.test(body.slice(0, 400));
  console.log(`[${name}] ${ok ? 'OK 免密' : 'FAIL 需要口令'} | 点击=${clicked} | 落地=${finalUrl.slice(0, 110)}`);
  console.log(`        文本: ${body.slice(0, 150)}`);
  if (errs.length) console.log(`        控制台错误: ${errs.slice(0, 3).join(' / ')}`);
  await p.close();
  return ok;
}

const qm = await check('Quantum', 'http://192.0.2.10:8080/files/', ['OpenID Connect', 'OpenID', 'OIDC']);
// 备用：直接走服务端 OIDC 入口
if (!qm) {
  const qm2 = await check('Quantum(直连OIDC入口)', 'http://192.0.2.10:8080/files/api/auth/oidc/login', []);
  console.log('Quantum 直连 OIDC 入口结果 =', qm2);
}

// JBrowse / draw.io / IT-Tools / Linux 命令速查：无独立账号体系，直接可用
const jb = await check('JBrowse 2', 'http://192.0.2.10:8091/index.html?config=data/demo/config.zh.json', []);
const draw = await check('draw.io', 'http://192.0.2.10:8082/', []);
const it = await check('IT-Tools', 'http://192.0.2.10:8084/', []);
const cmd = await check('Linux 命令速查', 'http://192.0.2.10:8086/', []);

console.log(`\nSSO 汇总: Open WebUI=${owui ? '免密' : '需口令'} Quantum=${qm ? '免密' : '需口令'} `
  + `JBrowse=${jb ? '免密' : '需口令'} draw.io=${draw ? '免密' : '需口令'} `
  + `IT-Tools=${it ? '免密' : '需口令'} Linux命令=${cmd ? '免密' : '需口令'}`);
await b.close();
process.exit(owui && qm && jb && draw && it && cmd ? 0 : 1);
