import { useEffect, useState } from 'react';
import { Alert, Button, Modal, Spin, Tag, Typography } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { api, type FileEntry, type OfficeContent } from '../../services/api';
import { errText } from '../../utils/err';
import { officeAdapterFor } from './registry';

type Props = {
  entry: FileEntry | null;
  open: boolean;
  mode: 'edit' | 'present';
  onClose: () => void;
  onSaved?: () => void;
};

/** 文件管理的 Office 工作区：编辑走结构化读写，放映只对演示文稿开放。 */
export default function OfficeWorkspace({ entry, open, mode, onClose, onSaved }: Props) {
  const adapter = entry ? officeAdapterFor(entry.name) : null;
  const [data, setData] = useState<OfficeContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadAt, setReloadAt] = useState(0);

  useEffect(() => {
    if (!open || mode !== 'edit' || !entry || !adapter) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setData(null);
    api
      .officeContent(entry.id)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errText(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, mode, entry, adapter, reloadAt]);

  if (!entry || !adapter) return null;

  if (mode === 'present' && adapter.Presentation) {
    const Presentation = adapter.Presentation;
    return (
      <Presentation
        entryId={entry.id}
        name={entry.name}
        open={open}
        onClose={onClose}
      />
    );
  }

  return (
    <Modal
      open={open && mode === 'edit'}
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <EditOutlined />
          <span>{entry.name}</span>
          <Tag color="blue" variant="filled">
            {adapter.label}
          </Tag>
        </span>
      }
      width="min(1280px, 96vw)"
      style={{ top: 24, maxWidth: '96vw' }}
      onCancel={onClose}
      destroyOnHidden
      maskClosable={false}
      footer={null}
    >
      {loading ? (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Spin tip="正在读取文档内容…">
            <div style={{ height: 80 }} />
          </Spin>
        </div>
      ) : error ? (
        <Alert
          type="error"
          showIcon
          title="无法打开该文档"
          description={errText(error)}
          action={
            <Button size="small" onClick={() => setReloadAt((n) => n + 1)}>
              重试
            </Button>
          }
        />
      ) : data ? (
        <adapter.Editor
          entryId={entry.id}
          data={data}
          onSaved={() => {
            onSaved?.();
          }}
        />
      ) : (
        <Typography.Text type="secondary">没有可编辑内容</Typography.Text>
      )}
    </Modal>
  );
}
