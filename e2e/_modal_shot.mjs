import { chromium } from 'playwright';
import fs from 'node:fs';
const CRED = {};
for (const line of fs.readFileSync('/etc/labspace/casdoor-users.txt','utf8').split('\n')) {
  const t=line.trim(); if(!t||t.startsWith('#')) continue;
  const [email,pass]=t.split(/\s+/); if(email&&pass) CRED[email.split('@')[0]]=pass;
}
const b = await chromium.launch({args:['--no-sandbox']});
const ctx = await b.newContext({locale:'zh-CN', viewport:{width:1440,height:1000}});
const page = await ctx.newPage();
await page.goto('http://192.0.2.10/login',{waitUntil:'domcontentloaded'});
await page.waitForSelector('#password',{timeout:40000});
await page.locator('#username').fill('labadmin');
await page.locator('#password').fill(CRED['labadmin']);
await page.getByRole('button',{name:/登录|Login/}).first().click();
await page.waitForTimeout(4000);
await page.goto('http://192.0.2.10/admin/users',{waitUntil:'domcontentloaded'});
await page.getByText('统一账号',{exact:false}).first().waitFor({timeout:30000});
await page.waitForTimeout(1500);
const row = page.locator('tr',{hasText:'student01'}).first();
await row.getByRole('button',{name:'编辑'}).click();
const dialog = page.locator('.ant-modal-container');
await dialog.waitFor({timeout:15000});
await page.waitForTimeout(1200);
await page.screenshot({path:'/opt/labspace/e2e/shots/_admin_grants_modal.png'});
console.log((await dialog.innerText()).replace(/\s+/g,' ').slice(0,500));
await b.close();
