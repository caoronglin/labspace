/**
 * previewEngine 契约测试：与 Go core internal/preview、Python preview_inline 对齐。
 * 运行：node --test src/debug/__tests__/previewEngine.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, deflateRawSync } from 'node:zlib';
import {
  renderPreview, unwrap, MAX_INPUT, MAX_ROWS, MAX_TEXT, PreviewError,
} from '../previewEngine.ts';

const enc = (s) => new TextEncoder().encode(s).buffer;
/** Node Buffer 的 .buffer 是内存池 slab，必须裁成精确 ArrayBuffer（浏览器 File 返回的就是精确的）。 */
const exact = (bufLike) => {
  const b = Buffer.from(bufLike);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

// ---------------------------------------------------------------- 文本 / gzip
test('文本预览：按字符截断，返回派生文本', async () => {
  const raw = enc('hello 世界\n' + 'x'.repeat(5000));
  const r = await renderPreview('note.txt', raw);
  assert.equal(r.kind, 'text');
  assert.equal(r.format, 'txt');
  assert.equal(r.bytesExamined, raw.byteLength);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= MAX_TEXT);
});

test('.gz 解压后按去后缀的扩展名分派', async () => {
  const r = await renderPreview('reads.fasta.gz', exact(gzipSync(Buffer.from('>a\nACGT\n>b\nTTTT\n'))));
  assert.equal(r.kind, 'bioinfo');
  assert.equal(r.format, 'fasta');
  assert.equal(r.records.length, 2);
  assert.equal(r.records[0].length, 4);
});

test('gzip 解压上限：超过 24MiB 拒绝', async () => {
  const bomb = gzipSync(Buffer.alloc(25 << 20));
  await assert.rejects(() => unwrap('big.txt.gz', exact(bomb)), PreviewError);
});

test('输入超过 8MiB 直接拒绝，不读进解析', async () => {
  await assert.rejects(() => renderPreview('x.txt', new ArrayBuffer(MAX_INPUT + 1)), PreviewError);
});

// ---------------------------------------------------------------- 生信格式
test('FASTA：最多 20 条，超出标记 truncated 且计数准确', async () => {
  let s = '';
  for (let i = 0; i < 25; i += 1) s += `>seq${i}\nACGTACGT\n`;
  const r = await renderPreview('x.fa', enc(s));
  assert.equal(r.records.length, MAX_ROWS);
  assert.equal(r.recordsSeen, 25);
  assert.equal(r.truncated, true);
  assert.ok(r.records[0].snippet.startsWith('ACGT'));
});

test('FASTQ：结构校验，缺行与长度不等都拒绝', async () => {
  const ok = await renderPreview('x.fq', enc('@r1\nACGT\n+\nIIII\n@r2\nTT\n+\n!!\n'));
  assert.equal(ok.kind, 'bioinfo');
  assert.equal(ok.recordsSeen, 2);
  await assert.rejects(() => renderPreview('x.fq', enc('@r1\nACGT\n+\nII\n')), PreviewError);
  await assert.rejects(() => renderPreview('x.fq', enc('@r1\nACGT\n+\n')), PreviewError);
});

test('SAM：跳过 @ 头，字段不足 11 的行不计入', async () => {
  const raw = '@HD\tVN:1.6\n@SQ\tSN:chr1\nr1\t0\tchr1\t1\t60\t4M\t*\t0\t0\tACGT\tIIII\nshort\tline\n';
  const r = await renderPreview('x.sam', enc(raw));
  assert.equal(r.recordsSeen, 1);
  assert.equal(r.records[0].rname, 'chr1');
});

// ---------------------------------------------------------------- 表格
test('CSV 带引号逗号不错列', async () => {
  const r = await renderPreview('x.csv', enc('a,b,c\n"x,y",z,w\n'));
  assert.equal(r.kind, 'table');
  assert.deepEqual(r.rows[1].slice(0, 3), ['x,y', 'z', 'w']);
});

test('表格最多 20 行、每行最多 16 列', async () => {
  const cols = Array.from({ length: 30 }, (_, i) => `c${i}`).join('\t');
  const raw = Array.from({ length: 30 }, () => cols).join('\n');
  const r = await renderPreview('x.tsv', enc(raw));
  assert.equal(r.rows.length, MAX_ROWS);
  assert.equal(r.rows[0].length, 16);
  assert.equal(r.truncated, true);
});

// ---------------------------------------------------------------- 图片元数据
test('PNG 只读头部尺寸，不解码像素', async () => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b[16] = 0; b[17] = 0; b[18] = 0x01; b[19] = 0x90;  // 400
  b[20] = 0; b[21] = 0; b[22] = 0x00; b[23] = 0xc8;  // 200
  const r = await renderPreview('x.png', b.buffer);
  assert.equal(r.kind, 'image-metadata');
  assert.equal(r.meta.width, 400);
  assert.equal(r.meta.height, 200);
  assert.equal(r.meta.bytes_examined, 33);
});

test('PDF / BAM 只给 requires-worker，不回传原始字节', async () => {
  const r = await renderPreview('x.pdf', enc('%PDF-1.7\nSECRET'));
  assert.equal(r.kind, 'requires-worker');
  assert.equal(r.text, undefined);
});

// ---------------------------------------------------------------- Office
/** 构造最小 ZIP：本地头 + 中央目录 + EOCD */
function makeZip(entries, { inflate = false } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(content);
    const payload = inflate ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30 + nameBuf.length + payload.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(inflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 22);       // uncompressed size
    local.writeUInt32LE(payload.length, 18);   // compressed size
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    payload.copy(local, 30 + nameBuf.length);
    locals.push(local);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(inflate ? 8 : 0, 10);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    central.push(cd);
    offset += local.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return exact(Buffer.concat([...locals, cdBuf, eocd]));
}

test('DOCX：抽取 <w:t> 文本，不执行宏、不解析外部实体', async () => {
  const xml = '<?xml version="1.0"?><w:document><w:p><w:t>Hello 实验室</w:t></w:p>'
    + '<w:p><w:t>Second paragraph</w:t></w:p></w:document>';
  const r = await renderPreview('x.docx', makeZip([['word/document.xml', xml], ['word/vbaProject.bin', 'MZ']]));
  assert.equal(r.kind, 'document');
  assert.match(r.text, /Hello 实验室/);
  assert.match(r.text, /Second paragraph/);
  assert.doesNotMatch(r.text, /MZ/);
});

test('DOCX deflate 成员也能解出', async () => {
  const xml = '<w:document><w:p><w:t>compressed text</w:t></w:p></w:document>';
  const r = await renderPreview('x.docx', makeZip([['word/document.xml', xml]], { inflate: true }));
  assert.match(r.text, /compressed text/);
});

test('非 ZIP 的 docx 明确报错，不静默返回空', async () => {
  await assert.rejects(() => renderPreview('x.docx', enc('not a zip')), PreviewError);
});

test('ZIP bomb：声明解压总量超限时拒绝', async () => {
  const xml = '<w:document><w:t>ok</w:t></w:document>';
  const zip = makeZip([['word/document.xml', xml]]);
  const b = new Uint8Array(zip.slice(0));
  const view = new DataView(b.buffer);
  // 中央目录第一条的 uncompressed size 在 +24；EOCD 在末尾 -22。
  // 找到 EOCD 指向的中央目录偏移再改。
  const cdOff = view.getUint32(b.length - 22 + 16, true);
  view.setUint32(cdOff + 24, 25 << 20, true);
  await assert.rejects(() => renderPreview('x.docx', b.buffer), PreviewError);
});

// ---------------------------------------------------------------- 兜底
test('未纳入的格式给 unsupported，不猜测内容', async () => {
  const r = await renderPreview('x.bin', enc('\x00\x01\x02'));
  assert.equal(r.kind, 'unsupported');
  assert.equal(r.rows, undefined);
  assert.equal(r.text, undefined);
});

test('任何结果都不含原始字节字段', async () => {
  const r = await renderPreview('secret.txt', enc('TOP-SECRET-CONTENT'));
  const serialized = JSON.stringify(r);
  assert.ok(!serialized.includes('raw') && !serialized.includes('content'), 'no raw field');
});
