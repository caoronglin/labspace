import { Badge, Button, Card, Flex, Space, Tag, Tooltip, Typography, theme } from 'antd';
import {
  AppstoreOutlined,
  BookOutlined,
  CloudServerOutlined,
  CodeOutlined,
  ConsoleSqlOutlined,
  FilePdfOutlined,
  FileSearchOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  PartitionOutlined,
  RobotOutlined,
  StarFilled,
  StarOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api, type ServiceItem } from '../services/api';
import { nativeRouteOf } from '../utils/serviceRoute';

const ICONS: Record<string, React.ReactNode> = {
  RobotOutlined: <RobotOutlined />,
  FolderOpenOutlined: <FolderOpenOutlined />,
  PartitionOutlined: <PartitionOutlined />,
  ConsoleSqlOutlined: <ConsoleSqlOutlined />,
  ToolOutlined: <ToolOutlined />,
  BookOutlined: <BookOutlined />,
  FilePdfOutlined: <FilePdfOutlined />,
  FileSearchOutlined: <FileSearchOutlined />,
  GlobalOutlined: <GlobalOutlined />,
  CodeOutlined: <CodeOutlined />,
  AppstoreOutlined: <AppstoreOutlined />,
  CloudServerOutlined: <CloudServerOutlined />,
};

export const CATEGORY_LABEL: Record<string, string> = {
  ai: 'AI',
  files: '文件',
  research: '科研',
  learn: '学习',
  draw: '绘图',
  dev: '开发工具',
};

/** 健康状态 → 语义 Badge（success / error / default），不再写死色值 */
const HEALTH_BADGE = {
  up: { status: 'success' as const, label: '正常' },
  down: { status: 'error' as const, label: '不可用' },
  default: { status: 'default' as const, label: '状态未知' },
};

export default function ServiceCard({
  service,
  favorited,
  onToggleFavorite,
}: {
  service: ServiceItem;
  favorited?: boolean;
  onToggleFavorite?: (id: string) => void;
}) {
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const health = service.health?.status;
  const healthMeta =
    health === 'up' ? HEALTH_BADGE.up : health === 'down' ? HEALTH_BADGE.down : HEALTH_BADGE.default;
  const healthTextColor =
    health === 'up' ? token.colorSuccess : health === 'down' ? token.colorError : token.colorTextSecondary;

  const open = () => {
    // 进入详情即记录一次访问，首页“最近访问”才有真实数据
    void api.touchRecent(service.id);
    // URL 已是站内页面的服务直接进页面，不再经过服务详情这一层
    navigate(nativeRouteOf(service) ?? `/services/${service.id}`);
  };

  return (
    <Card
      // lab-service-card 供既有测试/样式依赖；d509-card 提供统一的悬浮动效
      className="lab-service-card d509-card"
      variant="outlined"
      styles={{ body: { padding: token.paddingLG } }}
      role="link"
      tabIndex={0}
      aria-label={`打开服务：${service.name}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
    >
      <Flex gap={12} align="flex-start">
        <span
          className="d509-icon"
          style={{
            width: 40,
            height: 40,
            borderRadius: token.borderRadiusLG,
            fontSize: 20,
            background: token.colorPrimaryBg,
            color: token.colorPrimary,
          }}
        >
          {ICONS[service.icon] ?? <AppstoreOutlined />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Flex justify="space-between" align="flex-start" gap={8}>
            <Typography.Text
              strong
              title={service.name}
              style={{
                fontSize: 15,
                lineHeight: 1.3,
                // 标题固定两行高（短标题也占满），保证同一排卡片完全等高
                minHeight: 39,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {service.name}
            </Typography.Text>
            {onToggleFavorite && (
              <Tooltip title={favorited ? '取消收藏' : '收藏'}>
                <Button
                  type="text"
                  size="small"
                  aria-label={favorited ? `取消收藏 ${service.name}` : `收藏 ${service.name}`}
                  icon={
                    favorited ? (
                      <StarFilled style={{ color: token.colorWarning }} />
                    ) : (
                      <StarOutlined />
                    )
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleFavorite(service.id);
                  }}
                />
              </Tooltip>
            )}
          </Flex>
          <Typography.Paragraph
            type="secondary"
            ellipsis={{ rows: 2 }}
            style={{ fontSize: token.fontSizeSM, margin: '4px 0 8px', minHeight: 38, maxHeight: 38 }}
          >
            {service.description}
          </Typography.Paragraph>
          <Space size={6} wrap>
            <Tag variant="filled">
              {CATEGORY_LABEL[service.category] ?? service.category}
            </Tag>
            {health && (
              <Badge
                status={healthMeta.status}
                text={<span style={{ color: healthTextColor, fontSize: token.fontSizeSM }}>{healthMeta.label}</span>}
              />
            )}
          </Space>
        </div>
      </Flex>
    </Card>
  );
}
