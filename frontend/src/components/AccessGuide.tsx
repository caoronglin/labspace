import { Card, Flex, Tag, Typography, theme } from 'antd';
import { WifiOutlined } from '@ant-design/icons';
import { currentHost, hostUrl } from '../utils/host';

const IP_ENTRIES: { name: string; url: string }[] = [
  { name: '门户首页', url: hostUrl('/') },
  { name: '统一认证', url: hostUrl('/', 8090) },
  { name: '统一搜索', url: '/search' },
  { name: '文件管理', url: '/files' },
  { name: '公共基因组', url: '/genomes' },
  { name: '生信实训', url: '/bioinfo' },
  { name: '文件工坊', url: '/snapotter' },
  { name: '绘图', url: '/drawio' },
  { name: '图纸平台', url: hostUrl('/', 8093) },
  { name: 'Linux 命令', url: '/commands' },
  { name: '植物数据库', url: '/databases' },
];

/** 两个入口主机：内网 LAN 与 Tailscale，端口完全一致。 */
const ENTRY_HOSTS = ['192.0.2.10', '198.51.100.71'];

/** 访问入口：192.0.2.10 + 端口 */
export default function AccessGuide() {
  const { token } = theme.useToken();

  return (
    <Card
      size="small"
      title={
        <Flex align="center" gap={6}>
          <WifiOutlined style={{ color: token.colorSuccess }} />
          服务入口
        </Flex>
      }
      style={{ margin: '0 auto 24px', maxWidth: 880, width: '100%' }}
    >
      <Flex gap={8} wrap>
        {IP_ENTRIES.map((e) => (
          <a key={e.url} href={e.url} target="_blank" rel="noreferrer noopener">
            <Tag variant="filled" color="blue" style={{ cursor: 'pointer', padding: '3px 10px', fontSize: 12.5 }}>
              {e.name}
            </Tag>
          </a>
        ))}
      </Flex>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
        当前入口 {currentHost()}（内网 LAN / Tailscale 两个入口端口完全一致，链接自动跟随当前入口）：
        {ENTRY_HOSTS.map((h) => `http://${h}`).join('　')}
      </Typography.Text>
    </Card>
  );
}
