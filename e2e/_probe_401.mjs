import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE='http://192.0.2.10';
const l=readFileSync('/etc/labspace/casdoor-users.txt','utf8').split('\n').find(x=>x.startsWith('labadmin@local '));
const [u,p]=l.trim().split(/\s+/);
const b=await chromium.launch({args:['--no-sandbox']});
const c=await b.newContext({viewport:{width:1440,height:900},locale:'zh-CN'});
const page=await c.newPage();
await page.goto(BASE+'/login',{waitUntil:'domcontentloaded'});
await page.waitForSelector('input[type="password"]');
await page.locator('input[type="text"], input:not([type])').first().fill(u);
await page.locator('input[type="password"]').first().fill(p);
await page.getByRole('button',{name:/登录|Login/}).first().click();
await page.waitForTimeout(3500);
const bad=[];
page.on('response',r=>{ if(r.status()>=400) bad.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
for(const route of ['/bioinfo','/translation']){
  bad.length=0;
  await page.goto(BASE+route,{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(3000);
  console.log(route, JSON.stringify([...new Set(bad)].slice(0,10)));
}
await b.close();
