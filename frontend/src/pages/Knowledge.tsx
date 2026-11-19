import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  App,
  AutoComplete,
  Button,
  Card,
  Col,
  Empty,
  Flex,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
  theme,
} from 'antd';
import type { UploadFile } from 'antd';
import {
  AppstoreOutlined,
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  GlobalOutlined,
  InboxOutlined,
  LinkOutlined,
  LockOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  api,
  type FileEntry,
  type IngestResult,
  type IngestSummary,
  type KnowledgeDoc,
  type KnowledgeSpace,
} from '../services/api';
import KnowledgeAsk from '../components/KnowledgeAsk';
import { resolveDisplayName, usePeopleMap } from '../utils/displayName';

import { formatSize } from '../utils/format';
const VISIBILITY: Record<string, { label: string; color: string; icon: ReactNode; hint: string }> = {
  private: { label: '仅自己', color: 'default', icon: <LockOutlined />, hint: '只有你和管理员可见' },
  roles: { label: '指定角色', color: 'blue', icon: <TeamOutlined />, hint: '指定角色组的成员可见' },
  public: { label: '全实验室', color: 'green', icon: <GlobalOutlined />, hint: '所有已登录用户可见' },
};

interface DocForm {
  title: string;
  body: string;
  tags: string[];
  category: string;
  visibility: 'private' | 'roles' | 'public';
  roles: string[];
  spaceId: number;
}

interface UploadForm {
  category: string;
  tags: string[];
  visibility: 'private' | 'roles' | 'public';
  roles?: string[];
  spaceId?: number;
}

interface SpaceForm {
  name: string;
  description?: string;
  visibility: 'private' | 'roles' | 'public';
  roles?: string[];
}

/** 与后端 _extract_text 支持的格式保持一致，避免选了才报"无法抽取"。 */
const INGEST_ACCEPT = '.pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xls,.txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.html,.htm,.rtf,.epub';

const MAX_BATCH_HINT = '单次最多入库 50 个文件，单个文件不超过 20 MB。';

function formatTime(v?: string) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString('zh-CN');
}

// 大小格式化统一走 utils/format（见该文件顶部说明）
const formatBytes = formatSize;

/** 抽取出来的正文字数，用于判断"入库了但几乎没内容"。 */
function formatChars(v?: number) {
  const n = Number(v ?? 0);
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n.toLocaleString()} 字`;
}

/** 目录相对路径里 antd 会带上 "目录名/..."，入库时只保留目录内部结构。 */
function relPathOf(file: UploadFile) {
  const raw = (file.originFileObj as (File & { webkitRelativePath?: string }) | undefined)?.webkitRelativePath;
  if (!raw) return file.name ?? '';
  const parts = String(raw).split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : raw;
}

/** 回链用：从源内相对路径取出所在目录。 */
function parentOf(path: string) {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '';
}

function VisibilityTag({ value }: { value: string }) {
  const meta = VISIBILITY[value] ?? VISIBILITY.private;
  return (
    <Tag color={meta.color} icon={meta.icon}>
      {meta.label}
    </Tag>
  );
}

function CategoryTag({ value }: { value?: string }) {
  return (
    <Tag variant="filled" color={value ? 'purple' : 'default'} icon={<AppstoreOutlined />}>
      {value || '未分类'}
    </Tag>
  );
}

/** 入库结果：成功/覆盖/跳过分开报，跳过必须带上原因，否则用户只能看到"少了几个"。 */
function IngestReport({ report }: { report: { results: IngestResult[]; summary: IngestSummary } }) {
  const { summary, results } = report;
  const bad = results.filter((r) => !r.ok);
  return (
    <Flex vertical gap={8}>
      <Space size={6} wrap>
        <Typography.Text strong>
          新增 {summary.created} · 覆盖 {summary.updated} · 跳过 {summary.skipped}
        </Typography.Text>
        <Typography.Text type="secondary">抽取 {summary.chars.toLocaleString()} 字</Typography.Text>
      </Space>
      {bad.length ? (
        <div style={{ maxHeight: 160, overflowY: 'auto' }}>
          {bad.map((r) => (
            <div key={`${r.filePath ?? r.name}-${r.reason ?? ''}`}>
              <Typography.Text type="warning" style={{ fontSize: 12.5 }}>
                {r.name}：{r.reason || '未提取到文本'}
              </Typography.Text>
            </div>
          ))}
        </div>
      ) : null}
    </Flex>
  );
}

export default function Knowledge() {
  const { message, modal } = App.useApp();
  // 人员目录：作者/拥有者显示姓名而不是账号名
  const peopleMap = usePeopleMap();
  const { token } = theme.useToken();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'ask' | 'docs'>('ask');

  const [q, setQ] = useState('');
  const [keyword, setKeyword] = useState('');
  /** null = 全部知识库；0 = 未归档；>0 = 指定知识库 */
  const [spaceSel, setSpaceSel] = useState<number | null>(null);
  const [folder, setFolder] = useState('');
  const [tag, setTag] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [viewDocId, setViewDocId] = useState<number | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<KnowledgeDoc | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [dirMode, setDirMode] = useState(false);
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [report, setReport] = useState<{ results: IngestResult[]; summary: IngestSummary } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerDir, setPickerDir] = useState('');
  const [picked, setPicked] = useState<FileEntry[]>([]);
  const [spaceOpen, setSpaceOpen] = useState(false);
  const [spaceEditing, setSpaceEditing] = useState<KnowledgeSpace | null>(null);
  // 深链进来的条目（搜索页、文件存储）可能不在当前筛选结果里，单独记住它免得被列表重置掉选中项。
  const [deepDoc, setDeepDoc] = useState<number | null>(null);
  const [urlParams] = useSearchParams();
  const [form] = Form.useForm<DocForm>();
  const [uploadForm] = Form.useForm<UploadForm>();
  const [pickForm] = Form.useForm<UploadForm>();
  const [spaceForm] = Form.useForm<SpaceForm>();
  const visibility = Form.useWatch('visibility', form) ?? 'private';
  const uploadVisibility = Form.useWatch('visibility', uploadForm) ?? 'private';
  const pickVisibility = Form.useWatch('visibility', pickForm) ?? 'private';
  const spaceVisibility = Form.useWatch('visibility', spaceForm) ?? 'private';

  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 120_000 });
  const ragStatus = useQuery({
    queryKey: ['knowledge-rag-status'],
    queryFn: api.knowledgeRagStatus,
    refetchInterval: 30_000,
  });
  const spaces = useQuery({
    queryKey: ['knowledge-spaces'],
    queryFn: api.knowledgeSpaces,
    staleTime: 30_000,
  });
  const list = useQuery({
    queryKey: ['knowledge', keyword, folder, tag, spaceSel],
    queryFn: () =>
      api.knowledgeList(keyword, {
        folder,
        tag,
        space: spaceSel === null ? undefined : spaceSel,
      }),
    staleTime: 15_000,
  });
  const facets = useQuery({
    queryKey: ['knowledge-facets', spaceSel],
    queryFn: () => api.knowledgeCategories(spaceSel === null ? undefined : spaceSel),
    staleTime: 15_000,
  });
  const detail = useQuery({
    queryKey: ['knowledge-doc', selectedId],
    queryFn: () => api.knowledgeGet(selectedId as number),
    enabled: selectedId != null,
  });
  const viewDoc = useQuery({
    queryKey: ['knowledge-doc', viewDocId],
    queryFn: () => api.knowledgeGet(viewDocId as number),
    enabled: viewDocId != null,
  });
  // 入库时后端会拿当前会话重新过一次文件 ACL，这里列不出来也就选不到。
  const pickerEntries = useQuery({
    queryKey: ['files', 'users'],
    queryFn: () => api.files('users'),
    staleTime: 0,
    enabled: pickerOpen,
  });

  const pickerChildren = useMemo(() => {
    const prefix = pickerDir ? `${pickerDir}/` : '';
    const rows = (pickerEntries.data?.entries ?? []).filter((e) => {
      if (!e.path || e.path === pickerDir) return false;
      if (!e.path.startsWith(prefix)) return false;
      const rest = e.path.slice(prefix.length);
      return rest.length > 0 && !rest.includes('/');
    });
    return [...rows.filter((e) => e.dir), ...rows.filter((e) => !e.dir)];
  }, [pickerEntries.data?.entries, pickerDir]);

  const items = list.data?.items ?? [];
  const current = detail.data?.item ?? items.find((d) => d.id === selectedId) ?? null;
  const canEdit = Boolean(
    current && me.data?.authenticated && (me.data.isAdmin || current.owner === me.data.id),
  );
  const status = ragStatus.data;
  const categories = facets.data?.categories ?? [];
  const tagFacets = facets.data?.tags ?? [];
  const spaceItems = spaces.data?.items ?? [];
  const unfiled = spaces.data?.unfiled ?? { docs: 0, chars: 0 };
  const currentSpace = spaceSel != null && spaceSel > 0 ? spaceItems.find((s) => s.id === spaceSel) : null;
  const allDocs = useMemo(
    () => spaceItems.reduce((sum, s) => sum + s.docs, 0) + (unfiled.docs ?? 0),
    [spaceItems, unfiled.docs],
  );
  const editableSpaces = useMemo(() => spaceItems.filter((s) => s.canEdit), [spaceItems]);
  /** 下拉里既有的文件夹排在前面，"未分类"固定为 ''，与后端存储值一致。 */
  const categoryOptions = useMemo(
    () => [
      { value: '', label: '未分类' },
      ...categories.filter((c) => c.name).map((c) => ({ value: c.name, label: c.name })),
    ],
    [categories],
  );
  const spaceTargets = useMemo(
    () => [
      { value: 0, label: '未归档' },
      ...editableSpaces.map((s) => ({ value: s.id, label: s.name })),
    ],
    [editableSpaces],
  );

  /** 当前路径下的直接子文件夹（由条目的文件夹路径聚合而来）。 */
  const childFolders = useMemo(() => {
    const prefix = folder ? `${folder}/` : '';
    const map = new Map<string, { path: string; label: string; docs: number; chars: number }>();
    for (const c of categories) {
      if (!c.name) continue;
      if (!c.name.startsWith(prefix)) continue;
      const rest = c.name.slice(prefix.length);
      const head = rest.split('/')[0];
      if (!head) continue;
      const path = `${prefix}${head}`;
      const prev = map.get(path) ?? { path, label: head, docs: 0, chars: 0 };
      prev.docs += c.docs;
      prev.chars += c.chars;
      map.set(path, prev);
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  }, [categories, folder]);
  const folderCrumbs = useMemo(() => {
    const parts = folder.split('/').filter(Boolean);
    return parts.map((p, i) => ({ label: p, path: parts.slice(0, i + 1).join('/') }));
  }, [folder]);

  useEffect(() => {
    if (selectedId == null && items.length) setSelectedId(items[0].id);
    if (selectedId != null && items.length && !items.some((d) => d.id === selectedId)) {
      if (deepDoc != null && selectedId === deepDoc) return;
      setSelectedId(items[0].id);
    }
  }, [items, selectedId, deepDoc]);

  useEffect(() => {
    const doc = Number(urlParams.get('doc') || 0);
    const cat = urlParams.get('category') ?? '';
    const space = Number(urlParams.get('space') || 0);
    if (!doc && !cat && !space) return;
    setTab('docs');
    if (cat) setFolder(cat);
    if (space > 0) setSpaceSel(space);
    if (doc) {
      setSelectedId(doc);
      setDeepDoc(doc);
    }
  }, [urlParams]);

  const roleOptions = useMemo(() => {
    const roles = new Set<string>();
    for (const r of me.data?.roles ?? []) if (r.startsWith('lab-')) roles.add(r);
    for (const d of items) for (const r of d.roles) roles.add(r);
    for (const s of spaceItems) for (const r of s.roles) roles.add(r);
    return [...roles].sort().map((r) => ({ value: r, label: r }));
  }, [me.data?.roles, items, spaceItems]);

  const refreshDocs = async () => {
    await qc.invalidateQueries({ queryKey: ['knowledge'] });
    await qc.invalidateQueries({ queryKey: ['knowledge-facets'] });
    await qc.invalidateQueries({ queryKey: ['knowledge-spaces'] });
    await qc.invalidateQueries({ queryKey: ['knowledge-rag-status'] });
  };

  const save = useMutation({
    mutationFn: async (values: DocForm) => {
      const payload = {
        title: values.title.trim(),
        body: values.body ?? '',
        tags: values.tags ?? [],
        category: (values.category ?? '').trim(),
        visibility: values.visibility ?? 'private',
        roles: values.visibility === 'roles' ? (values.roles ?? []) : [],
        spaceId: values.spaceId ?? 0,
      };
      if (editing) return api.knowledgeUpdate(editing.id, payload);
      return api.knowledgeCreate(payload);
    },
    onSuccess: async (res) => {
      message.success(editing ? '文档已更新' : '文档已创建');
      setEditorOpen(false);
      setEditing(null);
      await refreshDocs();
      setSelectedId(res.item.id);
    },
    onError: (e: Error) => message.error(e.message || '保存失败'),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.knowledgeDelete(id),
    onSuccess: async () => {
      message.success('文档已删除');
      setSelectedId(null);
      await refreshDocs();
    },
    onError: (e: Error) => message.error(e.message || '删除失败'),
  });

  const ingest = useMutation({
    mutationFn: async (values: UploadForm) => {
      const files = fileList.map((f) => f.originFileObj as File | undefined).filter(Boolean) as File[];
      if (!files.length) throw new Error('请选择要上传的文档');
      if (files.length > 50) throw new Error(`一次最多 50 个文件，当前选了 ${files.length} 个`);
      const fd = new FormData();
      for (const file of files) fd.append('files', file);
      // Starlette 会把 multipart 文件名里的目录削掉，相对路径单独按同序提交。
      fd.append('paths', JSON.stringify(fileList.map(relPathOf)));
      fd.append('category', (values.category ?? '').trim());
      fd.append('tags', JSON.stringify(values.tags ?? []));
      fd.append('visibility', values.visibility ?? 'private');
      fd.append('roles', JSON.stringify(values.visibility === 'roles' ? (values.roles ?? []) : []));
      fd.append('spaceId', String(values.spaceId ?? 0));
      return api.knowledgeIngest(fd);
    },
    onSuccess: async (res) => {
      setReport(res);
      const failed = res.summary.skipped;
      message.success(
        `入库完成：新增 ${res.summary.created} · 覆盖 ${res.summary.updated}${failed ? ` · 跳过 ${failed}` : ''}`,
      );
      setUploadOpen(false);
      setFileList([]);
      uploadForm.resetFields();
      await refreshDocs();
    },
    onError: (e: Error) => message.error(e.message || '上传失败'),
  });

  const fromFiles = useMutation({
    mutationFn: async (values: UploadForm) => {
      if (!picked.length) throw new Error('请先勾选要入库的文件');
      return api.knowledgeFromFiles({
        items: picked.map((e) => ({ id: e.id, source: e.source, path: e.path })),
        category: (values.category ?? '').trim(),
        tags: values.tags ?? [],
        visibility: values.visibility ?? 'private',
        roles: values.visibility === 'roles' ? (values.roles ?? []) : [],
        spaceId: values.spaceId ?? 0,
      });
    },
    onSuccess: async (res) => {
      setReport(res);
      message.success(
        `入库完成：新增 ${res.summary.created} · 覆盖 ${res.summary.updated}${
          res.summary.skipped ? ` · 跳过 ${res.summary.skipped}` : ''
        }`,
      );
      setPickerOpen(false);
      setPicked([]);
      pickForm.resetFields();
      await refreshDocs();
    },
    onError: (e: Error) => message.error(e.message || '入库失败'),
  });

  const saveSpace = useMutation({
    mutationFn: (values: SpaceForm) => {
      const payload = {
        name: values.name.trim(),
        description: (values.description ?? '').trim(),
        visibility: values.visibility ?? 'private',
        roles: values.visibility === 'roles' ? (values.roles ?? []) : [],
      };
      if (spaceEditing) return api.knowledgeSpaceUpdate(spaceEditing.id, payload);
      return api.knowledgeSpaceCreate(payload);
    },
    onSuccess: async (res) => {
      message.success(spaceEditing ? '知识库已更新' : '知识库已创建');
      setSpaceOpen(false);
      setSpaceEditing(null);
      await refreshDocs();
      if (!spaceEditing) {
        setSpaceSel(res.item.id);
        setFolder('');
      }
    },
    onError: (e: Error) => message.error(e.message || '保存知识库失败'),
  });

  const removeSpace = useMutation({
    mutationFn: (id: number) => api.knowledgeSpaceDelete(id),
    onSuccess: async (res) => {
      message.success(`知识库已删除${res.movedToUnfiled ? `，${res.movedToUnfiled} 篇文档已移到未归档` : ''}`);
      await refreshDocs();
    },
    onError: (e: Error) => message.error(e.message || '删除知识库失败'),
  });

  const reindex = useMutation({
    mutationFn: api.knowledgeReindex,
    onSuccess: async (res) => {
      message.success(`索引已重建：${res.documents ?? 0} 篇文档 / ${res.chunks ?? 0} 个片段`);
      await qc.invalidateQueries({ queryKey: ['knowledge-rag-status'] });
    },
    onError: (e: Error) => message.error(e.message || '重建失败'),
  });

  const defaultSpaceId = spaceSel != null && spaceSel > 0 && editableSpaces.some((s) => s.id === spaceSel)
    ? spaceSel
    : 0;

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue({
      title: '',
      body: '',
      tags: [],
      category: folder || '',
      visibility: 'private',
      roles: [],
      spaceId: defaultSpaceId,
    });
    setEditorOpen(true);
  };

  const openEdit = (doc: KnowledgeDoc) => {
    setEditing(doc);
    form.setFieldsValue({
      title: doc.title,
      body: doc.body ?? doc.excerpt,
      tags: doc.tags ?? [],
      category: doc.category ?? '',
      visibility: doc.visibility,
      roles: doc.roles ?? [],
      spaceId: doc.spaceId ?? 0,
    });
    setEditorOpen(true);
  };

  const openUpload = () => {
    setFileList([]);
    uploadForm.setFieldsValue({
      category: folder || '',
      tags: [],
      visibility: 'private',
      roles: [],
      spaceId: defaultSpaceId,
    });
    setUploadOpen(true);
  };

  const openPicker = () => {
    setPicked([]);
    setPickerDir('');
    pickForm.setFieldsValue({
      category: folder || '',
      tags: [],
      visibility: 'private',
      roles: [],
      spaceId: defaultSpaceId,
    });
    setPickerOpen(true);
  };

  const openSpaceCreate = () => {
    setSpaceEditing(null);
    spaceForm.setFieldsValue({ name: '', description: '', visibility: 'private', roles: [] });
    setSpaceOpen(true);
  };

  const openSpaceEdit = (space: KnowledgeSpace) => {
    setSpaceEditing(space);
    spaceForm.setFieldsValue({
      name: space.name,
      description: space.description,
      visibility: space.visibility,
      roles: space.roles ?? [],
    });
    setSpaceOpen(true);
  };

  const confirmDeleteSpace = (space: KnowledgeSpace) => {
    modal.confirm({
      title: `删除知识库「${space.name}」？`,
      content: `知识库内的 ${space.docs} 篇文档不会删除，会移到「未归档」，之后仍可重新归类。`,
      okText: '删除知识库',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await removeSpace.mutateAsync(space.id);
        if (spaceSel === space.id) {
          setSpaceSel(null);
          setFolder('');
        }
      },
    });
  };

  const clearFilters = () => {
    setKeyword('');
    setQ('');
    setFolder('');
    setTag('');
  };

  const docsPanel = (
    <Flex vertical gap={16}>
      <Card styles={{ body: { padding: '12px 16px' } }}>
        <Flex vertical gap={10}>
          <Flex gap={8} align="center" wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
              知识库
            </Typography.Text>
            <Tag.CheckableTag
              checked={spaceSel === null}
              onChange={() => {
                setSpaceSel(null);
                setFolder('');
              }}
            >
              全部（{allDocs}）
            </Tag.CheckableTag>
            <Tag.CheckableTag
              checked={spaceSel === 0}
              onChange={() => {
                setSpaceSel(0);
                setFolder('');
              }}
            >
              未归档（{unfiled.docs}）
            </Tag.CheckableTag>
            {spaceItems.map((s) => (
              <Tag.CheckableTag
                key={s.id}
                checked={spaceSel === s.id}
                onChange={(next) => {
                  setSpaceSel(next ? s.id : null);
                  setFolder('');
                }}
              >
                {s.name} · {s.docs}
              </Tag.CheckableTag>
            ))}
            <Button size="small" icon={<FolderAddOutlined />} onClick={openSpaceCreate}>
              新建知识库
            </Button>
          </Flex>
          {currentSpace ? (
            <Flex gap={8} align="center" wrap>
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                {currentSpace.description || '暂无说明'} · {formatChars(currentSpace.chars)} ·{' '}
                {resolveDisplayName(currentSpace.owner, peopleMap, currentSpace.ownerName)}
              </Typography.Text>
              <VisibilityTag value={currentSpace.visibility} />
              {currentSpace.canEdit ? (
                <>
                  <Button
                    size="small"
                    type="link"
                    icon={<SettingOutlined />}
                    onClick={() => openSpaceEdit(currentSpace)}
                  >
                    设置
                  </Button>
                  <Button
                    size="small"
                    type="link"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => confirmDeleteSpace(currentSpace)}
                  >
                    删除
                  </Button>
                </>
              ) : null}
            </Flex>
          ) : null}
        </Flex>
      </Card>

      <Card styles={{ body: { padding: '12px 16px' } }}>
        <Flex vertical gap={10}>
          <Flex gap={8} align="center" wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
              文件夹
            </Typography.Text>
            <Tag.CheckableTag checked={!folder} onChange={() => setFolder('')}>
              根目录（{facets.data?.total ?? 0}）
            </Tag.CheckableTag>
            {childFolders.map((f) => (
              <Tag.CheckableTag key={f.path} checked={folder === f.path} onChange={() => setFolder(f.path)}>
                {f.label} · {f.docs}
              </Tag.CheckableTag>
            ))}
            {folder ? (
              <>
                <Button size="small" type="link" onClick={() => setFolder('')}>
                  根目录
                </Button>
                {folderCrumbs.map((c) => (
                  <Button key={c.path} size="small" type="link" onClick={() => setFolder(c.path)}>
                    {c.label}
                  </Button>
                ))}
              </>
            ) : null}
            {!childFolders.length && !folder ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                还没有文件夹，新建或入库文档时在「文件夹」填路径即可
              </Typography.Text>
            ) : null}
          </Flex>
          {tagFacets.length ? (
            <Flex gap={8} align="center" wrap>
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                标签
              </Typography.Text>
              {tagFacets.slice(0, 16).map((t) => (
                <Tag.CheckableTag
                  key={t.name}
                  checked={tag === t.name}
                  onChange={(next) => setTag(next ? t.name : '')}
                >
                  {t.name}（{t.docs}）
                </Tag.CheckableTag>
              ))}
            </Flex>
          ) : null}
          {report ? <IngestReport report={report} /> : null}
        </Flex>
      </Card>

      <Row gutter={[16, 16]}>
      <Col xs={24} lg={9} xl={8}>
        <Card
          title={`文档（${items.length}）`}
          style={{ height: '100%' }}
          styles={{ body: { padding: items.length ? '8px 0' : 24 } }}
        >
          <Spin spinning={list.isLoading}>
            {items.length ? (
              <div style={{ maxHeight: 600, overflowY: 'auto' }}>
                {items.map((doc, idx) => {
                  const meta = VISIBILITY[doc.visibility] ?? VISIBILITY.private;
                  const active = doc.id === selectedId;
                  return (
                    <div
                      key={doc.id}
                      onClick={() => {
                        setDeepDoc(null);
                        setSelectedId(doc.id);
                      }}
                      style={{
                        cursor: 'pointer',
                        padding: '10px 16px',
                        background: active ? token.colorPrimaryBg : undefined,
                        borderInlineStart: active ? `3px solid ${token.colorPrimary}` : '3px solid transparent',
                        borderBlockEnd: idx < items.length - 1 ? `1px solid ${token.colorSplit}` : undefined,
                      }}
                    >
                      <Flex gap={6} align="center" style={{ marginBottom: 4 }}>
                        <Typography.Text ellipsis style={{ flex: 1 }} strong={active}>
                          {doc.title}
                        </Typography.Text>
                        <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>
                          {meta.label}
                        </Tag>
                      </Flex>
                      <Flex vertical gap={6}>
                        <Typography.Paragraph
                          type="secondary"
                          ellipsis={{ rows: 2 }}
                          style={{ margin: 0, fontSize: 12.5 }}
                        >
                          {doc.excerpt || '（无正文）'}
                        </Typography.Paragraph>
                        <Space size={4} wrap>
                          {doc.spaceName ? (
                            <Tag variant="filled" color="geekblue">
                              {doc.spaceName}
                            </Tag>
                          ) : null}
                          <span
                            onClick={(e) => {
                              e.stopPropagation();
                              setFolder(doc.category || '');
                            }}
                          >
                            <CategoryTag value={doc.category} />
                          </span>
                          {doc.tags.slice(0, 2).map((t) => (
                            <Tag
                              key={t}
                              variant="filled"
                              style={{ cursor: 'pointer' }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setTag(t);
                              }}
                            >
                              {t}
                            </Tag>
                          ))}
                          {doc.filePath ? (
                            <Tooltip title={`来自文件存储：${doc.filePath} · ${formatBytes(doc.fileBytes)}`}>
                              <LinkOutlined style={{ color: token.colorPrimary, fontSize: 12 }} />
                            </Tooltip>
                          ) : null}
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {resolveDisplayName(doc.owner, peopleMap, doc.ownerName)} · {formatTime(doc.updatedAt)}
                          </Typography.Text>
                        </Space>
                      </Flex>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  keyword || folder || tag || spaceSel != null
                    ? '当前筛选条件下没有文档，换个关键词或清除筛选试试'
                    : '还没有知识文档'
                }
              >
                {keyword || folder || tag || spaceSel != null ? (
                  <Button onClick={clearFilters}>清除筛选</Button>
                ) : (
                  <Space>
                    <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                      新建文档
                    </Button>
                    <Button icon={<UploadOutlined />} onClick={openUpload}>
                      上传文档
                    </Button>
                    <Button icon={<FolderOpenOutlined />} onClick={openPicker}>
                      从文件存储入库
                    </Button>
                  </Space>
                )}
              </Empty>
            )}
          </Spin>
        </Card>
      </Col>

      <Col xs={24} lg={15} xl={16}>
        <Card
          title={
            <Flex gap={8} wrap align="center">
              <Typography.Text ellipsis style={{ maxWidth: 420 }}>
                {current?.title ?? '文档详情'}
              </Typography.Text>
              {current ? <CategoryTag value={current.category} /> : null}
              {current ? <VisibilityTag value={current.visibility} /> : null}
            </Flex>
          }
          extra={
            current ? (
              <Space>
                <Button size="small" icon={<EditOutlined />} disabled={!canEdit} onClick={() => openEdit(current)}>
                  编辑
                </Button>
                <Popconfirm
                  title="删除这篇文档？"
                  description="删除后不可恢复，索引也会同步更新。"
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  disabled={!canEdit}
                  onConfirm={() => remove.mutate(current.id)}
                >
                  <Button size="small" danger icon={<DeleteOutlined />} disabled={!canEdit}>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ) : null
          }
          loading={detail.isFetching}
          style={{ height: '100%' }}
        >
          {current ? (
            <Flex vertical gap={12}>
              <Space size={8} wrap>
                <Typography.Text type="secondary">作者 {resolveDisplayName(current.owner, peopleMap, current.ownerName)}</Typography.Text>
                <Typography.Text type="secondary">更新 {formatTime(current.updatedAt)}</Typography.Text>
                <Typography.Text type="secondary">正文 {formatChars((current.body ?? current.excerpt ?? '').length)}</Typography.Text>
                {current.roles.length ? (
                  <Typography.Text type="secondary">可见角色 {current.roles.join('、')}</Typography.Text>
                ) : null}
              </Space>
              {current.filePath ? (
                <Flex gap={8} align="center" wrap>
                  <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                    来源：{current.fileSource || 'users'}/{current.filePath}（{formatBytes(current.fileBytes)}
                    {current.fileModified ? ` · 文件更新于 ${formatTime(current.fileModified)}` : ''}）
                  </Typography.Text>
                  <Button
                    size="small"
                    icon={<FolderOpenOutlined />}
                    onClick={() =>
                      navigate(
                        `/files?source=${encodeURIComponent(current.fileSource || 'users')}&dir=${encodeURIComponent(
                          parentOf(current.filePath),
                        )}`,
                      )
                    }
                  >
                    在文件存储中打开
                  </Button>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    源文件改动后重新入库会覆盖这条记录，不会产生重复条目。
                  </Typography.Text>
                </Flex>
              ) : null}
              <Space size={4} wrap>
                {current.tags.map((t) => (
                  <Tag
                    key={t}
                    color="processing"
                    variant="filled"
                    style={{ cursor: 'pointer' }}
                    onClick={() => setTag(t)}
                  >
                    {t}
                  </Tag>
                ))}
              </Space>
              <Typography.Paragraph
                style={{
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: 14,
                  lineHeight: 1.75,
                  maxHeight: '56vh',
                  overflowY: 'auto',
                }}
              >
                {detail.data?.item.body || current.excerpt || '（无正文）'}
              </Typography.Paragraph>
            </Flex>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="从左侧选择一篇文档查看正文" />
          )}
        </Card>
      </Col>
      </Row>
    </Flex>
  );

  return (
    <Flex vertical gap={16}>
      <Card styles={{ body: { padding: '14px 18px' } }}>
        <Flex wrap gap={12} align="center" justify="space-between">
          <Space size={10} wrap>
            <FileTextOutlined style={{ fontSize: 18, color: token.colorPrimary }} />
            <Typography.Text strong style={{ fontSize: 16 }}>
              实验室知识库
            </Typography.Text>
            <Typography.Text type="secondary">FlashRAG 原生 RAG · 按知识库与文档 ACL 检索</Typography.Text>
            {status?.available ? (
              <>
                <Tag color="success">{status.indexReady ? '索引就绪' : '索引构建中'}</Tag>
                <Tag>{status.documents ?? 0} 篇 · {status.chunks ?? 0} 片段</Tag>
                <Tag color={status.generator?.configured ? 'processing' : 'default'}>
                  {status.generator?.configured ? `生成模型 ${status.generator.model}` : '仅检索模式'}
                </Tag>
              </>
            ) : (
              <Tag color="error">RAG 服务离线</Tag>
            )}
          </Space>
          <Space wrap>
            <Segmented
              value={tab}
              onChange={(v) => setTab(v as 'ask' | 'docs')}
              options={[
                { label: '知识问答', value: 'ask' },
                { label: '文档库', value: 'docs' },
              ]}
            />
            {tab === 'docs' ? (
              <>
                <Input
                  allowClear
                  prefix={<SearchOutlined />}
                  placeholder="搜索标题、正文或标签"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onPressEnter={() => setKeyword(q.trim())}
                  style={{ width: 220 }}
                />
                <Button icon={<ReloadOutlined />} onClick={() => list.refetch()}>
                  刷新
                </Button>
                <Button icon={<UploadOutlined />} onClick={openUpload}>
                  上传文档
                </Button>
                <Button icon={<FolderOpenOutlined />} onClick={openPicker}>
                  从文件存储入库
                </Button>
                <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                  新建文档
                </Button>
              </>
            ) : (
              <Button icon={<ReloadOutlined />} onClick={() => ragStatus.refetch()}>
                刷新状态
              </Button>
            )}
            {me.data?.isAdmin ? (
              <Button
                icon={<ThunderboltOutlined />}
                loading={reindex.isPending}
                onClick={() => reindex.mutate()}
              >
                重建索引
              </Button>
            ) : null}
          </Space>
        </Flex>
      </Card>

      {tab === 'ask' ? <KnowledgeAsk /> : docsPanel}

      <Modal
        open={editorOpen}
        title={editing ? '编辑文档' : '新建文档'}
        width={760}
        okText="保存"
        cancelText="取消"
        confirmLoading={save.isPending}
        onOk={() => form.submit()}
        onCancel={() => {
          setEditorOpen(false);
          setEditing(null);
        }}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          requiredMark="optional"
          initialValues={{ visibility: 'private', roles: [], tags: [], category: '', spaceId: 0 }}
          onFinish={(values) => save.mutate(values)}
        >
          <Row gutter={12}>
            <Col xs={24} md={14}>
              <Form.Item
                name="title"
                label="标题"
                rules={[
                  { required: true, whitespace: true, message: '请输入标题' },
                  { max: 200, message: '标题最多 200 字' },
                ]}
              >
                <Input placeholder="例如：水稻基因组注释流程笔记" maxLength={200} showCount />
              </Form.Item>
            </Col>
            <Col xs={24} md={10}>
              <Form.Item name="spaceId" label="所属知识库" extra="只能写入你创建或管理的知识库">
                <Select options={spaceTargets} placeholder="未归档" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="category" label="文件夹" extra="用 / 分隔层级，例如：项目/2026；留空即为未分类">
            <AutoComplete
              options={categoryOptions}
              placeholder="例如：生信流程 / 工具手册 / 项目/2026"
              showSearch={{ filterOption: (input, option) => String(option?.value ?? '').includes(input.trim()) }}
              maxLength={96}
            />
          </Form.Item>
          <Form.Item name="tags" label="标签">
            <Select mode="tags" placeholder="输入后回车添加，最多 20 个" tokenSeparators={[',', '，']} />
          </Form.Item>
          <Form.Item name="visibility" label="可见范围" extra={VISIBILITY[visibility]?.hint}>
            <Segmented
              options={[
                { value: 'private', label: '仅自己', icon: <LockOutlined /> },
                { value: 'roles', label: '指定角色', icon: <TeamOutlined /> },
                { value: 'public', label: '全实验室', icon: <GlobalOutlined /> },
              ]}
            />
          </Form.Item>
          {visibility === 'roles' ? (
            <Form.Item name="roles" label="可见角色组" rules={[{ required: true, message: '请至少选择一个角色组' }]}>
              <Select mode="tags" options={roleOptions} placeholder="选择或输入角色组，如 lab-teacher" />
            </Form.Item>
          ) : null}
          <Form.Item name="body" label="正文" extra="支持纯文本，最多 200 KB；保存后会自动重建检索索引">
            <Input.TextArea rows={14} placeholder="记录实验步骤、参数、结论或链接……" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={uploadOpen}
        title="上传文档入库"
        width={620}
        okText="上传并入库"
        cancelText="取消"
        confirmLoading={ingest.isPending}
        onOk={() => uploadForm.submit()}
        onCancel={() => {
          setUploadOpen(false);
          setFileList([]);
        }}
        destroyOnHidden
      >
        <Form
          form={uploadForm}
          layout="vertical"
          requiredMark="optional"
          initialValues={{ visibility: 'private', roles: [], spaceId: 0 }}
          onFinish={(values) => ingest.mutate(values)}
        >
          <Form.Item label="选择方式">
            <Flex gap={10} align="center" wrap>
              <Switch checked={dirMode} onChange={setDirMode} />
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                {dirMode
                  ? '整个目录：保留目录结构入库，一层子目录里的文件会记成 相对路径/文件名'
                  : '单文件：可以一次多选，最多 50 个'}
              </Typography.Text>
            </Flex>
          </Form.Item>
          <Form.Item label="文件" required>
            <Upload.Dragger
              key={dirMode ? 'dir' : 'file'}
              beforeUpload={() => false}
              multiple
              directory={dirMode}
              maxCount={50}
              fileList={fileList}
              onChange={({ fileList: next }) => setFileList(next.slice(0, 50))}
              accept={dirMode ? undefined : INGEST_ACCEPT}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">{dirMode ? '点击选择整个目录' : '点击或拖拽文件到此处'}</p>
              <p className="ant-upload-hint">
                PDF / Office 由文档抽取服务解析，纯文本直接入库。{MAX_BATCH_HINT}
              </p>
            </Upload.Dragger>
          </Form.Item>
          <Row gutter={12}>
            <Col xs={24} md={12}>
              <Form.Item name="spaceId" label="所属知识库" extra="只能写入你创建或管理的知识库">
                <Select options={spaceTargets} placeholder="未归档" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="category" label="文件夹" extra="同一批文件会落在同一个文件夹下">
                <AutoComplete
                  options={categoryOptions}
                  placeholder="例如：生信流程 / 项目/2026"
                  showSearch={{ filterOption: (input, option) => String(option?.value ?? '').includes(input.trim()) }}
                  maxLength={96}
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="tags" label="标签" extra="整批共用，便于后续按标签筛选">
            <Select mode="tags" placeholder="输入后回车添加，最多 20 个" tokenSeparators={[',', '，']} />
          </Form.Item>
          <Form.Item name="visibility" label="可见范围" extra={VISIBILITY[uploadVisibility]?.hint}>
            <Segmented
              options={[
                { value: 'private', label: '仅自己', icon: <LockOutlined /> },
                { value: 'roles', label: '指定角色', icon: <TeamOutlined /> },
                { value: 'public', label: '全实验室', icon: <GlobalOutlined /> },
              ]}
            />
          </Form.Item>
          {uploadVisibility === 'roles' ? (
            <Form.Item name="roles" label="可见角色组" rules={[{ required: true, message: '请至少选择一个角色组' }]}>
              <Select mode="tags" options={roleOptions} placeholder="选择或输入角色组，如 lab-teacher" />
            </Form.Item>
          ) : null}
        </Form>
      </Modal>

      <Modal
        open={pickerOpen}
        title="从文件存储入库"
        width={860}
        okText={`入库${picked.length ? `（${picked.length}）` : ''}`}
        cancelText="取消"
        confirmLoading={fromFiles.isPending}
        okButtonProps={{ disabled: picked.length === 0 }}
        onOk={() => pickForm.submit()}
        onCancel={() => {
          setPickerOpen(false);
          setPicked([]);
        }}
        destroyOnHidden
      >
        <Flex vertical gap={12}>
          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
            只列出你有权读取的文件；入库时用你自己的会话重新过一次文件 ACL，读不到的会跳过并说明原因。
            同一文件重复入库会覆盖旧条目。{MAX_BATCH_HINT}
          </Typography.Text>
          <Space size={8} wrap>
            <Button
              size="small"
              icon={<FolderOutlined />}
              disabled={!pickerDir}
              onClick={() => setPickerDir(pickerDir.includes('/') ? pickerDir.slice(0, pickerDir.lastIndexOf('/')) : '')}
            >
              上一层
            </Button>
            <Typography.Text style={{ fontSize: 12.5 }}>
              个人空间 / {pickerDir || '（根目录）'}
            </Typography.Text>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => pickerEntries.refetch()}>
              刷新
            </Button>
          </Space>
          <Table<FileEntry>
            size="small"
            rowKey="id"
            loading={pickerEntries.isLoading}
            dataSource={pickerChildren}
            pagination={false}
            scroll={{ y: 280 }}
            onRow={(row) => ({
              onDoubleClick: () => {
                if (row.dir) setPickerDir(row.path);
              },
            })}
            rowSelection={{
              selectedRowKeys: picked.map((p) => p.id),
              // 勾选跨目录保留：只替换当前目录内的选择，其余原样留着。
              onChange: (keys) => {
                const wanted = new Set(keys);
                const currentIds = new Set(pickerChildren.filter((e) => !e.dir).map((e) => e.id));
                const kept = picked.filter((p) => !currentIds.has(p.id));
                const added = pickerChildren.filter((e) => !e.dir && wanted.has(e.id));
                setPicked([...kept, ...added].slice(0, 50));
              },
              getCheckboxProps: (row) => ({ disabled: row.dir }),
            }}
            columns={[
              {
                title: '名称',
                dataIndex: 'name',
                render: (_v, row) => (
                  <Flex gap={6} align="center">
                    {row.dir ? (
                      <FolderOutlined style={{ color: token.colorWarning }} />
                    ) : (
                      <FileTextOutlined style={{ color: token.colorPrimary }} />
                    )}
                    <Typography.Text ellipsis style={{ maxWidth: 340 }}>
                      {row.name}
                    </Typography.Text>
                  </Flex>
                ),
              },
              {
                title: '大小',
                dataIndex: 'size',
                width: 90,
                render: (v: number, row) => (row.dir ? '—' : formatBytes(v)),
              },
              { title: '更新时间', dataIndex: 'modified', width: 170, render: (v: string) => formatTime(v) },
            ]}
          />
          {picked.length ? (
            <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
              已选 {picked.length} 个文件：{picked.map((p) => p.path.split('/').pop()).slice(0, 6).join('、')}
              {picked.length > 6 ? '…' : ''}
            </Typography.Text>
          ) : null}
          <Form
            form={pickForm}
            layout="vertical"
            requiredMark="optional"
            initialValues={{ visibility: 'private', roles: [], tags: [], category: '', spaceId: 0 }}
            onFinish={(values) => fromFiles.mutate(values)}
          >
            <Row gutter={12}>
              <Col xs={24} md={12}>
                <Form.Item name="spaceId" label="所属知识库" extra="只能写入你创建或管理的知识库">
                  <Select options={spaceTargets} placeholder="未归档" />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item name="category" label="文件夹" extra="留空即为未分类">
                  <AutoComplete
                    options={categoryOptions}
                    placeholder="例如：生信流程 / 工具手册"
                    showSearch={{ filterOption: (input, option) => String(option?.value ?? '').includes(input.trim()) }}
                    maxLength={96}
                  />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item name="tags" label="标签">
              <Select mode="tags" placeholder="输入后回车添加" tokenSeparators={[',', '，']} />
            </Form.Item>
            <Form.Item name="visibility" label="可见范围" extra={VISIBILITY[pickVisibility]?.hint}>
              <Segmented
                options={[
                  { value: 'private', label: '仅自己', icon: <LockOutlined /> },
                  { value: 'roles', label: '指定角色', icon: <TeamOutlined /> },
                  { value: 'public', label: '全实验室', icon: <GlobalOutlined /> },
                ]}
              />
            </Form.Item>
            {pickVisibility === 'roles' ? (
              <Form.Item name="roles" label="可见角色组" rules={[{ required: true, message: '请至少选择一个角色组' }]}>
                <Select mode="tags" options={roleOptions} placeholder="选择或输入角色组，如 lab-teacher" />
              </Form.Item>
            ) : null}
          </Form>
        </Flex>
      </Modal>

      <Modal
        open={spaceOpen}
        title={spaceEditing ? '设置知识库' : '新建知识库'}
        width={560}
        okText="保存"
        cancelText="取消"
        confirmLoading={saveSpace.isPending}
        onOk={() => spaceForm.submit()}
        onCancel={() => {
          setSpaceOpen(false);
          setSpaceEditing(null);
        }}
        destroyOnHidden
      >
        <Form
          form={spaceForm}
          layout="vertical"
          requiredMark="optional"
          initialValues={{ visibility: 'private', roles: [] }}
          onFinish={(values) => saveSpace.mutate(values)}
          style={{ marginTop: 8 }}
        >
          <Form.Item
            name="name"
            label="名称"
            rules={[
              { required: true, whitespace: true, message: '请输入知识库名称' },
              { max: 48, message: '名称最多 48 字' },
            ]}
          >
            <Input placeholder="例如：课题组文献 / 平台手册" maxLength={48} showCount />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input.TextArea rows={3} maxLength={300} showCount placeholder="这个知识库收录什么内容" />
          </Form.Item>
          <Form.Item name="visibility" label="可见范围" extra={VISIBILITY[spaceVisibility]?.hint}>
            <Segmented
              options={[
                { value: 'private', label: '仅自己', icon: <LockOutlined /> },
                { value: 'roles', label: '指定角色', icon: <TeamOutlined /> },
                { value: 'public', label: '全实验室', icon: <GlobalOutlined /> },
              ]}
            />
          </Form.Item>
          {spaceVisibility === 'roles' ? (
            <Form.Item name="roles" label="可见角色组" rules={[{ required: true, message: '请至少选择一个角色组' }]}>
              <Select mode="tags" options={roleOptions} placeholder="选择或输入角色组，如 lab-teacher" />
            </Form.Item>
          ) : null}
        </Form>
      </Modal>

      <Modal
        open={viewDocId != null}
        title={viewDoc.data?.item.title ?? '引用原文'}
        width={760}
        footer={null}
        onCancel={() => setViewDocId(null)}
        destroyOnHidden
      >
        {viewDoc.isLoading ? (
          <Flex justify="center" style={{ padding: 32 }}>
            <Spin />
          </Flex>
        ) : viewDoc.data?.item ? (
          <Flex vertical gap={10}>
            <Space size={8} wrap>
              <VisibilityTag value={viewDoc.data.item.visibility} />
              <Typography.Text type="secondary">
                {resolveDisplayName(viewDoc.data.item.owner, peopleMap, viewDoc.data.item.ownerName)} · 更新{' '}
                {formatTime(viewDoc.data.item.updatedAt)}
              </Typography.Text>
            </Space>
            <Typography.Paragraph
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                lineHeight: 1.75,
                maxHeight: '60vh',
                overflowY: 'auto',
              }}
            >
              {viewDoc.data.item.body || viewDoc.data.item.excerpt}
            </Typography.Paragraph>
          </Flex>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="引用文档不存在或无权访问" />
        )}
      </Modal>
    </Flex>
  );
}