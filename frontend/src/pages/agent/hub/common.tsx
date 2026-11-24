import type { ReactNode } from 'react';
import { Alert, Button, Empty, Skeleton } from 'antd';
import { AsApiError } from '../../../services/agentscope';

/**
 * 上游错误 → 一句人能读懂的原因。
 *
 * 能力中心的所有数据都来自 AgentScope，上游挂掉 / 未启用 / 参数非法时页面要能
 * 说清「为什么没有数据」，所以这里把状态码和上游 `detail` 都带上。
 */
import { formatDateTime, formatSize } from '../../../utils/format';
export function asErrorText(err: unknown): string {
  if (err instanceof AsApiError) {
    if (err.status === 404) return `接口不存在或该能力未启用（404）：${err.message}`;
    return `请求失败（HTTP ${err.status}）：${err.message}`;
  }
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return '未知错误';
}

/** 错误态：说明「暂不可用」的原因，并给一个重试入口。 */
export function AsErrorAlert({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Alert
      type="error"
      showIcon
      title="该能力暂不可用"
      description={asErrorText(error)}
      action={
        onRetry ? (
          <Button size="small" onClick={onRetry}>
            重试
          </Button>
        ) : undefined
      }
    />
  );
}

/** 加载态：骨架屏，不用假数据占位。 */
export function AsLoading({ rows = 4 }: { rows?: number }) {
  return <Skeleton active paragraph={{ rows }} />;
}

/** 空态：说明为什么是空的，并给出主行动。 */
export function AsEmpty({ description, action }: { description: string; action?: ReactNode }) {
  return (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={description}>
      {action}
    </Empty>
  );
}

/** 时间格式化：上游给的是 ISO 字符串，展示成本地时间。 */
/** 字节数格式化。 */
// 兼容旧名：这些函数被多处引用，统一实现后仍按原名导出。
export { formatSize as formatBytes, formatDateTime as formatTime };
