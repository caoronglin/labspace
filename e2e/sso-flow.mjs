// SSO 实测：门户登录后，各第三方服务能否免密进入。
//
// 2026-11 重写：Open WebUI(:3000) 与 Quantum(:8080) 都已下线，IT-Tools(:8084)
// 与图纸平台(:8093) 当前也不在本机部署 —— 脚本改为「只测还在线的服务」，
// 下线的服务记 SKIP，而不是让用例挂在打不开的地址上。
import { launch, loginContext } from './_auth.mjs';

const b = await launch();
const ctx = await loginContext(b);
const BASE = process.env.BASE || 'http://127.0.0.1';
console.log('门户登录 OK');

async function check(name, url, clickTexts) {
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (e) {
    console.log(`[${name}] SKIP 服务不可达 — ${String(e.message).slice(0, 60)}`);
    await p.close();
    return null;
  }
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

/** 只测「本机确实在跑」的服务：连不上就记 SKIP，不算失败。 */
async function checkIfUp(name, url, clickTexts) {
  const r = await check(name, url, clickTexts);
  if (r === null) console.log(`  [SKIP] ${name} — 服务当前未部署`);
  return r;
}

// 有独立账号体系（本机有部署时才有意义）的服务
const owui = await checkIfUp('Open WebUI', `${BASE}:3000/`, ['OpenID Connect', 'OpenID', 'OIDC']);
const qm = await checkIfUp('Quantum', `${BASE}:8080/files/`, ['OpenID Connect', 'OpenID', 'OIDC']);

// 无独立账号体系，直接可用
const jb = await checkIfUp('JBrowse 2', `${BASE}:8091/index.html?config=data/demo/config.zh.json`, []);
const draw = await checkIfUp('draw.io', `${BASE}:8082/`, []);
const it = await checkIfUp('IT-Tools', `${BASE}:8084/`, []);
const cmd = await checkIfUp('Linux 命令速查', `${BASE}:8086/`, []);

const label = (v) => (v === null ? '未部署' : v ? '免密' : '需口令');
console.log(`\nSSO 汇总: Open WebUI=${label(owui)} Quantum=${label(qm)} `
  + `JBrowse=${label(jb)} draw.io=${label(draw)} `
  + `IT-Tools=${label(it)} Linux命令=${label(cmd)}`);

// 判失败只看「在线且需要口令」的情况；未部署不参与判定。
const online = [owui, qm, jb, draw, it, cmd].filter((v) => v !== null);
const needPassword = online.filter((v) => v === false).length;
console.log(needPassword === 0
  ? `\n结果：在线的 ${online.length} 个服务均可免密进入`
  : `\n结果：${needPassword} 个在线服务仍要求口令`);
await b.close();
process.exit(needPassword === 0 ? 0 : 1);
