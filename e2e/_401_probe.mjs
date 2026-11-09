import { chromium } from 'playwright';
const BASE='http://192.0.2.10';
const b=await chromium.launch({args:['--no-sandbox']});
const ctx=await b.newContext({viewport:{width:1440,height:900},locale:'zh-CN'});
const p=await ctx.newPage();
p.on('response',r=>{if(r.status()===401)console.log('401',r.url())});
p.on('requestfailed',r=>console.log('FAIL',r.url(),r.failure()?.errorText));
await p.goto(BASE+'/login',{waitUntil:'domcontentloaded'});
await p.waitForSelector('#password',{timeout:30000});
await p.fill('#username','labadmin'); await p.fill('#password',process.env.LAB_PASS);
await p.click('button[type=submit]'); await p.waitForTimeout(4000);
for(const path of ['/','/services','/workbench','/knowledge']){
  await p.goto(BASE+path,{waitUntil:'domcontentloaded'}); await p.waitForTimeout(2500);
}
await b.close();
