import { chromium } from 'playwright';
const b = await chromium.launch({args:['--no-sandbox']});
const ctx = await b.newContext({locale:'zh-CN'});
const p = await ctx.newPage();
p.on('response', r=>{ const u=r.url(); if(u.includes('authorize')||u.includes('callback')||u.includes('get-app-login')) console.log('  ', r.status(), u.replace('http://','').slice(0,105)); });
// 直接从 IP 入口进入 Quantum
await p.goto('http://192.0.2.10:8080/files/', {waitUntil:'domcontentloaded'});
await p.waitForTimeout(2500);
console.log('  登录页:', (await p.evaluate(()=>document.body.innerText)).replace(/\s+/g,' ').slice(0,90));
// 点击 OIDC 入口（页面上的 Casdoor 按钮）
const oidcBtn = p.locator('button, a').filter({ hasText: /OpenID|OIDC|Casdoor|Sign in with/i }).first();
if (await oidcBtn.count()) { await oidcBtn.click(); } else { await p.goto('http://192.0.2.10:8080/files/api/auth/oidc/login?redirect=%2Ffiles%2F'); }
await p.waitForTimeout(5000);
console.log('  当前 URL:', p.url().slice(0,140));
const hasForm = await p.locator('#username, input[type=text]').count();
console.log('  登录表单:', hasForm > 0);
if (hasForm) {
  await p.locator('#username, input[type=text]').first().fill('student01');
  await p.locator('input[type=password]').first().fill(process.env.LAB_PASS);
  await p.locator('button[type=submit], input[type=submit]').first().click();
  await p.waitForTimeout(7000);
  console.log('  登录后 URL:', p.url().slice(0,120));
  console.log('  页面:', (await p.evaluate(()=>document.body.innerText)).replace(/\s+/g,' ').slice(0,130));
  await p.screenshot({path:'/opt/labspace/e2e/shots/quantum-oidc-ip.png'});
}
await b.close();
