import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Card, Flex, Form, Input, Select, Space, Tag, Typography } from 'antd';
import { DisconnectOutlined, LinkOutlined, ReloadOutlined } from '@ant-design/icons';
import { io, type Socket } from 'socket.io-client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/**
 * WebSSH 终端（antd + xterm 自绘）。
 *
 * 协议来源：镜像内 /app/app/socket_events.py 与 ssh_output_flow.py 逐行确认。
 *  上行：ssh_connect {host,port,username,password,auth_type,cols,rows,client_request_id}
 *        ssh_input   {session_id,data,acknowledge_backpressure}
 *        ssh_resize  {session_id,cols,rows}
 *        ssh_host_key_decision {session_id,accept}   ← 主机指纹确认
 *  下行：connected     {status}          'unauthenticated' 表示 WebSSH 侧未登录
 *        ssh_connected {session_id,...}
 *        ssh_output    {session_id,data,sequence}      ← 终端字节流，带 ack 流控
 *        ssh_error     {error}
 *        ssh_host_key  {session_id,fingerprint,...}    ← 需用户确认
 *        ssh_disconnected {session_id,reason}
 *
 * 两个必须坚持的点：
 *   1. **同源**：走 /ssh-io/ 与 /ssh-app/ 代理。端口不同即跨源，WebSSH 的
 *      表单登录会被浏览器拦掉，socket 也带不上会话 Cookie。
 *   2. **主机指纹要人确认**：首次连某台机器时服务端会给指纹，
 *      默认不自动接受 —— 自动接受等于把中间人防护关掉。
 */

const HOSTS = [
  { value: '100.77.182.76', label: 'HPC 计算节点（hpc20d509）' },
  { value: '100.75.160.113', label: 'Linux 桌面（rlcao-ubuntu）' },
  { value: '100.81.178.13', label: 'Windows 工作站（win-99hgg0bbe3f）' },
  { value: '100.100.161.104', label: 'Windows 工作站（wsd509）' },
];

interface HostKeyPrompt {
  sessionId: string;
  fingerprint: string;
  hostname: string;
}

export default function WebSshTerminal() {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const sessionRef = useRef<string>('');
  const [status, setStatus] = useState<'idle' | 'connecting' | 'ready' | 'need-login' | 'error'>('idle');
  const [errMsg, setErrMsg] = useState('');
  const [hostKey, setHostKey] = useState<HostKeyPrompt | null>(null);

  /** 建终端实例（只建一次）。 */
  const ensureTerm = useCallback(() => {
    if (termRef.current || !hostRef.current) return termRef.current;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      scrollback: 5000,
      theme: { background: '#0d1117', foreground: '#e6edf3' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    try {
      fit.fit();
    } catch {
      /* 容器还没尺寸时 fit 会抛，忽略 */
    }
    termRef.current = term;
    fitRef.current = fit;
    return term;
  }, []);

  /** 连 socket 并登记事件。 */
  const connectSocket = useCallback(() => {
    const term = ensureTerm();
    if (!term) return;

    socketRef.current?.disconnect();
    const socket = io(window.location.origin, {
      path: '/ssh-io/socket.io',
      transports: ['websocket', 'polling'],
      withCredentials: true,
    });
    socketRef.current = socket;

    socket.on('connected', (p: { status?: string }) => {
      if (p?.status === 'unauthenticated') {
        setStatus('need-login');
      } else if (p?.status === 'unavailable') {
        setStatus('error');
        setErrMsg('服务正在维护，稍后再试');
      }
    });

    socket.on('ssh_connected', (p: { session_id: string }) => {
      sessionRef.current = p.session_id;
      setStatus('ready');
      term.focus();
    });

    socket.on('ssh_output', (p: { session_id: string; data: string }, ack?: () => void) => {
      term.write(p.data);
      // 服务端是「发一块、等 ack」的流控：不回执会把它那侧卡住
      ack?.();
    });

    socket.on('ssh_error', (p: { error?: string }) => {
      setStatus('error');
      setErrMsg(p?.error || '连接失败');
      term.write(`\r\n\x1b[31m${p?.error || '连接失败'}\x1b[0m\r\n`);
    });

    socket.on('ssh_host_key', (p: { session_id: string; fingerprint?: string; hostname?: string }) => {
      // 指纹必须由人确认：自动接受等于把中间人防护关掉
      setHostKey({
        sessionId: p.session_id,
        fingerprint: p.fingerprint || '(服务端未给指纹)',
        hostname: p.hostname || '',
      });
    });

    socket.on('ssh_disconnected', (p: { reason?: string }) => {
      setStatus('idle');
      term.write(`\r\n\x1b[33m连接已断开${p?.reason ? `：${p.reason}` : ''}\x1b[0m\r\n`);
    });

    socket.on('connect_error', (err: Error & { data?: { status?: number } }) => {
      // WebSSH 未登录时 socket.io 握手直接 401（不是发 connected 事件），
      // 所以这里必须把 401 也识别成「需要登录」，否则用户只看到一句
      // "连不上"，会以为是服务挂了。
      const code = err?.data?.status;
      if (code === 401 || /unauthor/i.test(err?.message ?? '')) {
        setStatus('need-login');
        return;
      }
      setStatus('error');
      setErrMsg('连不上终端服务（检查 WebSSH 是否在运行）');
    });

    // 键盘 → 服务端
    term.onData((data) => {
      if (!sessionRef.current) return;
      socket.emit('ssh_input', {
        session_id: sessionRef.current,
        data,
        acknowledge_backpressure: false,
      });
    });

    // 尺寸变化 → 服务端
    const onResize = () => {
      if (!fitRef.current) return;
      try {
        fitRef.current.fit();
      } catch {
        return;
      }
      if (sessionRef.current && term) {
        socket.emit('ssh_resize', {
          session_id: sessionRef.current,
          cols: term.cols,
          rows: term.rows,
        });
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [ensureTerm]);

  useEffect(() => {
    const cleanup = connectSocket();
    return () => {
      cleanup?.();
      socketRef.current?.disconnect();
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, [connectSocket]);

  const doConnect = (v: { host: string; port: number; username: string; password: string }) => {
    const term = ensureTerm();
    const socket = socketRef.current;
    if (!term || !socket) return;
    term.clear();
    setStatus('connecting');
    setErrMsg('');
    term.focus();
    socket.emit('ssh_connect', {
      host: v.host,
      port: Number(v.port) || 22,
      username: v.username,
      password: v.password,
      auth_type: 'password',
      cols: term.cols,
      rows: term.rows,
      client_request_id: `portal-${Date.now()}`,
    });
  };

  const answerHostKey = (accept: boolean) => {
    if (!hostKey) return;
    socketRef.current?.emit('ssh_host_key_decision', {
      session_id: hostKey.sessionId,
      accept,
    });
    setHostKey(null);
    if (!accept) {
      setStatus('idle');
      message.info('已拒绝该主机指纹，连接中止');
    }
  };

  const statusTag = () => {
    if (status === 'ready') return <Tag color="green">已连接</Tag>;
    if (status === 'connecting') return <Tag color="blue">连接中…</Tag>;
    if (status === 'need-login') return <Tag color="orange">需要登录终端服务</Tag>;
    if (status === 'error') return <Tag color="red">出错</Tag>;
    return <Tag>未连接</Tag>;
  };

  return (
    <Card
      size="small"
      title={
        <Flex align="center" gap={8}>
          终端 {statusTag()}
        </Flex>
      }
      extra={
        <Space size={8}>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => {
              const cleanup = connectSocket();
              void cleanup;
              message.info('已重连终端服务');
            }}
          >
            重连
          </Button>
          <Button
            size="small"
            icon={<DisconnectOutlined />}
            disabled={!sessionRef.current}
            onClick={() => {
              socketRef.current?.emit('ssh_disconnect', { session_id: sessionRef.current });
              sessionRef.current = '';
              setStatus('idle');
            }}
          >
            断开
          </Button>
        </Space>
      }
    >
      {status === 'need-login' ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="还没登录终端服务"
          description={
            <span>
              WebSSH 有自己的一套账号（与门户账号分开，用于保存密钥与主机信任）。
              首次使用请先在{' '}
              <a href="/ssh-app/login" target="_blank" rel="noreferrer">
                这里登录或注册
              </a>
              ，回来刷新本页即可。
            </span>
          }
        />
      ) : null}

      {status === 'error' && errMsg ? (
        <Alert type="error" showIcon style={{ marginBottom: 12 }} title={errMsg} />
      ) : null}

      {hostKey ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title={`首次连接 ${hostKey.hostname || '该主机'}：请核对指纹`}
          description={
            <Flex vertical gap={8}>
              <Typography.Text code style={{ fontSize: 12 }}>
                {hostKey.fingerprint}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                指纹与这台机器的真实指纹不一致时，可能是中间人劫持 —— 请先向老师核对再点接受。
              </Typography.Text>
              <Space>
                <Button size="small" type="primary" danger onClick={() => answerHostKey(true)}>
                  接受并连接
                </Button>
                <Button size="small" onClick={() => answerHostKey(false)}>
                  拒绝
                </Button>
              </Space>
            </Flex>
          }
        />
      ) : null}

      <Form
        form={form}
        layout="inline"
        initialValues={{ host: HOSTS[0].value, port: 22 }}
        onFinish={doConnect}
        style={{ marginBottom: 12, rowGap: 8 }}
      >
        <Form.Item name="host" label="机器" style={{ minWidth: 260 }}>
          <Select options={HOSTS} showSearch optionFilterProp="label" />
        </Form.Item>
        <Form.Item name="port" label="端口" style={{ width: 90 }}>
          <Input />
        </Form.Item>
        <Form.Item name="username" label="用户名" rules={[{ required: true, message: '必填' }]}>
          <Input placeholder="远端账号" style={{ width: 130 }} />
        </Form.Item>
        <Form.Item name="password" label="口令" rules={[{ required: true, message: '必填' }]}>
          <Input.Password placeholder="远端口令" style={{ width: 150 }} />
        </Form.Item>
        <Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            icon={<LinkOutlined />}
            loading={status === 'connecting'}
          >
            连接
          </Button>
        </Form.Item>
      </Form>

      <div
        ref={hostRef}
        style={{
          height: 'calc(100dvh - 420px)',
          minHeight: 360,
          background: '#0d1117',
          borderRadius: 8,
          padding: 8,
          overflow: 'hidden',
        }}
      />
    </Card>
  );
}
