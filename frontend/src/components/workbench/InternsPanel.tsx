/**
 * 个人工作台 · 实习生绑定（InternsPanel）
 *
 * 由来：原来的「指派」页签把两件事混在一起——导师↔实习生绑定（真实需求，保留）
 * 与任务指派批阅（已下架）。现在绑定单独成页签。
 *
 * 与其他工作台面板保持同一套骨架：
 *   统计条 → 绑定关系表 → 绑定操作区 → 空态说明
 * 而不是之前的"一张卡片里塞一个 Popover"。
 *
 * 权限口径由后端 `assignment-people` 决定（前端不猜）：
 * 只有博士生及以上能改绑；其余身份只读查看自己的绑定关系。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Flex,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, LinkOutlined, TeamOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type MentorBindingRow } from '../../services/api';
import { errText } from '../../utils/err';

const { Paragraph, Text } = Typography;

export default function InternsPanel() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [internId, setInternId] = useState<string | undefined>(undefined);
  const [mentorId, setMentorId] = useState<string | undefined>(undefined);

  const bindings = useQuery({
    queryKey: ['workbench-mentor-bindings'],
    queryFn: api.workbenchMentorBindings,
    staleTime: 30_000,
  });

  const data = bindings.data;
  const rows = data?.bindings ?? [];
  const canBind = Boolean(data?.canBind);

  const bind = useMutation({
    mutationFn: ({ userId, mentor }: { userId: string; mentor: string }) =>
      api.workbenchBindMentor(userId, mentor),
    onSuccess: () => {
      message.success('已绑定导师');
      setInternId(undefined);
      setMentorId(undefined);
      void qc.invalidateQueries({ queryKey: ['workbench-mentor-bindings'] });
    },
    onError: (e: Error) => message.error(`绑定失败：${errText(e, 120)}`),
  });

  const unbind = useMutation({
    mutationFn: (userId: string) => api.workbenchUnbindMentor(userId),
    onSuccess: () => {
      message.success('已解除绑定');
      void qc.invalidateQueries({ queryKey: ['workbench-mentor-bindings'] });
    },
    onError: (e: Error) => message.error(`解绑失败：${errText(e, 120)}`),
  });

  /** 只能把低年级成员绑给年级更高的导师。 */
  const internRank = data?.interns.find((p) => p.id === internId)?.rank ?? -1;
  const mentorOptions = useMemo(
    () =>
      (data?.mentors ?? [])
        .filter((p) => p.rank > internRank)
        .map((p) => ({
          value: p.id,
          label: `${p.name}${p.rankLabel ? ` · ${p.rankLabel}` : ''}`,
        })),
    [data?.mentors, internRank],
  );

  const columns: ColumnsType<MentorBindingRow> = [
    {
      title: '成员',
      dataIndex: 'userName',
      key: 'userName',
      render: (v: string) => <Text strong>{v}</Text>,
    },
    {
      title: '',
      key: 'arrow',
      width: 40,
      align: 'center',
      render: () => <LinkOutlined style={{ color: '#8e99aa' }} />,
    },
    {
      title: '导师',
      dataIndex: 'mentorName',
      key: 'mentorName',
      render: (v: string) => <Tag color="blue">{v}</Tag>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      render: (_v, row) =>
        canBind ? (
          <Tooltip title="解除这条绑定">
            <Button
              size="small"
              danger
              type="text"
              icon={<DeleteOutlined />}
              loading={unbind.isPending}
              aria-label={`解除 ${row.userName} 的导师绑定`}
              onClick={() => unbind.mutate(row.userId)}
            >
              解绑
            </Button>
          </Tooltip>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Text>
        ),
    },
  ];

  return (
    <Flex vertical gap={12}>
      {bindings.isError ? (
        <Alert
          type="error"
          showIcon
          title="读取导师绑定失败"
          description={errText(bindings.error)}
          action={
            <Button size="small" onClick={() => void bindings.refetch()}>
              重试
            </Button>
          }
        />
      ) : null}

      {/* 统计条：与其它面板保持同一骨架 */}
      <Flex gap={12} wrap>
        <Card size="small" style={{ flex: '1 1 160px', minWidth: 150 }}>
          <Statistic
            title="我的导师"
            value={data?.myMentor?.mentorName ?? '未绑定'}
            valueStyle={{ fontSize: 18 }}
          />
        </Card>
        <Card size="small" style={{ flex: '1 1 160px', minWidth: 150 }}>
          <Statistic title="已绑定关系" value={rows.length} suffix="条" />
        </Card>
        <Card size="small" style={{ flex: '1 1 160px', minWidth: 150 }}>
          <Statistic
            title="可绑定成员"
            value={data?.interns?.length ?? 0}
            suffix="人"
            valueStyle={{ color: canBind ? '#2B5CE6' : '#8e99aa' }}
          />
        </Card>
      </Flex>

      {/* 绑定关系表 */}
      <Card
        size="small"
        title={
          <Space>
            <TeamOutlined />
            绑定关系
          </Space>
        }
        extra={
          <Text type="secondary" style={{ fontSize: 12 }}>
            {canBind ? '可改绑 / 解绑' : '当前身份只能查看'}
          </Text>
        }
      >
        <Table<MentorBindingRow>
          rowKey="userId"
          size="small"
          columns={columns}
          dataSource={rows}
          loading={bindings.isLoading}
          pagination={false}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="还没有绑定关系"
              />
            ),
          }}
        />
      </Card>

      {/* 绑定操作区：只在有权限时出现，没权限就说清楚为什么 */}
      {canBind ? (
        <Card size="small" title="新建绑定">
          <Flex gap={10} wrap align="flex-end">
            <Flex vertical gap={4} style={{ flex: '1 1 200px', minWidth: 180 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                成员
              </Text>
              <Select
                placeholder="选择低年级成员"
                value={internId}
                onChange={(v) => {
                  setInternId(v);
                  setMentorId(undefined);
                }}
                showSearch
                optionFilterProp="label"
                options={(data?.interns ?? []).map((p) => ({
                  value: p.id,
                  label: `${p.name}${p.rankLabel ? ` · ${p.rankLabel}` : ''}`,
                }))}
              />
            </Flex>
            <Flex vertical gap={4} style={{ flex: '1 1 200px', minWidth: 180 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                导师（只能选年级更高的）
              </Text>
              <Select
                placeholder={internId ? '选择导师' : '先选成员'}
                value={mentorId}
                onChange={setMentorId}
                disabled={!internId}
                showSearch
                optionFilterProp="label"
                options={mentorOptions}
                notFoundContent="没有年级更高的导师可选"
              />
            </Flex>
            <Button
              type="primary"
              icon={<LinkOutlined />}
              disabled={!internId || !mentorId}
              loading={bind.isPending}
              onClick={() => internId && mentorId && bind.mutate({ userId: internId, mentor: mentorId })}
            >
              绑定
            </Button>
          </Flex>
        </Card>
      ) : (
        <Alert
          type="info"
          showIcon
          title="改绑需要博士生及以上权限"
          description="你可以在这里查看自己的导师与已有绑定关系；需要调整请联系导师或管理员。"
        />
      )}

      <Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }}>
        绑定用于让导师在工作台看到自己带的成员、成员也能看到自己的导师；
        不涉及文件权限（文件权限由「文件存储」的共享与 ACL 决定）。
      </Paragraph>
    </Flex>
  );
}
