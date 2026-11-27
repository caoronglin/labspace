import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Flex, Space, Tag, Tooltip } from 'antd';
import { ClearOutlined, DisconnectOutlined, ReloadOutlined } from '@ant-design/icons';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { theme } from 'antd';

type TerminalStatus = 'connecting' | 'ready' | 'reconnecting' | 'closed' | 'error';

export default function SshTerminal({ sessionId }: { sessionId: string }) {
  const { token } = theme.useToken();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const [attempt, setAttempt] = useState(0);

  const fit = useCallback(() => {
    try {
      fitRef.current?.fit();
      const term = termRef.current;
      const socket = socketRef.current;
      if (term && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    } catch {
      /* 容器尚未布局完成时忽略，下一次 ResizeObserver 会再试。 */
    }
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      scrollback: 5000,
      convertEol: false,
      theme: {
        background: token.colorBgElevated,
        foreground: token.colorText,
        cursor: token.colorPrimary,
        selectionBackground: token.colorPrimary,
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(host);
    termRef.current = term;
    fitRef.current = fitAddon;
    fit();
    term.focus();

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${proto}//${window.location.host}/ssh-api/ws/sessions/${encodeURIComponent(sessionId)}`);
    socketRef.current = socket;
    setStatus('connecting');
    socket.onopen = () => {
      setStatus('ready');
      fit();
      term.focus();
    };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: string; data?: string; message?: string };
        if (message.type === 'output' && message.data) term.write(message.data);
        if (message.type === 'exit') {
          setStatus('closed');
          term.write('\r\n\x1b[33m[SSH 会话已结束]\x1b[0m\r\n');
        }
        if (message.type === 'error') {
          setStatus('error');
          term.write(`\r\n\x1b[31m${message.message || '终端错误'}\x1b[0m\r\n`);
        }
      } catch {
        term.write(String(event.data));
      }
    };
    socket.onerror = () => setStatus('error');
    socket.onclose = () => setStatus((prev) => (prev === 'ready' ? 'reconnecting' : prev));
    const inputSub = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
    });
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    return () => {
      observer.disconnect();
      inputSub.dispose();
      socket.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      socketRef.current = null;
    };
  }, [sessionId, attempt, fit, token.colorBgElevated, token.colorPrimary, token.colorText]);

  const statusMeta: Record<TerminalStatus, { label: string; color: string }> = {
    connecting: { label: '连接中', color: 'processing' },
    ready: { label: '已连接', color: 'success' },
    reconnecting: { label: '连接已断开', color: 'warning' },
    closed: { label: '会话已结束', color: 'default' },
    error: { label: '连接错误', color: 'error' },
  };

  return (
    <Flex vertical gap={8} style={{ height: '100%', minHeight: 420 }}>
      <Flex justify="space-between" align="center" wrap gap={8}>
        <Space>
          <Tag color={statusMeta[status].color}>{statusMeta[status].label}</Tag>
          <span style={{ color: token.colorTextSecondary, fontSize: 12 }}>真实 SSH 会话 · 支持中文输入与窗口缩放</span>
        </Space>
        <Space>
          <Tooltip title="清屏"><Button size="small" icon={<ClearOutlined />} onClick={() => termRef.current?.clear()} /></Tooltip>
          <Tooltip title="重新挂接终端"><Button size="small" icon={<ReloadOutlined />} onClick={() => setAttempt((n) => n + 1)} /></Tooltip>
          <Tooltip title="断开"><Button size="small" danger icon={<DisconnectOutlined />} onClick={() => socketRef.current?.close()} /></Tooltip>
        </Space>
      </Flex>
      <div
        ref={hostRef}
        onClick={() => termRef.current?.focus()}
        style={{ flex: 1, minHeight: 360, padding: 12, borderRadius: token.borderRadius, background: token.colorBgElevated, overflow: 'hidden' }}
      />
    </Flex>
  );
}
