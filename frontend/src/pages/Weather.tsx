import { lazy, Suspense, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Flex,
  Input,
  Row,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
  theme,
} from 'antd';
import { CloudOutlined, EnvironmentOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { api } from '../services/api';
import { tokens } from '../theme/tokens';

dayjs.locale('zh-cn');

/* 图表懒加载：@ant-design/plots 不进入天气页首屏 chunk */
const WeatherTrendChart = lazy(() => import('../components/charts/WeatherTrendChart'));

/** 表头统一字重 600（不用斑马纹，靠留白与字重建立层次） */
const head = (text: string) => <span style={{ fontWeight: 600 }}>{text}</span>;

export default function Weather() {
  const [city, setCity] = useState('');
  const [submitted, setSubmitted] = useState('');
  const { token } = theme.useToken();

  const query = useQuery({
    queryKey: ['weather', submitted],
    queryFn: () => api.weather(submitted),
    staleTime: 30_000,
    retry: false,
  });

  const report = query.data;
  const cur = report?.current;

  const runSearch = () => setSubmitted(city.trim());

  const dailyRows = (report?.daily ?? []).map((d) => ({
    key: d.date,
    date: d.date,
    weekday: dayjs(d.date).format('ddd'),
    description: d.description,
    range: d.max != null && d.min != null ? `${Math.round(d.max)} ~ ${Math.round(d.min)}` : '-',
    precipitation: d.precipitation,
    precipitationProbability: d.precipitationProbability,
  }));

  const rainy = dailyRows.some((d) => (d.precipitation ?? 0) > 0);

  return (
    <Flex vertical gap={16}>
      <Flex align="center" justify="space-between" wrap gap={8}>
        <Typography.Title level={3} style={{ margin: 0, fontSize: 22 }}>
          <Space>
            <CloudOutlined style={{ color: tokens.colorAccent }} />
            天气
          </Space>
        </Typography.Title>
        {report && (
          <Space wrap>
            <Tag icon={<EnvironmentOutlined />} variant="filled">
              {report.source}
            </Tag>
            {rainy ? (
              <Tag color="warning" variant="filled">
                未来 7 天有降水
              </Tag>
            ) : (
              <Tag color="success" variant="filled">
                未来 7 天无降水
              </Tag>
            )}
            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              更新时间：{dayjs(report.updated_at).format('YYYY-MM-DD HH:mm')}
            </Typography.Text>
          </Space>
        )}
      </Flex>

      <Card size="small">
        <Flex gap={8} align="center" wrap>
          <Input
            style={{ width: 260 }}
            value={city}
            onChange={(e) => setCity(e.target.value)}
            onPressEnter={runSearch}
            placeholder="城市名称，例如 北京"
            allowClear
            aria-label="城市名称"
          />
          <Button type="primary" icon={<SearchOutlined />} onClick={runSearch} loading={query.isFetching}>
            查询
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => query.refetch()} loading={query.isFetching}>
            刷新
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            留空则使用服务器默认城市
          </Typography.Text>
        </Flex>
      </Card>

      {query.isLoading && (
        <Card size="small">
          <Skeleton active paragraph={{ rows: 4 }} />
        </Card>
      )}

      {query.isError && (
        <Alert
          type="error"
          showIcon
          title="天气数据获取失败"
          description={(query.error as Error)?.message || '无法获取天气数据'}
          action={
            <Button size="small" onClick={() => query.refetch()}>
              重试
            </Button>
          }
        />
      )}

      {report && (
        <Row gutter={[16, 16]} align="stretch">
          <Col xs={24} lg={10}>
            <Card
              size="small"
              title={report.city}
              style={{ height: '100%' }}
              styles={{ body: { height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' } }}
            >
              <Flex vertical gap={16} align="center">
                <Typography.Title level={2} style={{ margin: 0, fontSize: 48, lineHeight: 1.1 }}>
                  {cur?.temperature != null ? `${Math.round(cur.temperature)}℃` : '--℃'}
                </Typography.Title>
                <Typography.Text style={{ fontSize: 16 }}>{cur?.description || '暂无描述'}</Typography.Text>
                <Flex gap={8} wrap justify="center">
                  {cur?.apparent != null && <Tag variant="filled">体感 {Math.round(cur.apparent)}℃</Tag>}
                  {cur?.humidity != null && <Tag variant="filled">湿度 {cur.humidity}%</Tag>}
                  {cur?.wind != null && <Tag variant="filled">风速 {cur.wind} km/h</Tag>}
                </Flex>
                <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM, textAlign: 'center' }}>
                  {[report.admin, report.country].filter(Boolean).join(' · ')}
                  {report.timezone ? ` · 时区 ${report.timezone}` : ''}
                </Typography.Text>
              </Flex>
            </Card>
          </Col>

          <Col xs={24} lg={14}>
            <Card size="small" title="未来 7 天">
              {dailyRows.length === 0 ? (
                <Empty description="暂无逐日预报" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ) : (
                <Table
                  size="small"
                  pagination={false}
                  rowKey="key"
                  dataSource={dailyRows}
                  scroll={{ x: 620 }}
                  columns={[
                    {
                      title: head('日期'),
                      dataIndex: 'date',
                      render: (_: unknown, row: (typeof dailyRows)[number]) => (
                        <Space size={6}>
                          <span>{dayjs(row.date).format('MM-DD')}</span>
                          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                            {row.weekday}
                          </Typography.Text>
                        </Space>
                      ),
                    },
                    {
                      title: head('天气'),
                      dataIndex: 'description',
                      render: (v: string) => v || '-',
                    },
                    {
                      title: head('最高 ~ 最低'),
                      dataIndex: 'range',
                      render: (v: string) => v,
                    },
                    {
                      title: head('降水概率'),
                      dataIndex: 'precipitationProbability',
                      render: (v: number | null) => (v == null ? '-' : `${v}%`),
                    },
                    {
                      title: head('降水量'),
                      dataIndex: 'precipitation',
                      render: (v: number | null) => (v == null ? '-' : `${v} mm`),
                    },
                  ]}
                />
              )}
            </Card>
          </Col>
        </Row>
      )}

      {report && dailyRows.length > 0 && (
        <Suspense
          fallback={
            <Card size="small">
              <Skeleton active paragraph={{ rows: 4 }} />
            </Card>
          }
        >
          <WeatherTrendChart daily={report.daily} />
        </Suspense>
      )}
    </Flex>
  );
}
