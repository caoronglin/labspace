import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Tooltip } from 'antd';
import { LoginOutlined } from '@ant-design/icons';

export interface SsoButtonProps {
  /** 服务自身的 OIDC 启动端点；门户已有会话时可直接免密进入 */
  ssoUrl?: string;
  /** 服务 id：提供时先走门户的 /sso/:id 页面，按当前入口主机自适应切换 OIDC 配置 */
  serviceId?: string;
  /** 按钮文案 */
  label?: string;
  size?: 'small' | 'middle' | 'large';
  block?: boolean;
}

/**
 * 「一键登录」按钮。
 *
 * 门户与第三方服务共用同一个门户 OIDC Provider，
 * 门户已登录 ⇒ 门户会话已存在 ⇒ 访问服务自己的 OIDC 启动端点即可免密进入，
 * 不需要再输入一次口令。
 *
 * 若提供 serviceId，则先进入门户的 /sso/:id 页面：那里会把该服务的
 * OIDC issuer/回调切换到当前访问入口所用的主机（内网 IP 或 Tailscale IP），
 * 再跳转到服务，避免远程用户被指向不可达的内网地址。
 */
export default function SsoButton({
  ssoUrl,
  serviceId,
  label = '一键登录',
  size = 'small',
  block,
}: SsoButtonProps) {
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  if (!ssoUrl && !serviceId) return null;

  const go = () => {
    setBusy(true);
    // 优先直连服务自带的 OIDC 启动端点：门户 OIDC 会话命中后无需再次输入口令
    if (ssoUrl) {
      window.location.href = ssoUrl;
      return;
    }
    navigate(`/sso/${serviceId}`);
  };

  return (
    <Tooltip title="门户与该服务共用统一认证账号，无需重复输入口令">
      <Button
        type="primary"
        size={size}
        block={block}
        icon={<LoginOutlined />}
        loading={busy}
        onClick={go}
      >
        {label}
      </Button>
    </Tooltip>
  );
}
