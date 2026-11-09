import type { ReactNode } from 'react';
import { Flex } from 'antd';
import PageHeader from './PageHeader';

/** 子页面统一骨架：标题条 + 统一间距；新页面优先复用它，避免各页各写一套标题。 */
export default function PageShell({
  title,
  description,
  extra,
  embedded = false,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  extra?: ReactNode;
  /** 嵌入到「科研工具」等上层容器时隐藏标题条，只保留内容与操作区 */
  embedded?: boolean;
  children: ReactNode;
}) {
  if (embedded) {
    return (
      <Flex vertical gap={12} className="d509-page-shell">
        {extra ? <Flex justify="flex-end" wrap gap={8}>{extra}</Flex> : null}
        {children}
      </Flex>
    );
  }
  return (
    <Flex vertical gap={16} className="d509-page-shell">
      <PageHeader title={title} description={description} extra={extra} />
      {children}
    </Flex>
  );
}