import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Badge,
  Button,
  Calendar,
  Card,
  Drawer,
  Dropdown,
  Empty,
  Flex,
  Form,
  Grid,
  Input,
  InputNumber,
  Modal,
  Select,
  Segmented,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  AppstoreOutlined,
  CalendarOutlined,
  CloudUploadOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  EllipsisOutlined,
  FieldStringOutlined,
  PlusOutlined,
  ProfileOutlined,
  ReloadOutlined,
  RobotOutlined,
  SearchOutlined,
  ShareAltOutlined,
  TableOutlined,
  TeamOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Prompts, Welcome } from '@ant-design/x';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useNavigate } from 'react-router-dom';
import {
  api,
  baserowApi,
  type BaserowField,
  type BaserowMember,
  type BaserowPerson,
  type BaserowRow,
  type BaserowTableRef,
  type BaserowWorkspace,
  type WorkbenchItem,
} from '../services/api';
import { errText } from '../utils/err';
import { handoffToAgent } from '../utils/agentHandoff';
import PageShell from '../components/PageShell';

type ViewMode = 'grid' | 'gallery' | 'kanban' | 'calendar';

const EDITABLE = new Set([
  'text',
  'long_text',
  'number',
  'rating',
  'boolean',
  'date',
  'url',
  'email',
  'single_select',
  'multiple_select',
  'people',
]);
const FIELD_TYPES = [
  { value: 'text', label: '单行文本' },
  { value: 'long_text', label: '多行文本' },
  { value: 'number', label: '数字' },
  { value: 'boolean', label: '是 / 否' },
  { value: 'date', label: '日期' },
  { value: 'url', label: '链接' },
  { value: 'email', label: '邮箱' },
  { value: 'people', label: '人员（系统账号）' },
];
const FIELD_TYPE_LABELS: Record<string, string> = {
  people: '人员',
  single_select: '单选',
  multiple_select: '多选',
  long_text: '多行文本',
  text: '文本',
  number: '数字',
  boolean: '是 / 否',
  date: '日期',
  url: '链接',
  email: '邮箱',
  link_row: '关联',
  file: '文件',
};
const ROLE_OPTIONS = [
  { value: 'ADMIN', label: '管理员' },
  { value: 'MEMBER', label: '成员' },
  { value: 'VIEWER', label: '只读' },
];
const VIEW_OPTIONS = [
  { value: 'grid', label: '表格', icon: <TableOutlined /> },
  { value: 'gallery', label: '画廊', icon: <AppstoreOutlined /> },
  { value: 'kanban', label: '看板', icon: <ProfileOutlined /> },
  { value: 'calendar', label: '日历', icon: <CalendarOutlined /> },
];

function optionId(value: unknown): number | string | undefined {
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    return (v.id as number) ?? (v.value as string);
  }
  return value as number | string | undefined;
}

function selectLabel(field: BaserowField, value: unknown): { label: string; color?: string } {
  const id = optionId(value);
  const hit = field.select_options.find((o) => o.id === id || o.value === id);
  return { label: hit?.value ?? String(id ?? ''), color: hit?.color };
}

function personRowId(value: unknown): number | undefined {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>).id : value;
  const id = Number(raw);
  return Number.isFinite(id) ? id : undefined;
}

function personLabel(value: unknown, peopleByRow?: Map<number, BaserowPerson>): string {
  const id = personRowId(value);
  if (id === undefined) return '';
  const person = peopleByRow?.get(id);
  if (person) return person.displayName;
  if (value && typeof value === 'object') {
    const raw = (value as Record<string, unknown>).value;
    if (raw !== undefined && raw !== null && raw !== '') return String(raw);
  }
  return peopleByRow ? `#${id}` : String(id);
}

function plainText(field: BaserowField | undefined, value: unknown, peopleByRow?: Map<number, BaserowPerson>): string {
  if (value === null || value === undefined || value === '') return '';
  if (field?.type === 'people') {
    if (Array.isArray(value)) return value.map((v) => personLabel(v, peopleByRow)).filter(Boolean).join(', ');
    return personLabel(value, peopleByRow);
  }
  if (field?.type === 'single_select') return selectLabel(field, value).label;
  if (field?.type === 'multiple_select' && Array.isArray(value)) {
    return value.map((v) => selectLabel(field, v).label).join(', ');
  }
  if (field?.type === 'boolean') return value ? '是' : '否';
  if (field?.type === 'date' && typeof value === 'string') {
    const d = dayjs(value);
    return d.isValid() ? d.format('YYYY-MM-DD') : value;
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function dateKey(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    const inner = v.value ?? v.date ?? v.start;
    return inner ? dateKey(inner) : '';
  }
  const d = dayjs(String(value));
  return d.isValid() ? d.format('YYYY-MM-DD') : '';
}

function renderValue(field: BaserowField, value: unknown, peopleByRow?: Map<number, BaserowPerson>) {
  if (value === null || value === undefined || value === '') return <Typography.Text type="secondary">—</Typography.Text>;
  if (field.type === 'boolean') return <Tag color={value ? 'green' : 'default'}>{value ? '是' : '否'}</Tag>;
  if (field.type === 'people') {
    const items = Array.isArray(value) ? value : [value];
    return (
      <Space size={4} wrap>
        {items.map((v, i) => (
          <Tag key={i} color="blue">
            {personLabel(v, peopleByRow) || '—'}
          </Tag>
        ))}
      </Space>
    );
  }
  if (field.type === 'single_select') {
    const { label, color } = selectLabel(field, value);
    return <Tag color={color || 'default'}>{label}</Tag>;
  }
  if (field.type === 'multiple_select' && Array.isArray(value)) {
    return (
      <Space size={4} wrap>
        {value.map((v, i) => {
          const { label, color } = selectLabel(field, v);
          return <Tag key={i} color={color || 'default'}>{label}</Tag>;
        })}
      </Space>
    );
  }
  if (field.type === 'url' && typeof value === 'string') {
    return (
      <a href={value} target="_blank" rel="noreferrer noopener">
        {value}
      </a>
    );
  }
  if (field.type === 'file' && Array.isArray(value)) return `${value.length} 个文件`;
  if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value);
  return field.type === 'long_text' ? (
    <Typography.Text ellipsis={{ tooltip: text }} style={{ maxWidth: 320 }}>
      {text}
    </Typography.Text>
  ) : (
    text
  );
}

function toFormValue(field: BaserowField, value: unknown): unknown {
  if (value === null || value === undefined) return field.type === 'boolean' ? false : undefined;
  if (field.type === 'single_select') return optionId(value);
  if (field.type === 'multiple_select' && Array.isArray(value)) return value.map(optionId).filter((v) => v !== undefined);
  if (field.type === 'people') {
    const list = Array.isArray(value) ? value : [value];
    return list.map(personRowId).filter((v): v is number => v !== undefined);
  }
  return value;
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function BaserowPage() {
  const { message, modal } = App.useApp();
  const screens = Grid.useBreakpoint();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const narrow = !screens.lg;

  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [databaseId, setDatabaseId] = useState<number | null>(null);
  const [tableId, setTableId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(50);
  const [search, setSearch] = useState('');
  const [orderBy, setOrderBy] = useState('');
  const [createKind, setCreateKind] = useState<null | 'workspace' | 'database' | 'table'>(null);
  const [fieldOpen, setFieldOpen] = useState(false);
  const [rowOpen, setRowOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<BaserowRow | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('MEMBER');
  const [renameTarget, setRenameTarget] = useState<BaserowField | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [importing, setImporting] = useState(false);
  const [fieldFormKey, setFieldFormKey] = useState(0);

  const [createForm] = Form.useForm<{ name: string }>();
  const [rowForm] = Form.useForm<Record<string, unknown>>();

  const overview = useQuery({ queryKey: ['baserow', 'overview'], queryFn: baserowApi.overview });
  const workspaces = overview.data?.workspaces ?? [];

  const selectedWorkspace: BaserowWorkspace | undefined = useMemo(
    () =>
      workspaces.find((w) => w.id === workspaceId) ??
      workspaces.find((w) => w.databases.some((d) => d.id === databaseId)),
    [workspaces, workspaceId, databaseId],
  );

  const tablesQuery = useQuery({
    queryKey: ['baserow', 'tables', databaseId],
    queryFn: () => baserowApi.tables(databaseId as number),
    enabled: databaseId !== null,
  });
  const tables = tablesQuery.data?.tables ?? [];

  const fieldsQuery = useQuery({
    queryKey: ['baserow', 'fields', tableId],
    queryFn: () => baserowApi.fields(tableId as number),
    enabled: tableId !== null,
  });
  const fields = fieldsQuery.data?.fields ?? [];

  const rowsQuery = useQuery({
    queryKey: ['baserow', 'rows', tableId, page, size, search, orderBy],
    queryFn: () => baserowApi.rows(tableId as number, { page, size, search, order_by: orderBy }),
    enabled: tableId !== null,
  });

  const viewRowsQuery = useQuery({
    queryKey: ['baserow', 'view-rows', tableId, search, orderBy],
    queryFn: () => baserowApi.rows(tableId as number, { page: 1, size: 200, search, order_by: orderBy }),
    enabled: tableId !== null && viewMode !== 'grid',
  });
  const viewRows = viewRowsQuery.data?.results ?? [];

  const membersQuery = useQuery({
    queryKey: ['baserow', 'members', selectedWorkspace?.id],
    queryFn: () => baserowApi.members(selectedWorkspace?.id as number),
    enabled: shareOpen && Boolean(selectedWorkspace?.id),
  });
  const members: BaserowMember[] = membersQuery.data?.members ?? [];

  const hasPeopleField = fields.some((f) => f.people);
  const peopleQuery = useQuery({
    queryKey: ['baserow', 'people', tableId],
    queryFn: () => baserowApi.people(tableId as number),
    enabled: tableId !== null && hasPeopleField,
    staleTime: 60_000,
  });
  const people = peopleQuery.data?.people ?? [];
  const peopleByRow = useMemo(() => new Map(people.map((p) => [p.row_id, p])), [people]);

  useEffect(() => {
    if (workspaceId === null && workspaces.length) setWorkspaceId(workspaces[0].id);
  }, [workspaceId, workspaces]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    const dbs = selectedWorkspace.databases;
    if (databaseId !== null && dbs.some((d) => d.id === databaseId)) return;
    setDatabaseId(dbs[0]?.id ?? null);
    setTableId(null);
  }, [selectedWorkspace, databaseId]);

  useEffect(() => {
    if (databaseId === null) {
      setTableId(null);
      return;
    }
    if (!tablesQuery.isSuccess) return;
    if (tableId === null || !tables.some((t) => t.id === tableId)) {
      setTableId(tables[0]?.id ?? null);
      setPage(1);
      setSearch('');
      setOrderBy('');
    }
  }, [databaseId, tablesQuery.isSuccess, tables, tableId]);

  const invalidate = (kind: 'overview' | 'tables' | 'fields' | 'rows' | 'view-rows') => {
    if (kind === 'rows') {
      qc.invalidateQueries({ queryKey: ['baserow', 'rows'] });
      qc.invalidateQueries({ queryKey: ['baserow', 'view-rows'] });
      return;
    }
    qc.invalidateQueries({ queryKey: ['baserow', kind] });
  };

  const createMutation = useMutation({
    mutationFn: async (vars: { kind: 'workspace' | 'database' | 'table'; name: string }) => {
      if (vars.kind === 'workspace') return baserowApi.createWorkspace(vars.name);
      if (vars.kind === 'database') {
        if (!selectedWorkspace?.id) throw new Error('请先选择工作区');
        return baserowApi.createDatabase(selectedWorkspace.id, vars.name);
      }
      if (!databaseId) throw new Error('请先选择数据表');
      return baserowApi.createTable(databaseId, vars.name);
    },
    onSuccess: async (data, vars) => {
      message.success('已创建');
      setCreateKind(null);
      createForm.resetFields();
      if (vars.kind === 'workspace') {
        await invalidate('overview');
        setWorkspaceId(data.id);
      } else if (vars.kind === 'database') {
        await invalidate('overview');
        setWorkspaceId(selectedWorkspace?.id ?? null);
        setDatabaseId(data.id);
      } else {
        await invalidate('tables');
        setTableId(data.id);
        setPage(1);
      }
    },
    onError: (e) => message.error(errText(e)),
  });

  const fieldMutation = useMutation({
    mutationFn: (vars: { name: string; type: string }) => baserowApi.createField(tableId as number, vars.name, vars.type),
    onSuccess: async () => {
      message.success('已新增字段');
      setFieldFormKey((k) => k + 1);
      await invalidate('fields');
    },
    onError: (e) => message.error(errText(e)),
  });

  const renameMutation = useMutation({
    mutationFn: (vars: { field: BaserowField; name: string }) =>
      baserowApi.renameField(tableId as number, vars.field.id, vars.name),
    onSuccess: async () => {
      message.success('字段已重命名');
      setRenameTarget(null);
      await invalidate('fields');
      await invalidate('rows');
    },
    onError: (e) => message.error(errText(e)),
  });

  const deleteFieldMutation = useMutation({
    mutationFn: (fieldId: number) => baserowApi.deleteField(tableId as number, fieldId),
    onSuccess: async () => {
      message.success('字段已删除');
      await invalidate('fields');
      await invalidate('rows');
    },
    onError: (e) => message.error(errText(e)),
  });

  const rowMutation = useMutation({
    mutationFn: (vars: { values: Record<string, unknown>; row?: BaserowRow }) =>
      vars.row
        ? baserowApi.updateRow(tableId as number, vars.row.id, vars.values)
        : baserowApi.createRow(tableId as number, vars.values),
    onSuccess: async () => {
      message.success(editingRow ? '已保存' : '已新增');
      setRowOpen(false);
      setEditingRow(null);
      rowForm.resetFields();
      await invalidate('rows');
    },
    onError: (e) => message.error(errText(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (rowId: number) => baserowApi.deleteRow(tableId as number, rowId),
    onSuccess: async () => {
      message.success('已删除');
      await invalidate('rows');
    },
    onError: (e) => message.error(errText(e)),
  });

  const deleteTableMutation = useMutation({
    mutationFn: () => baserowApi.deleteTable(tableId as number),
    onSuccess: async () => {
      message.success('工作表已删除');
      setTableId(null);
      await invalidate('tables');
    },
    onError: (e) => message.error(errText(e)),
  });

  const inviteMutation = useMutation({
    mutationFn: () => baserowApi.inviteMember(selectedWorkspace?.id as number, inviteEmail.trim(), inviteRole),
    onSuccess: async () => {
      message.success('邀请已发送');
      setInviteEmail('');
      await qc.invalidateQueries({ queryKey: ['baserow', 'members'] });
    },
    onError: (e) => message.error(errText(e)),
  });

  const updateMemberMutation = useMutation({
    mutationFn: (vars: { id: number; permissions: string }) =>
      baserowApi.updateMember(selectedWorkspace?.id as number, vars.id, vars.permissions),
    onSuccess: async () => {
      message.success('权限已更新');
      await qc.invalidateQueries({ queryKey: ['baserow', 'members'] });
    },
    onError: (e) => message.error(errText(e)),
  });

  const removeMemberMutation = useMutation({
    mutationFn: (id: number) => baserowApi.removeMember(selectedWorkspace?.id as number, id),
    onSuccess: async () => {
      message.success('已移除成员');
      await qc.invalidateQueries({ queryKey: ['baserow', 'members'] });
    },
    onError: (e) => message.error(errText(e)),
  });

  const editableFields = useMemo(() => fields.filter((f) => !f.read_only && EDITABLE.has(f.type)), [fields]);
  const primaryField = fields.find((f) => f.primary) ?? fields[0];
  const groupField = fields.find((f) => f.type === 'single_select');
  const dateField = fields.find((f) => f.type === 'date');
  const cardFields = fields.filter((f) => f.id !== primaryField?.id && f.type !== 'file').slice(0, 4);

  const columns: ColumnsType<BaserowRow> = useMemo(() => {
    const dataCols: ColumnsType<BaserowRow> = fields
      .filter((f) => f.type !== 'file')
      .map((f) => ({
        title: (
          <Space size={4}>
            <span>{f.name}</span>
            {f.primary && <Tag color="blue">主字段</Tag>}
          </Space>
        ),
        dataIndex: f.name,
        key: f.name,
        ellipsis: true,
        sorter: true,
        render: (_: unknown, row: BaserowRow) => renderValue(f, row[f.name], peopleByRow),
      }));
    dataCols.push({
      title: '操作',
      key: '__actions',
      width: 96,
      fixed: 'right',
      render: (_: unknown, row: BaserowRow) => (
        <Space size={4}>
          <Tooltip title="建为任务">
            <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => void createTaskFromRow(row)} />
          </Tooltip>
          <Tooltip title="编辑">
            <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openRowEdit(row)} />
          </Tooltip>
          <Tooltip title="删除">
            <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => confirmDeleteRow(row)} />
          </Tooltip>
        </Space>
      ),
    });
    return dataCols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, editableFields, peopleByRow]);

  const confirmDeleteRow = (row: BaserowRow) =>
    modal.confirm({
      title: '删除这一行？',
      content: '删除后不可恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => deleteMutation.mutateAsync(row.id),
    });

  const openRowEdit = (row: BaserowRow) => {
    setEditingRow(row);
    rowForm.setFieldsValue(
      Object.fromEntries(editableFields.map((f) => [f.name, toFormValue(f, row[f.name])])),
    );
    setRowOpen(true);
  };

  const openRowCreate = () => {
    setEditingRow(null);
    rowForm.resetFields();
    setRowOpen(true);
  };

  const submitRow = async () => {
    const raw = await rowForm.validateFields();
    const values: Record<string, unknown> = {};
    editableFields.forEach((f) => {
      const value = raw[f.name];
      if (value === undefined) return;
      values[f.name] =
        f.type === 'date' && value instanceof Object && 'format' in value
          ? (value as { format: (s: string) => string }).format('YYYY-MM-DD')
          : value;
    });
    rowMutation.mutate({ values, row: editingRow ?? undefined });
  };

  const openCreate = (kind: 'workspace' | 'database' | 'table') => {
    createForm.resetFields();
    createForm.setFieldsValue({
      name: kind === 'workspace' ? '新工作区' : kind === 'database' ? '新数据表' : '新工作表',
    });
    setCreateKind(kind);
  };

  const exportCsv = async () => {
    if (!tableId) return;
    try {
      const all: BaserowRow[] = [];
      for (let p = 1; p <= 50; p += 1) {
        const res = await baserowApi.rows(tableId, { page: p, size: 200, search, order_by: orderBy });
        all.push(...res.results);
        if (!res.next || all.length >= res.count) break;
      }
      const exportFields = fields.filter((f) => f.type !== 'file');
      const header = exportFields.map((f) => f.name);
      const byName = new Map(exportFields.map((f) => [f.name, f]));
      const esc = (name: string, v: unknown) => `"${plainText(byName.get(name), v, peopleByRow).replace(/"/g, '""')}"`;
      const lines = [
        header.map((h) => `"${h.replace(/"/g, '""')}"`).join(','),
        ...all.map((r) => header.map((h) => esc(h, r[h])).join(',')),
      ];
      downloadCsv(`${currentTable?.name || '工作表'}-${dayjs().format('YYYYMMDD')}.csv`, `\ufeff${lines.join('\n')}`);
      message.success(`已导出 ${all.length} 条记录`);
    } catch (e) {
      message.error(`导出失败：${errText(e)}`);
    }
  };

  const runImport = async (file: File) => {
    if (!tableId) return;
    setImporting(true);
    try {
      const res = await baserowApi.importTable(tableId, file);
      message.success(`已导入 ${res.created} 行${res.fields_added.length ? `，新增字段：${res.fields_added.join('、')}` : ''}`);
      await invalidate('fields');
      await invalidate('rows');
    } catch (e) {
      message.error(`导入失败：${errText(e)}`);
    } finally {
      setImporting(false);
    }
  };

  /** 把个人工作台的任务导入当前工作表：列名固定，缺列由后端自动建立。 */
  const importFromWorkbench = async () => {
    if (!tableId) return;
    setImporting(true);
    try {
      const { items } = await api.workbenchItems({ limit: 200 });
      const source = items.filter((it: WorkbenchItem) => it.status !== 'done');
      if (!source.length) {
        message.info('工作台没有进行中的事项');
        return;
      }
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = ['标题', '类型', '优先级', '截止日期', '标签', '说明'];
      const lines = [
        header.map(esc).join(','),
        ...source.map((it) =>
          [it.title, it.kind, it.priority, it.due_date || '', (it.tags || []).join(' '), it.content].map(esc).join(','),
        ),
      ];
      const file = new File([`\ufeff${lines.join('\n')}`], '工作台任务.csv', { type: 'text/csv' });
      const res = await baserowApi.importTable(tableId, file);
      message.success(`已从工作台导入 ${res.created} 项${res.fields_added.length ? `，新增字段：${res.fields_added.join('、')}` : ''}`);
      await invalidate('fields');
      await invalidate('rows');
    } catch (e) {
      message.error(`导入失败：${errText(e)}`);
    } finally {
      setImporting(false);
    }
  };

  const createTaskFromRow = async (row: BaserowRow) => {
    const title = primaryField ? plainText(primaryField, row[primaryField.name], peopleByRow) : '';
    const lines = fields
      .filter((f) => f.type !== 'file')
      .map((f) => `${f.name}：${plainText(f, row[f.name], peopleByRow) || '—'}`);
    try {
      const created = await api.workbenchCreateItem({
        kind: 'task',
        title: (title || `表格记录 #${row.id}`).slice(0, 60),
        content: `来自多维表格「${currentTable?.name || '工作表'}」记录 #${row.id}\n${lines.join('\n')}`,
        priority: 'normal',
        tags: ['多维表格', currentTable?.name || '工作表'].slice(0, 2),
        due_date: dateField ? dateKey(row[dateField.name]) || null : null,
      });
      message.success('已创建任务，可在个人工作台查看');
      qc.invalidateQueries({ queryKey: ['workbench'] });
      return created;
    } catch (e) {
      message.error(`创建任务失败：${errText(e)}`);
      return null;
    }
  };

  /** 把当前表的结构与少量记录交给 Agent 分析，形成表格 → 助手联动。 */
  const analyzeWithAgent = () => {
    if (!tableId) return;
    const sample = (viewRowsQuery.data?.results ?? rowsQuery.data?.results ?? []).slice(0, 20);
    const preview = sample.map((row) => {
      const cells = fields
        .filter((f) => f.type !== 'file')
        .slice(0, 8)
        .map((f) => `${f.name}=${plainText(f, row[f.name], peopleByRow) || '—'}`);
      return `- ${cells.join(' | ')}`;
    });
    const prompt = [
      `请分析多维表格「${currentTable?.name || '工作表'}」的数据。`,
      `字段：${fields.map((f) => `${f.name}(${f.type})`).join('、')}`,
      `记录总数：${rowsQuery.data?.count ?? sample.length}`,
      preview.length ? `样例数据：\n${preview.join('\n')}` : '当前没有记录。',
      '请给出数据质量检查、趋势/异常与下一步建议。',
    ].join('\n');
    navigate(handoffToAgent(prompt));
  };

  const currentTable = tables.find((t: BaserowTableRef) => t.id === tableId);
  const loading = overview.isLoading || tablesQuery.isLoading || fieldsQuery.isLoading;
  const noWorkspaces = !overview.isLoading && workspaces.length === 0;

  const moreMenu: MenuProps['items'] = [
    { key: 'export', icon: <DownloadOutlined />, label: '导出 CSV' },
    { key: 'fields', icon: <FieldStringOutlined />, label: '字段管理' },
    { type: 'divider' },
    { key: 'delete-table', icon: <DeleteOutlined />, label: '删除工作表', danger: true },
  ];

  const rowCard = (row: BaserowRow) => (
    <Card
      key={row.id}
      size="small"
      className="baserow-card"
      title={
        <Typography.Text strong ellipsis style={{ maxWidth: 220 }}>
          {primaryField ? plainText(primaryField, row[primaryField.name], peopleByRow) || `记录 #${row.id}` : `记录 #${row.id}`}
        </Typography.Text>
      }
      extra={
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              { key: 'task', icon: <PlusOutlined />, label: '建为任务' },
              { key: 'edit', icon: <EditOutlined />, label: '编辑' },
              { key: 'delete', icon: <DeleteOutlined />, label: '删除', danger: true },
            ],
            onClick: ({ key }) => {
              if (key === 'task') void createTaskFromRow(row);
              if (key === 'edit') openRowEdit(row);
              if (key === 'delete') confirmDeleteRow(row);
            },
          }}
        >
          <Button size="small" type="text" icon={<EllipsisOutlined />} aria-label="更多操作" />
        </Dropdown>
      }
    >
      <Flex vertical gap={4}>
        {cardFields.map((f) => (
          <Flex key={f.id} justify="space-between" gap={8}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {f.name}
            </Typography.Text>
            <Typography.Text style={{ fontSize: 12 }} ellipsis={{ tooltip: plainText(f, row[f.name], peopleByRow) }}>
              {plainText(f, row[f.name], peopleByRow) || '—'}
            </Typography.Text>
          </Flex>
        ))}
      </Flex>
    </Card>
  );

  const galleryView = (
    <Spin spinning={viewRowsQuery.isFetching}>
      {viewRows.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${narrow ? 240 : 280}px, 1fr))`, gap: 12 }}>
          {viewRows.map(rowCard)}
        </div>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无记录" />
      )}
    </Spin>
  );

  const kanbanView = () => {
    if (!groupField) {
      return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="看板需要一个单选字段作为分组依据，请先新增「单选」字段" />;
    }
    const columnsData = [
      ...groupField.select_options.map((o) => ({ key: String(o.id), label: o.value, rows: [] as BaserowRow[] })),
      { key: '__none', label: '未分组', rows: [] as BaserowRow[] },
    ];
    viewRows.forEach((row) => {
      const id = String(optionId(row[groupField.name]) ?? '');
      const col = columnsData.find((c) => c.key === id) ?? columnsData[columnsData.length - 1];
      col.rows.push(row);
    });
    return (
      <Spin spinning={viewRowsQuery.isFetching}>
        <Flex gap={12} style={{ overflowX: 'auto', paddingBottom: 8, alignItems: 'flex-start' }}>
          {columnsData.map((col) => (
            <Card
              key={col.key}
              size="small"
              title={
                <Space size={6}>
                  <Badge color={col.key === '__none' ? '#bfbfbf' : '#2B5CE6'} />
                  <span>{col.label}</span>
                  <Tag>{col.rows.length}</Tag>
                </Space>
              }
              style={{ width: 280, flex: '0 0 280px', background: 'var(--ant-color-fill-quaternary)' }}
            >
              <Flex vertical gap={8}>
                {col.rows.length ? col.rows.map(rowCard) : <Typography.Text type="secondary" style={{ fontSize: 12 }}>暂无记录</Typography.Text>}
              </Flex>
            </Card>
          ))}
        </Flex>
      </Spin>
    );
  };

  const calendarView = () => {
    if (!dateField) {
      return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="日历需要一个日期字段，请先新增「日期」字段" />;
    }
    const byDay = new Map<string, BaserowRow[]>();
    viewRows.forEach((row) => {
      const key = dateKey(row[dateField.name]);
      if (!key) return;
      byDay.set(key, [...(byDay.get(key) ?? []), row]);
    });
    return (
      <Spin spinning={viewRowsQuery.isFetching}>
        <Calendar
          fullscreen={!narrow}
          cellRender={(date, info) => {
            if (info.type !== 'date') return info.originNode;
            const key = date.format('YYYY-MM-DD');
            const rows = byDay.get(key) ?? [];
            if (!rows.length) return null;
            return (
              <Flex vertical gap={2} style={{ marginTop: 2 }}>
                {rows.slice(0, 3).map((row) => (
                  <div
                    key={row.id}
                    style={{
                      fontSize: 11,
                      lineHeight: '16px',
                      background: 'rgba(43,92,230,0.10)',
                      color: '#2B5CE6',
                      borderRadius: 4,
                      padding: '0 4px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    onClick={() => openRowEdit(row)}
                  >
                    {primaryField ? plainText(primaryField, row[primaryField.name], peopleByRow) || `#${row.id}` : `#${row.id}`}
                  </div>
                ))}
                {rows.length > 3 ? (
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    +{rows.length - 3} 项
                  </Typography.Text>
                ) : null}
              </Flex>
            );
          }}
        />
      </Spin>
    );
  };

  const toolbar = (
    <Card size="small" styles={{ body: { padding: '10px 14px' } }}>
      <Flex justify="space-between" align="center" wrap gap={10}>
        <Space wrap size={8}>
          <Select
            style={{ minWidth: 150 }}
            value={workspaceId ?? undefined}
            loading={overview.isLoading}
            placeholder="工作区"
            options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
            onChange={(id) => {
              setWorkspaceId(id);
              setDatabaseId(null);
              setTableId(null);
              setPage(1);
            }}
            suffixIcon={<DatabaseOutlined />}
          />
          <Select
            style={{ minWidth: 150 }}
            value={databaseId ?? undefined}
            placeholder="数据表"
            disabled={!selectedWorkspace?.databases.length}
            options={(selectedWorkspace?.databases ?? []).map((d) => ({ value: d.id, label: d.name }))}
            onChange={(id) => {
              setDatabaseId(id);
              setTableId(null);
              setPage(1);
            }}
          />
          <Select
            style={{ minWidth: 160 }}
            value={tableId ?? undefined}
            placeholder="工作表"
            loading={tablesQuery.isLoading}
            disabled={!tables.length}
            options={tables.map((t) => ({ value: t.id, label: t.name }))}
            onChange={(id) => {
              setTableId(id);
              setPage(1);
              setSearch('');
              setOrderBy('');
            }}
          />
          <Segmented
            value={viewMode}
            onChange={(v) => setViewMode(v as ViewMode)}
            options={VIEW_OPTIONS.map((o) => ({ value: o.value, icon: o.icon, title: `${o.label}视图` }))}
          />
        </Space>
        <Space wrap size={8}>
          {tableId !== null ? (
            <Input.Search
              allowClear
              placeholder="搜索记录"
              prefix={<SearchOutlined />}
              style={{ width: 220 }}
              onSearch={(v) => {
                setSearch(v.trim());
                setPage(1);
              }}
            />
          ) : null}
          {selectedWorkspace && selectedWorkspace.databases.length === 0 ? (
            <Button icon={<PlusOutlined />} onClick={() => openCreate('database')}>
              新建数据表
            </Button>
          ) : null}
          <Upload
            accept=".csv,.tsv,.txt"
            showUploadList={false}
            customRequest={({ file, onSuccess, onError }) => {
              runImport(file as File).then(
                () => onSuccess?.({}),
                () => onError?.(new Error('import failed')),
              );
            }}
          >
            <Button icon={<CloudUploadOutlined />} loading={importing} disabled={tableId === null}>
              导入表格
            </Button>
          </Upload>
          <Tooltip title="把个人工作台进行中的事项写成表格导入">
            <Button
              icon={<UnorderedListOutlined />}
              loading={importing}
              disabled={tableId === null}
              onClick={() => void importFromWorkbench()}
            >
              从工作台导入
            </Button>
          </Tooltip>
          <Dropdown
            trigger={['click']}
            menu={{
              items: moreMenu,
              onClick: ({ key }) => {
                if (key === 'export') void exportCsv();
                if (key === 'fields') setFieldOpen(true);
                if (key === 'delete-table' && tableId !== null) {
                  modal.confirm({
                    title: '删除整个工作表？',
                    content: '工作表中的所有字段与记录都会删除，且不可恢复。',
                    okText: '删除',
                    okButtonProps: { danger: true },
                    cancelText: '取消',
                    onOk: () => deleteTableMutation.mutateAsync(),
                  });
                }
              },
            }}
          >
            <Button icon={<EllipsisOutlined />} aria-label="更多操作" />
          </Dropdown>
          <Tooltip title="共享工作区">
            <Button icon={<TeamOutlined />} onClick={() => setShareOpen(true)} disabled={!selectedWorkspace}>
              共享
            </Button>
          </Tooltip>
          <Badge count={workspaces.length} size="small" offset={[-2, 2]}>
            <Button icon={<PlusOutlined />} onClick={() => openCreate('workspace')} aria-label="新建工作区" />
          </Badge>
          <Button
            icon={<ReloadOutlined />}
            loading={overview.isFetching || rowsQuery.isFetching}
            onClick={() => {
              invalidate('overview');
              if (databaseId) invalidate('tables');
              if (tableId) {
                invalidate('fields');
                invalidate('rows');
              }
            }}
          >
            刷新
          </Button>
          <Tooltip title="把当前表结构与样例交给 Agent 分析">
            <Button icon={<RobotOutlined />} disabled={tableId === null} onClick={analyzeWithAgent}>
              分析数据
            </Button>
          </Tooltip>
          <Button type="primary" icon={<PlusOutlined />} onClick={openRowCreate} disabled={tableId === null}>
            新增记录
          </Button>
        </Space>
      </Flex>
    </Card>
  );

  const content = () => {
    if (noWorkspaces) {
      return (
        <Card variant="borderless" style={{ background: 'var(--ant-color-fill-quaternary)' }}>
          <Flex vertical align="center" gap={16} style={{ padding: '32px 12px' }}>
            <Welcome
              variant="borderless"
              icon={<TableOutlined style={{ fontSize: 44, color: '#2B5CE6' }} />}
              title="用多维表格整理实验记录"
              description="每位成员拥有独立的工作区，可自由创建数据表、字段与记录；需要协作时可邀请同组成员共享。"
            />
            <Prompts
              wrap
              items={[
                { key: 'create', label: '创建我的第一个工作区', description: '默认命名「个人空间」' },
                { key: 'help', label: '多维表格能做什么？', description: '结构化记录 / 视图 / 协作' },
              ]}
              onItemClick={(info) => {
                if (info.data.key === 'create') createMutation.mutate({ kind: 'workspace', name: '个人空间' });
                else message.info('支持表格、画廊、看板、日历四种视图，可导入 CSV、导出数据并邀请成员共享。');
              }}
            />
          </Flex>
        </Card>
      );
    }
    if (databaseId === null) {
      return (
        <Card>
          <Empty description="当前工作区还没有数据表">
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate('database')}>
              新建数据表
            </Button>
          </Empty>
        </Card>
      );
    }
    if (tables.length === 0 && !tablesQuery.isLoading) {
      return (
        <Card>
          <Empty description="这个数据表还没有工作表">
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate('table')}>
              新建工作表
            </Button>
          </Empty>
        </Card>
      );
    }
    if (tableId === null) {
      return (
        <Card>
          <Empty description="选择或新建一个工作表" />
        </Card>
      );
    }
    return (
      <Card
        size="small"
        title={
          <Space size={8} wrap>
            <Typography.Text strong>{currentTable?.name || '工作表'}</Typography.Text>
            <Tag color={selectedWorkspace?.name.includes('个人') ? 'default' : 'blue'}>
              {selectedWorkspace?.name.includes('个人') ? '个人' : '共享'}
            </Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {rowsQuery.data ? `共 ${rowsQuery.data.count} 条记录` : `${fields.length} 个字段`}
            </Typography.Text>
          </Space>
        }
        extra={
          <Space wrap>
            <Button size="small" icon={<PlusOutlined />} onClick={() => setFieldOpen(true)}>
              新增字段
            </Button>
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openRowCreate}>
              新增记录
            </Button>
          </Space>
        }
      >
        {viewMode === 'grid' ? (
          <Table<BaserowRow>
            size="middle"
            rowKey="id"
            loading={loading || rowsQuery.isFetching}
            dataSource={rowsQuery.data?.results ?? []}
            columns={columns}
            scroll={{ x: 'max-content' }}
            pagination={{
              current: page,
              pageSize: size,
              total: rowsQuery.data?.count ?? 0,
              showSizeChanger: true,
              pageSizeOptions: [20, 50, 100, 200],
              showTotal: (t) => `共 ${t} 条`,
              onChange: (p, s) => {
                setPage(p);
                setSize(s);
              },
            }}
            onChange={(_p, _f, sorter) => {
              const s = Array.isArray(sorter) ? sorter[0] : sorter;
              const field = s?.field;
              if (!s?.order || !field) setOrderBy('');
              else setOrderBy(`${s.order === 'descend' ? '-' : ''}${String(field)}`);
              setPage(1);
            }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无记录" /> }}
          />
        ) : viewMode === 'gallery' ? (
          galleryView
        ) : viewMode === 'kanban' ? (
          kanbanView()
        ) : (
          calendarView()
        )}
      </Card>
    );
  };

  return (
    <PageShell
      title="多维表格"
      description="结构化记录实验数据，支持表格 / 画廊 / 看板 / 日历视图、CSV 导入导出、系统人员指派与工作区共享。"
      extra={
        <Space wrap>
          <Button icon={<UnorderedListOutlined />} onClick={() => setShareOpen(true)}>
            成员与权限
          </Button>
          <Button icon={<PlusOutlined />} onClick={() => openCreate('database')} disabled={!selectedWorkspace}>
            新建数据表
          </Button>
        </Space>
      }
    >
      <Flex vertical gap={12}>
        {toolbar}
        {content()}
      </Flex>

      <Modal
        title={createKind === 'workspace' ? '新建工作区' : createKind === 'database' ? '新建数据表' : '新建工作表'}
        open={createKind !== null}
        onCancel={() => setCreateKind(null)}
        onOk={() => createForm.submit()}
        okText="创建"
        cancelText="取消"
        confirmLoading={createMutation.isPending}
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical" onFinish={(v) => createKind && createMutation.mutate({ kind: createKind, name: v.name.trim() })}>
          <Form.Item name="name" label="名称" rules={[{ required: true, whitespace: true, message: '请输入名称' }]}>
            <Input maxLength={64} placeholder="例如：实验记录" onPressEnter={() => createForm.submit()} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer title="字段管理" open={fieldOpen} onClose={() => setFieldOpen(false)} width={narrow ? '100%' : 460}>
        <Flex vertical gap={12}>
          {fields.map((f) => (
            <Flex key={f.id} align="center" justify="space-between" gap={8}>
              <Space size={6}>
                <Typography.Text strong={f.primary}>{f.name}</Typography.Text>
                <Tag>{FIELD_TYPE_LABELS[f.type] || f.type}</Tag>
                {f.primary ? <Tag color="blue">主字段</Tag> : null}
                {f.read_only ? <Tag color="default">只读</Tag> : null}
              </Space>
              {!f.read_only ? (
                <Space size={2}>
                  <Button
                    size="small"
                    type="text"
                    icon={<EditOutlined />}
                    aria-label={`重命名字段 ${f.name}`}
                    onClick={() => {
                      setRenameTarget(f);
                      setRenameValue(f.name);
                    }}
                  />
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    aria-label={`删除字段 ${f.name}`}
                    onClick={() =>
                      modal.confirm({
                        title: `删除字段「${f.name}」？`,
                        content: '字段及其数据将被删除，且不可恢复。',
                        okText: '删除',
                        okButtonProps: { danger: true },
                        cancelText: '取消',
                        onOk: () => deleteFieldMutation.mutateAsync(f.id),
                      })
                    }
                  />
                </Space>
              ) : null}
            </Flex>
          ))}
          {hasPeopleField ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              人员字段关联「系统人员（自动同步）」表，账号目录变更后会自动更新；指派仅用于标记负责人。
            </Typography.Text>
          ) : null}
          <Form
            key={fieldFormKey}
            layout="inline"
            style={{ marginTop: 8 }}
            onFinish={(v) => fieldMutation.mutate(v as { name: string; type: string })}
            initialValues={{ type: 'text' }}
          >
            <Form.Item name="name" rules={[{ required: true, whitespace: true, message: '字段名称' }]}>
              <Input placeholder="新字段名称" style={{ width: 150 }} />
            </Form.Item>
            <Form.Item name="type">
              <Select options={FIELD_TYPES} style={{ width: 140 }} />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={fieldMutation.isPending}>
              添加
            </Button>
          </Form>
        </Flex>
      </Drawer>

      <Modal
        title="重命名字段"
        open={renameTarget !== null}
        onCancel={() => setRenameTarget(null)}
        onOk={() => {
          if (renameTarget && renameValue.trim()) renameMutation.mutate({ field: renameTarget, name: renameValue.trim() });
        }}
        okText="保存"
        cancelText="取消"
        confirmLoading={renameMutation.isPending}
        destroyOnHidden
      >
        <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} maxLength={64} />
      </Modal>

      <Drawer
        title={
          <Space>
            <ShareAltOutlined />
            共享与权限
            {selectedWorkspace ? <Tag>{selectedWorkspace.name}</Tag> : null}
          </Space>
        }
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        width={narrow ? '100%' : 520}
      >
        <Flex vertical gap={16}>
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
            个人空间默认仅自己可见；邀请成员后即成为共享工作区。管理员可管理成员权限，只读成员不能修改数据。
          </Typography.Paragraph>
          <Flex gap={8} wrap>
            <Input
              placeholder="成员邮箱"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              style={{ flex: '1 1 200px' }}
            />
            <Select value={inviteRole} onChange={setInviteRole} options={ROLE_OPTIONS} style={{ width: 120 }} />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={!inviteEmail.trim()}
              loading={inviteMutation.isPending}
              onClick={() => inviteMutation.mutate()}
            >
              邀请
            </Button>
          </Flex>
          <Spin spinning={membersQuery.isLoading}>
            {members.length ? (
              <Flex vertical gap={8}>
                {members.map((m) => (
                  <Card key={m.id} size="small">
                    <Flex align="center" justify="space-between" gap={8} wrap>
                      <Flex vertical gap={2} style={{ minWidth: 0 }}>
                        <Typography.Text strong ellipsis>
                          {m.name || m.email}
                        </Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                          {m.email}
                        </Typography.Text>
                      </Flex>
                      <Space size={6}>
                        <Select
                          size="small"
                          value={m.permissions}
                          options={ROLE_OPTIONS}
                          style={{ width: 110 }}
                          onChange={(permissions) => updateMemberMutation.mutate({ id: m.id, permissions })}
                        />
                        <Button
                          size="small"
                          danger
                          type="text"
                          icon={<DeleteOutlined />}
                          aria-label={`移除成员 ${m.email}`}
                          onClick={() =>
                            modal.confirm({
                              title: `移除成员 ${m.email}？`,
                              okText: '移除',
                              okButtonProps: { danger: true },
                              cancelText: '取消',
                              onOk: () => removeMemberMutation.mutateAsync(m.id),
                            })
                          }
                        />
                      </Space>
                    </Flex>
                  </Card>
                ))}
              </Flex>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有共享成员" />
            )}
          </Spin>
        </Flex>
      </Drawer>

      <Modal
        title={editingRow ? '编辑记录' : '新增记录'}
        open={rowOpen}
        onCancel={() => {
          setRowOpen(false);
          setEditingRow(null);
        }}
        onOk={submitRow}
        okText="保存"
        cancelText="取消"
        confirmLoading={rowMutation.isPending}
        destroyOnHidden
        width={640}
      >
        <Form form={rowForm} layout="vertical">
          <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : '1fr 1fr', gap: 16 }}>
            {editableFields.map((f) => (
              <Form.Item
                key={f.id}
                name={f.name}
                label={f.name}
                valuePropName={f.type === 'boolean' ? 'checked' : 'value'}
                extra={f.people ? '从系统账号中选择负责人；仅做标记，不会自动授予表格访问权限' : undefined}
              >
                {f.type === 'boolean' ? (
                  <Switch />
                ) : f.type === 'number' || f.type === 'rating' ? (
                  <InputNumber style={{ width: '100%' }} />
                ) : f.type === 'long_text' ? (
                  <Input.TextArea rows={3} maxLength={10000} />
                ) : f.type === 'single_select' ? (
                  <Select allowClear options={f.select_options.map((o) => ({ value: o.id, label: o.value }))} placeholder="请选择" />
                ) : f.type === 'multiple_select' ? (
                  <Select
                    mode="multiple"
                    allowClear
                    options={f.select_options.map((o) => ({ value: o.id, label: o.value }))}
                    placeholder="请选择"
                  />
                ) : f.type === 'people' ? (
                  <Select
                    mode="multiple"
                    allowClear
                    showSearch
                    loading={peopleQuery.isLoading}
                    placeholder={people.length ? '搜索并选择人员' : '暂无可选人员'}
                    options={people.map((p) => ({ value: p.row_id, label: p.displayName || p.name }))}
                    optionRender={(option) => {
                      const p = peopleByRow.get(Number(option.value));
                      const meta = [p?.email, (p?.groups ?? []).join(' / ')].filter(Boolean).join(' · ');
                      return (
                        <Flex vertical gap={0}>
                          <span>{p?.displayName || String(option.label ?? '')}</span>
                          {meta ? (
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {meta}
                            </Typography.Text>
                          ) : null}
                        </Flex>
                      );
                    }}
                    filterOption={(input, option) => {
                      const p = peopleByRow.get(Number(option?.value));
                      const text = [p?.displayName, p?.name, p?.email, ...(p?.groups ?? [])]
                        .filter(Boolean)
                        .join(' ')
                        .toLowerCase();
                      return text.includes(input.trim().toLowerCase());
                    }}
                  />
                ) : (
                  <Input placeholder={f.type === 'date' ? 'YYYY-MM-DD' : undefined} />
                )}
              </Form.Item>
            ))}
          </div>
          {!editableFields.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前工作表没有可编辑字段" />}
        </Form>
      </Modal>
    </PageShell>
  );
}