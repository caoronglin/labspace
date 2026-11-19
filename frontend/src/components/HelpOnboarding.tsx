import { useEffect, useState } from 'react';
import { Button, Card, Flex, Modal, Tag, Typography } from 'antd';
import { CheckCircleOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../app/AuthContext';
import { tourSeen } from './onboardingState';
import { CURRENT_RELEASE, CURRENT_VERSION } from '../content/releases';

/**
 * 版本更新介绍。
 *
 * **新手引导已经迁到 `OnboardingTour.tsx`**（用 antd Tour 逐步高亮真实控件，
 * 而不是这里原来的静态四宫格 Modal）。这里只保留「功能更新」弹窗：
 * CURRENT_VERSION 变化时弹一次（localStorage 全局记）。
 *
 * 两者的先后：首次登录时引导优先、更新弹窗让位 —— 一次只弹一个，
 * 两个模态叠在一起是典型的注意力事故。老用户（引导已看过）才直接看到更新。
 *
 * 标记可从帮助中心查看，弹窗本身不阻塞其它操作。
 */

const RELEASE_KEY = 'd509:help:release-seen';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式禁用存储时忽略 */
  }
}


export default function HelpOnboarding() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const [showUpdate, setShowUpdate] = useState(false);
  const account = me?.id || me?.email || '';

  useEffect(() => {
    if (!me?.authenticated || !account) return;
    const t = setTimeout(() => {
      // 首次登录让位给 Tour 引导；引导看完（标记已写）后才轮到更新弹窗。
      if (tourSeen(account)) {
        // 兼容早期写下的 'v<version>'：老标记带 v 前缀，永远比不上 CURRENT_VERSION，
        // 会导致更新弹窗反复出现（e2e 里就踩过这个坑）。
        const seen = read(RELEASE_KEY);
        const normalized = seen?.startsWith('v') ? seen.slice(1) : seen;
        if (normalized !== CURRENT_VERSION) setShowUpdate(true);
      }
    }, 2200);
    return () => clearTimeout(t);
  }, [me?.authenticated, account]);

  const dismiss = (goHelp = false) => {
    write(RELEASE_KEY, CURRENT_VERSION);
    setShowUpdate(false);
    if (goHelp) navigate('/help');
  };

  if (!showUpdate) return null;

  return (
    <Modal
      open
      centered
      width={620}
      mask={{ closable: false }}
      title={`功能更新 · ${CURRENT_RELEASE.title}`}
      onCancel={() => dismiss(false)}
      footer={[
        <Button key="detail" type="link" onClick={() => dismiss(true)}>
          查看更新日志
        </Button>,
        <Button key="ok" type="primary" onClick={() => dismiss(false)}>
          知道了
        </Button>,
      ]}
    >
      <Flex vertical gap={10} style={{ paddingTop: 4 }}>
        <Flex align="center" gap={8} wrap>
          <Tag color="blue">v{CURRENT_RELEASE.version}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {CURRENT_RELEASE.date}
          </Typography.Text>
        </Flex>
        <Typography.Paragraph type="secondary" style={{ margin: 0, fontSize: 13 }}>
          {CURRENT_RELEASE.summary}
        </Typography.Paragraph>
      </Flex>

      <Card
        size="small"
        style={{ marginTop: 14, background: 'var(--ant-color-fill-quaternary)' }}
        styles={{ body: { padding: '10px 14px' } }}
      >
        <Flex vertical gap={6}>
          <Flex align="center" gap={8}>
            <Typography.Text strong style={{ fontSize: 12.5 }}>
              更新内容
            </Typography.Text>
            <Tag color="green">v{CURRENT_VERSION}</Tag>
          </Flex>
          {CURRENT_RELEASE.highlights.map((h) => (
            <Flex key={h} align="flex-start" gap={8}>
              <CheckCircleOutlined style={{ color: '#52c41a', marginTop: 3 }} />
              <Typography.Text style={{ fontSize: 12.5, lineHeight: 1.6 }}>{h}</Typography.Text>
            </Flex>
          ))}
        </Flex>
      </Card>
    </Modal>
  );
}