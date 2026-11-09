/**
 * 管理员面板 · Agent 配置页（以 Tab 形式嵌入 /admin）
 *
 * 后端契约（见 src/services/api.ts，勿改）：
 * - api.agentStatus()        → { available, reason, gateway, model, models, quotas }
 * - api.agentModels()        → { models: AgentModel[] }
 * - api.agentAdminConfig()   → AgentAdminConfig
 * - api.agentUpdateAdminConfig(body) → AgentAdminConfig（PUT）
 * - api.agentAdminUsage()    → { users: AgentUsageRow[], totals: {...} }
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Skeleton,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  ScanOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import type {
  AgentAdminConfig,
  AgentEndpointModel,
  AgentMcpServerConfig,
  AgentModel,
  AgentModelEndpoint,
  AgentSkillConfig,
  AgentSkillOption,
  AgentUsageRow,
} from '../../services/api';

/** 该组件由 /admin 以 Tab 形式嵌入，故接收一个可选 prop，但不自行处理路由。 */
export interface AgentAdminProps {
  /** 保留占位，当前实现未使用 */
  none?: boolean;
}

interface ModelRow extends AgentModel {
  enabled: boolean;
}

interface QuotaForm {
  messages_per_hour?: number;
  messages_per_day?: number;
  tokens_per_day?: number;
  max_sessions?: number;
}

interface PluginForm {
  id: string;
  name: string;
  enabled: boolean;
}

interface FormState {
  models: ModelRow[];
  default_model: string;
  quotas: QuotaForm;
  plugins: PluginForm[];
  system_prompt: string;
  skills: AgentSkillConfig[];
  mcp_servers: AgentMcpServerConfig[];
  model_endpoints: AgentModelEndpoint[];
}

interface KeyValueDraft {
  key?: string;
  value?: string;
}

interface McpDraft {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args_text?: string;
  cwd?: string;
  url?: string;
  env?: KeyValueDraft[];
  headers?: KeyValueDraft[];
  description?: string;
  enabled: boolean;
}

interface EndpointDraft {
  provider: string;
  name?: string;
  base_url: string;
  api: string;
  api_key?: string;
  clear_api_key?: boolean;
  models: AgentEndpointModel[];
  enabled: boolean;
}

const API_OPTIONS = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Generative AI' },
];

function pairsToMap(items?: KeyValueDraft[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items ?? []) {
    const key = item.key?.trim();
    if (key) out[key] = item.value ?? '';
  }
  return out;
}

function mapToPairs(map?: Record<string, string>): KeyValueDraft[] {
  return Object.entries(map ?? {}).map(([key, value]) => ({ key, value }));
}

/** 保存成功后清空本地明文密钥，只保留「是否已设置」状态。 */
function settleEndpoints(items: AgentModelEndpoint[]): AgentModelEndpoint[] {
  return items.map((item) => ({
    ...item,
    api_key: '',
    clear_api_key: false,
    api_key_set: Boolean(item.api_key) || Boolean(item.api_key_set),
  }));
}

function PairList({ name, label }: { name: string; label: string }) {
  return (
    <Form.Item label={label}>
      <Form.List name={name}>
        {(fields, { add, remove }) => (
          <Flex vertical gap={8}>
            {fields.map(({ key, name: fieldName }) => (
              <Flex key={key} gap={8} align="center">
                <Form.Item name={[fieldName, 'key']} noStyle>
                  <Input placeholder="名称" />
                </Form.Item>
                <Form.Item name={[fieldName, 'value']} noStyle>
                  <Input placeholder="值" />
                </Form.Item>
                <Button
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => remove(fieldName)}
                />
              </Flex>
            ))}
            <Button type="dashed" block onClick={() => add({ key: '', value: '' })}>
              添加一项
            </Button>
          </Flex>
        )}
      </Form.List>
    </Form.Item>
  );
}

/** 固定字段顺序，避免键顺序差异造成「误判为已修改」 */
function normalizeQuota(q?: QuotaForm): QuotaForm {
  return {
    messages_per_hour: q?.messages_per_hour,
    messages_per_day: q?.messages_per_day,
    tokens_per_day: q?.tokens_per_day,
    max_sessions: q?.max_sessions,
  };
}

/** 把网关可用模型与已保存白名单合并成一张去重的模型表 */
function mergeModels(gateway: AgentModel[], saved: AgentModel[]): ModelRow[] {
  const map = new Map<string, ModelRow>();
  gateway.forEach((m) => {
    map.set(m.id, { ...m, enabled: false });
  });
  saved.forEach((m) => {
    const exist = map.get(m.id);
    map.set(m.id, {
      ...exist,
      ...m,
      id: m.id,
      label: m.label || exist?.label || m.id,
      provider: m.provider || exist?.provider || '',
      context: m.context ?? exist?.context ?? null,
      enabled: m.enabled ?? exist?.enabled ?? false,
    });
  });
  return Array.from(map.values());
}

function formatContext(ctx?: number | null) {
  if (ctx == null) return '-';
  return ctx.toLocaleString('zh-CN');
}

export default function AgentAdmin(_props?: AgentAdminProps) {
  const { message } = App.useApp();
  const qc = useQueryClient();

  const statusQuery = useQuery({
    queryKey: ['agent-status'],
    queryFn: api.agentStatus,
    staleTime: 30_000,
  });
  const modelsQuery = useQuery({
    queryKey: ['agent-models'],
    queryFn: api.agentModels,
    staleTime: 60_000,
  });
  const configQuery = useQuery({
    queryKey: ['agent-admin-config'],
    queryFn: api.agentAdminConfig,
    staleTime: 30_000,
  });
  const usageQuery = useQuery({
    queryKey: ['agent-admin-usage'],
    queryFn: api.agentAdminUsage,
    staleTime: 30_000,
  });

  const [form, setForm] = useState<FormState>({
    models: [],
    default_model: '',
    quotas: normalizeQuota(),
    plugins: [],
    system_prompt: '',
    skills: [],
    mcp_servers: [],
    model_endpoints: [],
  });
  const [initial, setInitial] = useState<FormState>(form);
  const initialized = useRef(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpEditing, setMcpEditing] = useState<string | null>(null);
  const [endpointOpen, setEndpointOpen] = useState(false);
  const [endpointEditing, setEndpointEditing] = useState<string | null>(null);
  const [mcpForm] = Form.useForm<McpDraft>();
  const [endpointForm] = Form.useForm<EndpointDraft>();

  const discoverQuery = useQuery({
    queryKey: ['agent-admin-skills'],
    queryFn: api.agentAdminSkills,
    enabled: discoverOpen,
    staleTime: 0,
    retry: false,
  });

  /** 首次拿到配置后初始化表单（后续刷新不覆盖用户正在编辑的内容） */
  const bootstrap = useCallback(() => {
    const cfg = configQuery.data;
    if (!cfg || initialized.current) return;
    // 网关模型列表尚未返回时先不初始化，避免白名单缺少网关侧模型
    if (!modelsQuery.data && !modelsQuery.isError) return;
    const rows = mergeModels(modelsQuery.data?.models ?? [], cfg.models ?? []);
    const next: FormState = {
      models: rows,
      default_model: cfg.default_model ?? '',
      quotas: normalizeQuota(cfg.quotas),
      plugins: (cfg.plugins ?? []).map((p) => ({ ...p })),
      system_prompt: cfg.system_prompt ?? '',
      skills: (cfg.skills ?? []).map((s) => ({ ...s })),
      mcp_servers: (cfg.mcp_servers ?? []).map((s) => ({
        ...s,
        args: [...(s.args ?? [])],
        env: { ...(s.env ?? {}) },
        headers: { ...(s.headers ?? {}) },
      })),
      model_endpoints: (cfg.model_endpoints ?? []).map((item) => ({
        ...item,
        api_key: '',
        clear_api_key: false,
        models: (item.models ?? []).map((m) => ({ ...m })),
      })),
    };
    setForm(next);
    setInitial(next);
    initialized.current = true;
  }, [configQuery.data, modelsQuery.data]);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(initial),
    [form, initial],
  );

  const setQuota = useCallback(
    (key: keyof QuotaForm, value: number | null) => {
      setForm((f) => ({ ...f, quotas: normalizeQuota({ ...f.quotas, [key]: value ?? undefined }) }));
    },
    [],
  );

  const toggleModel = useCallback((id: string, enabled: boolean) => {
    setForm((f) => {
      const models = f.models.map((m) => (m.id === id ? { ...m, enabled } : m));
      const default_model =
        f.default_model === id && !enabled ? '' : f.default_model;
      return { ...f, models, default_model };
    });
  }, []);

  const togglePlugin = useCallback((id: string, enabled: boolean) => {
    setForm((f) => ({
      ...f,
      plugins: f.plugins.map((p) => (p.id === id ? { ...p, enabled } : p)),
    }));
  }, []);

  const toggleSkill = useCallback((path: string, enabled: boolean) => {
    setForm((f) => ({
      ...f,
      skills: f.skills.map((s) => (s.path === path ? { ...s, enabled } : s)),
    }));
  }, []);

  const removeSkill = useCallback((path: string) => {
    setForm((f) => ({ ...f, skills: f.skills.filter((s) => s.path !== path) }));
  }, []);

  const addDiscoveredSkill = useCallback((option: AgentSkillOption) => {
    setForm((f) => {
      if (f.skills.some((s) => s.path === option.path)) return f;
      return {
        ...f,
        skills: [
          ...f.skills,
          {
            id: option.path,
            name: option.name,
            description: option.description,
            path: option.path,
            enabled: true,
          },
        ],
      };
    });
  }, []);

  const refreshModels = useCallback(async () => {
    const result = await modelsQuery.refetch();
    const gateway = result.data?.models ?? [];
    setForm((f) => ({ ...f, models: mergeModels(gateway, f.models) }));
    message.success('模型列表已刷新，新端点模型默认未启用');
  }, [modelsQuery, message]);

  const openMcp = useCallback(
    (server?: AgentMcpServerConfig) => {
      mcpForm.resetFields();
      if (server) {
        setMcpEditing(server.id || server.name);
        mcpForm.setFieldsValue({
          name: server.name,
          transport: server.transport,
          command: server.command ?? '',
          args_text: (server.args ?? []).join('\n'),
          cwd: server.cwd ?? '',
          url: server.url ?? '',
          env: mapToPairs(server.env),
          headers: mapToPairs(server.headers),
          description: server.description ?? '',
          enabled: server.enabled,
        });
      } else {
        setMcpEditing(null);
        mcpForm.setFieldsValue({
          name: '',
          transport: 'stdio',
          command: '',
          args_text: '',
          cwd: '',
          url: '',
          env: [],
          headers: [],
          description: '',
          enabled: true,
        });
      }
      setMcpOpen(true);
    },
    [mcpForm],
  );

  const submitMcp = useCallback(async () => {
    let values: McpDraft;
    try {
      values = await mcpForm.validateFields();
    } catch {
      return;
    }
    const name = values.name.trim();
    if (
      form.mcp_servers.some((s) => (s.id || s.name) !== mcpEditing && s.name === name)
    ) {
      message.error('已存在同名 MCP 服务器');
      return;
    }
    const base = {
      id: name,
      name,
      enabled: values.enabled,
      description: values.description?.trim() || '',
    };
    const server: AgentMcpServerConfig =
      values.transport === 'http'
        ? {
            ...base,
            transport: 'http',
            url: values.url?.trim() ?? '',
            headers: pairsToMap(values.headers),
          }
        : {
            ...base,
            transport: 'stdio',
            command: values.command?.trim() ?? '',
            args: (values.args_text ?? '')
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean),
            cwd: values.cwd?.trim() || '',
            env: pairsToMap(values.env),
          };
    setForm((f) => {
      const exists =
        mcpEditing !== null && f.mcp_servers.some((s) => (s.id || s.name) === mcpEditing);
      return {
        ...f,
        mcp_servers: exists
          ? f.mcp_servers.map((s) => ((s.id || s.name) === mcpEditing ? server : s))
          : [...f.mcp_servers, server],
      };
    });
    setMcpOpen(false);
  }, [mcpForm, mcpEditing, form.mcp_servers, message]);

  const removeMcp = useCallback((name: string) => {
    setForm((f) => ({ ...f, mcp_servers: f.mcp_servers.filter((s) => s.name !== name) }));
  }, []);

  const openEndpoint = useCallback(
    (item?: AgentModelEndpoint) => {
      endpointForm.resetFields();
      if (item) {
        setEndpointEditing(item.provider);
        endpointForm.setFieldsValue({
          provider: item.provider,
          name: item.name ?? '',
          base_url: item.base_url,
          api: item.api,
          api_key: '',
          clear_api_key: false,
          enabled: item.enabled,
          models: (item.models ?? []).map((m) => ({ ...m })),
        });
      } else {
        setEndpointEditing(null);
        endpointForm.setFieldsValue({
          provider: '',
          name: '',
          base_url: '',
          api: 'openai-completions',
          api_key: '',
          clear_api_key: false,
          enabled: true,
          models: [{ id: '', name: '', context: 128000, max_tokens: 16384, reasoning: false, image: false }],
        });
      }
      setEndpointOpen(true);
    },
    [endpointForm],
  );

  const submitEndpoint = useCallback(async () => {
    let values: EndpointDraft;
    try {
      values = await endpointForm.validateFields();
    } catch {
      return;
    }
    const provider = values.provider.trim().toLowerCase();
    if (
      form.model_endpoints.some(
        (e) => e.provider !== endpointEditing && e.provider === provider,
      )
    ) {
      message.error('已存在相同的 Provider 标识');
      return;
    }
    const models = (values.models ?? [])
      .filter((m) => m.id?.trim())
      .map((m) => ({
        id: m.id.trim(),
        name: m.name?.trim() || m.id.trim(),
        context: m.context ?? 128000,
        max_tokens: m.max_tokens ?? 16384,
        reasoning: !!m.reasoning,
        image: !!m.image,
      }));
    if (!models.length) {
      message.error('至少填写一个模型');
      return;
    }
    const previous = form.model_endpoints.find((e) => e.provider === endpointEditing);
    const endpoint: AgentModelEndpoint = {
      provider,
      name: values.name?.trim() || provider,
      base_url: values.base_url.trim().replace(/\/+$/, ''),
      api: values.api,
      api_key: values.api_key?.trim() || '',
      api_key_set: previous?.api_key_set ?? false,
      clear_api_key: !!values.clear_api_key,
      enabled: values.enabled,
      models,
    };
    setForm((f) => {
      const exists =
        endpointEditing !== null && f.model_endpoints.some((e) => e.provider === endpointEditing);
      return {
        ...f,
        model_endpoints: exists
          ? f.model_endpoints.map((e) => (e.provider === endpointEditing ? endpoint : e))
          : [...f.model_endpoints, endpoint],
      };
    });
    setEndpointOpen(false);
  }, [endpointForm, endpointEditing, form.model_endpoints, message]);

  const removeEndpoint = useCallback((provider: string) => {
    setForm((f) => ({
      ...f,
      model_endpoints: f.model_endpoints.filter((e) => e.provider !== provider),
    }));
  }, []);

  const reset = useCallback(() => {
    setForm(initial);
  }, [initial]);

  const save = useMutation({
    mutationFn: (payload: FormState) =>
      api.agentUpdateAdminConfig({
        models: payload.models.map((m) => ({
          id: m.id,
          label: m.label,
          provider: m.provider,
          context: m.context ?? null,
          enabled: m.enabled,
        })),
        default_model: payload.default_model || undefined,
        quotas: {
          messages_per_hour: payload.quotas.messages_per_hour,
          messages_per_day: payload.quotas.messages_per_day,
          tokens_per_day: payload.quotas.tokens_per_day,
          max_sessions: payload.quotas.max_sessions,
        },
        plugins: payload.plugins,
        system_prompt: payload.system_prompt,
        skills: payload.skills.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          path: s.path,
          enabled: s.enabled,
        })),
        mcp_servers: payload.mcp_servers.map((s) => ({
          id: s.id,
          name: s.name,
          transport: s.transport,
          command: s.command,
          args: s.args,
          env: s.env,
          cwd: s.cwd,
          url: s.url,
          headers: s.headers,
          description: s.description,
          enabled: s.enabled,
        })),
        model_endpoints: payload.model_endpoints.map((e) => ({
          provider: e.provider,
          name: e.name,
          base_url: e.base_url,
          api: e.api,
          ...(e.api_key ? { api_key: e.api_key } : {}),
          ...(e.clear_api_key ? { clear_api_key: true } : {}),
          models: e.models,
          enabled: e.enabled,
        })),
      }),
    onSuccess: (data: AgentAdminConfig) => {
      const next: FormState = {
        ...form,
        default_model: data.default_model ?? form.default_model,
        quotas: normalizeQuota(data.quotas ?? form.quotas),
        plugins: (data.plugins ?? form.plugins).map((p) => ({ ...p })),
        system_prompt: data.system_prompt ?? form.system_prompt,
        skills: (data.skills ?? form.skills).map((s) => ({ ...s })),
        mcp_servers: (data.mcp_servers ?? form.mcp_servers).map((s) => ({
          ...s,
          args: [...(s.args ?? [])],
          env: { ...(s.env ?? {}) },
          headers: { ...(s.headers ?? {}) },
        })),
        model_endpoints: settleEndpoints(
          ((data.model_endpoints ?? form.model_endpoints) as AgentModelEndpoint[]).map((e) => ({
            ...e,
            models: (e.models ?? []).map((m) => ({ ...m })),
          })),
        ),
        models: form.models,
      };
      setForm(next);
      setInitial(next);
      if (data.runtime_applied === false) {
        message.warning(
          `配置已保存，但未同步到网关：${data.runtime_error || '请检查网关服务后重新保存'}`,
        );
      } else {
        message.success('配置已保存并已下发到网关');
      }
      void qc.invalidateQueries({ queryKey: ['agent-admin-config'] });
      void qc.invalidateQueries({ queryKey: ['agent-status'] });
      void qc.invalidateQueries({ queryKey: ['agent-admin-usage'] });
      void qc.invalidateQueries({ queryKey: ['agent-models'] });
    },
  });

  const saveError = save.error instanceof Error ? save.error.message : '';

  const enabledModels = form.models.filter((m) => m.enabled);
  const defaultModelOptions = enabledModels.map((m) => ({
    value: m.id,
    label: m.label || m.id,
  }));

  const modelColumns: TableColumnsType<ModelRow> = [
    {
      title: '模型 ID',
      dataIndex: 'id',
      key: 'id',
      render: (v: string) => <span style={{ fontFamily: 'monospace', fontSize: 12.5 }}>{v}</span>,
    },
    { title: '名称', dataIndex: 'label', key: 'label', render: (v?: string) => v || '-' },
    { title: '提供方', dataIndex: 'provider', key: 'provider', render: (v?: string) => v || '-' },
    {
      title: '上下文长度',
      dataIndex: 'context',
      key: 'context',
      render: (v?: number | null) => formatContext(v),
    },
    {
      title: '允许使用',
      key: 'enabled',
      width: 120,
      render: (_, row) => (
        <Switch
          checked={row.enabled}
          onChange={(checked) => toggleModel(row.id, checked)}
          checkedChildren="允许"
          unCheckedChildren="禁止"
        />
      ),
    },
  ];

  const usageColumns: TableColumnsType<AgentUsageRow> = [
    {
      title: '用户',
      dataIndex: 'user_id',
      key: 'user_id',
      sorter: (a, b) => a.user_id.localeCompare(b.user_id, 'zh-CN'),
    },
    {
      title: '消息数',
      dataIndex: 'messages',
      key: 'messages',
      sorter: (a, b) => a.messages - b.messages,
    },
    {
      title: '输入 token',
      dataIndex: 'tokens_in',
      key: 'tokens_in',
      sorter: (a, b) => a.tokens_in - b.tokens_in,
    },
    {
      title: '输出 token',
      dataIndex: 'tokens_out',
      key: 'tokens_out',
      sorter: (a, b) => a.tokens_out - b.tokens_out,
    },
    {
      title: '合计',
      key: 'total',
      sorter: (a, b) => a.tokens_in + a.tokens_out - (b.tokens_in + b.tokens_out),
      render: (_, row) => row.tokens_in + row.tokens_out,
    },
  ];

  const mcpColumns: TableColumnsType<AgentMcpServerConfig> = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: 150,
      render: (v: string) => <span style={{ fontFamily: 'monospace', fontSize: 12.5 }}>{v}</span>,
    },
    {
      title: '类型',
      dataIndex: 'transport',
      key: 'transport',
      width: 90,
      render: (v: string) => <Tag color={v === 'http' ? 'blue' : 'purple'}>{v === 'http' ? 'HTTP' : 'stdio'}</Tag>,
    },
    {
      title: '启动方式',
      key: 'target',
      ellipsis: true,
      render: (_, row) => (
        <Typography.Text type="secondary" style={{ fontFamily: 'monospace', fontSize: 12 }} ellipsis>
          {row.transport === 'http'
            ? row.url
            : `${row.command ?? ''} ${(row.args ?? []).join(' ')}`.trim()}
        </Typography.Text>
      ),
    },
    {
      title: '启用',
      key: 'enabled',
      width: 90,
      render: (_, row) => (
        <Switch
          size="small"
          checked={row.enabled}
          onChange={(checked) =>
            setForm((f) => ({
              ...f,
              mcp_servers: f.mcp_servers.map((s) => (s.name === row.name ? { ...s, enabled: checked } : s)),
            }))
          }
        />
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 110,
      align: 'right',
      render: (_, row) => (
        <Space size={0}>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openMcp(row)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该 MCP 服务器？"
            description="保存配置后对新会话生效。"
            okText="删除"
            cancelText="取消"
            onConfirm={() => removeMcp(row.name)}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const endpointColumns: TableColumnsType<AgentModelEndpoint> = [
    {
      title: 'Provider',
      dataIndex: 'provider',
      key: 'provider',
      width: 150,
      render: (v: string) => <span style={{ fontFamily: 'monospace', fontSize: 12.5 }}>{v}</span>,
    },
    { title: '名称', dataIndex: 'name', key: 'name', width: 140, render: (v?: string) => v || '-' },
    {
      title: 'Base URL',
      dataIndex: 'base_url',
      key: 'base_url',
      ellipsis: true,
      render: (v: string) => (
        <Typography.Text type="secondary" style={{ fontFamily: 'monospace', fontSize: 12 }} ellipsis>
          {v}
        </Typography.Text>
      ),
    },
    {
      title: '协议',
      dataIndex: 'api',
      key: 'api',
      width: 170,
      render: (v: string) => API_OPTIONS.find((item) => item.value === v)?.label ?? v,
    },
    {
      title: '模型',
      key: 'models',
      width: 70,
      align: 'right',
      render: (_, row) => row.models.length,
    },
    {
      title: '密钥',
      key: 'key',
      width: 90,
      render: (_, row) =>
        row.api_key ? (
          <Tag color="processing">待保存</Tag>
        ) : row.api_key_set ? (
          <Tag color="success">已设置</Tag>
        ) : (
          <Tag>未设置</Tag>
        ),
    },
    {
      title: '启用',
      key: 'enabled',
      width: 90,
      render: (_, row) => (
        <Switch
          size="small"
          checked={row.enabled}
          onChange={(checked) =>
            setForm((f) => ({
              ...f,
              model_endpoints: f.model_endpoints.map((e) =>
                e.provider === row.provider ? { ...e, enabled: checked } : e,
              ),
            }))
          }
        />
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 110,
      align: 'right',
      render: (_, row) => (
        <Space size={0}>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEndpoint(row)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该模型端点？"
            description="保存配置后，该端点的模型将从白名单中消失。"
            okText="删除"
            cancelText="取消"
            onConfirm={() => removeEndpoint(row.provider)}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const status = statusQuery.data;
  const statusOk = status?.available === true;
  const editingEndpoint = endpointEditing
    ? form.model_endpoints.find((e) => e.provider === endpointEditing)
    : undefined;

  if (statusQuery.isPending || modelsQuery.isPending || configQuery.isPending) {
    return (
      <Card size="small" title="Agent 配置">
        <Skeleton active paragraph={{ rows: 8 }} />
      </Card>
    );
  }

  return (
    <Flex vertical gap={16}>
      {/* 1. 顶部状态条 */}
      <Card size="small" title="网关状态">
        {statusQuery.isError && (
          <Alert
            type="error"
            showIcon
            title="网关状态获取失败"
            description={
              statusQuery.error instanceof Error ? statusQuery.error.message : '请稍后重试'
            }
            action={
              <Button size="small" onClick={() => void statusQuery.refetch()}>
                重试
              </Button>
            }
          />
        )}
        {!statusQuery.isError && (
          <Flex vertical gap={12}>
            <Space orientation="horizontal" size={16} wrap>
              <Tag color={statusOk ? 'success' : 'error'} variant="filled">
                {statusOk ? '网关在线' : '网关不可用'}
              </Tag>
              <span>
                <span style={{ color: '#5B6675' }}>网关地址：</span>
                <span style={{ fontFamily: 'monospace' }}>{status?.gateway || '未配置'}</span>
              </span>
              <span>
                <span style={{ color: '#5B6675' }}>当前默认模型：</span>
                <span style={{ fontFamily: 'monospace' }}>{status?.model || '未配置'}</span>
              </span>
            </Space>
            {!statusOk && (
              <Alert
                type="warning"
                showIcon
                title="网关不可用"
                description={
                  status?.reason
                    ? `原因：${status.reason}。Agent 助手功能可能无法使用，请检查网关服务后重试。`
                    : '未获取到具体原因，请检查网关服务后重试。'
                }
                action={
                  <Button size="small" onClick={() => void statusQuery.refetch()}>
                    刷新状态
                  </Button>
                }
              />
            )}
            {configQuery.data?.runtime_applied === false && (
              <Alert
                type="warning"
                showIcon
                title="运行配置尚未同步到网关"
                description={
                  configQuery.data.runtime_error ||
                  '技能、MCP 或模型端点配置已保存，但网关没有确认生效。请检查网关服务后重新保存配置。'
                }
              />
            )}
          </Flex>
        )}
      </Card>

      {/* 2. 模型端点 */}
      <Card
        size="small"
        title="模型端点"
        extra={
          <Button size="small" type="primary" ghost icon={<PlusOutlined />} onClick={() => openEndpoint()}>
            添加端点
          </Button>
        }
      >
        <Flex vertical gap={12}>
          <Table<AgentModelEndpoint>
            size="small"
            rowKey="provider"
            columns={endpointColumns}
            dataSource={form.model_endpoints}
            pagination={false}
            scroll={{ x: 860 }}
            locale={{ emptyText: <Empty description="尚未配置模型端点" /> }}
          />
          <Alert
            type="info"
            showIcon
            title="模型端点用于接入自建的 OpenAI / Anthropic 兼容服务"
            description="保存后网关会写入 pi 的模型配置，真实 API Key 只保存在后端数据库，不会回显到浏览器。修改端点并保存会中断正在生成的回复，下一次发言自动使用新配置。"
          />
        </Flex>
      </Card>

      {/* 3. 模型白名单 */}
      <Card
        size="small"
        title="模型白名单"
        extra={
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void refreshModels()}>
            刷新模型列表
          </Button>
        }
      >
        <Flex vertical gap={16}>
          <Flex vertical gap={8}>
            <span style={{ color: '#5B6675', fontSize: 13 }}>默认模型</span>
            <Select
              style={{ maxWidth: 320 }}
              placeholder="请选择默认模型"
              options={defaultModelOptions}
              value={form.default_model || undefined}
              onChange={(v: string) => setForm((f) => ({ ...f, default_model: v }))}
              notFoundContent="暂无可用模型，请先在上表中开启至少一个模型"
            />
          </Flex>
          {modelsQuery.isError ? (
            <Alert
              type="error"
              showIcon
              title="模型列表获取失败"
              description={
                modelsQuery.error instanceof Error ? modelsQuery.error.message : '请稍后重试'
              }
              action={
                <Button size="small" onClick={() => void modelsQuery.refetch()}>
                  重试
                </Button>
              }
            />
          ) : (
            <Table<ModelRow>
              size="small"
              rowKey="id"
              columns={modelColumns}
              dataSource={form.models}
              pagination={false}
              scroll={{ x: 640 }}
              locale={{ emptyText: <Empty description="暂无可用模型" /> }}
            />
          )}
          <Alert
            type="info"
            showIcon
            title="白名单之外的模型普通用户不可选择"
            description="「允许使用」仅对管理员生效，用于决定普通用户可在对话中选择哪些模型；默认模型必须处于已启用状态。"
          />
        </Flex>
      </Card>

      {/* 3. 配额 */}
      <Card size="small" title="配额">
        <Row gutter={[16, 16]}>
          <Col xs={24} md={12} xl={6}>
            <Flex vertical gap={6}>
              <span>每小时消息上限</span>
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                step={10}
                placeholder="不限制"
                value={form.quotas.messages_per_hour}
                onChange={(v) => setQuota('messages_per_hour', v)}
              />
              <span style={{ color: '#5B6675', fontSize: 12.5 }}>
                单个用户在 1 小时内最多发送的消息条数，超出后提示稍后再试。
              </span>
            </Flex>
          </Col>
          <Col xs={24} md={12} xl={6}>
            <Flex vertical gap={6}>
              <span>每天消息上限</span>
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                step={10}
                placeholder="不限制"
                value={form.quotas.messages_per_day}
                onChange={(v) => setQuota('messages_per_day', v)}
              />
              <span style={{ color: '#5B6675', fontSize: 12.5 }}>
                单个用户在 24 小时内最多发送的消息条数，按自然日滚动重置。
              </span>
            </Flex>
          </Col>
          <Col xs={24} md={12} xl={6}>
            <Flex vertical gap={6}>
              <span>每天 token 预算</span>
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                step={1000}
                placeholder="不限制"
                value={form.quotas.tokens_per_day}
                onChange={(v) => setQuota('tokens_per_day', v)}
              />
              <span style={{ color: '#5B6675', fontSize: 12.5 }}>
                单个用户每天可消耗的 token 总量（输入 + 输出），用于控制算力成本。
              </span>
            </Flex>
          </Col>
          <Col xs={24} md={12} xl={6}>
            <Flex vertical gap={6}>
              <span>最大并发会话数</span>
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                step={1}
                placeholder="不限制"
                value={form.quotas.max_sessions}
                onChange={(v) => setQuota('max_sessions', v)}
              />
              <span style={{ color: '#5B6675', fontSize: 12.5 }}>
                单个用户同时保持的对话会话数量上限，超出后需关闭旧会话。
              </span>
            </Flex>
          </Col>
        </Row>
      </Card>

      {/* 4. 插件 */}
      <Card size="small" title="插件">
        {configQuery.isError ? (
          <Alert
            type="error"
            showIcon
            title="插件列表获取失败"
            description={
              configQuery.error instanceof Error ? configQuery.error.message : '请稍后重试'
            }
            action={
              <Button size="small" onClick={() => void configQuery.refetch()}>
                重试
              </Button>
            }
          />
        ) : form.plugins.length === 0 ? (
          <Empty description="暂无插件" />
        ) : (
          <Flex vertical gap={8}>
            {form.plugins.map((p) => (
              <Flex
                key={p.id}
                justify="space-between"
                align="center"
                style={{
                  padding: '10px 12px',
                  border: '1px solid #E6E9EF',
                  borderRadius: 10,
                }}
              >
                <span>{p.name || p.id}</span>
                <Switch
                  checked={p.enabled}
                  onChange={(checked) => togglePlugin(p.id, checked)}
                  checkedChildren="启用"
                  unCheckedChildren="停用"
                />
              </Flex>
            ))}
          </Flex>
        )}
      </Card>

      {/* 5. SKILLS */}
      <Card
        size="small"
        title="SKILLS（技能）"
        extra={
          <Button size="small" icon={<ScanOutlined />} onClick={() => setDiscoverOpen(true)}>
            扫描技能目录
          </Button>
        }
      >
        <Flex vertical gap={12}>
          {form.skills.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="尚未启用技能，可扫描网关上的技能目录后添加"
            />
          ) : (
            <Flex vertical gap={8}>
              {form.skills.map((skill) => (
                <Flex
                  key={skill.path}
                  justify="space-between"
                  align="center"
                  gap={12}
                  style={{
                    padding: '10px 12px',
                    border: '1px solid #E6E9EF',
                    borderRadius: 10,
                  }}
                >
                  <Flex vertical gap={2} style={{ minWidth: 0 }}>
                    <Space size={8} wrap>
                      <span style={{ fontWeight: 500 }}>{skill.name}</span>
                      <Tag color={skill.enabled ? 'success' : 'default'}>
                        {skill.enabled ? '已启用' : '已停用'}
                      </Tag>
                    </Space>
                    <span style={{ color: '#5B6675', fontSize: 12.5 }}>
                      {skill.description || '未提供描述'}
                    </span>
                    <Typography.Text
                      type="secondary"
                      style={{ fontFamily: 'monospace', fontSize: 12 }}
                      ellipsis
                    >
                      {skill.path}
                    </Typography.Text>
                  </Flex>
                  <Space size={8}>
                    <Switch
                      checked={skill.enabled}
                      onChange={(checked) => toggleSkill(skill.path, checked)}
                      checkedChildren="启用"
                      unCheckedChildren="停用"
                    />
                    <Popconfirm
                      title="移除该技能？"
                      okText="移除"
                      cancelText="取消"
                      onConfirm={() => removeSkill(skill.path)}
                    >
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                </Flex>
              ))}
            </Flex>
          )}
          <Alert
            type="info"
            showIcon
            title="技能采用 Agent Skills 规范（目录 + SKILL.md）"
            description="启用的技能会向模型提供名称与描述，命中任务时再加载完整说明。网关上的技能目录默认为 /opt/labspace/agent/skills。"
          />
        </Flex>
      </Card>

      {/* 6. MCP 服务器 */}
      <Card
        size="small"
        title="MCP 服务器"
        extra={
          <Button size="small" type="primary" ghost icon={<PlusOutlined />} onClick={() => openMcp()}>
            添加 MCP
          </Button>
        }
      >
        <Flex vertical gap={12}>
          <Table<AgentMcpServerConfig>
            size="small"
            rowKey="name"
            columns={mcpColumns}
            dataSource={form.mcp_servers}
            pagination={false}
            scroll={{ x: 760 }}
            locale={{ emptyText: <Empty description="尚未配置 MCP 服务器" /> }}
          />
          <Alert
            type="warning"
            showIcon
            title="MCP 服务器会在宿主机上执行命令"
            description="仅添加可信来源的服务器。stdio 类型需要填写可执行命令与参数，HTTP 类型填写服务地址；MCP 工具通过 pi-mcp-adapter 的 mcp 代理工具暴露给模型。"
          />
        </Flex>
      </Card>

      {/* 7. 系统提示词 */}
      <Card size="small" title="系统提示词">
        <Flex vertical gap={6}>
          <Input.TextArea
            rows={6}
            placeholder="留空则使用默认提示词"
            value={form.system_prompt}
            onChange={(e) => setForm((f) => ({ ...f, system_prompt: e.target.value }))}
            showCount
            maxLength={8000}
          />
          <span style={{ color: '#5B6675', fontSize: 12.5 }}>
            这是给 Agent 助手的全局指令，会追加到每次对话的系统提示中，建议写明角色定位、语言偏好与输出格式要求。
          </span>
        </Flex>
      </Card>

      {/* 6. 用量统计 */}
      <Card size="small" title="用量统计">
        <Table<AgentUsageRow>
          size="small"
          rowKey="user_id"
          columns={usageColumns}
          dataSource={usageQuery.data?.users ?? []}
          loading={usageQuery.isPending}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          scroll={{ x: 640 }}
          locale={{ emptyText: <Empty description="暂无用量数据" /> }}
          onChange={() => {
            /* 排序由 Table 内部处理，保留占位以便后续扩展 */
          }}
        />
        {usageQuery.isError && (
          <Alert
            type="error"
            showIcon
            title="用量统计获取失败"
            description={
              usageQuery.error instanceof Error ? usageQuery.error.message : '请稍后重试'
            }
            action={
              <Button size="small" onClick={() => void usageQuery.refetch()}>
                重试
              </Button>
            }
          />
        )}
      </Card>

      {/* 7. 底部操作条 */}
      <div
        style={{
          position: 'sticky',
          bottom: 0,
          zIndex: 5,
          background: '#FFFFFF',
          border: '1px solid #E6E9EF',
          borderRadius: 14,
          padding: 12,
          boxShadow: '0 -4px 16px rgba(16, 24, 40, 0.06)',
        }}
      >
        <Flex justify="space-between" align="center" wrap gap={12}>
          <span style={{ color: '#5B6675', fontSize: 13 }}>
            {dirty ? '有未保存的修改' : '当前配置已与后端一致'}
          </span>
          <Space orientation="horizontal" size={12}>
            <Button onClick={reset} disabled={!dirty || save.isPending}>
              重置
            </Button>
            <Button
              type="primary"
              loading={save.isPending}
              disabled={!dirty}
              onClick={() => save.mutate(form)}
            >
              保存配置
            </Button>
          </Space>
        </Flex>
      </div>

      {saveError && (
        <Alert
          type="error"
          showIcon
          title="保存失败"
          description={`保存配置失败：${saveError}`}
          closable={{ onClose: () => save.reset() }}
        />
      )}

      {/* 技能扫描 */}
      <Modal
        title="扫描技能目录"
        open={discoverOpen}
        onCancel={() => setDiscoverOpen(false)}
        footer={null}
        width={760}
        destroyOnHidden
      >
        <Flex vertical gap={12}>
          {discoverQuery.isLoading && <Skeleton active paragraph={{ rows: 4 }} />}
          {discoverQuery.isError && (
            <Alert
              type="error"
              showIcon
              title="技能目录扫描失败"
              description={
                discoverQuery.error instanceof Error ? discoverQuery.error.message : '请稍后重试'
              }
              action={
                <Button size="small" onClick={() => void discoverQuery.refetch()}>
                  重试
                </Button>
              }
            />
          )}
          {discoverQuery.data && (
            <>
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                扫描目录：{discoverQuery.data.roots.join('、') || '未配置'}
              </Typography.Text>
              {discoverQuery.data.skills.length === 0 ? (
                <Empty description="未发现技能。将包含 SKILL.md 的目录放入技能根目录后重新扫描。" />
              ) : (
                discoverQuery.data.skills.map((option) => {
                  const added = form.skills.some((s) => s.path === option.path);
                  return (
                    <Flex
                      key={option.path}
                      justify="space-between"
                      align="center"
                      gap={12}
                      style={{
                        padding: '10px 12px',
                        border: '1px solid #E6E9EF',
                        borderRadius: 10,
                      }}
                    >
                      <Flex vertical gap={2} style={{ minWidth: 0 }}>
                        <span style={{ fontWeight: 500 }}>{option.name}</span>
                        <span style={{ color: '#5B6675', fontSize: 12.5 }}>
                          {option.description || '未提供描述'}
                        </span>
                        <Typography.Text
                          type="secondary"
                          style={{ fontFamily: 'monospace', fontSize: 12 }}
                          ellipsis
                        >
                          {option.path}
                        </Typography.Text>
                      </Flex>
                      <Button
                        size="small"
                        type={added ? 'default' : 'primary'}
                        disabled={added}
                        onClick={() => addDiscoveredSkill(option)}
                      >
                        {added ? '已添加' : '添加'}
                      </Button>
                    </Flex>
                  );
                })
              )}
            </>
          )}
        </Flex>
      </Modal>

      {/* MCP 服务器编辑 */}
      <Modal
        title={mcpEditing ? '编辑 MCP 服务器' : '添加 MCP 服务器'}
        open={mcpOpen}
        onCancel={() => setMcpOpen(false)}
        onOk={() => void submitMcp()}
        okText="确定"
        cancelText="取消"
        width={680}
        destroyOnHidden
      >
        <Form form={mcpForm} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col xs={24} md={12}>
              <Form.Item
                name="name"
                label="名称"
                rules={[
                  { required: true, message: '请输入名称' },
                  {
                    pattern: /^[A-Za-z0-9_-]{1,64}$/,
                    message: '仅允许字母、数字、下划线和短横线',
                  },
                ]}
              >
                <Input placeholder="如 plant-db" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="transport" label="传输方式" rules={[{ required: true }]}>
                <Select
                  options={[
                    { value: 'stdio', label: 'stdio（本地命令）' },
                    { value: 'http', label: 'HTTP（远程服务）' },
                  ]}
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) => prev.transport !== cur.transport}
          >
            {({ getFieldValue }) =>
              getFieldValue('transport') === 'http' ? (
                <>
                  <Form.Item
                    name="url"
                    label="服务 URL"
                    rules={[
                      { required: true, message: '请输入服务 URL' },
                      { pattern: /^https?:\/\//i, message: '必须是 http(s) URL' },
                    ]}
                  >
                    <Input placeholder="https://example.com/mcp" />
                  </Form.Item>
                  <PairList name="headers" label="请求头" />
                </>
              ) : (
                <>
                  <Form.Item
                    name="command"
                    label="启动命令"
                    rules={[{ required: true, message: '请输入启动命令' }]}
                  >
                    <Input placeholder="如 npx、python3" />
                  </Form.Item>
                  <Form.Item name="args_text" label="命令参数（每行一个）">
                    <Input.TextArea
                      rows={3}
                      placeholder={'如：\n-y\n@modelcontextprotocol/server-filesystem\n/tmp'}
                    />
                  </Form.Item>
                  <Form.Item name="cwd" label="工作目录">
                    <Input placeholder="留空使用网关工作目录" />
                  </Form.Item>
                  <PairList name="env" label="环境变量" />
                </>
              )
            }
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input placeholder="可选，向模型说明该服务器的用途" />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      {/* 模型端点编辑 */}
      <Modal
        title={endpointEditing ? '编辑模型端点' : '添加模型端点'}
        open={endpointOpen}
        onCancel={() => setEndpointOpen(false)}
        onOk={() => void submitEndpoint()}
        okText="确定"
        cancelText="取消"
        width={880}
        destroyOnHidden
      >
        <Form form={endpointForm} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col xs={24} md={8}>
              <Form.Item
                name="provider"
                label="Provider 标识"
                rules={[
                  { required: true, message: '请输入 Provider 标识' },
                  {
                    pattern: /^[a-z0-9][a-z0-9_-]{0,63}$/,
                    message: '仅允许小写字母、数字、下划线和短横线',
                  },
                ]}
              >
                <Input placeholder="如 lab-gateway" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="name" label="显示名称">
                <Input placeholder="如 内部模型网关" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="api" label="API 协议" rules={[{ required: true }]}>
                <Select options={API_OPTIONS} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            name="base_url"
            label="Base URL"
            rules={[
              { required: true, message: '请输入 Base URL' },
              { pattern: /^https?:\/\//i, message: '必须是 http(s) URL' },
            ]}
          >
            <Input placeholder="https://api.example.com/v1" />
          </Form.Item>
          <Row gutter={12}>
            <Col xs={24} md={14}>
              <Form.Item
                name="api_key"
                label={editingEndpoint?.api_key_set ? 'API Key（留空保持不变）' : 'API Key'}
              >
                <Input.Password
                  placeholder={editingEndpoint?.api_key_set ? '已保存密钥，留空则不修改' : '填写服务商密钥'}
                  autoComplete="new-password"
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={10}>
              <Form.Item name="enabled" label="启用" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>
          {editingEndpoint?.api_key_set && (
            <Form.Item name="clear_api_key" label="清除已保存的 API Key" valuePropName="checked">
              <Switch />
            </Form.Item>
          )}
          <Form.Item label="模型列表" required>
            <Form.List name="models">
              {(fields, { add, remove }) => (
                <Flex vertical gap={12}>
                  {fields.map(({ key, name: fieldName }) => (
                    <div
                      key={key}
                      style={{ border: '1px solid #E6E9EF', borderRadius: 10, padding: 12 }}
                    >
                      <Row gutter={12} align="middle">
                        <Col xs={24} md={7}>
                          <Form.Item
                            name={[fieldName, 'id']}
                            label="模型 ID"
                            rules={[{ required: true, message: '请输入模型 ID' }]}
                            style={{ marginBottom: 8 }}
                          >
                            <Input placeholder="模型服务中的 ID" />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={7}>
                          <Form.Item
                            name={[fieldName, 'name']}
                            label="显示名称"
                            style={{ marginBottom: 8 }}
                          >
                            <Input placeholder="可选" />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item
                            name={[fieldName, 'context']}
                            label="上下文"
                            style={{ marginBottom: 8 }}
                          >
                            <InputNumber min={1024} step={1024} style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item
                            name={[fieldName, 'max_tokens']}
                            label="最大输出"
                            style={{ marginBottom: 8 }}
                          >
                            <InputNumber min={256} step={256} style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={2} style={{ textAlign: 'right' }}>
                          <Button
                            danger
                            type="text"
                            icon={<DeleteOutlined />}
                            disabled={fields.length <= 1}
                            onClick={() => remove(fieldName)}
                          />
                        </Col>
                      </Row>
                      <Flex gap={24} wrap>
                        <Form.Item
                          name={[fieldName, 'reasoning']}
                          label="推理模型"
                          valuePropName="checked"
                          style={{ marginBottom: 0 }}
                        >
                          <Switch size="small" />
                        </Form.Item>
                        <Form.Item
                          name={[fieldName, 'image']}
                          label="支持图片输入"
                          valuePropName="checked"
                          style={{ marginBottom: 0 }}
                        >
                          <Switch size="small" />
                        </Form.Item>
                      </Flex>
                    </div>
                  ))}
                  <Button
                    type="dashed"
                    block
                    icon={<PlusOutlined />}
                    onClick={() =>
                      add({
                        id: '',
                        name: '',
                        context: 128000,
                        max_tokens: 16384,
                        reasoning: false,
                        image: false,
                      })
                    }
                  >
                    添加模型
                  </Button>
                </Flex>
              )}
            </Form.List>
          </Form.Item>
        </Form>
      </Modal>
    </Flex>
  );
}
