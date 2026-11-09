import {
  Alert,
  App,
  Button,
  Card,
  Flex,
  Form,
  Input,
  Modal,
  Popover,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type FileGrant, type GroupPermissionRow } from '../../services/api';
import { GrantEditor, GrantList } from '../../components/acl/GrantEditor';

/** 推荐的角色组：名称稳定（用于 ACL），展示名可随时修改。 */
export const ROLE_GROUPS = [
  { name: 'lab-teacher', displayName: '老师', hint: '课件读写，公共与质粒只读' },
  { name: 'lab-postdoc', displayName: '博士后', hint: '共享只读，项目目录可写' },
  { name: 'lab-phd', displayName: '博士', hint: '共享只读，项目目录可写' },
  { name: 'lab-master', displayName: '研究生', hint: '共享只读，项目目录可写' },
  { name: 'lab-undergrad', displayName: '本科生', hint: '公共、课件、质粒只读' },
  { name: 'lab-intern', displayName: '实习生', hint: '仅公共目录只读' },
] as const;

/**
 * 权限组（预配置）：组名与成员关系由统一身份源维护，这里定义
 * "这个组默认能访问哪些共享目录"，并支持新建 / 改名 / 启停 / 删除。
 */
export default function GroupPermissions() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<GroupPermissionRow | null>(null);
  const [draft, setDraft] = useState<FileGrant[]>([]);
  const [pendingGroup, setPendingGroup] = useState<string | undefined>(undefined);
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState<GroupPermissionRow | null>(null);
  const [deleting, setDeleting] = useState<GroupPermissionRow | null>(null);
  const [createForm] = Form.useForm();
  const [editForm] = Form.useForm();

  const { data, isLoading } = useQuery({
    queryKey: ['admin-group-permissions'],
    queryFn: () => api.groupPermissions(),
    staleTime: 15_000,
  });

  const rows = data?.groups ?? [];
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin-group-permissions'] });
    void qc.invalidateQueries({ queryKey: ['admin-accounts'] });
  };

  const save = useMutation({
    mutationFn: ({ group, grants }: { group: string; grants: FileGrant[] }) =>
      api.setGroupGrants(group, grants),
    onSuccess: (res) => {
      message.success(`权限组 ${res.name} 的文件权限已更新`);
      setEditing(null);
      setPendingGroup(undefined);
      refresh();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const create = useMutation({
    mutationFn: (body: { name: string; displayName?: string; enabled?: boolean }) => api.createGroup(body),
    onSuccess: (res) => {
      message.success(`权限组 ${res.name} 已创建`);
      setCreateOpen(false);
      createForm.resetFields();
      refresh();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const update = useMutation({
    mutationFn: ({
      group,
      body,
    }: {
      group: string;
      body: { newName?: string; displayName?: string; enabled?: boolean };
    }) => api.updateGroup(group, body),
    onSuccess: (res) => {
      message.success(`权限组 ${res.name} 已更新`);
      setEditOpen(null);
      editForm.resetFields();
      refresh();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const remove = useMutation({
    mutationFn: ({ group, force }: { group: string; force: boolean }) =>
      api.removeFileGroup(group, force),
    onSuccess: (res) => {
      message.success(
        res.removedMembers
          ? `权限组 ${res.name} 已删除，${res.removedMembers} 名成员的组归属已移除`
          : `权限组 ${res.name} 已删除`,
      );
      setDeleting(null);
      refresh();
    },
    onError: (e: Error) => message.error(e.message),
  });

  // 身份源里存在、但还没配文件权限的组：可以直接在这里补上默认授权。
  const unconfigured = rows.filter((r) => r.inIdentitySource && !r.hasFileGrants);
  const missingRoles = ROLE_GROUPS.filter((r) => !rows.some((row) => row.name === r.name));

  const openEditor = (row: GroupPermissionRow) => {
    setEditing(row);
    setDraft(row.grants);
  };

  const openEdit = (row: GroupPermissionRow) => {
    setEditOpen(row);
    editForm.setFieldsValue({
      newName: row.name,
      displayName: row.displayName === row.name ? '' : row.displayName,
      enabled: row.enabled,
    });
  };

  return (
    <Card
      size="small"
      title={
        <Space size={8}>
          <span>权限组（预配置）</span>
          <Tag variant="filled">{rows.length}</Tag>
        </Space>
      }
      extra={
        <Space size={8} wrap>
          {unconfigured.length ? (
            <Select
              placeholder="为未配置的组添加默认权限"
              style={{ width: 220 }}
              value={pendingGroup}
              options={unconfigured.map((r) => ({
                value: r.name,
                label: r.displayName && r.displayName !== r.name ? `${r.displayName}（${r.name}）` : r.name,
              }))}
              onChange={(name) => {
                const row = rows.find((r) => r.name === name) ?? null;
                setPendingGroup(undefined);
                setEditing(row);
                setDraft([]);
              }}
            />
          ) : null}
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建权限组
          </Button>
        </Space>
      }
    >
      {!data?.fileAccessAvailable ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="文件核心当前不可用，权限组目录授权暂时无法读取或修改。"
        />
      ) : null}

      {missingRoles.length ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          title="推荐角色组尚未全部建立"
          description={
            <Flex gap={6} wrap>
              {missingRoles.map((r) => (
                <Tag key={r.name} color="blue">
                  {r.displayName}（{r.name}）
                </Tag>
              ))}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                点击右上角「新建权限组」补齐，成员会在账号编辑里选择。
              </Typography.Text>
            </Flex>
          }
        />
      ) : null}

      <Table<GroupPermissionRow>
        size="small"
        rowKey="name"
        loading={isLoading}
        pagination={false}
        dataSource={rows}
        scroll={{ x: 760 }}
        columns={[
          {
            title: '权限组',
            dataIndex: 'name',
            width: 230,
            render: (name: string, r) => (
              <Flex vertical gap={2}>
                <Space size={6} wrap>
                  <Typography.Text strong>{r.displayName || name}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {name}
                  </Typography.Text>
                  {r.builtin ? <Tag color="blue">内置</Tag> : <Tag>自定义</Tag>}
                  {!r.enabled ? <Tag color="warning">已停用</Tag> : null}
                </Space>
              </Flex>
            ),
          },
          {
            title: '成员',
            dataIndex: 'members',
            width: 96,
            render: (members: string[]) =>
              members?.length ? (
                <Popover
                  trigger="click"
                  title={`共 ${members.length} 人`}
                  content={
                    <Space size={[4, 4]} wrap style={{ maxWidth: 320 }}>
                      {members.map((m) => (
                        <Tag key={m}>{m}</Tag>
                      ))}
                    </Space>
                  }
                >
                  <Button size="small" type="link">
                    {members.length} 人
                  </Button>
                </Popover>
              ) : (
                <Typography.Text type="secondary">无</Typography.Text>
              ),
          },
          {
            title: '默认文件权限',
            dataIndex: 'grants',
            render: (grants: FileGrant[]) => <GrantList grants={grants} empty="未配置共享目录权限" />,
          },
          {
            title: '一致性',
            width: 160,
            render: (_: unknown, r) => {
              if (!r.inIdentitySource) {
                return <Tag color="error">身份源已移除</Tag>;
              }
              if (!r.hasFileGrants) {
                return <Typography.Text type="secondary">未配置</Typography.Text>;
              }
              return <Tag color="success">正常</Tag>;
            },
          },
          {
            title: '操作',
            width: 220,
            render: (_: unknown, r) => (
              <Space size={2} wrap>
                <Button size="small" type="link" onClick={() => openEditor(r)}>
                  配置权限
                </Button>
                {r.inIdentitySource ? (
                  <Button size="small" type="link" onClick={() => openEdit(r)}>
                    编辑
                  </Button>
                ) : null}
                <Button size="small" type="link" danger onClick={() => setDeleting(r)}>
                  删除
                </Button>
              </Space>
            ),
          },
        ]}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        组权限是成员的默认值，个人权限可在「统一账号」里单独放宽或收回；改名会同步迁移成员与组授权，删除时会先移出成员并吊销其会话。
      </Typography.Text>

      {/* ------------------------------------------------ 目录权限编辑 */}
      <Modal
        open={Boolean(editing)}
        title={`组文件权限：${editing?.displayName || editing?.name || ''}`}
        width={640}
        okText="保存"
        cancelText="取消"
        confirmLoading={save.isPending}
        onCancel={() => {
          setEditing(null);
          setPendingGroup(undefined);
        }}
        onOk={() => (editing ? save.mutate({ group: editing.name, grants: draft }) : undefined)}
      >
        {editing && !editing.inIdentitySource ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            title="该组已不在统一身份源中"
            description="仍可编辑，但没有任何账号能继承这些权限；建议删除后在身份源重新建组。"
          />
        ) : null}
        {editing?.members?.length ? (
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            将影响 {editing.members.length} 名成员：{editing.members.slice(0, 8).join('、')}
            {editing.members.length > 8 ? ' 等' : ''}
          </Typography.Paragraph>
        ) : null}
        <GrantEditor
          grants={draft}
          directories={data?.directories ?? {}}
          disabled={!data?.fileAccessAvailable}
          onChange={setDraft}
        />
      </Modal>

      {/* ------------------------------------------------ 新建 */}
      <Modal
        open={createOpen}
        title="新建权限组"
        okText="创建"
        cancelText="取消"
        confirmLoading={create.isPending}
        onOk={() => createForm.submit()}
        onCancel={() => {
          setCreateOpen(false);
          createForm.resetFields();
        }}
        destroyOnHidden
      >
        <Form
          form={createForm}
          layout="vertical"
          requiredMark={false}
          onFinish={(v: { name: string; displayName?: string; enabled?: boolean }) =>
            create.mutate({
              name: String(v.name || '').trim().toLowerCase(),
              displayName: v.displayName,
              enabled: v.enabled !== false,
            })
          }
        >
          <Form.Item
            name="name"
            label="组标识"
            extra="小写字母开头，仅含小写字母/数字/_/-，创建后仍可修改。"
            rules={[
              { required: true, message: '请输入组标识' },
              { pattern: /^[a-z][a-z0-9_-]{1,31}$/, message: '格式：小写字母开头，长度 2–32' },
            ]}
          >
            <Input placeholder="例如：lab-visiting" />
          </Form.Item>
          <Form.Item name="displayName" label="显示名称">
            <Input placeholder="例如：访问学者" />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked" initialValue>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      {/* ------------------------------------------------ 编辑 / 改名 */}
      <Modal
        open={Boolean(editOpen)}
        title={`编辑权限组：${editOpen?.displayName || editOpen?.name || ''}`}
        okText="保存"
        cancelText="取消"
        confirmLoading={update.isPending}
        onOk={() => editForm.submit()}
        onCancel={() => {
          setEditOpen(null);
          editForm.resetFields();
        }}
        destroyOnHidden
      >
        <Form
          form={editForm}
          layout="vertical"
          requiredMark={false}
          onFinish={(v: { newName?: string; displayName?: string; enabled?: boolean }) => {
            if (!editOpen) return;
            const next = String(v.newName || '').trim().toLowerCase();
            update.mutate({
              group: editOpen.name,
              body: {
                newName: next && next !== editOpen.name ? next : undefined,
                displayName: v.displayName?.trim() ?? '',
                enabled: v.enabled !== false,
              },
            });
          }}
        >
          <Form.Item
            name="newName"
            label="组标识"
            extra="改名会同步迁移成员归属与组文件授权，并吊销成员现有会话。"
            rules={[{ pattern: /^[a-z][a-z0-9_-]{1,31}$/, message: '格式：小写字母开头，长度 2–32' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="displayName" label="显示名称">
            <Input placeholder="例如：老师 / 博士 / 研究生" />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      {/* ------------------------------------------------ 删除 */}
      <Modal
        open={Boolean(deleting)}
        title={`删除权限组：${deleting?.displayName || deleting?.name || ''}`}
        okText={deleting?.members?.length ? '强制删除' : '删除'}
        okButtonProps={{ danger: true, loading: remove.isPending }}
        cancelText="取消"
        onCancel={() => setDeleting(null)}
        onOk={() =>
          deleting ? remove.mutate({ group: deleting.name, force: Boolean(deleting.members?.length) }) : undefined
        }
      >
        <Flex vertical gap={10}>
          <Typography.Text>
            将从统一身份源移除组 <Typography.Text code>{deleting?.name}</Typography.Text>
            ，并清理该组的文件授权模板。
          </Typography.Text>
          {deleting?.members?.length ? (
            <Alert
              type="warning"
              showIcon
              title={`该组仍有 ${deleting.members.length} 名成员`}
              description={
                <Flex vertical gap={6}>
                  <Flex gap={4} wrap>
                    {deleting.members.slice(0, 12).map((m) => (
                      <Tag key={m}>{m}</Tag>
                    ))}
                    {deleting.members.length > 12 ? <Tag>等 {deleting.members.length} 人</Tag> : null}
                  </Flex>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    强制删除会把这些成员移出该组并吊销其会话；账号与个人文件不受影响。
                  </Typography.Text>
                </Flex>
              }
            />
          ) : null}
        </Flex>
      </Modal>
    </Card>
  );
}