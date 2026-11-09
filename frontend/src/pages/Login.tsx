import { useEffect } from 'react';
import { Button, Card, Flex, Spin, Typography } from 'antd';
import { LoginOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../app/AuthContext';
import BrandMark from '../components/BrandMark';

export default function Login() {
  const navigate = useNavigate();
  const { me, loading } = useAuth();

  useEffect(() => {
    // 已登录直接回工作台，避免再次跳转 Casdoor
    if (!loading && me?.authenticated) {
      navigate('/', { replace: true });
      return;
    }
    // 后端登录入口是 302 跳转，必须整页跳转，不能走前端路由
    const t = setTimeout(() => window.location.replace('/api/auth/login'), 300);
    return () => clearTimeout(t);
  }, [navigate, me, loading]);

  return (
    <Flex align="center" justify="center" style={{ minHeight: '60vh', padding: 16 }}>
      <Card style={{ width: 380, maxWidth: '100%' }}>
        {/* 品牌区：Logo + 名称 + 一句定位 */}
        <Flex vertical align="center" gap={8} style={{ textAlign: 'center', marginBottom: 20 }}>
          <BrandMark size="lg" withText={false} />
          <Typography.Title level={3} style={{ margin: 0, fontSize: 20 }}>
            D509 实验室工作台
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ margin: 0, fontSize: 13 }}>
            一个入口访问 AI 对话、文件共享、科研绘图、文献检索与基因组数据。
          </Typography.Paragraph>
        </Flex>

        {/* 主行动：SSO 统一身份认证 */}
        <Button
          type="primary"
          block
          size="large"
          icon={<LoginOutlined />}
          onClick={() => window.location.replace('/api/auth/login')}
        >
          使用统一身份认证登录
        </Button>

        {/* 状态说明 */}
        <Flex align="center" justify="center" gap={8} style={{ marginTop: 16 }}>
          <Spin size="small" />
          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
            正在跳转到 Casdoor 统一身份认证…
          </Typography.Text>
        </Flex>

        {/* 兜底链接 */}
        <Flex gap={16} justify="center" align="center" style={{ marginTop: 20 }}>
          <Typography.Link onClick={() => navigate('/', { replace: true })} style={{ fontSize: 12.5 }}>
            回到首页
          </Typography.Link>
          <Typography.Link
            href="/api/health"
            target="_blank"
            rel="noreferrer noopener"
            style={{ fontSize: 12.5 }}
          >
            <SafetyCertificateOutlined /> 服务状态
          </Typography.Link>
        </Flex>
      </Card>
    </Flex>
  );
}
