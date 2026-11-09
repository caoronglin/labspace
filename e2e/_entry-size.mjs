#!/usr/bin/env node
/** 统计 dist/index.html 直接引用（script + modulepreload + css）的产物体积（raw/gzip）。 */
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';

const dist = resolve(process.argv[2] ?? 'dist');
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)].map((m) => m[1]);
let raw = 0;
let gz = 0;
const list = [];
for (const r of refs) {
  const p = join(dist, 'assets', r);
  const buf = readFileSync(p);
  const g = gzipSync(buf, { level: 9 }).length;
  raw += buf.length;
  gz += g;
  list.push([r, buf.length, g]);
}
for (const [r, b, g] of list.sort((a, b) => b[2] - a[2])) {
  console.log(`${r.padEnd(38)} raw=${(b / 1024).toFixed(1)}KB gzip=${(g / 1024).toFixed(2)}KB`);
}
console.log(
  `\n入口 HTML 引用产物合计: raw=${(raw / 1024).toFixed(1)}KB gzip=${(gz / 1024).toFixed(2)}KB (${refs.length} 个文件)`,
);
