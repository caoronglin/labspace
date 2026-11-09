import { chromium } from 'playwright';
const BASE='http://192.0.2.10';
const PASS=process.env.LAB_PASS;
const browser=await chromium.launch({args:['--no-sandbox']});
const ctx=await browser.newContext({locale:'zh-CN'});
const page=await ctx.newPage();
await page.goto(`${BASE}/login`,{waitUntil:'domcontentloaded'});
await page.waitForSelector('input[type="password"]',{timeout:20000});
await page.locator('input[type="text"], input:not([type])').first().fill(process.env.LAB_USER||'student01');
await page.locator('input[type="password"]').first().fill(PASS);
await page.getByRole('button',{name:/登录|Login/}).first().click();
await page.waitForTimeout(5000);
const api=async(p)=>page.evaluate(async (p)=>{const r=await fetch(p,{credentials:'include'});return{status:r.status,body:await r.json().catch(()=>null)}},p);
const src=await api('/api/files/sources');
console.log('sources',src.status,JSON.stringify(src.body));
for(const s of src.body?.sources??[]){
  if(!s.listable) continue;
  const l=await api(`/api/files?source=${s.id}`);
  console.log(s.id,l.status,'count='+l.body?.count);
  const f=(l.body?.entries??[]).find(e=>!e.dir);
  if(f){
    const pv=await api(`/api/files/${f.id}/preview`);
    console.log(' preview',pv.status,pv.body?.kind,pv.body?.format);
  }
}
await page.goto(`${BASE}/files`,{waitUntil:'domcontentloaded'});
await page.waitForTimeout(3000);
const txt=(await page.evaluate(()=>document.body.innerText)).replace(/\s+/g,' ');
console.log('page',/文件管理/.test(txt)?'OK':'FAIL',txt.slice(0,220));
await page.screenshot({path:'_files_page.png',fullPage:true});
await ctx.close();await browser.close();
