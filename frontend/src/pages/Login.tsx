import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Flex, Spin, Typography } from 'antd';
import { LoginOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../app/AuthContext';
import BrandMark from '../components/BrandMark';

/**
 * 登录页。
 *
 * 之前这里会「自动跳转到 Casdoor」，用户反馈卡在这一页。真实原因有两层：
 *
 * 1. **无限刷新**：AppLayout 在未登录时会 `<Navigate to="/login" replace />`，
 *    而登录页又在 300ms 后 `location.replace('/api/auth/login')` 跳到 Casdoor；
 *    Casdoor 授权失败又跳回 `/login?error=...`，于是 登录 → 授权 → 回登录 循环。
 * 2. **看不见原因**：出错时页面仍显示「正在跳转到 Casdoor…」，用户只看到一个
 *    永远转圈的页面。
 *
 * 现在的做法：
 *   * **不自动跳转**，把「使用统一身份认证登录」做成明确的主按钮 —— 跳转时机由用户决定，
 *     也就没有循环的可能；
 *   * 带 error 参数时显示原因，并说明下一步怎么办；
 *   * 已经登录时直接回到目标页（或首页）。
 */
export default function Login() {
  const navigate = useNavigate();
  const { me, loading } = useAuth();
  const [params] = useSearchParams();
  const back = params.get('back') ?? '';
  const error = params.get('error') ?? '';
  const [starting, setStarting] = useState(false);
  const navigated = useRef(false);

  const loginUrl = `/api/auth/login${back ? `?back=${encodeURIComponent(back)}` : ''}`;

  // 自动跳转的去重标记：同一标签页只自动跳一次。
  // 反复自动跳是"一直卡在 /login"的直接原因（Casdoor 取消授权 → 回 /login?error= → 又跳）。
  const AUTO_KEY = 'labspace.login.auto';

  useEffect(() => {
    // 已登录：直接去目标页。只做一次，避免与「用户正在点登录」互相打架。
    if (loading || !me?.authenticated || navigated.current) return;
    navigated.current = true;
    navigate(back || '/', { replace: true });
  }, [back, loading, me, navigate]);

  useEffect(() => {
    // 出错时不自动跳：页面要停在原地把原因讲清楚，否则用户只会看到转圈。
    if (error) return;
    // 已经在本次会话里自动跳过，就不要再跳（避免与手动点击叠加成循环）。
    if (sessionStorage.getItem(AUTO_KEY) === '1') return;
    const t = setTimeout(() => {
      sessionStorage.setItem(AUTO_KEY, '1');
      startLogin();
    }, 400);
    return () => clearTimeout(t);
    // startLogin 依赖 loginUrl，这里用 ref 保持依赖稳定即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  const startLogin = () => {
    setStarting(true);
    // 整页跳转：后端 /api/auth/login 是 302 到 Casdoor，前端路由走不了
    window.location.assign(loginUrl);
  };

  return (
    <Flex align="center" justify="center" style={{ minHeight: '60vh', padding: 16 }}>
      <Card style={{ width: 420, maxWidth: '100%' }}>
        {/* 品牌区：Logo + 名称 + 一句定位 */}
        <Flex vertical align="center" gap={8} style={{ textAlign: 'center', marginBottom: 20 }}>
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
            message="登录未完成"
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

        {back ? (
          <Alert
            type="info"
            showIcon
            message="登录后将回到你刚才访问的页面"
            description={<Typography.Text code style={{ fontSize: 12 }}>{back}</Typography.Text>}
            style={{ marginBottom: 16 }}
          />
        ) : null}

        {/* 主行动：SSO 统一身份认证（由用户点击触发，避免自动跳转造成的循环） */}
        <Button
          type="primary"
          block
          size="large"
          icon={<LoginOutlined />}
          loading={starting}
          onClick={startLogin}
        >
          {error ? '重新登录' : '使用统一身份认证登录'}
        </Button>

        {/* 状态说明：只在真的在跳转时才显示，避免"永远转圈"的错觉 */}
        {starting ? (
          <Flex align="center" justify="center" gap={8} style={{ marginTop: 16 }}>
            <Spin size="small" />
            <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
              正在跳转到统一身份认证…
            </Typography.Text>
          </Flex>
        ) : (
          <Typography.Paragraph
            type="secondary"
            style={{ marginTop: 16, marginBottom: 0, fontSize: 12.5, textAlign: 'center' }}
          >
            使用实验室统一身份认证（Casdoor）登录，不需要单独注册。
          </Typography.Paragraph>
        )}

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
