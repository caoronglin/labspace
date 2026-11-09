/**
 * 公告面板（顶栏铃铛的内容）
 *
 * 从 AppLayout 里抽出来：布局文件已经同时在管侧栏、面包屑、命令面板、主题、用户菜单，
 * 再把「加载态 / 失败态 / 空态 + 列表」混进去就没人看得动了。
 */
import { Empty, Flex, Skeleton, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';

export default function AnnouncementsPanel() {
  const query = useQuery({
    queryKey: ['announcements'],
    queryFn: api.announcements,
    staleTime: 120_000,
    retry: false,
  });

  if (query.isPending) return <Skeleton active paragraph={{ rows: 2 }} title={false} />;

  if (query.isError) {
    return (
      <Flex vertical gap={4} style={{ width: 320 }}>
        <Typography.Text type="secondary">公告加载失败，请稍后重试</Typography.Text>
        <Typography.Link onClick={() => void query.refetch()} style={{ fontSize: 12 }}>
          重新加载
        </Typography.Link>
      </Flex>
    );
  }

  const items = query.data?.announcements ?? [];
  if (items.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无公告" />;
  }

  return (
    <Flex vertical gap={10} style={{ width: 320, maxHeight: 360, overflow: 'auto' }}>
      {items.map((a) => (
        <div key={a.id}>
          <Typography.Text strong style={{ fontSize: 13 }}>
            {a.title}
          </Typography.Text>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '2px 0 0' }}>
            {a.content}
          </Typography.Paragraph>
        </div>
      ))}
    </Flex>
  );
}
