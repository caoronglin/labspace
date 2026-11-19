/**
 * 个人工作台 · 简报与趋势页签
 *
 * 信息层级按「趋势概览 → 简报时间线」两段式组织：
 * - 趋势概览：来自 GET /api/workbench/summary 的统计口径（进行中任务 / 本周完成 / 进行中项目 / 收件箱）；
 * - 简报时间线：来自 GET /api/workbench/briefs，每条可展开全文。
 *
 * 只读说明：后端存在 POST /api/workbench/briefs，但前端 services/api.ts 目前
 * 只提供 workbenchBriefs() 读取方法，没有封装创建方法；本组件不新增接口，
 * 因此简报区为只读展示，不提供「生成简报」表单。
 */
import { useMemo } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Empty,
  Flex,
  Grid,
  Row,
  Skeleton,
  Statistic,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from 'antd';
import { FileTextOutlined, LineChartOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api, type WorkbenchBrief } from '../../services/api';
import { errText } from '../../utils/err';

/* ------------------------------------------------------------------ 工具 */

/** 从简报 payload 中取出关联项目名（payload 为自由字典，做安全收敛） */
function payloadProjects(payload: Record<string, unknown> | undefined): string[] {
  if (!payload) return [];
  const raw = payload.projects;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      names.push(item);
      continue;
    }
    if (item && typeof item === 'object') {
      const name = (item as Record<string, unknown>).name;
      if (typeof name === 'string' && name.trim()) names.push(name.trim());
    }
  }
  return names;
}

/** 简报标题：按日期生成，日期缺失时退化为「未标注日期」 */
const briefTitle = (brief: WorkbenchBrief, index: number) =>
  brief.date ? `简报 · ${dayjs(brief.date).format('YYYY-MM-DD')}` : `简报 ${index + 1}`;

/* ------------------------------------------------------------------ 主体 */

export default function BriefPanel() {
  const screens = Grid.useBreakpoint();
  const narrow = !screens.md;

  const briefsQuery = useQuery({
    queryKey: ['workbench-briefs'],
    queryFn: api.workbenchBriefs,
    staleTime: 60_000,
  });

  const summaryQuery = useQuery({
    queryKey: ['workbench-summary'],
    queryFn: api.workbenchSummary,
    staleTime: 30_000,
  });

  const briefs = useMemo(() => briefsQuery.data?.briefs ?? [], [briefsQuery.data]);
  const loading = briefsQuery.isLoading && !briefsQuery.data;
  const briefsError = briefsQuery.error as Error | null;
  const summaryError = summaryQuery.error as Error | null;

  const stats = summaryQuery.data?.stats;

  /** 近 7 天里每天的简报条数（按日期倒序） */
  const recentDays = useMemo(() => {
    const counter = new Map<string, number>();
    for (const brief of briefs) {
      if (!brief.date) continue;
      const key = dayjs(brief.date).format('YYYY-MM-DD');
      counter.set(key, (counter.get(key) ?? 0) + 1);
    }
    return [...counter.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 7);
  }, [briefs]);

  /* ------------------------------------------------------- 渲染 */

  const renderBrief = (brief: WorkbenchBrief, index: number) => {
    const content = brief.content ?? '';
    const projects = payloadProjects(brief.payload);
    return (
      <Flex vertical gap={6} style={{ minWidth: 0 }}>
        <Flex gap={8} align="center" wrap>
          <Typography.Text strong style={{ fontSize: 13.5 }}>
            {briefTitle(brief, index)}
          </Typography.Text>
          {projects.map((name) => (
            <Tag key={name} color="blue" variant="filled" style={{ margin: 0 }}>
              {name}
            </Tag>
          ))}
        </Flex>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {brief.date ? dayjs(brief.date).format('YYYY-MM-DD HH:mm') : '未标注时间'}
        </Typography.Text>

        {content ? (
          <Tooltip title={content}>
            <Typography.Paragraph
              type="secondary"
              style={{ margin: 0, fontSize: 12.5 }}
              ellipsis={{ rows: narrow ? 2 : 3 }}
            >
              {content}
            </Typography.Paragraph>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
            这条简报没有正文
          </Typography.Text>
        )}

        <Collapse
          ghost
          size="small"
          items={[
            {
              key: 'full',
              label: (
                <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                  查看全文
                </Typography.Text>
              ),
              children: (
                <Typography.Paragraph
                  style={{
                    margin: 0,
                    fontSize: 12.5,
                    lineHeight: 1.8,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {content || '（无正文）'}
                </Typography.Paragraph>
              ),
            },
          ]}
        />
      </Flex>
    );
  };

  return (
    <Flex vertical gap={16}>
      {/* ------------------------------------------------ 错误态 */}
      {briefsError ? (
        <Alert
          type="error"
          showIcon
          variant="filled"
          title="简报加载失败"
          description={errText(briefsError, 120)}
          action={
            <Button size="small" type="primary" onClick={() => void briefsQuery.refetch()}>
              重试
            </Button>
          }
        />
      ) : null}

      {summaryError ? (
        <Alert
          type="error"
          showIcon
          variant="filled"
          title="概览数据加载失败"
          description={errText(summaryError, 120)}
          action={
            <Button size="small" type="primary" onClick={() => void summaryQuery.refetch()}>
              重试
            </Button>
          }
        />
      ) : null}

      {/* ------------------------------------------------ 趋势概览 */}
      <Row gutter={[16, 16]} align="stretch">
        <Col xs={24} xl={16}>
          <Card
            size="small"
            title={
              <Flex gap={8} align="center">
                <LineChartOutlined /> 趋势概览
              </Flex>
            }
            variant="outlined"
            className="d509-card"
            style={{ height: '100%' }}
          >
            {summaryQuery.isLoading && !summaryQuery.data ? (
              <Skeleton active paragraph={{ rows: 2 }} />
            ) : (
              <Flex gap={24} align="center" wrap>
                <Statistic
                  title="进行中任务"
                  value={stats?.activeTasks ?? 0}
                  styles={{ content: { fontSize: 22 } }}
                />
                <Statistic
                  title="本周已完成"
                  value={stats?.completedThisWeek ?? 0}
                  styles={{ content: { fontSize: 22 } }}
                />
                <Statistic
                  title="进行中项目"
                  value={stats?.activeProjects ?? 0}
                  styles={{ content: { fontSize: 22 } }}
                />
                <Statistic
                  title="收件箱"
                  value={stats?.inbox ?? 0}
                  styles={{ content: { fontSize: 22 } }}
                />
              </Flex>
            )}
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card
            size="small"
            title="近期节奏"
            variant="outlined"
            className="d509-card"
            style={{ height: '100%' }}
          >
            {loading ? (
              <Skeleton active paragraph={{ rows: 2 }} />
            ) : recentDays.length === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                近期还没有简报记录
              </Typography.Text>
            ) : (
              <Flex gap={8} wrap>
                {recentDays.map(([date, count]) => (
                  <Tag key={date} color={count > 1 ? 'blue' : 'default'} style={{ margin: 0 }}>
                    {date} · {count} 条
                  </Tag>
                ))}
              </Flex>
            )}
          </Card>
        </Col>
      </Row>

      {/* ------------------------------------------------ 简报时间线 */}
      <Card
        size="small"
        title={
          <Flex gap={8} align="center">
            <FileTextOutlined /> 简报流
          </Flex>
        }
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            共 {briefs.length} 条
          </Typography.Text>
        }
        variant="outlined"
        className="d509-card"
      >
        <Alert
          type="info"
          showIcon
          variant="filled"
          style={{ marginBottom: 12 }}
          title="只读视图"
          description="简报由后端每日生成并落库；前端接口层目前只有读取方法 workbenchBriefs()，未提供创建方法，因此这里不提供「生成简报」表单。"
        />

        {loading ? (
          <Skeleton active paragraph={{ rows: 5 }} />
        ) : briefs.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="还没有简报，明天再来看看"
            styles={{ image: { height: 48 } }}
          />
        ) : (
          <Timeline
            items={briefs.map((brief, index) => ({
              key: brief.date ?? `brief-${index}`,
              color: index === 0 ? '#2B5CE6' : 'var(--ant-color-border, #E6E9EF)',
              children: renderBrief(brief, index),
            }))}
          />
        )}
      </Card>
    </Flex>
  );
}
