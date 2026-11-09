import { chromium } from 'playwright';
const BASE='http://192.0.2.10';
const b=await chromium.launch({args:['--no-sandbox']});
const ctx=await b.newContext({viewport:{width:1440,height:900},locale:'zh-CN'});
const p=await ctx.newPage();
let phase='pre';
p.on('response',r=>{if(r.status()===401)console.log(phase,'401',r.url())});
await p.goto(BASE+'/login',{waitUntil:'domcontentloaded'});
await p.waitForSelector('#password',{timeout:30000});
await p.fill('#username','labadmin'); await p.fill('#password',process.env.LAB_PASS);
await p.click('button[type=submit]'); await p.waitForTimeout(5000);
phase='post'; console.log('me',await p.evaluate(async()=>{const r=await fetch('/api/me',{credentials:'include'});return [r.status,await r.text()]}));
for(const path of ['/','/services','/workbench','/knowledge']){
  phase='nav '+path;
  await p.goto(BASE+path,{waitUntil:'domcontentloaded'}); await p.waitForTimeout(2500);
}
await b.close();
