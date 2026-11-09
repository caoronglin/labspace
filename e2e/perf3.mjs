import { chromium } from 'playwright';
const b = await chromium.launch({args:['--no-sandbox']});
const ctx = await b.newContext();
const p = await ctx.newPage();
async function go(label){
  await p.goto('http://192.0.2.10/', {waitUntil:'domcontentloaded'});
  await p.waitForTimeout(2000);
  const m = await p.evaluate(()=>{
    const rs = performance.getEntriesByType('resource');
    const nav = performance.getEntriesByType('navigation')[0];
    const transfer = rs.reduce((a,r)=>a+(r.transferSize||0),0) + (nav?.transferSize||0);
    const decoded = rs.reduce((a,r)=>a+(r.decodedBodySize||0),0);
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    const dcl = nav?.domContentLoadedEventEnd||0;
    return {transfer: Math.round(transfer/1024), decoded: Math.round(decoded/1024), fcp: Math.round(fcp?.startTime||0), dcl: Math.round(dcl), n: rs.length+1};
  });
  console.log(`  ${label.padEnd(16)} 网络传输 ${String(m.transfer).padStart(5)} KB | 解压后 ${String(m.decoded).padStart(5)} KB | ${m.n} 个请求 | FCP ${m.fcp}ms | DCL ${m.dcl}ms`);
}
await go('首访（冷缓存）');
await go('二访（热缓存）');
await go('三访（热缓存）');
await b.close();
