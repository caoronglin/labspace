import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE='http://192.0.2.10';
const l=readFileSync('/etc/labspace/casdoor-users.txt','utf8').split('\n').find(x=>x.startsWith('labadmin@local '));
const [u,p]=l.trim().split(/\s+/);
const b=await chromium.launch({args:['--no-sandbox']});
for (const [w,h,tag] of [[1440,960,'desktop'],[390,844,'mobile']]) {
  const c=await b.newContext({viewport:{width:w,height:h},locale:'zh-CN'});
  const page=await c.newPage();
  await page.goto(BASE+'/login',{waitUntil:'domcontentloaded'});
  await page.waitForSelector('input[type="password"]');
  await page.locator('input[type="text"], input:not([type])').first().fill(u);
  await page.locator('input[type="password"]').first().fill(p);
  await page.getByRole('button',{name:/登录|Login/}).first().click();
  await page.waitForTimeout(3500);
  await page.goto(BASE+'/databases',{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(2500);
  const overflow = await page.evaluate(()=>({doc:document.documentElement.scrollWidth-document.documentElement.clientWidth,body:document.body.scrollWidth-document.body.clientWidth}));
  const chips = await page.locator('.ant-tag-checkable').count();
  const firstRow = await page.evaluate(()=>{
    const tags=[...document.querySelectorAll('.ant-tag-checkable')].filter(el=>el.offsetParent);
    if(!tags.length) return null;
    const top=Math.round(tags[0].getBoundingClientRect().top);
    return {total:tags.length, firstRow:tags.filter(el=>Math.abs(el.getBoundingClientRect().top-top)<4).length};
  });
  await page.screenshot({path:`/opt/labspace/e2e/shots/databases-filter-${tag}.png`});
  console.log(tag, JSON.stringify({overflow, chips, firstRow}));
  await c.close();
}
await b.close();
