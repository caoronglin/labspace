import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Empty, Input, Segmented, Space, Table, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { api, type OfficeContent, type OfficeSheet } from '../../services/api';
import { errText } from '../../utils/err';
import OfficeToolbar from './OfficeToolbar';

type Props = {
  entryId: string;
  data: OfficeContent;
  onSaved: () => void;
};

type SheetRow = { key: number; cells: string[] };

function excelColumn(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function cloneSheets(sheets: OfficeSheet[]): OfficeSheet[] {
  return sheets.map((s) => ({ ...s, rows: s.rows.map((r) => [...r]) }));
}

/** 表格：窗口化读取（500×60），只提交发生变化的单元格，保留公式与其它工作表。 */
export default function XlsxEditor({ entryId, data, onSaved }: Props) {
  const { message, modal } = App.useApp();
  const initial = useMemo(() => cloneSheets(data.sheets ?? []), [data]);
  const [sheets, setSheets] = useState<OfficeSheet[]>(initial);
  const [active, setActive] = useState(0);
  const [base, setBase] = useState(() => JSON.stringify(initial));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSheets(initial);
    setBase(JSON.stringify(initial));
    setActive(0);
  }, [initial]);

  const dirty = JSON.stringify(sheets) !== base;
  const sheet = sheets[active];

  const cols = Math.min(Math.max(12, sheet?.maxCol ?? 12), 60);
  const rowCount = Math.max(sheet?.rows.length ?? 0, 20);

  const dataSource = useMemo<SheetRow[]>(
    () =>
      Array.from({ length: rowCount }, (_, r) => ({
        key: r,
        cells: sheet?.rows[r] ?? [],
      })),
    [rowCount, sheet],
  );

  const updateCell = useCallback(
    (row: number, col: number, value: string) => {
      setSheets((prev) =>
        prev.map((s, i) => {
          if (i !== active) return s;
          const rows = s.rows.map((r) => [...r]);
          while (rows.length <= row) rows.push([]);
          while (rows[row].length <= col) rows[row].push('');
          rows[row][col] = value;
          return { ...s, rows };
        }),
      );
    },
    [active],
  );

  const columns = useMemo(
    () => [
      {
        title: '',
        key: 'rowno',
        width: 52,
        fixed: 'left' as const,
        render: (_: unknown, __: SheetRow, index: number) => (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {index + 1}
          </Typography.Text>
        ),
      },
      ...Array.from({ length: cols }, (_, c) => ({
        title: excelColumn(c),
        key: `c${c}`,
        width: 132,
        render: (_: unknown, record: SheetRow) => (
          <Input
            value={record.cells[c] ?? ''}
            variant="borderless"
            onChange={(e) => updateCell(record.key, c, e.target.value)}
            style={{ fontSize: 13, paddingInline: 4 }}
          />
        ),
      })),
    ],
    [cols, updateCell],
  );

  const addRow = () => {
    setSheets((prev) =>
      prev.map((s, i) =>
        i === active
          ? { ...s, rows: [...s.rows, Array.from({ length: cols }, () => '')], maxRow: s.maxRow + 1 }
          : s,
      ),
    );
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.officeSave(entryId, { kind: 'xlsx', sheets });
      setBase(JSON.stringify(sheets));
      message.success(`已保存（${Math.max(1, Math.round(res.size / 1024))} KB）`);
      onSaved();
    } catch (e) {
      message.error(`保存失败：${errText(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    if (!dirty) return;
    modal.confirm({
      title: '还原所有未保存修改？',
      okText: '还原',
      cancelText: '取消',
      onOk: () => {
        setSheets(initial);
        setBase(JSON.stringify(initial));
      },
    });
  };

  if (!sheet) {
    return <Empty description="该工作簿没有可编辑的工作表" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
      <OfficeToolbar
        label="XLSX 编辑"
        hint={
          data.normalized
            ? '旧版 .xls：保存时会自动转回原格式'
            : `仅前 ${sheet.window.rows} 行 × ${sheet.window.cols} 列可在网页中编辑，窗口外保持原值`
        }
        dirty={dirty}
        saving={saving}
        onReset={reset}
        onSave={save}
        extra={
          <Button size="small" icon={<PlusOutlined />} onClick={addRow}>
            追加行
          </Button>
        }
      />
      <Space size={8} wrap>
        <Segmented
          value={active}
          onChange={(v) => setActive(Number(v))}
          options={sheets.map((s, i) => ({ label: s.name || `Sheet${i + 1}`, value: i }))}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {sheet.maxRow} 行 × {sheet.maxCol} 列（原始范围）
        </Typography.Text>
      </Space>
      {sheet.rows.length >= sheet.window.rows || sheet.maxCol >= sheet.window.cols ? (
        <Alert
          type="info"
          showIcon
          title="工作表超出网页编辑窗口"
          description={`当前只展示前 ${sheet.window.rows} 行 × ${sheet.window.cols} 列；窗口外的单元格不会被改动。`}
        />
      ) : null}
      <div style={{ border: '1px solid var(--ant-color-border-secondary)', borderRadius: 10, overflow: 'hidden' }}>
        <Table<SheetRow>
          size="small"
          virtual
          rowKey="key"
          dataSource={dataSource}
          columns={columns}
          pagination={false}
          scroll={{ x: cols * 132 + 52, y: 480 }}
        />
      </div>
    </div>
  );
}
