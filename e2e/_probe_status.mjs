import { chromium } from 'playwright';
import fs from 'node:fs';
const CRED = {};
for (const line of fs.readFileSync('/etc/labspace/casdoor-users.txt','utf8').split('\n')) { const t=line.trim(); if(!t||t.startsWith('#'))continue; const [e,p]=t.split(/\s+/); if(e&&p)CRED[e.split('@')[0]]=p; }
const b = await chromium.launch({args:['--no-sandbox']});
const page = await (await b.newContext()).newPage();
await page.goto('http://192.0.2.10/login',{waitUntil:'domcontentloaded'});
await page.waitForSelector('#password',{timeout:40000});
await page.locator('#username').fill('labadmin');
await page.locator('#password').fill(CRED.labadmin);
await page.getByRole('button',{name:/登录|Login/}).first().click();
await page.waitForTimeout(3000);
const r = await page.evaluate(async () => { const res = await fetch('/api/agent/status',{credentials:'include'}); return {s:res.status, j:await res.json()}; });
console.log(r.s, JSON.stringify({sandbox:r.j.sandbox, memoryCount:r.j.memoryCount, available:r.j.available}));
await b.close();
