import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { Alert, Button, Result, Space, Typography } from 'antd';
import { CopyOutlined, HomeOutlined, ReloadOutlined } from '@ant-design/icons';

type ErrorStatus = '403' | '404' | '500' | 'error';

const STATUS_TEXT: Record<ErrorStatus, { title: string; subTitle: string }> = {
  '403': { title: '没有访问权限', subTitle: '当前账号无权查看该页面，可联系管理员开通。' },
  '404': { title: '页面不存在', subTitle: '该地址可能已失效，或链接有误。' },
  '500': { title: '服务出错了', subTitle: '服务端处理失败，可稍后重试。' },
  error: { title: '页面出现异常', subTitle: '可以刷新重试；若持续出现，请把下面的诊断信息反馈给管理员。' },
};

/** 从错误信息里推断 HTTP 语义状态（403 / 404 / 500），其余归为通用错误。 */
function inferStatus(message: string): ErrorStatus {
  const m = message.toLowerCase();
  if (/\b403\b|forbidden|无权限|unauthor/.test(m)) return '403';
  if (/\b404\b|not found|页面不存在/.test(m)) return '404';
  if (/\b500\b|internal server error|server error/.test(m)) return '500';
  return 'error';
}

/** 全局错误边界：页面级异常兜底，避免白屏。 */
interface Props {
  children: ReactNode;
  /** 可显式指定语义状态（403 / 404 / 500），不传则从错误信息推断。 */
  status?: Exclude<ErrorStatus, 'error'>;
  /**
   * 出错时提供给用户的原地恢复入口（例如「重试这个面板」）。
   * 页面级边界不需要；包在单个数据区块外层时，能让用户只重载这一块而不是整页刷新。
   */
  onRetry?: () => void;
}

interface State {
  error: Error | null;
  info?: ErrorInfo;
  /** 诊断信息是否已复制，用于按钮反馈 */
  copied?: boolean;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 仅记录错误摘要，不含敏感信息
    console.error('[D509] 页面异常:', error.message, info.componentStack?.slice(0, 200));
  }

  /** 诊断信息：路径 + 错误摘要 + 堆栈前 500 字 + 时间戳 */
  private buildDiagnostics(error: Error): string {
    const lines = [
      `时间: ${new Date().toISOString()}`,
      `路径: ${window.location.pathname}${window.location.search}`,
      `错误: ${error.message}`,
      `堆栈: ${(error.stack ?? '').slice(0, 500)}`,
    ];
    return lines.join('\n');
  }

  private async copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 非安全上下文下 clipboard 不可用，退回 execCommand
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const status: ErrorStatus = this.props.status ?? inferStatus(error.message);
    const meta = STATUS_TEXT[status];

    return (
      <Result
        status={status === 'error' ? 'error' : status}
        title={meta.title}
        subTitle={meta.subTitle}
        extra={[
          <Button
            key="reload"
            type="primary"
            icon={<ReloadOutlined />}
            onClick={() => {
              this.setState({ error: null });
              window.location.reload();
            }}
          >
            刷新页面
          </Button>,
          this.props.onRetry ? (
            <Button
              key="retry"
              icon={<ReloadOutlined />}
              onClick={() => {
                this.setState({ error: null });
                this.props.onRetry?.();
              }}
            >
              重试这一块
            </Button>
          ) : null,
          <Button key="home" icon={<HomeOutlined />} onClick={() => window.location.assign('/')}>
            返回首页
          </Button>,
        ]}
      >
        <Space orientation="vertical" size={12} style={{ width: '100%', maxWidth: 720, margin: '0 auto' }}>
          <Alert
            type="warning"
            showIcon
            title="错误摘要"
            description={
              <Typography.Text code copyable={{ text: error.message }} style={{ fontSize: 12, wordBreak: 'break-all' }}>
                {error.message}
              </Typography.Text>
            }
          />
          <Button
            icon={<CopyOutlined />}
            onClick={async () => {
              const ok = await this.copy(this.buildDiagnostics(error));
              this.setState({ copied: ok });
            }}
          >
            {this.state.copied ? '诊断信息已复制' : '复制诊断信息'}
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            诊断信息包含当前路径、错误摘要、堆栈前 500 字与时间戳，可直接粘贴反馈给管理员。
          </Typography.Text>
        </Space>
      </Result>
    );
  }
}

/**
 * 数据区块的错误边界：重试时同时让相关查询失效
 *
 * 页面级边界只能「刷新整页」；挂在单个卡片外层时，用户想重试的其实只有那一组查询，
 * 这里把两者的动作接上，其它区块保持原状。
 */
export function QueryErrorBoundary({
  children,
  queryKey,
}: {
  children: ReactNode;
  queryKey: QueryKey;
}) {
  const qc = useQueryClient();
  return (
    <ErrorBoundary onRetry={() => void qc.invalidateQueries({ queryKey })}>{children}</ErrorBoundary>
  );
}
