import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Flex, Tooltip } from 'antd';
import { ExportOutlined, FullscreenOutlined, ReloadOutlined } from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';
import { useThemeMode } from '../theme/ThemeContext';

/** 生信实训平台：纯 iframe 嵌入，平台自身的导航与登录流程完整保留。 */
export default function Bioinfo() {
  const { resolved, primary } = useThemeMode();
  const [reloadAt, setReloadAt] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [params] = useSearchParams();
  // 走门户同源 /apps/bioinfo/（nginx 反代），不再用 IP+端口直连。
  // iframe 直接发起 OIDC：门户已有会话时自动完成 SSO，不再落到生信登录按钮页。
  // tab=terminal 仍可直达生信平台自己的 PTY 工作区；它不是门户 SSH 网关。
  const src = useMemo(() => {
    const tab = params.get('tab');
    const target = tab === 'terminal' ? '/apps/bioinfo/workspace' : '/apps/bioinfo/';
    return `/apps/bioinfo/api/v1/auth/login?redirect=${encodeURIComponent(target)}`;
  }, [params]);

  const pushTheme = useCallback(() => {
    const target = frameRef.current?.contentWindow;
    if (!target) return;
    let targetOrigin = '*';
    try {
      targetOrigin = new URL(src).origin;
    } catch {
      /* 主题消息不含敏感信息，通配来源即可 */
    }
    target.postMessage({ type: 'labspace:theme', mode: resolved, primary }, targetOrigin);
  }, [src, resolved, primary]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      if (document.fullscreenElement === wrap) void document.exitFullscreen();
    };
  }, []);

  const toggleFullscreen = async () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await wrap.requestFullscreen();
    }
  };

  return (
    <div
      ref={wrapRef}
      style={{
        position: 'relative',
        height: fullscreen ? '100dvh' : 'calc(100dvh - 112px)',
        minHeight: 480,
        border: fullscreen ? 0 : '1px solid var(--d509-border-soft)',
        borderRadius: fullscreen ? 0 : 'var(--d509-radius-lg)',
        overflow: 'hidden',
        background: fullscreen ? 'var(--d509-surface)' : 'transparent',
      }}
    >
      <Flex
        gap={4}
        style={{
          position: 'absolute',
          top: 10,
          right: 12,
          zIndex: 2,
          padding: 4,
          borderRadius: 10,
          background: 'var(--ant-color-bg-elevated, #fff)',
          boxShadow: '0 2px 10px rgba(15, 23, 42, 0.12)',
        }}
      >
        <Tooltip title="刷新">
          <Button type="text" size="small" icon={<ReloadOutlined />} aria-label="刷新" onClick={() => setReloadAt((n) => n + 1)} />
        </Tooltip>
        <Tooltip title={fullscreen ? '退出全屏' : '全屏'}>
          <Button
            type="text"
            size="small"
            icon={<FullscreenOutlined />}
            aria-label={fullscreen ? '退出全屏' : '全屏'}
            onClick={toggleFullscreen}
          />
        </Tooltip>
        <Tooltip title="新窗口打开">
          <Button
            type="text"
            size="small"
            icon={<ExportOutlined />}
            aria-label="新窗口打开"
            href={src}
            target="_blank"
            rel="noreferrer"
          />
        </Tooltip>
      </Flex>
      <iframe
        key={`${src}#${reloadAt}`}
        ref={frameRef}
        src={src}
        title="生信实验实训平台"
        onLoad={pushTheme}
        style={{ display: 'block', width: '100%', height: '100%', border: 0 }}
        allow="clipboard-read; clipboard-write; fullscreen"
        allowFullScreen
      />
    </div>
  );
}