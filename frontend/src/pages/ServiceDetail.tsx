import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Alert, Button, Flex, Result, Space, Spin, Tag, Typography } from 'antd';
import { useQuery, useMutation } from '@tanstack/react-query';
import { ArrowLeftOutlined, ExportOutlined, StarFilled, StarOutlined } from '@ant-design/icons';
import { api } from '../services/api';
import { nativeRouteOf } from '../utils/serviceRoute';
import { CATEGORY_LABEL } from '../components/ServiceCard';
import EmbedFrame from '../components/EmbedFrame';
import SsoButton from '../components/SsoButton';
import { tokens } from '../theme/tokens';

export default function ServiceDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();

  const { data: servicesData, isLoading } = useQuery({ queryKey: ['services'], queryFn: api.services, staleTime: 60_000 });
  const { data: favData } = useQuery({ queryKey: ['favorites'], queryFn: api.favorites, staleTime: 30_000 });
  const { data: health } = useQuery({
    queryKey: ['service-health', id],
    queryFn: () => api.serviceHealth(id),
    enabled: !!id,
    staleTime: 30_000,
  });
  const favMutation = useMutation({
    mutationFn: ({ sid, on }: { sid: string; on: boolean }) => (on ? api.addFavorite(sid) : api.removeFavorite(sid)),
  });
  const { data: embedInfo } = useQuery({
    queryKey: ['service-embed', id],
    queryFn: () => api.serviceEmbed(id),
    enabled: !!id,
    staleTime: 300_000,
    retry: 0,
  });

  const service = (servicesData?.services ?? []).find((s) => s.id === id);
  // 站内已原生实现的服务不再停留在这层「详情」页，直接跳到原生页面
  const nativeRoute = nativeRouteOf(service);
  useEffect(() => {
    if (nativeRoute) navigate(nativeRoute, { replace: true });
  }, [nativeRoute, navigate]);

  if (isLoading || nativeRoute) {
    return (
      <Flex justify="center" style={{ padding: 80 }}>
        <Spin />
      </Flex>
    );
  }

  if (!service) {
    return <Result status="404" title="服务不存在" subTitle="该服务可能未授权或已下线" />;
  }

  const favorited = (favData?.favorites ?? []).includes(service.id);

  const open = () => {
    // 记录最近访问（真实数据，供首页“最近访问”使用）
    void api.touchRecent(service.id);
    // 带 OIDC 的服务直接打开其登录启动端点，复用门户已建立的 Casdoor 会话
    window.open(service.ssoUrl || service.url, '_blank', 'noopener');
  };

  const embedSrc = service.embedUrl || service.url;
  const canEmbed = !!service.embed && embedInfo?.embeddable === true;
  const healthLabel =
    health?.status === 'up' ? '正常' : health?.status === 'down' ? '不可用' : health?.status === 'external-down' ? '外部离线' : '未知';

  return (
    <Flex vertical gap={12}>
      <Flex align="center" justify="space-between" gap={12} wrap>
        <Flex align="center" gap={10} style={{ minWidth: 0 }}>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)} aria-label="返回" />
          <div style={{ minWidth: 0 }}>
            <Typography.Title level={4} style={{ margin: 0, fontSize: 18 }}>
              {service.name}
            </Typography.Title>
            <Typography.Text type="secondary" ellipsis style={{ display: 'block', maxWidth: 720, fontSize: 13 }}>
              {service.description}
            </Typography.Text>
          </div>
          <Space size={6} wrap>
            <Tag color="blue" variant="filled">
              {CATEGORY_LABEL[service.category] ?? service.category}
            </Tag>
            {service.tags.map((t) => (
              <Tag key={t} variant="filled">
                {t}
              </Tag>
            ))}
            <Tag color={health?.status === 'up' ? 'green' : health?.status === 'unknown' ? 'default' : 'red'} variant="filled">
              {healthLabel}
              {health?.latency_ms != null ? ` · ${health.latency_ms}ms` : ''}
            </Tag>
          </Space>
        </Flex>
        <Space wrap>
          <Button type="primary" icon={<ExportOutlined />} onClick={open}>
            打开服务
          </Button>
          {service.ssoUrl ? <SsoButton ssoUrl={service.ssoUrl} serviceId={service.id} size="middle" /> : null}
          <Button
            icon={favorited ? <StarFilled style={{ color: tokens.colorWarning }} /> : <StarOutlined />}
            onClick={() => favMutation.mutate({ sid: service.id, on: !favorited })}
          >
            {favorited ? '已收藏' : '收藏'}
          </Button>
        </Space>
      </Flex>

      {/* 单一服务直接内嵌展示，不再套一层卡片 */}
      {canEmbed ? (
        <EmbedFrame src={embedSrc} title={service.name} height="calc(100vh - 230px)" />
      ) : (
        <Alert
          type="info"
          showIcon
          title="该服务未提供内嵌入口"
          description={
            service.embed
              ? `服务端探测结果：${embedInfo?.reason ?? '检测中…'}。点击右上角「打开服务」在新标签页使用。`
              : '点击右上角「打开服务」在新标签页使用。'
          }
        />
      )}

      {service.guide.length > 0 ? (
        <details>
          <summary style={{ cursor: 'pointer', color: 'var(--d509-text-secondary)' }}>使用指南</summary>
          <ul style={{ paddingInlineStart: 18, margin: '8px 0 0', color: 'var(--d509-text-secondary)' }}>
            {service.guide.map((g) => (
              <li key={g} style={{ marginBottom: 4 }}>
                {g}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Flex>
  );
}
