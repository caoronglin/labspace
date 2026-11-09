import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = 'http://192.0.2.10';
const line = fs.readFileSync('/etc/labspace/casdoor-users.txt','utf8').split('\n').find(l=>l.startsWith('labadmin@local'));
const pw = line.trim().split(/\s+/)[1];
let fails=0; const ok=(n,c,x='')=>{console.log(`${c?'PASS':'FAIL'}  ${n}${x?'  '+x:''}`); if(!c) fails++;};
const b=await chromium.launch({args:['--no-sandbox']});
const ctx=await b.newContext({locale:'zh-CN',viewport:{width:1680,height:1000}});
const p=await ctx.newPage(); const errs=[];
p.on('pageerror',e=>errs.push(String(e)));
await p.goto(`${BASE}/login`); await p.waitForSelector('input[type="password"]');
await p.locator('input[type="text"], input:not([type])').first().fill('labadmin');
await p.locator('input[type="password"]').first().fill(pw);
await p.getByRole('button',{name:/登录|Login/}).first().click(); await p.waitForTimeout(4000);
const wm=p.locator('.ant-modal').filter({hasText:'欢迎使用 D509 工作台'}).first();
if(await wm.isVisible().catch(()=>false)){await wm.getByRole('button',{name:/开始使用/}).click(); await p.waitForTimeout(500);}

for (const [from,to] of [['/services','/start'],['/nav','/start'],['/favorites','/start']]) {
  await p.goto(`${BASE}${from}`,{waitUntil:'domcontentloaded'}); await p.waitForTimeout(900);
  ok(`${from} 下线`, new URL(p.url()).pathname===to, p.url());
}

await p.goto(`${BASE}/plot`,{waitUntil:'domcontentloaded'}); await p.waitForTimeout(2500);
ok('/plot 归入科研工具', /科研工具/.test(await p.locator('body').innerText()) && new URL(p.url()).pathname==='/tools', p.url());
ok('科研工具三个标签', (await p.getByRole('tab').count())>=3);
await p.screenshot({path:'shots/final-tools-plot.png',fullPage:true});
await p.getByRole('button',{name:/数据/}).click(); await p.waitForTimeout(500);
const dataDrawer=p.locator('.ant-drawer').filter({hasText:'数据源'});
ok('绘图数据抽屉', await dataDrawer.isVisible().catch(()=>false));
ok('数据抽屉含上传与示例', /上传 CSV/.test(await dataDrawer.innerText().catch(()=>'')));
await dataDrawer.getByRole('button',{name:/完\s*成/}).click(); await p.waitForTimeout(400);
await p.getByRole('button',{name:/样式/}).click(); await p.waitForTimeout(500);
const styleDrawer=p.locator('.ant-drawer').filter({hasText:'参数与样式'});
ok('绘图样式抽屉', await styleDrawer.isVisible().catch(()=>false));
await styleDrawer.getByRole('button',{name:/完\s*成/}).click(); await p.waitForTimeout(300);

await p.goto(`${BASE}/agent?mode=kb`,{waitUntil:'domcontentloaded'}); await p.waitForTimeout(2500);
const body=await p.locator('body').innerText();
ok('Agent 知识库模式', /知识库问答/.test(body)&&/Agent 对话/.test(body)&&/实验记录/.test(body), p.url());
await p.screenshot({path:'shots/final-agent-kb.png',fullPage:true});

await p.goto(`${BASE}/agent`,{waitUntil:'domcontentloaded'}); await p.waitForTimeout(2500);
const chatBody=await p.locator('body').innerText();
ok('Agent 记忆与沙箱', /记忆/.test(chatBody)&&/沙箱/.test(chatBody), p.url());

await p.goto(`${BASE}/workbench`,{waitUntil:'domcontentloaded'}); await p.waitForTimeout(1500);
await p.getByRole('tab',{name:/每日文献/}).click(); await p.waitForTimeout(2500);
const wbBody=await p.locator('body').innerText();
ok('工作台每日文献', /今日文献/.test(wbBody)&&/我的文献库/.test(wbBody), p.url());
await p.screenshot({path:'shots/final-workbench-reading.png',fullPage:true});

await p.goto(`${BASE}/admin/backups`,{waitUntil:'domcontentloaded'}); await p.waitForTimeout(2500);
const btxt=await p.locator('body').innerText();
ok('备份页面可访问', /备份/.test(btxt)&&(/3 天|3天|保留/.test(btxt)), p.url());
await p.screenshot({path:'shots/final-admin-backups.png',fullPage:true});

ok('无前端异常', errs.length===0, errs.slice(0,2).join(' | '));
await b.close(); console.log(fails?`${fails} FAILED`:'ALL PASS'); process.exit(fails?1:0);
