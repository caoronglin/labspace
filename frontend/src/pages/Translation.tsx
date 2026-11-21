import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Drawer,
  Empty,
  Flex,
  Input,
  Listy,
  Row,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  HistoryOutlined,
  ReloadOutlined,
  TranslationOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { errText } from '../utils/err';
import { tokens } from '../theme/tokens';
import { palette } from '../theme/palette';

const HISTORY_KEY = 'labspace-translate-history';
const HISTORY_LIMIT = 10;

const STYLE_OPTIONS = [
  { value: '技术论文', label: '技术论文' },
  { value: '学术严谨', label: '学术严谨' },
  { value: '日常口语', label: '日常口语' },
];

interface HistoryItem {
  text: string;
  translated: string;
  target_lang: string;
  time: string;
}

function readHistory(): HistoryItem[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((i): i is HistoryItem => !!i && typeof i.text === 'string');
  } catch {
    return [];
  }
}

function writeHistory(items: HistoryItem[]): void {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, HISTORY_LIMIT)));
  } catch {
    /* 本地存储不可用时忽略 */
  }
}

export default function Translation() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();

  const [source, setSource] = useState('');
  const [targetLang, setTargetLang] = useState('');
  const [style, setStyle] = useState('技术论文');
  const [terminology, setTerminology] = useState('');
  const [history, setHistory] = useState<HistoryItem[]>(() => readHistory());
  const [historyOpen, setHistoryOpen] = useState(false);

  const statusQuery = useQuery({
    queryKey: ['translate-status'],
    queryFn: () => api.translateStatus(),
    staleTime: 30_000,
    retry: false,
    // 一次性探测失败会把「不可用」一直挂在页面上：可用时 60 秒复查，不可用时 10 秒自动重试
    refetchInterval: (query) =>
      query.state.data ? (query.state.data.available ? 60_000 : 10_000) : false,
  });

  const status = statusQuery.data;
  const languages = useMemo(() => status?.languages ?? [], [status]);
  const langLabel = (value: string) => languages.find((l) => l.value === value)?.label ?? value;

  useEffect(() => {
    if (!targetLang && languages.length > 0) setTargetLang(languages[0].value);
  }, [languages, targetLang]);

  const maxChars = status?.maxChars ?? 0;
  const tooLong = maxChars > 0 && source.length > maxChars;

  const translateMutation = useMutation({
    mutationFn: async () => {
      if (!targetLang) throw new Error('请选择目标语言');
      return api.translateText(source.trim(), targetLang, style, terminology.trim());
    },
    onSuccess: (res) => {
      const item: HistoryItem = {
        text: source.trim(),
        translated: res.translated,
        target_lang: res.target_lang,
        time: new Date().toISOString(),
      };
      const next = [item, ...history].slice(0, HISTORY_LIMIT);
      setHistory(next);
      writeHistory(next);
      message.success('翻译完成');
    },
    onError: (e: Error) => message.error(`翻译失败：${errText(e)}`),
  });

  const result = translateMutation.data;

  const canSubmit =
    !tooLong &&
    source.trim().length > 0 &&
    !!targetLang &&
    (status?.effective_available ?? status?.available) !== false &&
    !translateMutation.isPending;

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success('已复制到剪贴板');
    } catch {
      message.error('复制失败');
    }
  };

  const downloadText = (text: string) => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `translation-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const applyHistory = (item: HistoryItem) => {
    setSource(item.text);
    setTargetLang(item.target_lang || targetLang);
    setHistoryOpen(false);
  };

  const clearHistory = () => {
    setHistory([]);
    writeHistory([]);
    message.success('历史记录已清空');
  };

  const unavailableReason =
    status && !status.available
      ? status.reason || `本地 Hy-MT2 服务未响应（${status.base_url || '模型服务'}）`
      : '';
  const fallbackReady = !!status?.fallback?.available;

  return (
    <Flex vertical gap={16}>
      <Flex align="center" justify="space-between" wrap gap={8}>
        <Typography.Title level={3} style={{ margin: 0, fontSize: 22 }}>
          <Space>
            <TranslationOutlined style={{ color: tokens.colorPrimary }} />
            文本翻译
          </Space>
        </Typography.Title>
        <Space>
          <Button icon={<HistoryOutlined />} onClick={() => setHistoryOpen(true)}>
            历史记录{history.length > 0 ? `（${history.length}）` : ''}
          </Button>
          <Button
            icon={<ReloadOutlined />}
            loading={statusQuery.isFetching}
            onClick={() => queryClient.invalidateQueries({ queryKey: ['translate-status'] })}
          >
            检查服务状态
          </Button>
        </Space>
      </Flex>

      {statusQuery.isLoading && (
        <Card size="small">
          <Flex justify="center">
            <Spin description="正在获取模型服务状态…" />
          </Flex>
        </Card>
      )}

      {statusQuery.isError && (
        <Alert
          type="error"
          showIcon
          title="获取服务状态失败"
          description={(statusQuery.error as Error)?.message || '无法连接后端服务'}
          action={
            <Button size="small" onClick={() => queryClient.invalidateQueries({ queryKey: ['translate-status'] })}>
              重试
            </Button>
          }
        />
      )}

      {status && !status.available && (
        <Alert
          type={fallbackReady ? 'info' : 'warning'}
          showIcon
          title={fallbackReady ? '本地 Hy-MT2 未就绪，已自动改用备用网关' : '翻译服务当前不可用'}
          description={
            fallbackReady
              ? `${unavailableReason}。当前使用备用网关（${status?.fallback?.provider} · ${status?.fallback?.model}），仅带风格/术语的请求会走此通道。`
              : unavailableReason
          }
          action={
            <Button size="small" onClick={() => queryClient.invalidateQueries({ queryKey: ['translate-status'] })}>
              检查服务状态
            </Button>
          }
        />
      )}

      {(status?.effective_available ?? status?.available) && (
        <Space wrap size={8}>
          <Tag color="blue" variant="filled">
            {status?.available ? status?.provider : status?.fallback?.provider}
          </Tag>
          <Tag>{status?.available ? status?.model : status?.fallback?.model}</Tag>
          {status?.available && status?.base_url && <Tag>接口 {status.base_url}</Tag>}
          {maxChars > 0 && <Tag>单次上限 {maxChars} 字</Tag>}
        </Space>
      )}

      <Row gutter={[16, 16]} align="stretch">
        <Col xs={24} lg={12}>
          <Card
            title="原文"
            size="small"
            style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
            styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column' } }}
          >
            <Input.TextArea
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="粘贴需要翻译的中文或英文内容"
              autoSize={{ minRows: 10, maxRows: 18 }}
              showCount
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}
            />
            {tooLong && (
              <Alert
                style={{ marginTop: 8 }}
                type="error"
                showIcon
                title={`超出模型单次长度上限（${maxChars} 字）`}
                description={`当前 ${source.length} 字，请拆分后再试。`}
              />
            )}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              字符数：{source.length}
              {maxChars > 0 ? ` / ${maxChars}` : ''}
            </Typography.Text>
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card
            title="译文"
            size="small"
            style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
            styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column' } }}
          >
            {translateMutation.isPending ? (
              <Flex vertical gap={12} align="center" justify="center" style={{ minHeight: 220 }}>
                <Spin description="翻译中…" />
              </Flex>
            ) : translateMutation.isError ? (
              <Alert
                type="error"
                showIcon
                title="翻译失败"
                description={(translateMutation.error as Error)?.message || '未知错误'}
                action={
                  <Button size="small" onClick={() => translateMutation.mutate()}>
                    重试
                  </Button>
                }
              />
            ) : result ? (
              <Flex vertical gap={12}>
                <div
                  style={{
                    background: palette.white,
                    border: `1px solid ${tokens.colorBorder}`,
                    borderRadius: 10,
                    padding: 16,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    fontSize: 14,
                    lineHeight: 1.7,
                  }}
                >
                  {result.translated}
                </div>
                <Flex gap={8} wrap align="center">
                  <Tag icon={<ClockCircleOutlined />} variant="filled">
                    耗时 {result.elapsed_ms} ms
                  </Tag>
                  <Tag icon={<CheckCircleOutlined />}>{result.model}</Tag>
                  {result.provider && <Tag color="cyan">{result.provider}</Tag>}
                  {result.fallback_used && <Tag color="orange">本地引擎回退</Tag>}
                  <Tag>目标语言：{langLabel(result.target_lang)}</Tag>
                  {result.usage?.input != null && <Tag>输入 {result.usage.input} tokens</Tag>}
                  {result.usage?.output != null && <Tag>输出 {result.usage.output} tokens</Tag>}
                </Flex>
                <Space>
                  <Button icon={<CopyOutlined />} onClick={() => copyText(result.translated)}>
                    复制
                  </Button>
                  <Button icon={<DownloadOutlined />} onClick={() => downloadText(result.translated)}>
                    下载 .txt
                  </Button>
                </Space>
              </Flex>
            ) : (
              <Empty description="暂无译文，粘贴原文后点击左侧「翻译」按钮" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
          </Card>
        </Col>
      </Row>

      <Card title="翻译选项" size="small">
        <Row gutter={[16, 16]}>
          <Col xs={24} md={8}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              目标语言
            </Typography.Text>
            <Select
              style={{ width: '100%', marginTop: 6 }}
              value={targetLang || undefined}
              placeholder="选择目标语言"
              onChange={setTargetLang}
              options={languages.map((l) => ({ value: l.value, label: l.label }))}
              loading={statusQuery.isLoading}
            />
          </Col>
          <Col xs={24} md={8}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              文体
            </Typography.Text>
            <Select
              style={{ width: '100%', marginTop: 6 }}
              value={style}
              onChange={setStyle}
              options={STYLE_OPTIONS}
            />
          </Col>
          <Col xs={24} md={8}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              术语表（可选，逗号分隔）
            </Typography.Text>
            <Input
              style={{ width: '100%', marginTop: 6 }}
              value={terminology}
              onChange={(e) => setTerminology(e.target.value)}
              placeholder="例如：CRISPR, gRNA, 脱靶"
            />
          </Col>
        </Row>
        <Flex gap={8} style={{ marginTop: 16 }} align="center">
          <Button
            type="primary"
            loading={translateMutation.isPending}
            disabled={!canSubmit}
            onClick={() => translateMutation.mutate()}
          >
            翻译
          </Button>
          {tooLong && (
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              超出模型单次长度上限（{maxChars} 字）
            </Typography.Text>
          )}
        </Flex>
      </Card>

      <Drawer
        title="翻译历史（最近 10 条）"
        placement="right"
        size="default"
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        extra={
          <Button size="small" icon={<DeleteOutlined />} onClick={clearHistory} disabled={history.length === 0}>
            清空
          </Button>
        }
      >
        {history.length === 0 ? (
          <Empty description="暂无历史记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Listy
            items={history}
            rowKey={(item) => `${item.time}-${item.text.slice(0, 12)}`}
            itemRender={(item) => (
              <div style={{ cursor: 'pointer' }} onClick={() => applyHistory(item)}>
                <Typography.Text ellipsis style={{ maxWidth: 260, display: 'block' }}>
                  {item.text}
                </Typography.Text>
                <Space size={6} wrap style={{ marginTop: 4 }}>
                  <Tag>{langLabel(item.target_lang)}</Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {new Date(item.time).toLocaleString('zh-CN')}
                  </Typography.Text>
                </Space>
              </div>
            )}
          />
        )}
      </Drawer>
    </Flex>
  );
}
