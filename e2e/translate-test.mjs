import { chromium } from 'playwright';
import fs from 'node:fs';
const b = await chromium.launch({args:['--no-sandbox']});
const p = await (await b.newContext({locale:'zh-CN', viewport:{width:1400,height:950}})).newPage();
await p.goto('http://192.0.2.10/api/auth/login', {waitUntil:'domcontentloaded'});
await p.waitForSelector('#username', {timeout:20000});
await p.locator('#username').fill('student01');
await p.locator('#password').fill(process.env.LAB_PASS);
await p.getByRole('button', {name:'登录'}).first().click();
await p.waitForURL('http://192.0.2.10/**', {timeout:25000}).catch(()=>{});
await p.goto('http://192.0.2.10/translate', {waitUntil:'networkidle'});
await p.waitForTimeout(1500);
const status = await p.evaluate(async()=> (await fetch('/api/pdf-translate/status',{credentials:'include'})).text());
console.log('  服务状态:', status);
// 上传测试 PDF
const buf = fs.readFileSync('/tmp/testdoc.pdf');
await p.locator('input[type=file]').setInputFiles({name:'testdoc.pdf', mimeType:'application/pdf', buffer:buf});
await p.waitForTimeout(3000);
console.log('  已提交，等待处理…');
for (let i=0;i<40;i++){
  await p.waitForTimeout(5000);
  const t = (await p.evaluate(()=>document.body.innerText)).replace(/\s+/g,' ');
  if (t.includes('翻译完成')||t.includes('翻译失败')){ console.log('  结果:', t.match(/翻译完成|翻译失败/)[0]); break; }
  if (i%6===0) console.log('   ...', t.match(/排队中|正在解析[^，]*/)?.[0] ?? '');
}
await p.screenshot({path:'/opt/labspace/e2e/shots/translate-result.png'});
const files = await p.evaluate(async()=> (await fetch('/api/drawings',{credentials:'include'})).text());
await b.close();
