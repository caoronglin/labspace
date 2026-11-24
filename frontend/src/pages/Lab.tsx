import { useState } from 'react';
import { Alert, App, Button, Space, Tooltip } from 'antd';
import { SyncOutlined } from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';
import { Navigate, useLocation, useSearchParams } from 'react-router-dom';
import PageShell from '../components/PageShell';
import { useAuth } from '../app/AuthContext';
import { api } from '../services/api';
import BaserowPage from './BaserowPage';

/**
 * 多维表格空间。
 *
 * 定位变化：这里原来是「实验室中心（库存 + 生信流水线）」。流水线已下线，
 * 库存台账也已并入多维表格 —— 库存作为多维表格里的一个工作区（实验室物资）
 * 管理，不再是独立页签；页面只保留多维表格本身。
 */
export default function Lab() {
  const [params] = useSearchParams();
  const location = useLocation();
  const { isAdmin } = useAuth();
  const { message } = App.useApp();
  const [mergedNotice, setMergedNotice] = useState(
    Boolean((location.state as { inventoryMerged?: boolean } | null)?.inventoryMerged),
  );

  const publish = useMutation({
    mutationFn: () => api.labopsPublishInventory(),
    onSuccess: (data) => {
      const detail = data.tables.map((t) => `${t.name} ${t.rows} 行`).join('，');
      message.success(
        `库存已同步到多维表格：工作区「${data.workspaceName}」/ 数据库「${data.databaseName}」（${detail}）`,
      );
    },
    onError: (error) => {
      message.error(`同步库存失败：${error instanceof Error ? error.message : String(error)}`);
    },
  });

  if (params.get('tab') === 'bookings') return <Navigate to="/workbench?tab=records" replace />;
  if (params.get('tab') === 'eln') return <Navigate to="/workbench?tab=records" replace />;
  // 旧深链：流水线已下线，统一回到表格视图
  if (params.get('tab') === 'pipelines') return <Navigate to="/lab" replace />;
  // 旧深链：库存台账已并入多维表格
  if (params.get('tab') === 'inventory') {
    return <Navigate to="/lab?tab=tables" replace state={{ inventoryMerged: true }} />;
  }

  return (
    <PageShell
      title="多维表格空间"
      description="实验数据、样品台账与项目清单共用一套表格：表格 / 画廊 / 看板 / 日历视图，支持 CSV 导入导出与成员权限。"
      extra={
        <Space size={8} wrap>
          {isAdmin ? (
          <Tooltip title="把本地库存台账发布为多维表格里的工作区「实验室物资」（重复点击不会重复写入）">
            <Button
              icon={<SyncOutlined />}
              loading={publish.isPending}
              onClick={() => publish.mutate()}
            >
              把库存同步到多维表格
            </Button>
          </Tooltip>
          ) : null}
        </Space>
      }
    >
      <Space orientation="vertical" size={12} style={{ width: '100%' }}>
        {mergedNotice ? (
          <Alert
            type="info"
            showIcon
            closable={{ onClose: () => setMergedNotice(false) }}
            title="库存台账"
            description="库存台账不再单独作为页签，请在多维表格里打开工作区「实验室物资」。"
          />
        ) : null}
        {/* 不用 iframe 嵌 Baserow：这里是我们自己调 Baserow API 渲染的原生页面
            （字段类型、视图、附件、成员等都在门户内完成，不需要二次登录）。 */}
        <BaserowPage embedded />
      </Space>
    </PageShell>
  );
}
