import { chromium } from 'playwright';
const b = await chromium.launch({args:['--no-sandbox']});
const ctx = await b.newContext({locale:'zh-CN', viewport:{width:1440,height:900}});
const p = await ctx.newPage();
p.on('response', r=>{ const u=r.url(); if(u.includes('callback')) console.log('  ', r.status(), u.slice(0,100)); });
// 1) 打开 Quantum（未登录）→ 走 OIDC 登录
await p.goto('http://192.0.2.10:8080/files/', {waitUntil:'domcontentloaded'});
await p.waitForTimeout(2500);
const btn = p.locator('button, a').filter({ hasText: /OpenID|OIDC|Casdoor|Sign in with/i }).first();
if (await btn.count()) { await btn.click(); } else { await p.goto('http://192.0.2.10:8080/files/api/auth/oidc/login?redirect=%2Ffiles%2F'); }
await p.waitForSelector('#username', {timeout:25000});
// 2) 用统一后的口令登录 Casdoor
await p.locator('#username').fill('student01');
await p.locator('#password').fill(process.env.PW);
await p.getByRole('button', {name:'登录'}).first().click();
await p.waitForTimeout(8000);
console.log('  最终 URL:', p.url().slice(0,110));
const t = (await p.evaluate(()=>document.body.innerText)).replace(/\s+/g,' ');
console.log('  页面:', t.slice(0,150));
await p.screenshot({path:'/opt/labspace/e2e/shots/quantum-real.png'});
await b.close();
