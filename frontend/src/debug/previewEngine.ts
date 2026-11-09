/**
 * Bounded, derived-only preview engine (browser side of the global panel).
 *
 * Same contract as the Go core `internal/preview` and the Python
 * `preview_inline`: never hand out source bytes, cap input / expansion /
 * records / text, never render untrusted SVG / HTML / PDF, never run Office
 * macros. Everything is parsed from a locally selected File, in memory.
 */
export const MAX_INPUT = 8 << 20;
export const MAX_EXPANDED = 24 << 20;
export const MAX_ROWS = 20;
export const MAX_TEXT = 2048;
const MAX_CELL = 240;
const MAX_ZIP_ENTRIES = 256;

export interface PreviewResult {
  kind: 'bioinfo' | 'table' | 'text' | 'document' | 'image-metadata' | 'requires-worker' | 'unsupported';
  format: string;
  rows?: string[][];
  records?: Record<string, string | number>[];
  recordsSeen?: number;
  text?: string;
  meta?: Record<string, number | string | null>;
  truncated: boolean;
  notice?: string;
  bytesExamined?: number;
}

export class PreviewError extends Error {}

const short = (v: string, n: number) => (v.length <= n ? v : v.slice(0, n));

const decode = (buf: ArrayBuffer): string => new TextDecoder('utf-8', { fatal: false }).decode(buf);

const lines = (buf: ArrayBuffer): string[] =>
  decode(buf).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

/** Strip one .gz layer with a hard decompression ceiling. */
export async function unwrap(name: string, buf: ArrayBuffer): Promise<[string, ArrayBuffer]> {
  if (buf.byteLength > MAX_INPUT) throw new PreviewError('文件超过 8MiB 内联预览上限');
  const lower = name.toLowerCase();
  if (!lower.endsWith('.gz')) return [lower, buf];
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  } catch (e) {
    throw new PreviewError(`无法解压 gzip：${(e as Error).message}`);
  }
  try {
    const out = await new Response(stream).arrayBuffer();
    if (out.byteLength > MAX_EXPANDED) throw new PreviewError('解压后数据超过 24MiB 上限');
    return [lower.slice(0, -3), out];
  } catch (e) {
    if (e instanceof PreviewError) throw e;
    throw new PreviewError('gzip 流损坏或不完整');
  }
}

function fasta(buf: ArrayBuffer): Partial<PreviewResult> {
  const records: Record<string, string | number>[] = [];
  let total = 0;
  let current: Record<string, string | number> | null = null;
  for (const line of lines(buf)) {
    if (line.startsWith('>')) {
      total += 1;
      if (records.length >= MAX_ROWS) {
        current = null;
        continue;
      }
      current = { header: short(line.slice(1).trim(), 200), length: 0, snippet: '' };
      records.push(current);
    } else if (current) {
      const seq = line.trim().toUpperCase().replace(/[^A-Z*.\-]/g, '');
      current.length = (current.length as number) + seq.length;
      const snippet = current.snippet as string;
      if (snippet.length < 80) current.snippet = snippet + seq.slice(0, 80 - snippet.length);
    }
  }
  return { kind: 'bioinfo', format: 'fasta', records, recordsSeen: total, truncated: total > MAX_ROWS };
}

function fastq(buf: ArrayBuffer): Partial<PreviewResult> {
  const ls = lines(buf);
  while (ls.length && ls[ls.length - 1] === '') ls.pop();
  if (ls.length % 4 !== 0) throw new PreviewError('FASTQ 记录不完整（需 4 行一组）');
  const total = ls.length / 4;
  const records: Record<string, string | number>[] = [];
  for (let i = 0; i < total; i += 1) {
    const [a, seq, plus, qual] = ls.slice(i * 4, i * 4 + 4);
    if (!a.startsWith('@') || !plus.startsWith('+') || seq.length !== qual.length) {
      throw new PreviewError('FASTQ 结构校验失败');
    }
    if (i < MAX_ROWS) {
      records.push({ header: short(a.slice(1), 200), length: seq.length, sequence_snippet: short(seq, 80) });
    }
  }
  return { kind: 'bioinfo', format: 'fastq', records, recordsSeen: total, truncated: total > MAX_ROWS };
}

function sam(buf: ArrayBuffer): Partial<PreviewResult> {
  const records: Record<string, string | number>[] = [];
  let total = 0;
  for (const line of lines(buf)) {
    if (!line || line.startsWith('@')) continue;
    const f = line.split('\t');
    if (f.length < 11) continue;
    total += 1;
    if (records.length < MAX_ROWS) {
      records.push({ qname: short(f[0], 100), flag: f[1], rname: f[2], pos: f[3], mapq: f[4], cigar: short(f[5], 120) });
    }
  }
  return { kind: 'bioinfo', format: 'sam', records, recordsSeen: total, truncated: total > MAX_ROWS };
}

/** Minimal quote-aware CSV split so a quoted comma doesn't shift columns. */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cell += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cell); cell = ''; }
    else cell += c;
  }
  out.push(cell);
  return out;
}

function table(buf: ArrayBuffer, ext: string): Partial<PreviewResult> {
  const rows: string[][] = [];
  for (const line of lines(buf)) {
    if (!line.trim() || line.startsWith('##')) continue;
    if (rows.length >= MAX_ROWS) break;
    const cells = ext === '.csv' ? splitCsv(line) : line.split('\t');
    rows.push(cells.slice(0, 16).map((c) => short(c, MAX_CELL)));
  }
  return { kind: 'table', format: ext.slice(1), rows, truncated: rows.length >= MAX_ROWS };
}

/** Read dimensions from PNG / JPEG / GIF headers only; never decode pixels. */
function imageMeta(buf: ArrayBuffer, ext: string): Partial<PreviewResult> {
  const b = new Uint8Array(buf);
  let width: number | null = null;
  let height: number | null = null;
  const u16be = (o: number) => (b[o] << 8) | b[o + 1];
  const u32be = (o: number) => (b[o] * 0x1000000) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b.length >= 24) {
    width = u32be(16); height = u32be(20);
  } else if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const marker = b[i + 1];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = u16be(i + 5); width = u16be(i + 7); break;
      }
      const len = u16be(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
  } else if (decode(buf.slice(0, 6)) === 'GIF87a' || decode(buf.slice(0, 6)) === 'GIF89a') {
    if (b.length >= 10) { width = b[6] | (b[7] << 8); height = b[8] | (b[9] << 8); }
  }
  return {
    kind: 'image-metadata', format: ext.slice(1),
    meta: { width, height },
    notice: '仅读取头部尺寸；缩略图需在隔离 Worker 中生成',
  };
}

/** Office = a ZIP; parse the central directory by hand, no external deps. */
async function office(buf: ArrayBuffer, ext: string): Promise<Partial<PreviewResult>> {
  const b = new Uint8Array(buf);
  const view = new DataView(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65558); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new PreviewError('不是有效的 Office (ZIP) 文件');
  const count = view.getUint16(eocd + 10, true);
  if (count > MAX_ZIP_ENTRIES) throw new PreviewError('Office ZIP 条目过多');
  let off = view.getUint32(eocd + 16, true);
  const entries: { name: string; size: number; compressed: number; method: number; local: number }[] = [];
  let totalExpanded = 0;
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(off, true) !== 0x02014b50) throw new PreviewError('Office 中央目录损坏');
    const method = view.getUint16(off + 10, true);
    const compressed = view.getUint32(off + 20, true);
    const size = view.getUint32(off + 24, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const local = view.getUint32(off + 42, true);
    const name = decode(buf.slice(off + 46, off + 46 + nameLen));
    totalExpanded += size;
    entries.push({ name, size, compressed, method, local });
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (totalExpanded > MAX_EXPANDED) throw new PreviewError('Office 解压后超过 24MiB 上限');

  const isDocx = (p: string) => ext === '.docx' && p === 'word/document.xml';
  const isXlsx = (p: string) => ext === '.xlsx' && p.startsWith('xl/worksheets/sheet') && p.endsWith('.xml');
  const isPptx = (p: string) => ext === '.pptx' && p.startsWith('ppt/slides/slide') && p.endsWith('.xml');
  const wanted = entries.filter((e) => isDocx(e.name) || isXlsx(e.name) || isPptx(e.name)).slice(0, MAX_ROWS);

  const chunks: string[] = [];
  for (const e of wanted) {
    const nameLen = view.getUint16(e.local + 26, true);
    const extraLen = view.getUint16(e.local + 28, true);
    const start = e.local + 30 + nameLen + extraLen;
    const part = buf.slice(start, start + e.compressed);
    let xml: ArrayBuffer = part;
    if (e.method === 8) {
      try {
        xml = await new Response(new Blob([part]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
      } catch { throw new PreviewError('Office 成员解压失败'); }
    } else if (e.method !== 0) {
      throw new PreviewError('不支持的 Office 压缩方式');
    }
    // Strip tags, keep only character data inside <w:t> / <a:t> / <v>.
    const source = decode(xml);
    const re = /<(?:w:|a:)?(?:t|v)[^>]*>([^<]*)</g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) chunks.push(m[1]);
  }
  const text = short(chunks.join(' '), MAX_TEXT);
  return {
    kind: 'document', format: ext.slice(1), text,
    truncated: entries.length > MAX_ROWS || text.length >= MAX_TEXT,
    notice: '仅抽取可见文本；不执行宏、不解析外部实体',
  };
}

const BIOINFO: Record<string, 'fasta' | 'fastq' | 'sam'> = {
  '.fa': 'fasta', '.fna': 'fasta', '.faa': 'fasta', '.fasta': 'fasta',
  '.fq': 'fastq', '.fastq': 'fastq', '.sam': 'sam',
};
const TABLE_EXT = new Set(['.gff', '.gff3', '.gtf', '.vcf', '.bed', '.csv', '.tsv']);
const TEXT_EXT = new Set(['.txt', '.md', '.log', '.json', '.yaml', '.yml']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const OFFICE_EXT = new Set(['.docx', '.pptx', '.xlsx']);
const WORKER_EXT = new Set(['.pdf', '.bam', '.cram', '.bai', '.crai', '.bw', '.bigwig']);

/** Render bounded derived metadata for one locally selected file. */
export async function renderPreview(name: string, raw: ArrayBuffer): Promise<PreviewResult> {
  const [lower, data] = await unwrap(name, raw);
  const ext = extOf(lower);
  const base: PreviewResult = {
    kind: 'unsupported', format: ext.slice(1), truncated: false,
    meta: { bytes_examined: data.byteLength },
    bytesExamined: data.byteLength,
  };
  let patch: Partial<PreviewResult>;
  if (BIOINFO[ext]) {
    patch = { fasta, fastq, sam }[BIOINFO[ext]](data);
  } else if (TABLE_EXT.has(ext)) {
    patch = table(data, ext);
  } else if (TEXT_EXT.has(ext)) {
    const full = decode(data);
    patch = { kind: 'text', text: short(full, MAX_TEXT), truncated: full.length > MAX_TEXT };
  } else if (OFFICE_EXT.has(ext)) {
    patch = await office(data, ext);
  } else if (IMAGE_EXT.has(ext)) {
    patch = imageMeta(data, ext);
  } else if (WORKER_EXT.has(ext)) {
    patch = { kind: 'requires-worker', notice: '该格式需隔离渲染 Worker，不返回原始二进制' };
  } else {
    patch = { kind: 'unsupported', notice: '文件格式未纳入允许的预览器' };
  }
  return { ...base, ...patch, meta: { ...base.meta, ...patch.meta } };
}
