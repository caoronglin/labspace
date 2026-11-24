import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Flex, Input, Typography } from 'antd';
import { LoginOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../app/AuthContext';
import BrandMark from '../components/BrandMark';

/** 登录后只允许回到同源站内路径，避免开放重定向。 */
function safeBack(raw: string): string {
  const value = (raw || '').trim();
  if (!value || value.startsWith('//') || /[\\\n\r]/.test(value)) return '/';
  return value.startsWith('/') ? value.slice(0, 200) : '/';
}

/**
 * 门户登录页。
 *
 * 身份认证已收口到门户自身：账号口令由后端 bcrypt 校验，会话为门户自签 JWT。
 * Casdoor 已下线，生信实训与 primer3 通过门户 OIDC Provider 单点登录。
 */
export default function Login() {
  const navigate = useNavigate();
  const { me, loading } = useAuth();
  const [params] = useSearchParams();
  const back = safeBack(params.get('back') ?? '');
  const error = params.get('error') ?? '';
  const navigated = useRef(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (loading || !me?.authenticated || navigated.current) return;
    navigated.current = true;
    navigate(back, { replace: true });
  }, [back, loading, me, navigate]);

  const submitPassword = async () => {
    if (!username.trim() || !password) {
      setFormError('请输入账号与口令');
      return;
    }
    setSubmitting(true);
    setFormError('');
    try {
      const res = await fetch('/api/auth/login-direct', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setFormError(String(data.detail || '登录失败，请稍后再试'));
        return;
      }
      window.location.assign(back);
    } catch {
      setFormError('网络异常，请稍后再试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Flex align="center" justify="center" style={{ minHeight: '60vh', padding: 16 }}>
      <Card style={{ width: 420, maxWidth: '100%' }}>
        <Flex vertical gap={8} style={{ textAlign: 'center', marginBottom: 20 }}>
          <BrandMark size="lg" withText={false} />
          <Typography.Title level={3} style={{ margin: 0, fontSize: 20 }}>
            D509 实验室工作台
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ margin: 0, fontSize: 13 }}>
            一个入口访问 AI 对话、文件存储、科研绘图、文献检索与基因组数据。
          </Typography.Paragraph>
        </Flex>

        {error ? (
          <Alert
            type="error"
            showIcon
            title="登录未完成"
            description={
              <Flex vertical gap={6}>
                <Typography.Text>{error}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                  常见原因：账号不在实验室组织内、账号被停用、或授权流程超时。
                  请联系管理员确认账号后重试。
                </Typography.Text>
              </Flex>
            }
            style={{ marginBottom: 16 }}
          />
        ) : null}

        {back !== '/' ? (
          <Alert
            type="info"
            showIcon
            title="登录后将回到你刚才访问的页面"
            description={<Typography.Text code style={{ fontSize: 12 }}>{back}</Typography.Text>}
            style={{ marginBottom: 16 }}
          />
        ) : null}

        <Flex vertical gap={10}>
          <Input
            id="username"
            size="large"
            allowClear
            autoComplete="username"
            placeholder="账号，例如 student01"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onPressEnter={submitPassword}
          />
          <Input.Password
            id="password"
            size="large"
            autoComplete="current-password"
            placeholder="口令"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onPressEnter={submitPassword}
          />
          {formError ? (
            <Typography.Text type="danger" style={{ fontSize: 12.5 }}>
              {formError}
            </Typography.Text>
          ) : null}
          <Button
            type="primary"
            block
            size="large"
            icon={<LoginOutlined />}
            loading={submitting}
            onClick={submitPassword}
          >
            登录
          </Button>
        </Flex>

        <Typography.Paragraph
          type="secondary"
          style={{ marginTop: 16, marginBottom: 0, fontSize: 12.5, textAlign: 'center' }}
        >
          使用实验室统一身份登录，不需要单独注册；首次登录后按提示修改初始口令。
        </Typography.Paragraph>

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
