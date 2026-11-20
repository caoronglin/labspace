import { chromium } from 'playwright';
const BASE='http://192.0.2.10';
const b = await chromium.launch({headless:true});
const ctx = await b.newContext({viewport:{width:1440,height:900}});
const page = await ctx.newPage();
await page.goto(BASE+'/login',{waitUntil:'domcontentloaded',timeout:30000});
await page.waitForSelector('#username',{timeout:20000});
await page.fill('#username','labadmin@local'); await page.fill('#password',process.env.LAB_ADMIN_PASS);
await page.click('button[type=submit]'); await page.waitForTimeout(3000);

// 1) 导航项
const navPaths = await page.evaluate(async()=>{
  const m = await import('/src/app/navigation.tsx').catch(()=>null);
  return null;
});
const svc = await page.evaluate(async()=> (await fetch('/api/services',{credentials:'include'})).json());
const services = svc.services||[];

const paths = ['/','/start','/services','/favorites','/search','/literature','/drawio','/drawings','/docling','/translate','/translation','/weather','/workbench','/agent','/devtools','/databases','/network','/snapotter','/commands','/admin/status','/admin/users','/admin/settings','/cropgenome/'];
console.log('=== 门户路由检查 ===');
const bad=[];
for (const p of paths) {
  const resp = await page.goto(BASE+p,{waitUntil:'domcontentloaded',timeout:25000}).catch(e=>null);
  await page.waitForTimeout(900);
  const txt = await page.evaluate(()=>document.body.innerText);
  const is404 = txt.includes('页面不存在');
  const is403 = txt.includes('无访问权限');
  const status = resp?.status();
  const title = (txt.split('\n').filter(Boolean)[1]||'').slice(0,30);
  const flag = is404?'❌404':(is403?'⚠403':(status===200?'✓':'?'));
  if (is404||is403||status!==200) bad.push(p);
  console.log(`  ${flag} ${p.padEnd(18)} http=${status} ${is404?'页面不存在':(is403?'无访问权限':title)}`);
}
console.log('\n=== 外部/端口服务入口（只做 HTTP 探测）===');
for (const s of services) {
  const u = s.url;
  if (!u.startsWith('http')) continue;
  const abs = u.replace('http://192.0.2.10', BASE).replace('http://198.51.100.71','http://198.51.100.71');
  const r = await page.request.get(abs,{timeout:15000}).catch(e=>null);
  console.log(`  ${r?.status()===200?'✓':(r?'?':'✗')} ${String(s.id).padEnd(16)} ${u} → ${r?.status()??'不可达'}`);
}
console.log('\n未接入/异常路由:', bad.length? bad.join(', '):'无');
await b.close();
