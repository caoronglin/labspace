import { chromium } from 'playwright';
const b = await chromium.launch({args:['--no-sandbox']});
const p = await (await b.newContext({locale:'zh-CN', viewport:{width:1500,height:1000}})).newPage();
await p.goto('http://192.0.2.10/api/auth/login', {waitUntil:'domcontentloaded'});
await p.waitForSelector('#username', {timeout:20000});
await p.locator('#username').fill('student01');
await p.locator('#password').fill(process.env.LAB_PASS);
await p.getByRole('button', {name:'登录'}).first().click();
await p.waitForURL('http://192.0.2.10/**', {timeout:25000}).catch(()=>{});
await p.goto('http://192.0.2.10/devtools', {waitUntil:'networkidle'});
await p.waitForTimeout(2000);
const tabs = await p.evaluate(()=>Array.from(document.querySelectorAll('.ant-tabs-tab')).map(t=>t.innerText.trim()));
console.log('  工具页签:', tabs.join(' / '));
// 测 JSON 美化
await p.locator('.ant-tabs-tab').filter({hasText:'JSON'}).first().click();
await p.waitForTimeout(800);
const t = (await p.evaluate(()=>document.body.innerText)).replace(/\s+/g,' ');
console.log('  JSON 页含结果:', t.includes('"labspace"') || t.includes('LabSpace'));
// 测 UUID
await p.locator('.ant-tabs-tab').filter({hasText:'UUID'}).first().click();
await p.waitForTimeout(600);
await p.getByRole('button', {name:'生成 5 个'}).click();
await p.waitForTimeout(800);
const t2 = (await p.evaluate(()=>document.body.innerText)).replace(/\s+/g,' ');
console.log('  UUID 生成:', (t2.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)||[]).length, '个');
await p.screenshot({path:'/opt/labspace/e2e/shots/devtools.png'});
await b.close();
