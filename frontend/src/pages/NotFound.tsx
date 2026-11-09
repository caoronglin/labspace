import { useState } from 'react';
import { Button, Card, Col, Flex, Input, Result, Row, Typography } from 'antd';
import {
  AppstoreOutlined,
  HomeOutlined,
  SearchOutlined,
  StarOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';

/** 常用入口：工作台 / 起始页 / 统一搜索 */
const ENTRIES = [
  { key: 'workbench', label: '工作台', desc: '回到常用任务面板', icon: <ToolOutlined />, path: '/workbench' },
  { key: 'start', label: '起始页', desc: '常用入口与工具', icon: <AppstoreOutlined />, path: '/start' },
  { key: 'search', label: '统一搜索', desc: '检索全站内容', icon: <StarOutlined />, path: '/search' },
];

export default function NotFound() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');

  return (
    <Result
      status="404"
      title="页面不存在"
      subTitle="该地址可能已失效，或链接有误。"
      extra={
        <Flex vertical gap={16} align="center" style={{ width: '100%', maxWidth: 640, margin: '0 auto' }}>
          <Input.Search
            allowClear
            enterButton="搜索"
            placeholder="在站内搜索服务、命令或资料"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onSearch={(v) => {
              const s = v.trim();
              if (s) navigate(`/search?q=${encodeURIComponent(s)}`);
            }}
            aria-label="站内搜索"
            style={{ width: '100%' }}
          />
          <Button type="primary" icon={<HomeOutlined />} onClick={() => navigate('/')}>
            返回首页
          </Button>
        </Flex>
      }
    >
      <Typography.Text type="secondary">或者从下面的常用入口继续：</Typography.Text>
      <Row gutter={[16, 16]} style={{ marginTop: 12, maxWidth: 720, marginInline: 'auto' }}>
        {ENTRIES.map((e) => (
          <Col key={e.key} xs={24} sm={8}>
            <Card
              size="small"
              hoverable
              onClick={() => navigate(e.path)}
              role="button"
              tabIndex={0}
              aria-label={`前往${e.label}`}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault();
                  navigate(e.path);
                }
              }}
            >
              <Flex gap={10} align="center">
                <span className="d509-icon" style={{ width: 32, height: 32, fontSize: 16, borderRadius: 8 }}>
                  {e.icon}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.25 }}>{e.label}</div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {e.desc}
                  </Typography.Text>
                </div>
              </Flex>
            </Card>
          </Col>
        ))}
      </Row>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 12 }}>
        <SearchOutlined /> 也可以在顶部搜索框直接搜索全站内容。
      </Typography.Text>
    </Result>
  );
}
