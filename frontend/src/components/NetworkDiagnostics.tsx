import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Flex, Tag, Typography, theme } from 'antd';
import { CheckCircleFilled, WarningFilled } from '@ant-design/icons';
import { currentHost } from '../utils/host';

interface Entry {
  name: string;
  url: string;
  up: boolean;
  detail: string;
}

/** 服务入口自检：当前访问主机上的同源路径，不使用独立端口 */
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
        title={`服务入口（${currentHost()} 同源路径）`}
        description={
          <Typography.Text style={{ fontSize: 13 }}>
            全部服务均通过 <b>{currentHost()}</b> 的同源路径访问，<b>不再使用 IP + 独立端口</b>，
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
            1. 所有入口都通过门户同源路径访问，<b>不需要 DNS、hosts 或独立服务端口</b>。
          </Typography.Text>
          <Typography.Text style={{ fontSize: 12.5 }}>
            2. 统一认证由门户自身提供，登录与登出均在同源路径完成，不再跳转独立认证端口。
          </Typography.Text>
          <Typography.Text style={{ fontSize: 12.5 }}>
            3. 入口自适应：当前入口 <b>{currentHost()}</b>；若经 Tailscale 访问，同源路径会自动跟随当前主机。
          </Typography.Text>
        </Flex>
      </Card>
    </Flex>
  );
}