/**
 * 种子记录详情抽屉：一次看全所有字段 + 附件下载 + 备份状态提示。
 */
import { Alert, Button, Descriptions, Drawer, Flex, Grid, Space, Typography } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import type { BaserowField, BaserowRow } from '../../../services/api';
import { FileList, renderSeedValue, toFileList } from './SeedValue';
import { findField, selectLabel } from './seedMeta';

export interface SeedDetailDrawerProps {
  open: boolean;
  fields: BaserowField[];
  row: BaserowRow | null;
  onClose: () => void;
  onEdit: (row: BaserowRow) => void;
}

/** 备份状态：字段里的文本/选项决定这条记录是不是还欠一份备份。 */
function backupHint(fields: BaserowField[], row: BaserowRow): { text: string; done: boolean } | null {
  const field = findField(fields, ['备份状态', '备份']);
  if (!field) return null;
  const raw = row[field.name];
  if (field.type === 'single_select') {
    const label = selectLabel(field, raw).label;
    return { text: label || '未标记备份状态', done: /已备份|已存|完成/.test(label) };
  }
  if (field.type === 'boolean') {
    return { text: raw ? '已备份' : '待备份', done: Boolean(raw) };
  }
  const text = raw ? String(raw) : '待备份';
  return { text, done: /已备份|已存|完成/.test(text) };
}

export default function SeedDetailDrawer({
  open,
  fields,
  row,
  onClose,
  onEdit,
}: SeedDetailDrawerProps) {
  const screens = Grid.useBreakpoint();
  const narrow = !screens.md;

  if (!row) {
    return <Drawer open={false} onClose={onClose} />;
  }

  const backup = backupHint(fields, row);
  const fileFields = fields.filter((f) => f.type === 'file');
  const primary = fields.find((f) => f.primary);
  const title = primary ? String(row[primary.name] ?? '种子记录') : '种子记录';

  return (
    <Drawer
      open={open}
      title={title}
      size={narrow ? '100%' : 560}
      onClose={onClose}
      destroyOnHidden
      extra={
        <Button
          type="primary"
          icon={<EditOutlined />}
          onClick={() => {
            onClose();
            onEdit(row);
          }}
        >
          编辑
        </Button>
      }
    >
      <Flex vertical gap={16}>
        {backup ? (
          <Alert
            type={backup.done ? 'success' : 'warning'}
            showIcon
            title={backup.done ? '备份状态正常' : '该记录待备份'}
            description={backup.text}
          />
        ) : null}
        <Descriptions
          bordered
          size="small"
          column={narrow ? 1 : 2}
          items={fields
            .filter((f) => f.type !== 'file')
            .map((f) => ({
              key: String(f.id),
              label: f.name,
              children: renderSeedValue(f, row[f.name]),
            }))}
        />
        {fileFields.length ? (
          <div>
            <Typography.Title level={5}>附件</Typography.Title>
            <Space orientation="vertical" size={10} style={{ width: '100%' }}>
              {fileFields.map((f) => (
                <div key={String(f.id)}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {f.name}
                  </Typography.Text>
                  <div>
                    <FileList files={toFileList(row[f.name])} />
                  </div>
                </div>
              ))}
            </Space>
          </div>
        ) : null}
      </Flex>
    </Drawer>
  );
}
