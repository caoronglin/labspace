import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Flex, Skeleton, Space, Tooltip, Typography } from 'antd';
import { ExpandOutlined, ExportOutlined, ReloadOutlined } from '@ant-design/icons';

export interface EmbedFrameProps {
  /** 内嵌地址（必须先经服务端确认允许嵌入） */
  src: string;
  /** 标题，用于无障碍与工具栏提示 */
  title: string;
  /** 高度，数字按 px 处理，字符串原样使用 */
  height?: number | string;
  /** 加载超时（毫秒），超时后提示改用新窗口 */
  timeoutMs?: number;
}

/**
 * 通用内嵌框架。
 *
 * 说明：
 * - 是否允许嵌入由后端 `GET /api/services/{id}/embed` 判定（依据
 *   X-Frame-Options / CSP frame-ancestors），本组件只负责展示与工具栏。
 * - 目标站点若在自身前端发起跳转（OIDC 登录），浏览器会拒绝在 iframe 中
 *   跨域带凭据跳转，这类服务请走「一键登录」而非内嵌。
 */
export default function EmbedFrame({ src, title, height = 'calc(100vh - 210px)', timeoutMs = 20000 }: EmbedFrameProps) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'timeout'>('loading');
  const [nonce, setNonce] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPhase('loading');
    const timer = window.setTimeout(() => setPhase((p) => (p === 'loading' ? 'timeout' : p)), timeoutMs);
    return () => window.clearTimeout(timer);
  }, [src, nonce, timeoutMs]);

  const reload = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  const openNew = useCallback(() => {
    window.open(src, '_blank', 'noopener');
  }, [src]);

  const toggleFullscreen = useCallback(async () => {
    const el = wrapRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await el.requestFullscreen();
      }
    } catch {
      /* 浏览器拒绝全屏时忽略 */
    }
  }, []);

  return (
    <div ref={wrapRef} className="d509-embed">
      <Flex className="d509-embed-bar" align="center" justify="space-between" gap={8}>
        <Flex align="center" gap={8} style={{ minWidth: 0 }}>
          <Typography.Text strong ellipsis style={{ fontSize: 13, maxWidth: 360 }}>
            {title}
          </Typography.Text>
          <Typography.Text type="secondary" ellipsis style={{ fontSize: 12 }}>
            {src}
          </Typography.Text>
        </Flex>
        <Space size={4}>
          <Tooltip title="刷新内嵌页">
            <Button size="small" type="text" icon={<ReloadOutlined />} onClick={reload} aria-label="刷新内嵌页" />
          </Tooltip>
          <Tooltip title="在新窗口打开">
            <Button size="small" type="text" icon={<ExportOutlined />} onClick={openNew} aria-label="在新窗口打开" />
          </Tooltip>
          <Tooltip title="全屏">
            <Button size="small" type="text" icon={<ExpandOutlined />} onClick={toggleFullscreen} aria-label="全屏" />
          </Tooltip>
        </Space>
      </Flex>

      <div className="d509-embed-body" style={{ height }}>
        {phase === 'loading' ? (
          <div className="d509-embed-loading">
            <Skeleton active title={{ width: '32%' }} paragraph={{ rows: 6 }} />
          </div>
        ) : null}
        {phase === 'timeout' ? (
          <div className="d509-embed-loading">
            <Alert
              type="warning"
              showIcon
              title="内嵌页加载超时"
              description="目标站点可能拒绝被嵌入（X-Frame-Options / CSP），或加载时间过长。点击「在新窗口打开」可直接使用。"
              action={
                <Button size="small" type="primary" onClick={openNew}>
                  新窗口打开
                </Button>
              }
            />
          </div>
        ) : null}
        <iframe
          key={nonce}
          src={src}
          title={title}
          className="d509-embed-frame"
          onLoad={() => setPhase('ready')}
          referrerPolicy="strict-origin-when-cross-origin"
          allow="clipboard-read; clipboard-write; fullscreen; geolocation; microphone; camera"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals allow-popups-to-escape-sandbox"
        />
      </div>
    </div>
  );
}
