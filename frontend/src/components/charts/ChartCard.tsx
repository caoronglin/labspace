/**
 * 图表卡片统一封装
 *
 * 职责（一个图只表达一件事）：
 * - Card + 标题 + 说明 + 右侧额外操作
 * - 三态：加载中（Skeleton）/ 空数据（Empty「暂无数据」）/ 请求失败（Alert + 重试）
 * - 可访问性兜底：图表下方的「数据表格」折叠区（等价数据，便于读屏与复制）
 */
import type { ReactNode } from 'react';
import { Alert, Button, Card, Collapse, Empty, Skeleton, Table, Typography } from 'antd';
import type { TableColumnsType } from 'antd';

export interface ChartTable {
  columns: TableColumnsType<Record<string, unknown>>;
  rows: Record<string, unknown>[];
  /** 表格上方的补充说明 */
  caption?: ReactNode;
}

export interface ChartCardProps {
  title: string;
  /** 图表说明（一句话说明这个图表达什么） */
  description?: ReactNode;
  /** 卡片右上角操作 */
  extra?: ReactNode;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** 是否为空数据 */
  empty?: boolean;
  emptyText?: string;
  /** 等价数据表格（可访问性兜底） */
  table?: ChartTable;
  children?: ReactNode;
}

export default function ChartCard({
  title,
  description,
  extra,
  loading = false,
  error,
  onRetry,
  empty = false,
  emptyText = '暂无数据',
  table,
  children,
}: ChartCardProps) {
  const hasError = !!error;
  const showSkeleton = !hasError && loading;
  const showEmpty = !hasError && !loading && empty;

  return (
    <Card size="small" title={title} extra={extra} styles={{ body: { padding: '12px 16px 16px' } }}>
      {description ? (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '0 0 8px' }}>
          {description}
        </Typography.Paragraph>
      ) : null}

      {hasError ? (
        <Alert
          type="error"
          showIcon
          title="数据加载失败"
          description={error instanceof Error ? error.message : '请稍后重试'}
          action={
            onRetry ? (
              <Button size="small" onClick={onRetry}>
                重试
              </Button>
            ) : undefined
          }
        />
      ) : showSkeleton ? (
        <Skeleton active paragraph={{ rows: 3 }} />
      ) : showEmpty ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />
      ) : (
        children
      )}

      {table && !hasError && !showSkeleton ? (
        <Collapse
          ghost
          size="small"
          style={{ marginTop: 8 }}
          items={[
            {
              key: 'table',
              label: '查看数据表格',
              children: (
                <>
                  {table.caption ? (
                    <Typography.Paragraph type="secondary" style={{ fontSize: 11.5, margin: '0 0 8px' }}>
                      {table.caption}
                    </Typography.Paragraph>
                  ) : null}
                  <Table
                    size="small"
                    rowKey={(_, index) => String(index)}
                    columns={table.columns}
                    dataSource={table.rows}
                    pagination={false}
                    scroll={{ x: 'max-content' }}
                  />
                </>
              ),
            },
          ]}
        />
      ) : null}
    </Card>
  );
}
