/**
 * 种子管理页的字段语义层。
 *
 * Baserow 模板的字段由后端定义（GET /api/baserow/templates/seed），
 * 前端不硬编码字段清单，而是按字段名/类型做语义分组与必填判断：
 * 模板字段调整后，分组与提示仍然成立。
 */
import type { BaserowField } from '../../../services/api';

export type SeedGroupKey = 'basic' | 'stock' | 'quality' | 'backup' | 'attachment';

export interface SeedGroup {
  key: SeedGroupKey;
  label: string;
  hint: string;
}

export const SEED_GROUPS: SeedGroup[] = [
  { key: 'basic', label: '基本信息', hint: '种子身份、来源与负责人' },
  { key: 'stock', label: '库存与存放', hint: '数量、单位、出入库与存放位置' },
  { key: 'quality', label: '质量与处理', hint: '活力、纯度与处理方式' },
  { key: 'backup', label: '备份', hint: '备份位置与备份状态' },
  { key: 'attachment', label: '附件', hint: '图片、检测报告等凭证' },
];

/**
 * 分组关键词。顺序即优先级：先命中先归组。
 *
 * 「入库」只认带日期/时间的词，避免把「入库人」这种基本信息误判成库存字段。
 */
const GROUP_KEYWORDS: { key: Exclude<SeedGroupKey, 'attachment'>; words: string[] }[] = [
  { key: 'backup', words: ['备份', '副本', '异地', '冷库'] },
  { key: 'quality', words: ['活力', '发芽', '纯度', '水分', '含水', '等级', '检测', '处理', '消毒', '休眠', '质量', '标准'] },
  {
    key: 'stock',
    words: ['数量', '库存', '单位', '入库日期', '入库时间', '入库量', '出库日期', '出库时间', '存放', '位置', '库位', '冰箱', '货架', '有效期'],
  },
  { key: 'basic', words: ['名称', '品名', '品种', '品系', '编号', '来源', '采集', '入库人', '负责人', '备注', '说明', '供应商', '产地'] },
];

/** 字段归组：文件字段固定进「附件」，其余按关键词匹配，未命中归「基本信息」。 */
export function groupOf(field: BaserowField): SeedGroupKey {
  if (field.type === 'file') return 'attachment';
  for (const rule of GROUP_KEYWORDS) {
    if (rule.words.some((w) => field.name.includes(w))) return rule.key;
  }
  return 'basic';
}

/** 按分组把字段拆开，组内保持模板给出的顺序。 */
export function groupFields(fields: BaserowField[]): { key: SeedGroupKey; label: string; hint: string; fields: BaserowField[] }[] {
  return SEED_GROUPS.map((g) => ({
    ...g,
    fields: fields.filter((f) => groupOf(f) === g.key),
  })).filter((g) => g.fields.length > 0);
}

/** 数量字段名（用于数量与单位联动提示）。 */
export function quantityFieldName(fields: BaserowField[]): string | undefined {
  return fields.find((f) => f.name.includes('数量') || f.name.includes('库存量'))?.name;
}

/** 单位字段名。 */
export function unitFieldName(fields: BaserowField[]): string | undefined {
  return fields.find((f) => f.name.includes('单位'))?.name;
}

/**
 * 必填字段名集合。
 *
 * 模板接口只给字段名与类型，必填规则按语义推导：
 * 主字段（Baserow 的 primary）必填；名称/编号/品种这类身份字段、
 * 数量与入库日期这类台账字段也必填；有数量字段时单位跟着必填。
 */
export function requiredFieldNames(fields: BaserowField[]): Set<string> {
  const required = new Set<string>();
  const words = ['名称', '品名', '编号', '品种', '品系', '入库日期'];
  const hasQuantity = fields.some((f) => f.name.includes('数量') || f.name.includes('库存量'));
  for (const f of fields) {
    if (f.primary) {
      required.add(f.name);
      continue;
    }
    if (words.some((w) => f.name.includes(w))) {
      required.add(f.name);
      continue;
    }
    if (hasQuantity && f.name.includes('数量')) required.add(f.name);
    if (hasQuantity && f.name.includes('单位')) required.add(f.name);
  }
  return required;
}

/** 新建记录时需要默认填今天日期的字段（入库/登记类）。 */
export function defaultDateFieldNames(fields: BaserowField[]): string[] {
  return fields
    .filter((f) => f.type === 'date' && /入库|登记|建档|建卡|日期/.test(f.name))
    .map((f) => f.name);
}

/** 单选项取值（Baserow 可能返回 id、value 或对象）。 */
export function optionId(value: unknown): number | string | undefined {
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    return (v.id as number) ?? (v.value as string);
  }
  return value as number | string | undefined;
}

/** 单选项在字段里的展示名与颜色。 */
export function selectLabel(field: BaserowField, value: unknown): { label: string; color?: string } {
  const id = optionId(value);
  const hit = field.select_options.find((o) => o.id === id || o.value === id);
  return { label: hit?.value ?? String(id ?? ''), color: hit?.color };
}

/** 找出名字命中关键词的第一个字段。 */
export function findField(fields: BaserowField[], words: string[]): BaserowField | undefined {
  return fields.find((f) => words.some((w) => f.name.includes(w)));
}

export interface SeedStats {
  total: number;
  inStock: number;
  lowVitality: number;
  pendingBackup: number;
}

/**
 * 台账统计：在库数量 / 低活力数 / 待备份数。
 *
 * 判定优先用单选字段的选项（状态、备份状态），取不到选项时退回
 * 出库日期为空 / 数值低于阈值 / 备份字段未标记已备份。
 *
 * `total` 由调用方传入（服务端记录总数），其余三项按传入的行集统计。
 */
export function computeSeedStats(
  rows: Record<string, unknown>[],
  fields: BaserowField[],
  total: number,
): SeedStats {
  const statusField = findField(fields, ['库存状态', '在库状态', '状态']);
  const outDateField = findField(fields, ['出库日期', '出库时间']);
  const vitalityField = findField(fields, ['活力', '发芽率']);
  const backupField = findField(fields, ['备份状态', '备份']);

  const labelOf = (field: BaserowField | undefined, value: unknown) =>
    field ? selectLabel(field, value).label : '';

  let inStock = 0;
  let lowVitality = 0;
  let pendingBackup = 0;

  for (const row of rows) {
    const statusLabel = labelOf(statusField, statusField ? row[statusField.name] : undefined);
    if (statusField) {
      if (/在库|库存|现存/.test(statusLabel)) inStock += 1;
    } else if (outDateField) {
      const out = row[outDateField.name];
      if (!out) inStock += 1;
    } else {
      inStock += 1;
    }

    if (vitalityField) {
      const raw = row[vitalityField.name];
      if (typeof raw === 'number') {
        if (raw < 30) lowVitality += 1;
      } else {
        const label = selectLabel(vitalityField, raw).label;
        if (/低|不合格|过期/.test(label)) lowVitality += 1;
      }
    }

    if (backupField) {
      const raw = row[backupField.name];
      const label = labelOf(backupField, raw);
      if (label && /已备份|已存|完成/.test(label)) {
        // 已备份的不计入待备份
      } else if (raw === true) {
        // 布尔字段为真视为已备份
      } else {
        pendingBackup += 1;
      }
    }
  }

  return { total, inStock, lowVitality, pendingBackup };
}

/**
 * 这一行是不是「还没备份」。
 *
 * 台账里最容易被忽略的就是备份：种子丢了还能补，备份丢了就是全丢。
 * 表格用它在行首打标、页面用它做「仅看待备份」筛选。
 */
export function isPendingBackup(
  row: Record<string, unknown>,
  fields: BaserowField[],
): boolean {
  const backupField = findField(fields, ['备份状态', '是否已备份', '已备份', '备份']);
  if (!backupField) return false;
  const raw = row[backupField.name];
  if (raw === true) return false;
  if (raw === null || raw === undefined || raw === '') return true;
  const label = selectLabel(backupField, raw).label;
  if (/已备份|已存|完成|是/.test(label)) return false;
  if (/未备份|待备份|否/.test(label)) return true;
  // 备份日期填了就视为已备份
  const dateField = findField(fields, ['备份日期', '备份时间']);
  if (dateField && row[dateField.name]) return false;
  return true;
}

/**
 * 默认显示哪些列。
 *
 * 种子台账有近二十列，全展开就得左右拖；默认只给「看得懂一张台账」的关键列，
 * 其余列可以在「列设置」里勾出来。规则按字段语义猜，模板改了也能自适应。
 */
export function defaultVisibleFieldNames(fields: BaserowField[]): string[] {
  const wanted = [
    ['名称', '品名'],
    ['编号', '条码'],
    ['物种', '品种', '品系'],
    ['数量', '库存量'],
    ['单位'],
    ['存放位置', '库位'],
    ['存放柜', '冰箱'],
    ['活力等级', '活力'],
    ['是否已备份', '备份状态'],
    ['备份日期'],
  ];
  const picked: string[] = [];
  for (const words of wanted) {
    const hit = fields.find((f) => words.some((w) => f.name.includes(w)));
    if (hit && !picked.includes(hit.name)) picked.push(hit.name);
  }
  // 主字段永远显示
  const primary = fields.find((f) => f.primary);
  if (primary && !picked.includes(primary.name)) picked.unshift(primary.name);
  return picked;
}
