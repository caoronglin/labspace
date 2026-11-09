import { useEffect, useState } from 'react';
import { Button, Card, Flex, Modal, Tag, Typography } from 'antd';
import {
  CheckCircleOutlined,
  CompassOutlined,
  ExperimentOutlined,
  FolderOpenOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../app/AuthContext';
import { CURRENT_RELEASE, CURRENT_VERSION } from '../content/releases';

/**
 * 首次激活引导 + 版本更新介绍。
 *
 * - 每个账号第一次进入工作台：弹一次「快速上手」（localStorage 按账号记）。
 * - 之后 CURRENT_VERSION 变化：弹一次「功能更新」（localStorage 全局记）。
 * 两处标记都可在帮助中心查看，弹窗本身不阻塞其它操作。
 */

const ONBOARD_PREFIX = 'd509:help:onboarded:';
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
    /* 隐私模式禁用存储时忽略：本次会话内不再弹 */
  }
}

const TOUR = [
  {
    icon: <SafetyCertificateOutlined />,
    title: '统一身份',
    description: '一次登录，访问全部实验室服务。',
  },
  {
    icon: <FolderOpenOutlined />,
    title: '文件与共享',
    description: '公共文件、质粒、基因组与个人文件按权限隔离。',
  },
  {
    icon: <ExperimentOutlined />,
    title: '科研工具',
    description: '基因组浏览、序列分析、文献检索、知识库相互串联。',
  },
  {
    icon: <CompassOutlined />,
    title: '随时可查',
    description: '右上角「帮助中心」提供上手、FAQ 与更新日志。',
  },
];

export default function HelpOnboarding() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'onboard' | 'update' | null>(null);
  const account = me?.id || me?.email || '';

  useEffect(() => {
    if (!me?.authenticated || !account) return;
    const t = setTimeout(() => {
      if (!read(ONBOARD_PREFIX + account)) {
        setMode('onboard');
      } else if (read(RELEASE_KEY) !== CURRENT_VERSION) {
        setMode('update');
      }
    }, 1200);
    return () => clearTimeout(t);
  }, [me?.authenticated, account]);

  const dismiss = (goHelp = false) => {
    if (account) write(ONBOARD_PREFIX + account, '1');
    write(RELEASE_KEY, CURRENT_VERSION);
    setMode(null);
    if (goHelp) navigate('/help');
  };

  if (!mode) return null;
  const isOnboard = mode === 'onboard';

  return (
    <Modal
      open
      centered
      width={620}
      mask={{ closable: false }}
      title={isOnboard ? '欢迎使用 D509 工作台' : `功能更新 · ${CURRENT_RELEASE.title}`}
      onCancel={() => dismiss(false)}
      footer={[
        <Button key="detail" type="link" onClick={() => dismiss(true)}>
          {isOnboard ? '查看帮助中心' : '查看更新日志'}
        </Button>,
        <Button key="ok" type="primary" onClick={() => dismiss(false)}>
          {isOnboard ? '开始使用' : '知道了'}
        </Button>,
      ]}
    >
      {isOnboard ? (
        <Flex vertical gap={14} style={{ paddingTop: 4 }}>
          <Typography.Paragraph type="secondary" style={{ margin: 0, fontSize: 13 }}>
            这是你第一次进入工作台。四个入口先认识一下，更多内容在帮助中心。
          </Typography.Paragraph>
          <div className="d509-grid d509-grid-sm">
            {TOUR.map((t) => (
              <Card key={t.title} size="small" styles={{ body: { padding: 12 } }}>
                <Flex vertical gap={4}>
                  <Flex align="center" gap={8}>
                    <span style={{ color: '#2B5CE6', fontSize: 16 }}>{t.icon}</span>
                    <Typography.Text strong style={{ fontSize: 13 }}>{t.title}</Typography.Text>
                  </Flex>
                  <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: 1.55 }}>
                    {t.description}
                  </Typography.Text>
                </Flex>
              </Card>
            ))}
          </div>
        </Flex>
      ) : (
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
      )}

      <Card
        size="small"
        style={{ marginTop: 14, background: 'var(--ant-color-fill-quaternary)' }}
        styles={{ body: { padding: '10px 14px' } }}
      >
        <Flex vertical gap={6}>
          <Flex align="center" gap={8}>
            <Typography.Text strong style={{ fontSize: 12.5 }}>
              {isOnboard ? '本次更新' : '更新内容'}
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

      {isOnboard ? (
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 10, fontSize: 12 }}>
          这条引导仅首次登录显示；功能更新后还会再提示一次。
        </Typography.Text>
      ) : null}
    </Modal>
  );
}