import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Alert, App, Empty, Input, Typography } from 'antd';
import { api, type OfficeBlock, type OfficeContent, type OfficeTableBlock } from '../../services/api';
import { errText } from '../../utils/err';
import OfficeToolbar from './OfficeToolbar';

type Props = {
  entryId: string;
  data: OfficeContent;
  onSaved: () => void;
};

function paragraphStyle(style: string): CSSProperties {
  const name = style.toLowerCase();
  if (name.includes('title') || name === '标题') {
    return { fontSize: 26, fontWeight: 700, textAlign: 'center', lineHeight: 1.5 };
  }
  if (name.includes('heading 1') || name === '标题 1' || name === 'h1') {
    return { fontSize: 22, fontWeight: 650, lineHeight: 1.5, marginTop: 10 };
  }
  if (name.includes('heading 2') || name === '标题 2' || name === 'h2') {
    return { fontSize: 18, fontWeight: 600, lineHeight: 1.6, marginTop: 8 };
  }
  if (name.includes('heading 3') || name === '标题 3' || name === 'h3') {
    return { fontSize: 16, fontWeight: 600, lineHeight: 1.6, marginTop: 6 };
  }
  return { fontSize: 14, lineHeight: 1.85 };
}

const TableBlock = memo(function TableBlock({
  block,
  onCell,
}: {
  block: OfficeTableBlock;
  onCell: (index: number, row: number, col: number, value: string) => void;
}) {
  return (
    <div style={{ overflowX: 'auto', margin: '10px 0' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td
                  key={c}
                  style={{
                    border: '1px solid var(--ant-color-border-secondary)',
                    padding: 0,
                    minWidth: 100,
                    verticalAlign: 'top',
                  }}
                >
                  <Input.TextArea
                    value={cell}
                    variant="borderless"
                    autoSize={{ minRows: 1 }}
                    onChange={(e) => onCell(block.index, r, c, e.target.value)}
                    style={{ padding: '6px 8px', fontSize: 13, lineHeight: 1.6 }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

/** Word 文档：按段落/表格逐块编辑，保留段落样式与首个 run 的字体。 */
export default function DocxEditor({ entryId, data, onSaved }: Props) {
  const { message, modal } = App.useApp();
  const initial = useMemo(() => data.blocks ?? [], [data]);
  const [blocks, setBlocks] = useState<OfficeBlock[]>(initial);
  const [base, setBase] = useState(() => JSON.stringify(initial));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setBlocks(initial);
    setBase(JSON.stringify(initial));
  }, [initial]);

  const dirty = JSON.stringify(blocks) !== base;

  const updateParagraph = useCallback((index: number, text: string) => {
    setBlocks((prev) =>
      prev.map((b) =>
        b.index === index && b.type === 'paragraph'
          ? { ...b, text }
          : b,
      ),
    );
  }, []);

  const updateCell = useCallback((index: number, row: number, col: number, value: string) => {
    setBlocks((prev) =>
      prev.map((b) => {
        if (b.index !== index || b.type !== 'table') return b;
        const rows = b.rows.map((r, ri) =>
          ri === row ? r.map((cell, ci) => (ci === col ? value : cell)) : r,
        );
        return { ...b, rows };
      }),
    );
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.officeSave(entryId, { kind: 'docx', blocks });
      setBase(JSON.stringify(blocks));
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
        setBlocks(initial);
        setBase(JSON.stringify(initial));
      },
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
      <OfficeToolbar
        label="DOCX 编辑"
        hint={data.normalized ? '旧版 .doc：保存时会自动转回原格式' : '仅修改文字内容，复杂行内格式会退化为单一文本段'}
        dirty={dirty}
        saving={saving}
        onReset={reset}
        onSave={save}
      />
      {data.truncated ? (
        <Alert
          type="warning"
          showIcon
          title="段落数量超过网页编辑上限"
          description="仅前 4000 个段落/表格可编辑；未展示的内容在保存时会原样保留。"
        />
      ) : null}
      <div
        style={{
          overflow: 'auto',
          maxHeight: 'min(74vh, 860px)',
          background: 'var(--ant-color-fill-quaternary)',
          borderRadius: 10,
          padding: '24px 16px',
        }}
      >
        <div
          style={{
            maxWidth: 820,
            minHeight: 480,
            margin: '0 auto',
            background: '#fff',
            borderRadius: 4,
            boxShadow: '0 8px 28px rgba(15, 23, 42, 0.12)',
            padding: '48px 56px',
          }}
        >
          {blocks.length === 0 ? (
            <Empty description="该文档没有可编辑的段落" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            blocks.map((block) =>
              block.type === 'table' ? (
                <TableBlock key={block.index} block={block} onCell={updateCell} />
              ) : (
                <Input.TextArea
                  key={block.index}
                  value={block.text}
                  variant="borderless"
                  autoSize={{ minRows: 1 }}
                  placeholder="空段落"
                  onChange={(e) => updateParagraph(block.index, e.target.value)}
                  style={{
                    ...paragraphStyle(block.style),
                    padding: '2px 0',
                    resize: 'none',
                    color: 'var(--ant-color-text)',
                  }}
                />
              ),
            )
          )}
        </div>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        共 {blocks.length} 个块；保存后立即覆盖原文件，下载与其它页面同步更新。
      </Typography.Text>
    </div>
  );
}
