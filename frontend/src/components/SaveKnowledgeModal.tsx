import { useEffect, useMemo } from 'react';
import { App, AutoComplete, Form, Input, Modal, Select, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { useAuth } from '../app/AuthContext';
import { errText } from '../utils/err';

interface SaveKnowledgeValues {
  title: string;
  spaceId?: number;
  category?: string;
  tags?: string[];
  visibility: 'private' | 'roles' | 'public';
  roles?: string[];
}

interface Props {
  open: boolean;
  title: string;
  body: string;
  category?: string;
  tags?: string[];
  onClose: () => void;
  onSaved?: () => void;
}

const VISIBILITY_HINT: Record<string, string> = {
  private: '只有你和管理员可见，后续可在知识库中调整',
  roles: '指定角色组的成员可见',
  public: '所有已登录用户可见',
};

export default function SaveKnowledgeModal({ open, title, body, category, tags, onClose, onSaved }: Props) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { me } = useAuth();
  const [form] = Form.useForm<SaveKnowledgeValues>();
  const visibility = Form.useWatch('visibility', form) ?? 'private';

  const spaces = useQuery({
    queryKey: ['knowledge-spaces'],
    queryFn: api.knowledgeSpaces,
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });

  const facets = useQuery({
    queryKey: ['knowledge-facets'],
    queryFn: () => api.knowledgeCategories(),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });

  const spaceOptions = useMemo(
    () => [
      { value: 0, label: '未归档' },
      ...(spaces.data?.items ?? []).filter((s) => s.canEdit).map((s) => ({ value: s.id, label: s.name })),
    ],
    [spaces.data],
  );

  const categoryOptions = useMemo(
    () => (facets.data?.categories ?? []).map((c) => ({ value: c.name, label: c.name })),
    [facets.data],
  );
  const roleOptions = useMemo(
    () => (me?.roles ?? []).filter((r) => r.startsWith('lab-')).sort().map((r) => ({ value: r, label: r })),
    [me?.roles],
  );

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      title,
      spaceId: 0,
      category: category ?? '',
      tags: tags ?? [],
      visibility: 'private',
      roles: [],
    });
  }, [open, title, category, tags, form]);

  const save = useMutation({
    mutationFn: (values: SaveKnowledgeValues) =>
      api.knowledgeCreate({
        title: values.title.trim(),
        body,
        spaceId: values.spaceId ?? 0,
        tags: values.tags ?? [],
        category: (values.category ?? '').trim(),
        visibility: values.visibility,
        roles: values.visibility === 'roles' ? (values.roles ?? []) : [],
      }),
    onSuccess: () => {
      message.success('已保存到知识库');
      void qc.invalidateQueries({ queryKey: ['knowledge'] });
      void qc.invalidateQueries({ queryKey: ['knowledge-facets'] });
      void qc.invalidateQueries({ queryKey: ['knowledge-rag-status'] });
      onSaved?.();
      onClose();
    },
    onError: (e: Error) => message.error(`保存失败：${errText(e)}`),
  });

  return (
    <Modal
      open={open}
      title="保存到知识库"
      okText="保存"
      cancelText="取消"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={() => (save.isPending ? undefined : onClose())}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} style={{ marginTop: 12 }}>
        <Form.Item name="title" label="标题" rules={[{ required: true, whitespace: true, message: '请填写标题' }]}>
          <Input maxLength={200} showCount placeholder="知识库条目标题" />
        </Form.Item>
        <Form.Item name="spaceId" label="所属知识库" extra="只能写入你创建或管理的知识库">
          <Select options={spaceOptions} placeholder="未归档" />
        </Form.Item>
        <Form.Item name="category" label="文件夹" extra="用 / 分隔层级，例如：文献资料/2026；留空即为未分类">
          <AutoComplete
            options={categoryOptions}
            placeholder="例如：文献资料"
            showSearch={{ filterOption: (input, option) => String(option?.value ?? '').includes(input) }}
          />
        </Form.Item>
        <Form.Item name="tags" label="标签">
          <Select mode="tags" placeholder="输入后回车添加，最多 20 个" tokenSeparators={[',', '，']} />
        </Form.Item>
        <Form.Item name="visibility" label="可见范围" extra={VISIBILITY_HINT[visibility]}>
          <Select
            options={[
              { value: 'private', label: '仅自己' },
              { value: 'roles', label: '指定角色组' },
              { value: 'public', label: '全实验室' },
            ]}
          />
        </Form.Item>
        {visibility === 'roles' ? (
          <Form.Item
            name="roles"
            label="可见角色组"
            rules={[{ required: true, message: '请至少选择一个角色组' }]}
          >
            <Select mode="tags" options={roleOptions} placeholder="选择或输入角色组，如 lab-teacher" />
          </Form.Item>
        ) : null}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          正文将保存当前内容（{body.length.toLocaleString()} 字符），保存后自动重建检索索引。
        </Typography.Text>
      </Form>
    </Modal>
  );
}