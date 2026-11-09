import type { ReactNode } from 'react';
import { Flex, Typography } from 'antd';

/** ProCard 风格指标块：图标 + 标题 + 主数值 + 辅助说明。 */
export default function ProStat({
  icon,
  title,
  value,
  suffix,
  hint,
  color = '#2B5CE6',
}: {
  icon?: ReactNode;
  title: ReactNode;
  value: ReactNode;
  suffix?: ReactNode;
  hint?: ReactNode;
  color?: string;
}) {
  return (
    <Flex
      align="center"
      gap={14}
      style={{
        padding: '14px 18px',
        border: '1px solid var(--ant-color-border-secondary)',
        borderRadius: 'var(--ant-border-radius-lg)',
        background: 'var(--ant-color-bg-container)',
        minHeight: 80,
      }}
    >
      {icon ? (
        <Flex
          align="center"
          justify="center"
          style={{
            width: 40,
            height: 40,
            flex: '0 0 40px',
            borderRadius: 10,
            color,
            background: `color-mix(in srgb, ${color} 12%, transparent)`,
            fontSize: 18,
          }}
        >
          {icon}
        </Flex>
      ) : null}
      <Flex vertical gap={2} style={{ minWidth: 0 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
          {title}
        </Typography.Text>
        <Flex align="baseline" gap={6} style={{ minWidth: 0 }}>
          <Typography.Text strong style={{ fontSize: 22, lineHeight: 1.2, color }}>
            {value}
          </Typography.Text>
          {suffix ? <Typography.Text type="secondary">{suffix}</Typography.Text> : null}
        </Flex>
        {hint ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {hint}
          </Typography.Text>
        ) : null}
      </Flex>
    </Flex>
  );
}