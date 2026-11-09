import { useMemo, useState, type ReactNode } from 'react';
import { Button, Card, Flex, Input, Segmented, Space, Tooltip, Typography } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import type { TableProps } from 'antd/es/table';
import Table from 'antd/es/table';

type Size = 'small' | 'middle' | 'large';

/**
 * ProTable 风格的卡片表格：标题栏 + 关键词检索 + 密度切换 + 刷新 + 右对齐操作区。
 * 本地过滤只用于已经完整加载到前端的列表，分页/远程检索请直接用 Table。
 */
export default function ProTableCard<T extends object>({
  title,
  description,
  extra,
  toolbar,
  searchable = true,
  searchPlaceholder = '搜索',
  searchText,
  dataSource,
  onRefresh,
  refreshLoading,
  ...tableProps
}: {
  title: ReactNode;
  description?: ReactNode;
  extra?: ReactNode;
  toolbar?: ReactNode;
  searchable?: boolean;
  searchPlaceholder?: string;
  /** 参与关键词匹配的文本；默认拼接记录里的字符串字段 */
  searchText?: (row: T) => string;
  dataSource?: T[];
  onRefresh?: () => void;
  refreshLoading?: boolean;
} & Omit<TableProps<T>, 'title' | 'dataSource' | 'size' | 'pagination'> & {
    pagination?: TableProps<T>['pagination'];
  }) {
  const [q, setQ] = useState('');
  const [density, setDensity] = useState<Size>('middle');

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle || !dataSource) return dataSource;
    const text = searchText ?? ((row: T) => Object.values(row as Record<string, unknown>).map(String).join(' '));
    return dataSource.filter((row) => text(row).toLowerCase().includes(needle));
  }, [q, dataSource, searchText]);

  return (
    <Card
      variant="borderless"
      style={{ boxShadow: '0 1px 2px rgba(15,23,42,0.06)' }}
      styles={{ body: { paddingTop: 4 } }}
      title={
        <Flex vertical gap={2}>
          <Typography.Text strong>{title}</Typography.Text>
          {description ? (
            <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
              {description}
            </Typography.Text>
          ) : null}
        </Flex>
      }
      extra={
        <Space wrap size={8}>
          {toolbar}
          {searchable ? (
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder={searchPlaceholder}
              style={{ width: 210 }}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          ) : null}
          <Tooltip title="表格密度">
            <Segmented
              size="small"
              value={density ?? 'middle'}
              onChange={(v) => setDensity(v as Size)}
              options={[
                { value: 'small', label: '紧凑' },
                { value: 'middle', label: '默认' },
                { value: 'large', label: '宽松' },
              ]}
            />
          </Tooltip>
          {onRefresh ? (
            <Tooltip title="刷新">
              <Button size="small" icon={<ReloadOutlined />} loading={refreshLoading} onClick={onRefresh} />
            </Tooltip>
          ) : null}
          {extra}
        </Space>
      }
    >
      <Table<T>
        {...tableProps}
        size={density}
        dataSource={rows}
        pagination={
          tableProps.pagination === false
            ? false
            : {
                pageSize: 10,
                showSizeChanger: true,
                showTotal: (total) => `共 ${total} 条`,
                ...(tableProps.pagination ?? {}),
              }
        }
      />
    </Card>
  );
}