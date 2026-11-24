import { launch } from './_auth.mjs';
const b = await launch();
const ctx = await b.newContext();
const p = await ctx.newPage();
p.on('response', async (r) => {
  if (r.url().includes('8097')) {
    console.log('RES', r.status(), r.url(), '→', r.headers()['location'] || '(no location)');
    console.log('   server:', r.headers()['server'], '| via:', r.headers()['via']);
  }
});
await p.goto('http://127.0.0.1:8097/', { waitUntil: 'domcontentloaded' }).catch(e => console.log('goto err', String(e).slice(0,60)));
await p.waitForTimeout(2000);
console.log('final:', p.url());
await b.close();
