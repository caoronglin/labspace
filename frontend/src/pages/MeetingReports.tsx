/**
 * 组会汇报（/meetings）。
 *
 * 布局约定：**上下结构，不做左右分栏**。
 * 之前的"左侧周列表 + 右侧文件"在小屏上要横向滚动，在宽屏上又把文件区压窄，
 * 两头都不好用。现在改成：
 *
 *   ① 顶部统计（可见周数 / 材料数 / 占用 / 当前周）
 *   ② 周选择器：横向滚动的周卡片（本身就是时间线，一眼看到有材料的那几周）
 *   ③ 选中周的操作区（上传 / 文件存储 / 授权）—— 整宽
 *   ④ 文件表格 —— 整宽
 *
 * 权限口径：周目录**独立授权**，未授权的周根本不出现在选择器里（不是空列表）。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Drawer,
  Empty,
  Flex,
  Grid,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { UploadProps } from 'antd';
import {
  CloudUploadOutlined,
  DeleteOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  InboxOutlined,
  ReloadOutlined,
  ScheduleOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import PageShell from '../components/PageShell';
import { useAuth } from '../app/AuthContext';
import { api, type PeopleEntry } from '../services/api';
import { meetingApi, type MeetingFile, type MeetingWeek } from '../services/labspaces';
import { labSharedApi } from '../services/labShared';
import { errText } from '../utils/err';

import { formatSize } from '../utils/format';
const { Paragraph, Text } = Typography;

// 大小格式化统一走 utils/format（见该文件顶部说明）
const formatBytes = formatSize;

export default function MeetingReports() {
  // 保留期从**后端**取（回收站清单里带 retentionDays），不写死天数：
  // 写死的「7 天」一旦和实际配置漂移，用户会据此安排"过期就找导师"然后踩空。
  const trashQuery = useQuery({ queryKey: ['file-trash'], queryFn: api.fileTrash, staleTime: 30_000 });
  const retentionDays = trashQuery.data?.retentionDays ?? 7;
  const { message } = App.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const screens = Grid.useBreakpoint();
  const { isTeacher, isAdmin } = useAuth();
  const canManage = isTeacher || isAdmin;

  const [selected, setSelected] = useState<string>('');
  const [grantOpen, setGrantOpen] = useState(false);
  const [compressOpen, setCompressOpen] = useState(false);
  const [keepWeeks, setKeepWeeks] = useState(4);
  const [grantPicks, setGrantPicks] = useState<string[]>([]);

  const weeks = useQuery({
    queryKey: ['meetings', 'weeks'],
    queryFn: meetingApi.weeks,
    retry: false,
    staleTime: 30_000,
  });

  const weekList = weeks.data?.weeks ?? [];
  /** 默认选中：优先当前周，其次第一个可见周 —— 不要让用户落在必然 403 的周上。 */
  const current = useMemo(() => {
    if (selected) return selected;
    const cur = weeks.data?.currentWeek ?? '';
    if (cur && weekList.some((w) => w.yearWeek === cur)) return cur;
    return weekList[0]?.yearWeek ?? '';
  }, [selected, weeks.data?.currentWeek, weekList]);

  const files = useQuery({
    queryKey: ['meetings', 'files', current],
    queryFn: () => meetingApi.files(current),
    enabled: Boolean(current),
    retry: false,
  });

  const people = useQuery({
    queryKey: ['people'],
    queryFn: api.people,
    enabled: grantOpen,
    retry: false,
    staleTime: 300_000,
  });

  // 我在组员共享树里的那棵目录（学生侧）：用它做「组会 ↔ 共享目录」的跳转
  const sharedMine = useQuery({
    queryKey: ['lab-shared', 'mine'],
    queryFn: labSharedApi.mine,
    staleTime: 60_000,
    retry: false,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['meetings'] });
  };

  const grantMutation = useMutation({
    mutationFn: ({ week, userId }: { week: string; userId: string }) =>
      meetingApi.grant(week, userId),
    onSuccess: () => {
      message.success('已开通该周的访问权');
      invalidate();
    },
    onError: (e) => message.error(`开通失败：${errText(e)}`),
  });

  /**
   * 沿用上一周的授权名单。
   *
   * 组会逐周授权，每周要开的人几乎都一样 —— 这是流程上最没价值的重复劳动，
   * 也是「忘了给谁开」的事故来源。这里一键把上周名单搬过来（只加不减）。
   */
  const copyPrevMutation = useMutation({
    mutationFn: (week: string) => meetingApi.copyPreviousGrants(week),
    onSuccess: (r) => {
      if (r.failed.length) {
        message.warning(`已沿用 ${r.added.length} 人；${r.failed.length} 人失败：${r.failed[0]}`);
      } else if (!r.added.length) {
        message.info(`本周已包含 ${r.from} 的全部授权（跳过 ${r.skipped} 人）`);
      } else {
        message.success(`已沿用 ${r.from} 的授权：新增 ${r.added.length} 人，跳过 ${r.skipped} 人`);
      }
      invalidate();
    },
    onError: (e) => message.error(`沿用失败：${errText(e)}`),
  });

  const revokeMutation = useMutation({
    mutationFn: ({ week, userId }: { week: string; userId: string }) =>
      meetingApi.revoke(week, userId),
    onSuccess: () => {
      message.success('已收回该周的访问权');
      invalidate();
    },
    onError: (e) => message.error(`收回失败：${errText(e)}`),
  });

  const uploadMutation = useMutation({
    mutationFn: ({ file, week }: { file: File; week: string }) => meetingApi.upload(file, week),
    onSuccess: (r) => {
      message.success(`已上传到 ${r.yearWeek}`);
      invalidate();
    },
    onError: (e) => message.error(`上传失败：${errText(e)}`),
  });

  const deleteMutation = useMutation({
    mutationFn: ({ week, path }: { week: string; path: string }) =>
      meetingApi.deleteFile(week, path),
    onSuccess: (r) => {
      message.success(`已删除 ${r.name}（可在文件存储的回收站恢复）`);
      invalidate();
    },
    onError: (e) => message.error(`删除失败：${errText(e)}`),
  });

  const compressMutation = useMutation({
    mutationFn: (keep: number) => meetingApi.compress(keep),
    onSuccess: (r) => {
      message.success(`已压缩 ${r.compressed} 个旧周目录`);
      setCompressOpen(false);
      invalidate();
    },
    onError: (e) => message.error(`压缩失败：${errText(e)}`),
  });

  const peopleOptions = useMemo(
    () =>
      (people.data?.people ?? []).map((p: PeopleEntry) => ({
        value: p.id,
        label: p.displayName || p.name,
      })),
    [people.data],
  );

  const grantedIds = useMemo(() => {
    const week = weekList.find((w) => w.yearWeek === current);
    return new Set((week?.grants ?? []).map((g) => g.userId));
  }, [weekList, current]);

  const totalSize = weekList.reduce((s, w) => s + (w.sizeBytes || 0), 0);
  const totalFiles = weekList.reduce((s, w) => s + (w.fileCount || 0), 0);

  const uploadProps: UploadProps = {
    accept: '.pdf,.md,.txt,.docx,.xlsx,.pptx,.csv,.png,.jpg',
    showUploadList: false,
    multiple: false,
    customRequest: ({ file, onSuccess, onError }) => {
      uploadMutation.mutate(
        { file: file as File, week: current },
        { onSuccess: () => onSuccess?.({ ok: true }), onError: (e) => onError?.(e as Error) },
      );
    },
  };

  const fileColumns: ColumnsType<MeetingFile> = [
    {
      title: '文件',
      dataIndex: 'name',
      key: 'name',
      render: (v: string) => (
        <Space size={6}>
          <FileTextOutlined />
          <Text strong>{v}</Text>
        </Space>
      ),
    },
    {
      title: '大小',
      dataIndex: 'size',
      key: 'size',
      width: 110,
      align: 'right',
      render: (v: number) => formatBytes(v || 0),
    },
    {
      title: '修改时间',
      dataIndex: 'modified',
      key: 'modified',
      width: 180,
      render: (v: string) =>
        v ? <Text type="secondary">{new Date(v).toLocaleString('zh-CN')}</Text> : '—',
    },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      render: (_v, row) => (
        <Popconfirm
          title={`删除 ${row.name}？`}
          description={`会移入文件存储的回收站，${retentionDays} 天内可恢复。`}
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => deleteMutation.mutate({ week: current, path: row.path })}
        >
          <Tooltip title="删除">
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              aria-label={`删除 ${row.name}`}
            />
          </Tooltip>
        </Popconfirm>
      ),
    },
  ];

  /** 周选择卡片：横向滚动的一行，本身就是时间线。 */
  const weekCard = (week: MeetingWeek) => {
    const active = week.yearWeek === current;
    return (
      <button
        key={week.yearWeek}
        type="button"
        onClick={() => setSelected(week.yearWeek)}
        aria-pressed={active}
        style={{
          flex: '0 0 auto',
          minWidth: 152,
          padding: '10px 12px',
          textAlign: 'left',
          cursor: 'pointer',
          borderRadius: 10,
          border: active
            ? '1px solid var(--ant-color-primary)'
            : '1px solid var(--ant-color-border-secondary)',
          background: active ? 'var(--ant-color-primary-bg)' : 'transparent',
        }}
      >
        <Flex vertical gap={2}>
          <Flex justify="space-between" align="center" gap={6}>
            <Text strong>{week.yearWeek}</Text>
            {week.yearWeek === weeks.data?.currentWeek ? <Tag color="blue">本周</Tag> : null}
            {week.compressed ? <Tag color="purple">已压缩</Tag> : null}
          </Flex>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {week.fileCount} 个文件 · {formatBytes(week.sizeBytes)}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            已授权 {week.grants.length} 人
          </Text>
        </Flex>
      </button>
    );
  };

  return (
    <PageShell
      title="组会汇报"
      description="按 ISO 周归档，每周一个目录；每个周目录单独授权，未授权的人看不到。"
      extra={
        <Space wrap>
          {/* 组会材料与「组员共享目录」是两处：
              组会按周归档（逐周授权），共享目录是每人一棵的个人材料区
              （含 01_组会汇报）。用户常常不知道材料该放哪、也不知道另一处
              有没有同一份东西 —— 这里直接把两个入口摆在一起。 */}
          {sharedMine.data?.granted ? (
            <Button
              icon={<FolderOpenOutlined />}
              onClick={() =>
                navigate(
                  `/files?source=users&dir=${encodeURIComponent(
                    `${sharedMine.data?.path ?? ''}/01_组会汇报`,
                  )}`,
                )
              }
            >
              我的共享目录 · 01_组会汇报
            </Button>
          ) : null}
          <Button
            icon={<ReloadOutlined />}
            loading={weeks.isFetching}
            onClick={() => void weeks.refetch()}
          >
            刷新
          </Button>
          {canManage ? (
            <>
              <Button
                icon={<TeamOutlined />}
                onClick={() => {
                  setGrantPicks([]);
                  setGrantOpen(true);
                }}
                disabled={!current}
              >
                管理授权
              </Button>
              <Button icon={<InboxOutlined />} onClick={() => setCompressOpen(true)}>
                压缩旧目录
              </Button>
            </>
          ) : null}
        </Space>
      }
    >
      {/* ① 统计 */}
      <Flex gap={12} wrap>
        <Card size="small" style={{ flex: '1 1 150px', minWidth: 140 }}>
          <Statistic title="可见周目录" value={weekList.length} suffix="周" />
        </Card>
        <Card size="small" style={{ flex: '1 1 150px', minWidth: 140 }}>
          <Statistic title="材料总数" value={totalFiles} suffix="份" />
        </Card>
        <Card size="small" style={{ flex: '1 1 150px', minWidth: 140 }}>
          <Statistic title="合计占用" value={formatBytes(totalSize)} />
        </Card>
        <Card size="small" style={{ flex: '1 1 150px', minWidth: 140 }}>
          <Statistic
            title="当前周"
            value={weeks.data?.currentWeek ?? '—'}
            valueStyle={{ fontSize: 20 }}
          />
        </Card>
      </Flex>

      {weeks.isError ? (
        <Alert
          type="error"
          showIcon
          title="读取周目录失败"
          description={errText(weeks.error)}
          action={
            <Button size="small" onClick={() => void weeks.refetch()}>
              重试
            </Button>
          }
        />
      ) : null}

      {/* ② 周选择器（横向滚动，不占左右分栏） */}
      <Card
        size="small"
        title={
          <Space>
            <ScheduleOutlined />
            选择周目录
          </Space>
        }
        extra={<Text type="secondary">{weekList.length} 周可见</Text>}
      >
        {weekList.length === 0 ? (
          <Empty
            description="还没有可见的周目录（组会目录默认只对授权人开放）"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        ) : (
          <Flex gap={10} wrap={Boolean(screens.md)} style={{ overflowX: 'auto', paddingBottom: 4 }}>
            {weekList.map(weekCard)}
          </Flex>
        )}
      </Card>

      {/* ③ 选中周的操作 + ④ 文件表格（都是整宽） */}
      <Card
        size="small"
        title={
          <Space wrap>
            <span>{current || '未选择周目录'}</span>
            {current ? <Tag color="blue">{files.data?.total ?? 0} 个文件</Tag> : null}
          </Space>
        }
        extra={
          current ? (
            <Space wrap>
              <Upload {...uploadProps}>
                <Button
                  type="primary"
                  icon={<CloudUploadOutlined />}
                  loading={uploadMutation.isPending}
                >
                  上传材料
                </Button>
              </Upload>
              <Button
                icon={<FolderOpenOutlined />}
                onClick={() => navigate(`/files?source=meeting&dir=${encodeURIComponent(current)}`)}
              >
                文件存储
              </Button>
            </Space>
          ) : null
        }
      >
        {!current ? (
          <Empty description="从上面选择一个周目录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : files.isError ? (
          <Alert
            type="warning"
            showIcon
            title="该周目录不可见或无权访问"
            description={errText(files.error)}
          />
        ) : (
          <Table<MeetingFile>
            rowKey="path"
            columns={fileColumns}
            dataSource={files.data?.files ?? []}
            loading={files.isLoading}
            pagination={{ pageSize: 20, hideOnSinglePage: true }}
            scroll={{ x: screens.md ? undefined : 720 }}
            locale={{ emptyText: <Empty description="这一周还没有材料" /> }}
          />
        )}
      </Card>

      {/* 授权抽屉 */}
      <Drawer
        title="管理访问授权"
        open={grantOpen}
        onClose={() => setGrantOpen(false)}
        size={screens.md ? 460 : '100%'}
        extra={<Text type="secondary">{current}</Text>}
      >
        <Paragraph type="secondary">
          组会目录不继承实验室组权限：只有在这里单独授权的人能看到这一周的材料。
        </Paragraph>
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          <Select
            style={{ width: '100%' }}
            showSearch
            allowClear
            mode="multiple"
            placeholder="选择要授权的成员"
            optionFilterProp="label"
            value={grantPicks}
            onChange={setGrantPicks}
            options={peopleOptions.filter((o) => !grantedIds.has(o.value))}
          />
          <Button
            type="primary"
            disabled={!current || !grantPicks.length}
            loading={grantMutation.isPending}
            onClick={() => {
              for (const userId of grantPicks) grantMutation.mutate({ week: current, userId });
              setGrantPicks([]);
            }}
          >
            开通访问权（{grantPicks.length}）
          </Button>
          <Button
            disabled={!current}
            loading={copyPrevMutation.isPending}
            onClick={() => current && copyPrevMutation.mutate(current)}
            title="把上一周的授权名单整套复制到本周（只加不减）"
          >
            沿用上周授权
          </Button>
        </Space>

        <div style={{ height: 1, background: 'rgba(5,5,5,0.06)', margin: '16px 0' }} />
        <Text strong>当前周已授权人员</Text>
        <List
          size="small"
          style={{ marginTop: 8 }}
          dataSource={weekList.find((w) => w.yearWeek === current)?.grants ?? []}
          locale={{ emptyText: '这一周还没有授权任何人' }}
          renderItem={(g) => (
            <List.Item
              actions={[
                <Popconfirm
                  key="revoke"
                  title="收回该成员的访问权？"
                  description="只收回访问权，目录里的材料仍然保留。"
                  okText="收回"
                  cancelText="取消"
                  onConfirm={() => revokeMutation.mutate({ week: current, userId: g.userId })}
                >
                  <Button size="small" danger icon={<DeleteOutlined />} aria-label="收回访问权">
                    收回
                  </Button>
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                avatar={<TeamOutlined />}
                title={g.name}
                description={g.grantedBy ? `由 ${g.grantedBy} 授权` : undefined}
              />
            </List.Item>
          )}
        />
      </Drawer>

      {/* 压缩旧目录 */}
      <Modal
        title="压缩旧周目录"
        open={compressOpen}
        onCancel={() => setCompressOpen(false)}
        okText="开始压缩"
        cancelText="取消"
        confirmLoading={compressMutation.isPending}
        onOk={() => compressMutation.mutate(keepWeeks)}
        destroyOnHidden
      >
        <Paragraph>
          把最近 <Text strong>{keepWeeks}</Text> 周以外的目录打包成 tar.gz，
          省空间但不再能直接浏览里面的文件。
        </Paragraph>
        <InputNumber
          min={1}
          max={52}
          value={keepWeeks}
          onChange={(v) => setKeepWeeks(Number(v) || 1)}
          addonAfter="周"
          style={{ width: 160 }}
        />
      </Modal>
    </PageShell>
  );
}
