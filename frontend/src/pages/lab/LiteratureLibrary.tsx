import { useMemo, useState } from 'react';
import {
  App,
  Button,
  Card,
  Checkbox,
  Dropdown,
  Drawer,
  Empty,
  Flex,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Tag,
  Tree,
  Typography,
} from 'antd';
import type { TreeDataNode } from 'antd';
import {
  BookOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  FolderOutlined,
  FolderOpenOutlined,
  LinkOutlined,
  PlusOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api, type LabopsLibrary, type LabopsLibraryFolder, type LabopsLiterature } from '../../services/api';

const STATUS: Record<string, { color: string; label: string }> = {
  unread: { color: 'default', label: '未读' },
  reading: { color: 'processing', label: '在读' },
  read: { color: 'green', label: '已读' },
};

const LIBRARY_COLORS = ['#1677ff', '#52c41a', '#fa8c16', '#722ed1', '#eb2f96', '#13c2c2'];

/** 文件夹树的三个固定节点：全部文献 / 未分类 / 用户自建文件夹。 */
const ALL_KEY = '__all__';
const ROOT_KEY = '__root__';

export default function LiteratureLibrary() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [keyword, setKeyword] = useState('');
  const [semanticQ, setSemanticQ] = useState('');
  const [status, setStatus] = useState('');
  const [libraryId, setLibraryId] = useState('');
  const [folderKey, setFolderKey] = useState(ALL_KEY);
  const [importOpen, setImportOpen] = useState(false);
  const [editItem, setEditItem] = useState<LabopsLiterature | null>(null);
  const [citeItem, setCiteItem] = useState<LabopsLiterature | null>(null);
  const [citeText, setCiteText] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [libraryModalOpen, setLibraryModalOpen] = useState(false);
  const [editingLibrary, setEditingLibrary] = useState<LabopsLibrary | null>(null);
  const [deletingLibrary, setDeletingLibrary] = useState<LabopsLibrary | null>(null);
  const [libraryTarget, setLibraryTarget] = useState('');
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [editingFolder, setEditingFolder] = useState<LabopsLibraryFolder | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<LabopsLibraryFolder | null>(null);
  const [folderTarget, setFolderTarget] = useState('root');
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveIds, setMoveIds] = useState<string[]>([]);
  const [moveLibrary, setMoveLibrary] = useState('');
  const [moveFolder, setMoveFolder] = useState('');
  const [importForm] = Form.useForm();
  const [editForm] = Form.useForm();
  const [libraryForm] = Form.useForm();
  const [folderForm] = Form.useForm();

  const libraries = useQuery({ queryKey: ['labops', 'libraries'], queryFn: () => api.labopsLibraries() });
  const libraryItems = libraries.data?.items ?? [];
  const defaultId = libraries.data?.defaultId ?? '';
  const activeLibraryId = libraryId || defaultId;

  const folders = useQuery({
    queryKey: ['labops', 'library-folders', activeLibraryId],
    queryFn: () => api.labopsLibraryFolders(activeLibraryId),
    enabled: Boolean(activeLibraryId),
  });
  const folderItems = folders.data?.items ?? [];

  // folderParam：undefined = 整个库，'' = 未分类，其余是具体文件夹
  const folderParam = folderKey === ALL_KEY ? undefined : folderKey === ROOT_KEY ? '' : folderKey;

  const list = useQuery({
    queryKey: ['labops', 'literature', keyword, status, activeLibraryId, folderParam],
    queryFn: () => api.labopsLiterature(keyword, status, activeLibraryId, folderParam),
  });
  const semantic = useQuery({
    queryKey: ['labops', 'literature-search', semanticQ],
    queryFn: () => api.labopsLiteratureSearch(semanticQ),
    enabled: semanticQ.trim().length > 0,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['labops', 'literature'] });
    qc.invalidateQueries({ queryKey: ['labops', 'libraries'] });
    qc.invalidateQueries({ queryKey: ['labops', 'library-folders'] });
  };

  const importDoi = useMutation({
    mutationFn: (values: { doi?: string; title?: string; tags?: string[] }) =>
      api.labopsImportLiterature({
        ...values,
        library_id: activeLibraryId,
        folder_id: folderParam ?? '',
      }),
    onSuccess: (r) => {
      message.success(r.duplicate ? '该 DOI 已在库中' : '已导入文献');
      setImportOpen(false);
      importForm.resetFields();
      refresh();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const update = useMutation({
    mutationFn: (values: Partial<LabopsLiterature>) => api.labopsUpdateLiterature(editItem!.id, values),
    onSuccess: () => {
      message.success('已保存');
      setEditItem(null);
      refresh();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const remove = useMutation({
    mutationFn: api.labopsDeleteLiterature,
    onSuccess: () => {
      message.success('已删除');
      refresh();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const saveLibrary = useMutation({
    mutationFn: (values: { name: string; description?: string; color?: string }) =>
      editingLibrary
        ? api.labopsUpdateLibrary(editingLibrary.id, values)
        : api.labopsCreateLibrary(values),
    onSuccess: () => {
      message.success(editingLibrary ? '已更新文献库' : '已创建文献库');
      setLibraryModalOpen(false);
      setEditingLibrary(null);
      libraryForm.resetFields();
      refresh();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const deleteLibrary = useMutation({
    mutationFn: ({ id, moveTo }: { id: string; moveTo?: string }) => api.labopsDeleteLibrary(id, moveTo),
    onSuccess: (r) => {
      message.success(r.moved ? `已删除文献库，${r.moved} 篇文献已转移` : '已删除文献库');
      setDeletingLibrary(null);
      setLibraryTarget('');
      if (libraryId) setLibraryId('');
      refresh();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const saveFolder = useMutation({
    mutationFn: (values: { name: string; parent_id?: string }) =>
      editingFolder
        ? api.labopsUpdateLibraryFolder(editingFolder.id, values)
        : api.labopsCreateLibraryFolder(activeLibraryId, values),
    onSuccess: () => {
      message.success(editingFolder ? '已重命名文件夹' : '已创建文件夹');
      setFolderModalOpen(false);
      setEditingFolder(null);
      folderForm.resetFields();
      refresh();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const deleteFolder = useMutation({
    mutationFn: ({ id, moveTo }: { id: string; moveTo?: string }) => api.labopsDeleteLibraryFolder(id, moveTo),
    onSuccess: (r) => {
      message.success(r.moved ? `已删除文件夹，${r.moved} 篇文献已转移` : '已删除文件夹');
      setDeletingFolder(null);
      setFolderKey(ALL_KEY);
      refresh();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const moveLiterature = useMutation({
    mutationFn: (values: { ids: string[]; libraryId: string; folderId: string }) =>
      api.labopsMoveLiterature(values.ids, values.libraryId, values.folderId),
    onSuccess: (r) => {
      message.success(`已移动 ${r.moved} 篇文献`);
      setMoveOpen(false);
      setMoveIds([]);
      setSelectedIds([]);
      refresh();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const showCite = async (item: LabopsLiterature, style: string) => {
    try {
      const text = await api.labopsCitation(item.id, style);
      setCiteItem(item);
      setCiteText(text);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const items = semanticQ ? semantic.data?.items ?? [] : list.data?.items ?? [];

  const treeData = useMemo<TreeDataNode[]>(() => {
    const nodes = new Map<string, TreeDataNode>();
    const roots: TreeDataNode[] = [];
    folderItems.forEach((f) => nodes.set(f.id, { key: f.id, title: `${f.name}（${f.item_count}）` }));
    folderItems.forEach((f) => {
      const node = nodes.get(f.id)!;
      const parent = f.parent_id ? nodes.get(f.parent_id) : undefined;
      if (parent) parent.children = [...(parent.children ?? []), node];
      else roots.push(node);
    });
    return [
      { key: ALL_KEY, title: '全部文献' },
      { key: ROOT_KEY, title: '未分类' },
      ...roots,
    ];
  }, [folderItems]);

  const currentFolder = folderItems.find((f) => f.id === folderKey) ?? null;
  const activeLibrary = libraryItems.find((l) => l.id === activeLibraryId) ?? null;

  const openMove = (ids: string[]) => {
    setMoveIds(ids);
    setMoveLibrary(activeLibraryId);
    setMoveFolder(folderParam ?? '');
    setMoveOpen(true);
  };

  const moveFolderOptions = useQuery({
    queryKey: ['labops', 'library-folders', moveLibrary],
    queryFn: () => api.labopsLibraryFolders(moveLibrary),
    enabled: moveOpen && Boolean(moveLibrary),
  });

  return (
    <Flex vertical gap={16}>
      <Card
        title={
          <Space>
            <BookOutlined />
            我的文献库
          </Space>
        }
        extra={
          <Dropdown
            menu={{
              items: [
                { key: 'bibtex', label: '导出 BibTeX' },
                { key: 'ris', label: '导出 RIS' },
                { key: 'gbt7714', label: '导出 GB/T 7714' },
                { key: 'apa', label: '导出 APA' },
              ],
              onClick: ({ key }) => window.open(api.labopsLiteratureExportUrl([], key), '_blank'),
            }}
          >
            <Button icon={<DownloadOutlined />}>导出引用</Button>
          </Dropdown>
        }
      >
        <Flex gap={12} wrap style={{ marginBottom: 12 }}>
          <Select
            style={{ width: 220 }}
            value={activeLibraryId || undefined}
            onChange={(v) => {
              setLibraryId(v);
              setFolderKey(ALL_KEY);
              setSelectedIds([]);
            }}
            options={libraryItems.map((lib) => ({
              value: lib.id,
              label: (
                <Space size={6}>
                  {lib.color && <span style={{ color: lib.color }}>●</span>}
                  {lib.name}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {lib.item_count}
                  </Typography.Text>
                </Space>
              ),
            }))}
            placeholder="选择文献库"
          />
          <Button
            icon={<PlusOutlined />}
            onClick={() => {
              setEditingLibrary(null);
              libraryForm.resetFields();
              setLibraryModalOpen(true);
            }}
          >
            新建文献库
          </Button>
          {activeLibrary && !activeLibrary.is_default && (
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'rename',
                    label: '重命名 / 改描述',
                    onClick: () => {
                      setEditingLibrary(activeLibrary);
                      libraryForm.setFieldsValue({
                        name: activeLibrary.name,
                        description: activeLibrary.description,
                        color: activeLibrary.color || LIBRARY_COLORS[0],
                      });
                      setLibraryModalOpen(true);
                    },
                  },
                  {
                    key: 'delete',
                    label: '删除文献库',
                    danger: true,
                    onClick: () => {
                      if (activeLibrary.item_count > 0) {
                        setDeletingLibrary(activeLibrary);
                        setLibraryTarget(libraryItems.find((l) => l.id !== activeLibrary.id)?.id ?? '');
                      } else {
                        deleteLibrary.mutate({ id: activeLibrary.id });
                      }
                    },
                  },
                ],
              }}
            >
              <Button icon={<EditOutlined />}>管理当前库</Button>
            </Dropdown>
          )}
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setImportOpen(true)}>
            DOI 导入
          </Button>
          <Input.Search
            allowClear
            prefix={<SearchOutlined />}
            placeholder="标题 / 作者 / 摘要 / DOI"
            style={{ width: 260 }}
            onSearch={setKeyword}
          />
          <Input.Search
            allowClear
            placeholder="语义检索（AI 向量）"
            style={{ width: 260 }}
            enterButton="语义检索"
            onSearch={setSemanticQ}
          />
          <Select
            allowClear
            placeholder="阅读状态"
            style={{ width: 130 }}
            value={status || undefined}
            onChange={(v) => setStatus(v ?? '')}
            options={Object.entries(STATUS).map(([value, s]) => ({ value, label: s.label }))}
          />
          <Button disabled={selectedIds.length === 0} onClick={() => openMove(selectedIds)}>
            批量移动（{selectedIds.length}）
          </Button>
        </Flex>
        {semanticQ && (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            语义检索：{semantic.data?.mode === 'hybrid' ? '关键词 + 向量混合排序' : '向量模型未就绪，已降级为关键词匹配'}
          </Typography.Paragraph>
        )}
        <Flex gap={16} align="flex-start" wrap>
          <Card
            size="small"
            title={
              <Space size={6}>
                <FolderOutlined />
                文件夹
              </Space>
            }
            style={{ width: 260, flexShrink: 0 }}
            extra={
              <Button
                size="small"
                type="text"
                icon={<PlusOutlined />}
                onClick={() => {
                  setEditingFolder(null);
                  folderForm.setFieldsValue({ name: '' });
                  setFolderModalOpen(true);
                }}
              >
                新建
              </Button>
            }
          >
            <Tree
              key={activeLibraryId}
              treeData={treeData}
              selectedKeys={[folderKey]}
              defaultExpandAll
              onSelect={(keys) => {
                if (keys.length) {
                  setFolderKey(String(keys[0]));
                  setSelectedIds([]);
                }
              }}
            />
            <Flex gap={6} wrap style={{ marginTop: 12 }}>
              <Button
                size="small"
                disabled={!currentFolder}
                onClick={() => {
                  if (!currentFolder) return;
                  setEditingFolder(currentFolder);
                  folderForm.setFieldsValue({ name: currentFolder.name });
                  setFolderModalOpen(true);
                }}
              >
                重命名
              </Button>
              <Button
                size="small"
                danger
                disabled={!currentFolder}
                onClick={() => {
                  if (!currentFolder) return;
                  setDeletingFolder(currentFolder);
                  setFolderTarget('root');
                }}
              >
                删除
              </Button>
            </Flex>
            {currentFolder && (
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                {currentFolder.name}：{currentFolder.item_count} 篇
              </Typography.Paragraph>
            )}
          </Card>
          <Card style={{ flex: 1, minWidth: 320 }} styles={{ body: { paddingTop: 8 } }}>
            <Flex gap={10} align="center" style={{ marginBottom: 8 }}>
              <Checkbox
                checked={items.length > 0 && selectedIds.length === items.length}
                indeterminate={selectedIds.length > 0 && selectedIds.length < items.length}
                onChange={(e) => setSelectedIds(e.target.checked ? items.map((i) => i.id) : [])}
              >
                全选当前列表
              </Checkbox>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                已选 {selectedIds.length} 篇
              </Typography.Text>
            </Flex>
            <List
              loading={semanticQ ? semantic.isFetching : list.isLoading}
              dataSource={items}
              locale={{
                emptyText: (
                  <Empty description={semanticQ ? '没有匹配文献' : '这里还没有文献'}>
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => setImportOpen(true)}>
                      导入文献
                    </Button>
                  </Empty>
                ),
              }}
              renderItem={(item: LabopsLiterature) => (
                <List.Item
                  actions={[
                    <Button
                      key="open"
                      size="small"
                      icon={<LinkOutlined />}
                      disabled={!item.url && !item.doi}
                      onClick={() => window.open(item.url || `https://doi.org/${item.doi}`, '_blank')}
                    >
                      原文
                    </Button>,
                    <Button key="move" size="small" icon={<FolderOpenOutlined />} onClick={() => openMove([item.id])}>
                      移动到
                    </Button>,
                    <Button
                      key="edit"
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => {
                        setEditItem(item);
                        editForm.setFieldsValue({
                          status: item.status,
                          tags: item.tags ?? [],
                          notes: item.notes ?? '',
                        });
                      }}
                    >
                      笔记
                    </Button>,
                    <Dropdown
                      key="cite"
                      menu={{
                        items: [
                          { key: 'gbt7714', label: 'GB/T 7714' },
                          { key: 'bibtex', label: 'BibTeX' },
                          { key: 'ris', label: 'RIS' },
                          { key: 'apa', label: 'APA' },
                        ],
                        onClick: ({ key }) => showCite(item, key),
                      }}
                    >
                      <Button size="small" icon={<CopyOutlined />}>
                        引用
                      </Button>
                    </Dropdown>,
                    <Popconfirm key="del" title="删除该文献？" okButtonProps={{ danger: true }} onConfirm={() => remove.mutate(item.id)}>
                      <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>,
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <Space wrap size={6}>
                        <Checkbox
                          checked={selectedIds.includes(item.id)}
                          onChange={(e) =>
                            setSelectedIds((prev) =>
                              e.target.checked ? [...prev, item.id] : prev.filter((x) => x !== item.id),
                            )
                          }
                        />
                        <Typography.Text strong>{item.title || '未命名文献'}</Typography.Text>
                        <Tag color={STATUS[item.status]?.color}>{STATUS[item.status]?.label ?? item.status}</Tag>
                        {typeof item.score === 'number' && item.score > 0 && (
                          <Tag variant="filled">相关度 {item.score.toFixed(2)}</Tag>
                        )}
                      </Space>
                    }
                    description={
                      <Flex vertical gap={4}>
                        <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                          {[item.authors, item.journal, item.pub_year, item.doi].filter(Boolean).join(' · ')}
                        </Typography.Text>
                        {item.notes && (
                          <Typography.Paragraph style={{ margin: 0, fontSize: 13 }} ellipsis={{ rows: 2 }}>
                            笔记：{item.notes}
                          </Typography.Paragraph>
                        )}
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          更新于 {dayjs(item.updated_at).format('YYYY-MM-DD HH:mm')}
                        </Typography.Text>
                      </Flex>
                    }
                  />
                </List.Item>
              )}
            />
          </Card>
        </Flex>
      </Card>

      <Modal
        title={editingLibrary ? '编辑文献库' : '新建文献库'}
        open={libraryModalOpen}
        onCancel={() => setLibraryModalOpen(false)}
        onOk={() => libraryForm.submit()}
        confirmLoading={saveLibrary.isPending}
        destroyOnHidden
      >
        <Form form={libraryForm} layout="vertical" onFinish={(v) => saveLibrary.mutate(v)}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请填写名称' }]}>
            <Input placeholder="例如：水稻耐盐专题" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} placeholder="这个库用来收什么文献" />
          </Form.Item>
          <Form.Item name="color" label="颜色">
            <Select options={LIBRARY_COLORS.map((c) => ({ value: c, label: <span style={{ color: c }}>● {c}</span> }))} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="删除文献库"
        open={Boolean(deletingLibrary)}
        onCancel={() => setDeletingLibrary(null)}
        onOk={() => deleteLibrary.mutate({ id: deletingLibrary!.id, moveTo: libraryTarget || undefined })}
        confirmLoading={deleteLibrary.isPending}
        okText="删除并转移"
        destroyOnHidden
      >
        <Typography.Paragraph>
          「{deletingLibrary?.name}」里还有 {deletingLibrary?.item_count ?? 0} 篇文献，请选择它们要移动到的文献库：
        </Typography.Paragraph>
        <Select
          style={{ width: '100%' }}
          value={libraryTarget || undefined}
          onChange={setLibraryTarget}
          placeholder="选择目标文献库"
          options={libraryItems
            .filter((l) => l.id !== deletingLibrary?.id)
            .map((l) => ({ value: l.id, label: l.name }))}
        />
      </Modal>

      <Modal
        title={editingFolder ? '重命名文件夹' : '新建文件夹'}
        open={folderModalOpen}
        onCancel={() => setFolderModalOpen(false)}
        onOk={() => folderForm.submit()}
        confirmLoading={saveFolder.isPending}
        destroyOnHidden
      >
        <Form form={folderForm} layout="vertical" onFinish={(v) => saveFolder.mutate(v)}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请填写名称' }]}>
            <Input placeholder="例如：田间试验" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="删除文件夹"
        open={Boolean(deletingFolder)}
        onCancel={() => setDeletingFolder(null)}
        onOk={() => deleteFolder.mutate({ id: deletingFolder!.id, moveTo: folderTarget })}
        confirmLoading={deleteFolder.isPending}
        okText="删除并转移"
        destroyOnHidden
      >
        <Typography.Paragraph>
          「{deletingFolder?.name}」里还有 {deletingFolder?.item_count ?? 0} 篇文献，请选择它们的去处：
        </Typography.Paragraph>
        <Select
          style={{ width: '100%' }}
          value={folderTarget}
          onChange={setFolderTarget}
          options={[
            { value: 'root', label: '移到未分类（库根目录）' },
            ...folderItems
              .filter((f) => f.id !== deletingFolder?.id)
              .map((f) => ({ value: f.id, label: `移到 ${f.name}` })),
          ]}
        />
      </Modal>

      <Modal
        title={`移动 ${moveIds.length} 篇文献`}
        open={moveOpen}
        onCancel={() => setMoveOpen(false)}
        onOk={() => moveLiterature.mutate({ ids: moveIds, libraryId: moveLibrary, folderId: moveFolder })}
        confirmLoading={moveLiterature.isPending}
        destroyOnHidden
      >
        <Flex vertical gap={12}>
          <Select
            style={{ width: '100%' }}
            value={moveLibrary || undefined}
            onChange={(v) => {
              setMoveLibrary(v);
              setMoveFolder('');
            }}
            placeholder="目标文献库"
            options={libraryItems.map((l) => ({ value: l.id, label: l.name }))}
          />
          <Select
            style={{ width: '100%' }}
            value={moveFolder}
            onChange={setMoveFolder}
            placeholder="目标文件夹"
            options={[
              { value: '', label: '未分类（库根目录）' },
              ...(moveFolderOptions.data?.items ?? []).map((f) => ({ value: f.id, label: f.name })),
            ]}
          />
        </Flex>
      </Modal>

      <Modal
        title="DOI 导入"
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={() => importForm.submit()}
        confirmLoading={importDoi.isPending}
        destroyOnHidden
      >
        <Form form={importForm} layout="vertical" onFinish={(v) => importDoi.mutate(v)}>
          <Form.Item name="doi" label="DOI" extra="例如 10.1038/s41586-023-00000-0，条目信息将自动从 Crossref 拉取">
            <Input placeholder="10.xxxx/xxxxx" />
          </Form.Item>
          <Form.Item name="title" label="或手动填写标题">
            <Input placeholder="不填 DOI 时必填" />
          </Form.Item>
          <Form.Item name="tags" label="标签">
            <Select mode="tags" placeholder="输入后回车" />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title="阅读笔记"
        open={Boolean(editItem)}
        onClose={() => setEditItem(null)}
        size={560}
        extra={
          <Button type="primary" loading={update.isPending} onClick={() => editForm.submit()}>
            保存
          </Button>
        }
        destroyOnHidden
      >
        {editItem && (
          <Flex vertical gap={12}>
            <Typography.Text strong>{editItem.title}</Typography.Text>
            <Form form={editForm} layout="vertical" onFinish={(v) => update.mutate(v)}>
              <Form.Item name="status" label="阅读状态">
                <Select options={Object.entries(STATUS).map(([value, s]) => ({ value, label: s.label }))} />
              </Form.Item>
              <Form.Item name="tags" label="标签">
                <Select mode="tags" />
              </Form.Item>
              <Form.Item name="notes" label="笔记">
                <Input.TextArea rows={12} placeholder="记录方法、结论、可复用点…" />
              </Form.Item>
            </Form>
          </Flex>
        )}
      </Drawer>

      <Modal
        title={citeItem ? `引用 · ${citeItem.title}` : ''}
        open={Boolean(citeItem)}
        onCancel={() => setCiteItem(null)}
        footer={[
          <Button key="close" onClick={() => setCiteItem(null)}>
            关闭
          </Button>,
          <Button
            key="copy"
            type="primary"
            icon={<CopyOutlined />}
            onClick={async () => {
              await navigator.clipboard.writeText(citeText);
              message.success('已复制');
            }}
          >
            复制
          </Button>,
        ]}
        width={640}
      >
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.7, margin: 0 }}>{citeText}</pre>
      </Modal>
    </Flex>
  );
}
