import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Flex, Tag, Typography, theme } from 'antd';
import { CheckCircleFilled, WarningFilled } from '@ant-design/icons';
import { currentHost, hostUrl } from '../utils/host';

interface Entry {
  name: string;
  url: string;
  up: boolean;
  detail: string;
}

/** 服务入口自检：当前访问主机 + 端口，不使用任何域名 */
export default function NetworkDiagnostics() {
  const { token } = theme.useToken();
  const { data, isLoading } = useQuery({
    queryKey: ['network-entries'],
    queryFn: async () => {
      const r = await fetch('/api/network/entries', { credentials: 'include' });
      if (!r.ok) throw new Error('自检失败');
      return (await r.json()) as { items: Entry[]; host: string };
    },
    staleTime: 30_000,
    retry: false,
  });

  const items = data?.items ?? [];
  const down = items.filter((i) => !i.up);

  return (
    <Flex vertical gap={16}>
      <Alert
        type={down.length === 0 && items.length > 0 ? 'success' : 'warning'}
        showIcon
        icon={down.length === 0 ? <CheckCircleFilled /> : <WarningFilled />}
        title={`服务入口（${currentHost()} + 端口）`}
        description={
          <Typography.Text style={{ fontSize: 13 }}>
            全部服务均以 <b>{currentHost()} + 端口</b> 对外，<b>不使用任何域名</b>，
            客户端无需 DNS 解析、也无需任何 hosts 配置；
            <b>入口自适应</b>：从哪个地址进入，下列所有服务就用同一个地址。
            {isLoading ? '正在自检…' : down.length === 0 ? '当前全部入口探测正常。' : `当前 ${down.length} 个入口异常。`}
          </Typography.Text>
        }
      />

      <Card size="small" title="入口清单" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>实时探测</Typography.Text>}>
        <Flex vertical gap={8}>
          {items.map((i) => (
            <Flex key={i.url} gap={10} align="center" wrap>
              {i.up ? (
                <CheckCircleFilled style={{ color: token.colorSuccess }} />
              ) : (
                <WarningFilled style={{ color: token.colorError }} />
              )}
              <Typography.Text style={{ width: 190 }}>{i.name}</Typography.Text>
              <a href={i.url} target="_blank" rel="noreferrer noopener">
                <Typography.Text style={{ color: token.colorInfo }}>{i.url}</Typography.Text>
              </a>
              <Tag variant="filled" color={i.up ? 'green' : 'red'} style={{ fontSize: 11 }}>
                {i.detail}
              </Tag>
            </Flex>
          ))}
        </Flex>
      </Card>

      <Card size="small" title="使用说明">
        <Flex vertical gap={4} style={{ width: '100%' }}>
          <Typography.Text style={{ fontSize: 12.5 }}>
            1. 所有入口都以 IP + 端口访问，<b>不需要 DNS，不需要 hosts，不需要改路由器设置</b>。
          </Typography.Text>
          <Typography.Text style={{ fontSize: 12.5 }}>
            2. 统一认证固定在 <b>{hostUrl('/', 8090)}</b>，门户登录跳转均指向该地址。
          </Typography.Text>
          <Typography.Text style={{ fontSize: 12.5 }}>
            3. 入口自适应：当前入口 <b>{currentHost()}</b>；若经 Tailscale 访问则自动切换为 Tailscale 地址，端口完全一致，无需任何配置。
          </Typography.Text>
        </Flex>
      </Card>
    </Flex>
  );
}