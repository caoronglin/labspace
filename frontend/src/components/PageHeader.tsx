import type { ReactNode } from 'react';
import { Flex, Typography } from 'antd';

/**
 * 页面标题条：标题 + 一句说明（常用于数量/口径）+ 右侧操作区。
 *
 * 设计约束（见《D509 设计规范》E 节页面骨架）：
 * - 一屏/一区块最多一个 primary 按钮，其余放 default / text；
 * - 标题 ≤ 12 字，说明只写一句话（如「共 42 个」）。
 */
export default function PageHeader({
  title,
  description,
  extra,
}: {
  title: ReactNode;
  description?: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <Flex align="center" justify="space-between" wrap gap={12} className="d509-page-header">
      <Flex vertical gap={2} style={{ minWidth: 0 }}>
        <Typography.Title level={3} style={{ margin: 0, fontSize: 20, lineHeight: 1.3 }}>
          {title}
        </Typography.Title>
        {description ? (
          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
            {description}
          </Typography.Text>
        ) : null}
      </Flex>
      {extra ? (
        <Flex gap={8} align="center" wrap>
          {extra}
        </Flex>
      ) : null}
    </Flex>
  );
}
