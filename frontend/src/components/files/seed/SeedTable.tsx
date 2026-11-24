/**
 * 种子台账的轻量多维表格。
 *
 * 与 BaserowPage 的完整视图不同，这里只做「种子管理」需要的四件事：
 * 按字段类型渲染、行内编辑、分页排序、搜索。
 * 字段顺序与类型都来自 Baserow 模板，前端不写死列。
 */
import { useState } from 'react';
import {
  Button,
  Card,
  DatePicker,
  Empty,
  Flex,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, EditOutlined, EyeOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import type { BaserowField, BaserowRow } from '../../../services/api';
import { renderSeedValue } from './SeedValue';
import { isPendingBackup, optionId } from './seedMeta';

/** 单元格写回 Baserow 的值形状。 */
export type SeedCellValue = string | number | boolean | null;

/** 行内编辑支持的字段类型：其余类型只能进抽屉整体编辑。 */
const INLINE_TYPES = new Set(['text', 'long_text', 'number', 'date', 'single_select', 'boolean']);

export interface SeedTableProps {
  fields: BaserowField[];
  rows: BaserowRow[];
  total: number;
  loading: boolean;
  page: number;
  size: number;
  search: string;
  orderBy: string;
  /** 只显示这些字段（列设置）；不传就全显示。 */
  visibleFieldNames?: string[];
  onOrder: (orderBy: string) => void;
  onPage: (page: number, size: number) => void;
  onOpenRow: (row: BaserowRow) => void;
  onEditRow: (row: BaserowRow) => void;
  /** 行内保存：把单元格的新值写回 Baserow。 */
  onSaveCell: (row: BaserowRow, field: BaserowField, value: SeedCellValue) => void;
  /** 删除一行（台账里作废的记录）。 */
  onDeleteRow?: (row: BaserowRow) => void;
}

/** 把 Baserow 值转成编辑器需要的形状。 */
function toEditorValue(field: BaserowField, value: unknown): string | number | boolean | Dayjs | undefined {
  if (value === null || value === undefined || value === '') {
    if (field.type === 'boolean') return false;
    return undefined;
  }
  if (field.type === 'date') {
    const d = dayjs(String(value));
    return d.isValid() ? d : undefined;
  }
  if (field.type === 'single_select') {
    const id = optionId(value);
    return id === undefined ? undefined : (typeof id === 'number' ? id : String(id));
  }
  if (field.type === 'number') return typeof value === 'number' ? value : Number(value);
  if (field.type === 'boolean') return Boolean(value);
  return String(value);
}

/** 编辑器值转回 Baserow 能接受的形状。 */
function fromEditorValue(
  field: BaserowField,
  value: string | number | boolean | Dayjs | undefined,
): SeedCellValue {
  if (field.type === 'date') {
    return typeof value === 'object' && value !== null && 'format' in value
      ? (value as Dayjs).format('YYYY-MM-DD')
      : null;
  }
  if (field.type === 'number') return typeof value === 'number' ? value : null;
  if (field.type === 'boolean') return Boolean(value);
  if (value === undefined || value === '') return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return null;
}

/** 可行内编辑的单元格：点一下进入编辑，Enter 保存、Esc 取消、失焦保存。 */
function InlineCell({
  field,
  row,
  onSave,
}: {
  field: BaserowField;
  row: BaserowRow;
  onSave: (row: BaserowRow, field: BaserowField, value: SeedCellValue) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | number | boolean | Dayjs | undefined>(undefined);
  const raw = row[field.name];

  if (!editing) {
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={`编辑 ${field.name}`}
        onClick={() => {
          setDraft(toEditorValue(field, raw));
          setEditing(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setDraft(toEditorValue(field, raw));
            setEditing(true);
          }
        }}
        style={{ cursor: 'pointer', minHeight: 22 }}
      >
        {renderSeedValue(field, raw)}
      </div>
    );
  }

  const commit = () => {
    onSave(row, field, fromEditorValue(field, draft));
    setEditing(false);
  };

  const cancel = () => {
    setEditing(false);
  };

  return (
    <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {field.type === 'number' ? (
        <InputNumber
          size="small"
          autoFocus
          style={{ width: '100%' }}
          value={typeof draft === 'number' ? draft : undefined}
          onChange={(v) => setDraft(v ?? undefined)}
          onPressEnter={commit}
          onBlur={commit}
        />
      ) : field.type === 'date' ? (
        <div
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
            if (e.key === 'Escape') cancel();
          }}
        >
          <DatePicker
            size="small"
            autoFocus
            style={{ width: '100%' }}
            value={draft && typeof draft === 'object' ? draft : undefined}
            onChange={(v) => {
              setDraft(v ?? undefined);
              onSave(row, field, v ? v.format('YYYY-MM-DD') : null);
              setEditing(false);
            }}
          />
        </div>
      ) : field.type === 'single_select' ? (
        <Select
          size="small"
          autoFocus
          allowClear
          style={{ width: '100%' }}
          value={draft as string | number | undefined}
          options={field.select_options.map((o) => ({ value: o.id, label: o.value }))}
          onChange={(v) => {
            setDraft(v ?? undefined);
            onSave(row, field, v ?? null);
            setEditing(false);
          }}
        />
      ) : field.type === 'boolean' ? (
        <Switch
          size="small"
          checked={Boolean(draft)}
          onChange={(checked) => {
            setDraft(checked);
            onSave(row, field, checked);
            setEditing(false);
          }}
        />
      ) : (
        <Input
          size="small"
          autoFocus
          value={typeof draft === 'string' ? draft : ''}
          onChange={(e) => setDraft(e.target.value)}
          onPressEnter={commit}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') cancel();
          }}
        />
      )}
    </div>
  );
}

export default function SeedTable({
  fields,
  rows,
  total,
  loading,
  page,
  size,
  search,
  orderBy,
  visibleFieldNames,
  onOrder,
  onPage,
  onOpenRow,
  onEditRow,
  onSaveCell,
  onDeleteRow,
}: SeedTableProps) {
  // 操作列的无障碍文案用主字段（种子名称）指代记录。
  const primaryName = fields.find((f) => f.primary)?.name ?? fields[0]?.name;
  const rowLabel = (row: BaserowRow) => String(row[primaryName ?? ''] ?? '记录');

  // 列设置：只渲染选中的字段，顺序仍按模板给���的来。
  const shown = visibleFieldNames?.length
    ? fields.filter((f) => visibleFieldNames.includes(f.name))
    : fields;

  const columns: ColumnsType<BaserowRow> = shown.map((f) => {
    const sortOrder: 'ascend' | 'descend' | null = orderBy === `-${f.name}`
      ? 'descend'
      : orderBy === f.name
        ? 'ascend'
        : null;
    return {
      title: <span>{f.name}</span>,
      dataIndex: f.name,
      key: f.name,
      ellipsis: true,
      // 文件字段不能排序（Baserow 会对 order_by 报错）
      sorter: f.type !== 'file',
      sortOrder,
      // 名称列固定在左侧，行多了也认得出是哪一条。
      fixed: f.name === primaryName && shown.length > 6 ? 'left' : undefined,
      width: f.name === primaryName ? 160 : undefined,
      render: (_: unknown, row: BaserowRow) => (
        <Space size={6}>
          {INLINE_TYPES.has(f.type) ? (
            <InlineCell field={f} row={row} onSave={onSaveCell} />
          ) : (
            renderSeedValue(f, row[f.name])
          )}
          {f.name === primaryName && isPendingBackup(row, fields) ? (
            <Tag color="warning" style={{ marginInlineEnd: 0 }}>
              待备份
            </Tag>
          ) : null}
        </Space>
      ),
    };
  });

  columns.push({
    title: '操作',
    key: '__actions',
    width: onDeleteRow ? 128 : 88,
    fixed: 'right',
    render: (_: unknown, row: BaserowRow) => (
      <Space size={2}>
        <Tooltip title="详情">
          <Button
            size="small"
            type="text"
            icon={<EyeOutlined />}
            aria-label={`查看 ${rowLabel(row)} 详情`}
            onClick={() => onOpenRow(row)}
          />
        </Tooltip>
        <Tooltip title="编辑">
          <Button
            size="small"
            type="text"
            icon={<EditOutlined />}
            aria-label={`编辑 ${rowLabel(row)}`}
            onClick={() => onEditRow(row)}
          />
        </Tooltip>
        {onDeleteRow ? (
          <Popconfirm
            title="删除这条种子记录？"
            description="删掉后下方提示里可以「撤销」；只是笔误的话，关掉后改个名字即可。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => onDeleteRow(row)}
          >
            <Tooltip title="删除">
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                aria-label={`删除 ${rowLabel(row)}`}
              />
            </Tooltip>
          </Popconfirm>
        ) : null}
      </Space>
    ),
  });

  return (
    <Table<BaserowRow>
      rowKey="id"
      size="small"
      loading={loading}
      columns={columns}
      dataSource={rows}
      scroll={{ x: 'max-content' }}
      pagination={{
        current: page,
        pageSize: size,
        total,
        showSizeChanger: true,
        pageSizeOptions: [20, 50, 100, 200],
        showTotal: (t) => `共 ${t} 条`,
        onChange: (p, s) => onPage(p, s),
      }}
      onChange={(_p, _f, sorter) => {
        const s = Array.isArray(sorter) ? sorter[0] : sorter;
        const field = s?.field;
        if (!s?.order || !field) {
          onOrder('');
          return;
        }
        onOrder(`${s.order === 'descend' ? '-' : ''}${String(field)}`);
      }}
      locale={{
        emptyText: (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={search ? `没有匹配「${search}」的记录` : '还没有种子记录'}
          />
        ),
      }}
    />
  );
}

/** 顶部统计条：总数 / 在库 / 低活力 / 待备份（用 antd Statistic 渲染）。 */
export function SeedStatsBar({
  total,
  inStock,
  lowVitality,
  pendingBackup,
  extra,
}: {
  total: number;
  inStock: number;
  lowVitality: number;
  pendingBackup: number;
  extra?: React.ReactNode;
}) {
  const items: { title: string; value: number; color?: string }[] = [
    // 后三项只统计**当前页**（服务端一次只给一页）。标题里直接标出来，
    // 否则用户会把它当全局数字 —— 那比不显示更糟。
    { title: '种子总数', value: total },
    { title: '本页在库', value: inStock, color: '#16A34A' },
    { title: '本页低活力', value: lowVitality, color: '#DC2626' },
    { title: '本页待备份', value: pendingBackup, color: '#D97706' },
  ];
  return (
    <Flex gap={12} wrap align="stretch">
      {items.map((it) => (
        <Card key={it.title} size="small" style={{ flex: '1 1 150px', minWidth: 140 }}>
          <Statistic
            title={it.title}
            value={it.value}
            styles={{ content: { fontSize: 24, color: it.color } }}
          />
        </Card>
      ))}
      {extra ? <div style={{ flex: '1 1 200px' }}>{extra}</div> : null}
    </Flex>
  );
}
