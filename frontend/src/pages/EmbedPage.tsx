import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Flex, Result, Space, Spin, Tag, Typography } from 'antd';
import { ArrowLeftOutlined, ExportOutlined } from '@ant-design/icons';
import { api, type ServiceItem } from '../services/api';
import EmbedFrame from '../components/EmbedFrame';
import SsoButton from '../components/SsoButton';

const CATEGORY_LABEL: Record<string, string> = {
  ai: 'AI 与对话',
  research: '科研分析',
  dev: '开发工具',
  learn: '学习工具',
  draw: '图纸绘图',
  office: '办公协同',
  external: '外部系统',
};

/** 上游应用无中文包时，门户提供中文操作指引 */
const GUIDE: Record<string, string[]> = {
  drawio: [
    '左侧为图形面板，拖拽图形到中间画布即可绘图。',
    '右侧为格式面板，可调整样式；顶部菜单支持撤销、重做与导出。',
    '保存后图形会存入你的账号，可在「流程图设计」页的「我的图形」面板里查看。',
  ],
  'linux-command': [
    '顶部搜索框输入关键字过滤命令。',
    '点击列表项展开该命令的中文说明、参数与示例。',
  ],
  jbrowse: [
    '顶部菜单：文件 / 添加 / 工具 / 帮助 / 共享。',
    '下方为参考序列与轨道区域，滚轮缩放、拖拽平移。',
    '「添加」菜单可添加新的视图与轨道，「共享」可导出会话链接。',
  ],
};

/**
 * 服务内嵌页（/embed/:id）。
 *
 * 流程：
 * 1. 取服务元数据与内嵌可行性（服务端依据 X-Frame-Options / CSP frame-ancestors 判定）。
 * 2. 可嵌入 → 直接内嵌；不可嵌入 → 给出「在新窗口打开」与「一键登录」两条回退路径。
 */
export default function EmbedPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();

  const serviceQuery = useQuery({
    queryKey: ['services'],
    queryFn: api.services,
    staleTime: 60_000,
  });

  const service: ServiceItem | undefined = useMemo(
    () => serviceQuery.data?.services?.find((s) => s.id === id),
    [serviceQuery.data, id],
  );

  const embedQuery = useQuery({
    queryKey: ['service-embed', id],
    queryFn: () => api.serviceEmbed(id),
    enabled: Boolean(id),
    retry: 0,
  });

  if (serviceQuery.isLoading) {
    return (
      <Flex align="center" justify="center" style={{ minHeight: 320 }}>
        <Spin size="large" description="正在加载服务信息…" />
      </Flex>
    );
  }

  if (!service) {
    return <Result status="404" title="服务不存在" subTitle={`未找到 id 为 ${id} 的服务`} />;
  }

  const embed = embedQuery.data;
  const target = embed?.url || service.embedUrl || service.url;

  return (
    <Flex vertical gap={16}>
      <Card size="small" styles={{ body: { padding: 16 } }}>
        <Flex align="center" justify="space-between" gap={12} wrap>
          <Flex align="center" gap={12} style={{ minWidth: 0 }}>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)}>
              返回
            </Button>
            <div style={{ minWidth: 0 }}>
              <Typography.Title level={5} style={{ margin: 0, fontSize: 16 }}>
                {service.name}
              </Typography.Title>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {CATEGORY_LABEL[service.category] ?? service.category} · {service.description}
              </Typography.Text>
            </div>
          </Flex>
          <Space wrap>
            {service.ssoUrl ? <SsoButton ssoUrl={service.ssoUrl} serviceId={service.id} size="middle" /> : null}
            <Button
              type={service.ssoUrl ? 'default' : 'primary'}
              icon={<ExportOutlined />}
              onClick={() => window.open(target, '_blank', 'noopener')}
            >
              在新窗口打开
            </Button>
          </Space>
        </Flex>
      </Card>

      {embedQuery.isLoading ? (
        <Card size="small">
          <Flex align="center" justify="center" style={{ minHeight: 200 }}>
            <Spin description="正在检测嵌入策略…" />
          </Flex>
        </Card>
      ) : embedQuery.isError ? (
        <Alert type="warning" showIcon title="无法检测内嵌策略" description={String((embedQuery.error as Error)?.message ?? '')} />
      ) : embed?.embeddable ? (
        <Flex vertical gap={12}>
          {service.langNote ? (
            <Alert type="info" showIcon title="界面语言说明" description={service.langNote} />
          ) : null}
          <EmbedFrame src={target} title={service.name} />
          {GUIDE[id] ? (
            <Card size="small" title="中文操作指引">
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {GUIDE[id].map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </Card>
          ) : null}
        </Flex>
      ) : (
        <Result
          status="warning"
          title="该服务不允许被嵌入"
          subTitle={embed?.reason || '目标站点通过 X-Frame-Options / CSP 禁止了第三方页面嵌入。'}
          extra={
            <Space wrap>
              <Button type="primary" icon={<ExportOutlined />} onClick={() => window.open(target, '_blank', 'noopener')}>
                在新窗口打开
              </Button>
              {service.ssoUrl ? <SsoButton ssoUrl={service.ssoUrl} serviceId={service.id} size="large" label="一键登录并使用" /> : null}
            </Space>
          }
        >
          {embed?.evidence ? (
            <Space orientation="vertical" size={4}>
              <Typography.Text type="secondary">探测证据：</Typography.Text>
              <Tag>{embed.evidence}</Tag>
              <Typography.Text type="secondary">检测时间：{embed.checked_at}</Typography.Text>
            </Space>
          ) : null}
        </Result>
      )}
    </Flex>
  );
}
