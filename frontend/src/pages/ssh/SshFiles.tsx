import { useCallback, useEffect, useRef, useState } from 'react';
import { App, Button, Flex, Form, Input, Modal, Popconfirm, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ArrowLeftOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FileOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  ReloadOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { sshApi } from '../../services/ssh';
import type { SshFileEntry } from '../../services/ssh-types';
import { formatDateTime, formatSize } from '../../utils/format';

function parentPath(path: string): string {
  if (path === '/' || path === '.') return path;
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function joinPath(parent: string, name: string): string {
  if (parent === '/') return `/${name}`;
  return `${parent.replace(/\/$/, '')}/${name}`;
}

function fileTypeLabel(type: SshFileEntry['type']): string {
  if (type === 'dir') return '目录';
  if (type === 'link') return '链接';
  return '文件';
}

export default function SshFiles({ sessionId }: { sessionId: string }) {
  const { message } = App.useApp();
  const [path, setPath] = useState('.');
  const [resolvedPath, setResolvedPath] = useState('.');
  const [entries, setEntries] = useState<SshFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<{ path: string; text: string; truncated: boolean } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [renameValue, setRenameValue] = useState<string | null>(null);
  const [folderForm] = Form.useForm();
  const [renameForm] = Form.useForm();
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const pathRef = useRef('.');

  const load = useCallback(async (target = pathRef.current) => {
    setLoading(true);
    try {
      const data = await sshApi.listFiles(sessionId, target);
      pathRef.current = data.path;
      setResolvedPath(data.path);
      setPath(data.path);
      setEntries(data.entries);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '目录读取失败');
    } finally {
      setLoading(false);
    }
  }, [message, sessionId]);

  useEffect(() => { void load('.'); }, [load]);

  const openEntry = (entry: SshFileEntry) => {
    if (entry.type === 'dir') void load(entry.path);
  };

  const download = async (entry: SshFileEntry) => {
    try {
      const blob = await sshApi.downloadFile(sessionId, entry.path);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = entry.name;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '下载失败');
    }
  };

  const showPreview = async (entry: SshFileEntry) => {
    setPreviewLoading(true);
    setPreview({ path: entry.path, text: '', truncated: false });
    try {
      setPreview(await sshApi.previewFile(sessionId, entry.path));
    } catch (error) {
      message.error(error instanceof Error ? error.message : '预览失败');
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const columns: ColumnsType<SshFileEntry> = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, entry) => (
        <Button type="link" icon={entry.type === 'dir' ? <FolderOpenOutlined /> : <FileOutlined />} onClick={() => openEntry(entry)} style={{ paddingInline: 0 }}>
          {name}
        </Button>
      ),
    },
    { title: '类型', dataIndex: 'type', key: 'type', width: 90, render: (type: SshFileEntry['type']) => fileTypeLabel(type) },
    { title: '大小', dataIndex: 'size', key: 'size', width: 110, render: (size: number, entry) => entry.type === 'dir' ? '—' : formatSize(size) },
    { title: '修改时间', dataIndex: 'mtime', key: 'mtime', width: 180, render: (mtime: number) => formatDateTime(mtime * 1000) },
    {
      title: '操作',
      key: 'actions',
      width: 230,
      render: (_, entry) => (
        <Space size={4}>
          {entry.type === 'file' ? <Button type="text" size="small" onClick={() => void showPreview(entry)}>预览</Button> : null}
          {entry.type === 'dir' ? null : <Button type="text" size="small" icon={<DownloadOutlined />} onClick={() => void download(entry)} />}
          <Button type="text" size="small" onClick={() => { setRenameValue(entry.path); renameForm.setFieldsValue({ name: entry.name }); }}>重命名</Button>
          <Popconfirm title="确认删除远程文件？" description="此操作直接修改远端服务器，无法从门户回收站恢复。" okText="删除" cancelText="取消" onConfirm={async () => {
            try {
              await sshApi.deleteFile(sessionId, entry.path);
              message.success('已删除');
              await load();
            } catch (error) {
              message.error(error instanceof Error ? error.message : '删除失败');
            }
          }}>
            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Flex vertical gap={12} style={{ height: '100%', minHeight: 420 }}>
      <Flex justify="space-between" align="center" wrap gap={8}>
        <Space wrap>
          <Button icon={<ArrowLeftOutlined />} disabled={resolvedPath === '/' || resolvedPath === '.'} onClick={() => void load(parentPath(resolvedPath))}>上一级</Button>
          <Button icon={<ArrowUpOutlined />} disabled={resolvedPath === '/' || resolvedPath === '.'} onClick={() => void load('/')}>根目录</Button>
          <Input value={path} onChange={(event) => setPath(event.target.value)} onPressEnter={() => void load(path)} style={{ width: 320 }} prefix={<FolderOpenOutlined />} />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>
        </Space>
        <Space wrap>
          <Button icon={<PlusOutlined />} onClick={() => { folderForm.resetFields(); setMkdirOpen(true); }}>新建目录</Button>
          <Button icon={<UploadOutlined />} onClick={() => uploadRef.current?.click()}>上传</Button>
          <input
            ref={uploadRef}
            type="file"
            hidden
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              try {
                await sshApi.uploadFile(sessionId, resolvedPath, file);
                message.success('上传完成');
                await load();
              } catch (error) {
                message.error(error instanceof Error ? error.message : '上传失败');
              }
            }}
          />
        </Space>
      </Flex>
      <Typography.Text type="secondary">当前目录：{resolvedPath} · 共 {entries.length} 项</Typography.Text>
      <Table<SshFileEntry> rowKey="path" columns={columns} dataSource={entries} loading={loading} size="small" pagination={false} scroll={{ y: 420 }} onRow={(entry) => ({ onDoubleClick: () => openEntry(entry) })} />

      <Modal title="新建远程目录" open={mkdirOpen} onCancel={() => setMkdirOpen(false)} onOk={async () => {
        const values = await folderForm.validateFields();
        const target = joinPath(resolvedPath, String(values.name || '').trim());
        try {
          await sshApi.mkdir(sessionId, target);
          message.success('目录已创建');
          setMkdirOpen(false);
          await load();
        } catch (error) {
          message.error(error instanceof Error ? error.message : '创建失败');
        }
      }}>
        <Form form={folderForm} layout="vertical">
          <Form.Item name="name" label="目录名" rules={[{ required: true, message: '请输入目录名' }]}>
            <Input placeholder="例如：analysis-results" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="重命名" open={renameValue !== null} onCancel={() => setRenameValue(null)} onOk={async () => {
        if (!renameValue) return;
        const values = await renameForm.validateFields();
        const target = joinPath(parentPath(renameValue), String(values.name || '').trim());
        try {
          await sshApi.rename(sessionId, renameValue, target);
          message.success('重命名完成');
          setRenameValue(null);
          await load();
        } catch (error) {
          message.error(error instanceof Error ? error.message : '重命名失败');
        }
      }}>
        <Form form={renameForm} layout="vertical">
          <Form.Item name="name" label="新名称" rules={[{ required: true, message: '请输入新名称' }]}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title={`文件预览 · ${preview?.path ?? ''}`} open={preview !== null} onCancel={() => setPreview(null)} footer={null} width={820}>
        {previewLoading ? <Typography.Text type="secondary">正在读取远程文件…</Typography.Text> : (
          <Input.TextArea value={preview?.text ?? ''} readOnly autoSize={{ minRows: 12, maxRows: 26 }} />
        )}
        {preview?.truncated ? <Typography.Text type="warning">内容超过预览上限，仅显示前 256 KB。</Typography.Text> : null}
      </Modal>
    </Flex>
  );
}
