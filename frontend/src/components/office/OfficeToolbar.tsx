import type { ReactNode } from 'react';
import { Button, Card, Flex, Space, Tag, Typography } from 'antd';
import { CheckCircleOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';

type Props = {
  label: string;
  hint?: string;
  dirty: boolean;
  saving: boolean;
  onReset: () => void;
  onSave: () => void;
  extra?: ReactNode;
};

/** 三类 Office 编辑器共用的顶部工具条，保持与门户其它页面同一套 AntD 视觉。 */
export default function OfficeToolbar({ label, hint, dirty, saving, onReset, onSave, extra }: Props) {
  return (
    <Card size="small" styles={{ body: { padding: '8px 12px' } }}>
      <Flex align="center" justify="space-between" gap={12} wrap>
        <Space size={8} wrap>
          <Tag color="blue" variant="filled">
            {label}
          </Tag>
          {dirty ? <Tag color="orange">未保存</Tag> : <Tag icon={<CheckCircleOutlined />}>已同步</Tag>}
          {hint ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {hint}
            </Typography.Text>
          ) : null}
        </Space>
        <Space size={8} wrap>
          {extra}
          <Button size="small" icon={<ReloadOutlined />} disabled={!dirty || saving} onClick={onReset}>
            还原
          </Button>
          <Button
            size="small"
            type="primary"
            icon={<SaveOutlined />}
            loading={saving}
            disabled={!dirty}
            onClick={onSave}
          >
            保存覆盖
          </Button>
        </Space>
      </Flex>
    </Card>
  );
}
