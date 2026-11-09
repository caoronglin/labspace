import { Alert, Card, Flex, Space, Table, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { api, type AccessProbe } from '../../services/api';
import { FILE_SOURCE_LABEL } from './shared';

const ACTION_LABEL: Record<string, string> = {
  list: '列出',
  read: '查看',
  download: '下载',
  create: '新建',
  modify: '修改',
  delete: '删除',
};

const ACTION_ORDER = ['list', 'read', 'download', 'create', 'modify', 'delete'];

function originLabel(origin: string | undefined) {
  if (!origin) return null;
  if (origin === 'user') return <Tag color="blue">个人权限</Tag>;
  if (origin === 'admin') return <Tag color="purple">管理员身份</Tag>;
  if (origin.startsWith('group:')) return <Tag color="green">继承自组 {origin.slice(6)}</Tag>;
  return <Tag>{origin}</Tag>;
}

/**
 * 权限预演：用与真实会话完全相同的判定顺序（单独收回 > 个人权限 > 用户组 > 管理员）
 * 计算某账号在每个目录上的实际能力，避免"配置看起来对"与"实际能访问"各说一套。
 */
export default function AccessPreview({ name }: { name: string }) {
  const { data, isFetching, error } = useQuery({
    queryKey: ['account-access-preview', name],
    queryFn: () => api.accessPreview(name),
    enabled: Boolean(name),
    staleTime: 0,
  });

  if (error) {
    return <Alert type="error" showIcon title={`权限预演失败：${(error as Error).message}`} />;
  }

  const rows = (data?.probes ?? []).filter(
    // 只保留"能看到点什么"的路径：全 false 的行除了噪音没有信息。
    (p) => Object.values(p.actions).some((v) => v),
  );

  return (
    <Card size="small" style={{ marginTop: 16 }}>
      <Flex vertical gap={12}>
        <Space size={8} wrap>
          <Typography.Text strong>{name} 的实际权限</Typography.Text>
          {data?.admin ? <Tag color="purple">管理员</Tag> : null}
          {(data?.roles ?? []).map((r) => (
            <Tag key={r}>{r}</Tag>
          ))}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            个人空间始终只暴露本人目录，不在下表内。
          </Typography.Text>
        </Space>
        <Table<AccessProbe>
          size="small"
          rowKey={(r) => `${r.source}/${r.path}`}
          loading={isFetching && !data}
          pagination={false}
          dataSource={rows}
          columns={[
            {
              title: '文件源',
              dataIndex: 'source',
              width: 110,
              render: (source: string) => FILE_SOURCE_LABEL[source] ?? source,
            },
            {
              title: '目录',
              dataIndex: 'path',
              width: 160,
              render: (path: string) => path || <Typography.Text type="secondary">根目录</Typography.Text>,
            },
            {
              title: '可执行操作',
              render: (_: unknown, r) => (
                <Space size={[4, 4]} wrap>
                  {ACTION_ORDER.filter((a) => r.actions[a]).map((a) => (
                    <Tag key={a} color="success">
                      {ACTION_LABEL[a] ?? a}
                    </Tag>
                  ))}
                  {!ACTION_ORDER.some((a) => r.actions[a]) ? (
                    <Typography.Text type="secondary">无</Typography.Text>
                  ) : null}
                </Space>
              ),
            },
            {
              title: '授权来源',
              render: (_: unknown, r) => (
                <Space size={[4, 4]} wrap>
                  {Array.from(new Set(Object.values(r.origin ?? {}))).map((o) => (
                    <span key={o}>{originLabel(o)}</span>
                  ))}
                  {!Object.keys(r.origin ?? {}).length ? (
                    <Typography.Text type="secondary">-</Typography.Text>
                  ) : null}
                </Space>
              ),
            },
          ]}
        />
        {!isFetching && !rows.length ? (
          <Typography.Text type="secondary">
            该账号目前看不到任何共享目录：既没有个人授权，所属用户组也未配置这些文件源。
          </Typography.Text>
        ) : null}
      </Flex>
    </Card>
  );
}
