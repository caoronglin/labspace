import { chromium } from 'playwright';
const b = await chromium.launch({args:['--no-sandbox']});
const p = await (await b.newContext({locale:'zh-CN', viewport:{width:1500,height:950}}));
const pg = await p.newPage();
const targets = [
  ['门户', 'http://192.0.2.10/'],
  ['统一认证', 'http://192.0.2.10:8090/'],
  ['生信实训平台', 'http://192.0.2.10:8102/'],
  ['Quantum', 'http://192.0.2.10:8080/files/'],
  ['draw.io', 'http://192.0.2.10:8082/'],
  ['IT-Tools', 'http://192.0.2.10:8084/'],
  ['Linux Command', 'http://192.0.2.10:8086/'],
  ['JBrowse', 'http://192.0.2.10:8091/index.html?config=data/demo/config.zh.json'],
  ['植物数据库(门户页)', 'http://192.0.2.10/databases'],
];
for (const [name, url] of targets) {
  const fails=[];
  const h = r => { if (r.status()>=400) fails.push(r.status()+' '+r.url().slice(0,50)); };
  pg.on('response', h);
  try {
    const res = await pg.goto(url, {waitUntil:'networkidle', timeout:30000});
    await pg.waitForTimeout(1200);
    const title = await pg.title();
    console.log(`  ${String(res.status()).padEnd(4)} ${name.padEnd(22)} ${url}`);
    if (fails.length) console.log('        失败资源:', fails.slice(0,2));
  } catch(e) { console.log(`  ERR  ${name}: ${e.message.split('\n')[0]}`); }
  pg.removeAllListeners('response');
}
await b.close();
