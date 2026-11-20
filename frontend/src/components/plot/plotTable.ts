/** 绘图工作台的数据表：粘贴/上传的 CSV / TSV 解析结果。参数下拉与实时预览共用。 */
export type ParsedTable = {
  headers: string[];
  rows: Record<string, string>[];
};

export function parseTable(text: string): ParsedTable {
  const raw = text.replace(/^\uFEFF/, '');
  if (!raw.trim()) return { headers: [], rows: [] };
  const first = raw.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = first.includes('\t') && !first.includes(',') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quoted) {
      if (ch === '"' && raw[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = (rows.shift() ?? []).map((h) => h.trim());
  const objects = rows
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h, idx) => [h, (r[idx] ?? '').trim()])));
  return { headers, rows: objects };
}

export function toNumber(value: unknown): number {
  const n = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** 数值列：整列都能解析成数字才算，避免混进带单位的列名。 */
export function numericColumnsOf(table: ParsedTable): string[] {
  return table.headers.filter(
    (h) => table.rows.length > 0 && table.rows.every((r) => r[h] !== '' && Number.isFinite(Number(r[h]))),
  );
}
