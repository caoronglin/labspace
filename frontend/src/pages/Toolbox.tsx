import { useMemo } from 'react';
import { Flex, Tabs, Typography } from 'antd';
import { BarChartOutlined, ExperimentOutlined, PartitionOutlined } from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';
import PageShell from '../components/PageShell';
import Drawio from './Drawio';
import PlotStudio from './PlotStudio';
import Genomes from './Genomes';

/** 科研工具：流程图、绘图、基因组共用一套入口与权限，子页面仍可独立直达。 */
export default function Toolbox() {
  const [params, setParams] = useSearchParams();
  const tool = useMemo(() => {
    const v = params.get('tool');
    return v === 'plot' || v === 'genomes' ? v : 'drawio';
  }, [params]);

  return (
    <PageShell
      title="科研工具"
      description="流程图设计 · 绘图工作台 · 公共基因组，共用实验室账号与文件权限。"
    >
      <Tabs
        activeKey={tool}
        onChange={(key) => {
          const next = new URLSearchParams(params);
          next.set('tool', key);
          setParams(next, { replace: true });
        }}
        destroyOnHidden={false}
        tabBarStyle={{ marginBottom: 12 }}
        items={[
          {
            key: 'drawio',
            label: (
              <span>
                <PartitionOutlined /> 流程图
              </span>
            ),
            children: <Drawio embedded />,
          },
          {
            key: 'plot',
            label: (
              <span>
                <BarChartOutlined /> 绘图
              </span>
            ),
            children: <PlotStudio embedded />,
          },
          {
            key: 'genomes',
            label: (
              <span>
                <ExperimentOutlined /> 基因组
              </span>
            ),
            children: <Genomes embedded />,
          },
        ]}
      />
      <Flex justify="center">
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          在文件存储中选中的基因组会自动带到「基因组」标签；绘图结果可直接回写个人目录。
        </Typography.Text>
      </Flex>
    </PageShell>
  );
}