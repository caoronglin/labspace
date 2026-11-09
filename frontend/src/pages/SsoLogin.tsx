import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, App, Button, Card, Result, Space, Spin, Typography } from 'antd';
import { ArrowLeftOutlined, ExportOutlined } from '@ant-design/icons';
import { api } from '../services/api';

/**
 * 一键登录中转页。
 *
 * 1. 读取当前访问入口的主机（内网 IP 或 Tailscale IP）；
 * 2. 调用后端把目标服务的 OIDC issuer / 回调地址切换到该主机
 *    （由宿主机侧的 OIDC 同步服务执行）；
 * 3. 跳转到服务自身的登录入口，Casdoor 已有会话即可免密进入。
 */
export default function SsoLoginPage() {
  const { serviceId = '' } = useParams();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [state, setState] = useState<'running' | 'done' | 'error'>('running');
  const [detail, setDetail] = useState('');
  const [loginUrl, setLoginUrl] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.ssoPrepare(serviceId);
        if (cancelled) return;
        setLoginUrl(res.loginUrl);
        setState('done');
        window.location.href = res.loginUrl;
      } catch (err) {
        if (cancelled) return;
        const text = err instanceof Error ? err.message : String(err);
        setDetail(text);
        setState('error');
        message.error('一键登录准备失败');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serviceId, message]);

  return (
    <div className="d509-page">
      <Card style={{ maxWidth: 640, margin: '48px auto' }}>
        {state === 'running' && (
          <div style={{ textAlign: 'center', padding: '32px 0' }}>
            <Spin size="large" />
            <Typography.Paragraph style={{ marginTop: 20 }}>
              正在按当前入口地址准备一键登录…
            </Typography.Paragraph>
            <Typography.Text type="secondary">
              若服务配置需要切换，容器重启通常需要 10~30 秒。
            </Typography.Text>
          </div>
        )}

        {state === 'done' && (
          <Result
            status="success"
            title="已跳转到目标服务"
            subTitle="若未自动跳转，请点击下方按钮。"
            extra={
              <Space>
                <Button type="primary" icon={<ExportOutlined />} href={loginUrl}>
                  继续前往
                </Button>
                <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)}>
                  返回
                </Button>
              </Space>
            }
          />
        )}

        {state === 'error' && (
          <Result
            status="warning"
            title="一键登录准备失败"
            subTitle={detail}
            extra={
              <Space>
                <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)}>
                  返回
                </Button>
              </Space>
            }
          />
        )}

        {state === 'error' && (
          <Alert
            type="info"
            showIcon
            title="备用方案"
            description="可以先在浏览器中直接打开该服务页面，再使用服务自身的账号登录。"
          />
        )}
      </Card>
    </div>
  );
}
