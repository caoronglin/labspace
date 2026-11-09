import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { Empty, Flex, Input, Modal, Spin, Tag, Typography, type InputRef } from 'antd';
import {
  AppstoreOutlined,
  ArrowRightOutlined,
  ConsoleSqlOutlined,
  DatabaseOutlined,
  BugOutlined,
  EyeOutlined,
  FileSearchOutlined,
  HomeOutlined,
  SearchOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { api, type CorpusItem } from '../services/api';
import { useAuth } from '../app/AuthContext';
import { useNavCommands } from '../app/useNavCommands';
import { nativeRouteOf } from '../utils/serviceRoute';

const TYPE_META: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  service: { label: '服务', icon: <AppstoreOutlined />, color: '#2B5CE6' },
  database: { label: '植物库', icon: <DatabaseOutlined />, color: '#12A594' },
  command: { label: '命令', icon: <ConsoleSqlOutlined />, color: '#7C3AED' },
  tool: { label: '工具', icon: <ToolOutlined />, color: '#D97706' },
  page: { label: '页面', icon: <HomeOutlined />, color: '#64748B' },
  snapotter: { label: '文件工坊', icon: <ThunderboltOutlined />, color: '#0891B2' },
};

const GROUP_ORDER = ['page', 'service', 'tool', 'snapotter', 'database', 'command'];

interface NavCommandLike {
  id: string; label: string; hint?: string; icon: React.ReactNode; run: () => void;
}

/** 命令面板里的一条候选：要么是页面命令，要么是语料命中 */
type Entry =
  | { kind: 'nav'; id: string; label: string; hint?: string; icon: React.ReactNode; run: () => void }
  | { kind: 'corpus'; id: string; item: CorpusItem; run: () => void };

/**
 * 命令面板（⌘K / Ctrl+K）
 *
 * 三个来源合并成一个列表：
 * 1. 页面命令（来自导航注册表，最近访问过的会被提前）；
 * 2. 统一语料 /api/corpus（服务、工具、植物库、Linux 命令、内嵌页）；
 * 3. 都为空时给一条「去统一搜索页」的兜底，而不是让人对着空列表发呆。
 */
export default function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<InputRef>(null);

  const { commands: navCommands } = useNavCommands({ query: q, isAdmin });

  // 全局面板动作：不依赖路由，登录页/起始页也可直达
  const panelCommands = useMemo<NavCommandLike[]>(() => [
    {
      id: 'panel:debug', label: '打开全局 Debug', hint: '运行时诊断 / 服务健康（⌘⇧D）',
      icon: <BugOutlined />,
      run: () => window.dispatchEvent(new CustomEvent('d509:debug')),
    },
    {
      id: 'panel:preview', label: '预览本地文件', hint: '有界派生预览，不上传原始字节',
      icon: <EyeOutlined />,
      run: () => window.dispatchEvent(new CustomEvent('d509:preview')),
    },
  ].filter((c) => isAdmin && (!q.trim() || `${c.label}${c.hint}`.toLowerCase().includes(q.trim().toLowerCase()))), [isAdmin, q]);

  const { data, isFetching } = useQuery({
    queryKey: ['corpus', q],
    queryFn: () => api.corpus(q, 40),
    enabled: open,
    staleTime: 30_000,
    retry: false,
  });

  const goCorpus = (it: CorpusItem) => {
    onClose();
    if (it.type === 'service') {
      navigate(nativeRouteOf({ url: it.url }) ?? `/services/${it.id}`);
    } else if (it.path.startsWith('/')) {
      navigate(it.path);
    } else if (it.url) {
      window.open(it.url, '_blank', 'noreferrer');
    }
  };

  const entries = useMemo<Entry[]>(() => {
    const nav: Entry[] = [...panelCommands, ...navCommands].map((c) => ({
      kind: 'nav',
      id: c.id,
      label: c.label,
      hint: c.hint,
      icon: c.icon,
      run: c.run,
    }));

    const navPaths = new Set(navCommands.map((c) => c.id.replace('nav:', '')));
    const seen = new Set<string>();
    const corpus: Entry[] = [];
    for (const it of data?.items ?? []) {
      // 页面类语料已经由注册表覆盖，去重避免同一个去处出现两次；标题相同的也去重
      if (it.type === 'page' && navPaths.has(it.path)) continue;
      const rid = `${it.type}:${it.id}`;
      if (seen.has(rid) || seen.has(it.title)) continue;
      seen.add(rid);
      seen.add(it.title);
      corpus.push({ kind: 'corpus', id: rid, item: it, run: () => goCorpus(it) });
    }
    return [...nav, ...corpus];
  }, [panelCommands, navCommands, data, onClose, navigate]);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [q]);

  // 列表变化后（异步语料回来）把选中项夹回合法范围，避免越界访问 undefined
  useEffect(() => {
    setActive((i) => (entries.length === 0 ? 0 : Math.min(i, entries.length - 1)));
  }, [entries.length]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, entries.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = entries[active];
      if (hit) {
        // 任何动作执行后都收起面板；否则键盘打开的 Debug 面板会被 cmdk 盖住
        onClose();
        hit.run();
      } else if (q.trim()) {
        onClose();
        navigate(`/search?q=${encodeURIComponent(q.trim())}`);
      }
    }
  };

  const navEntries = entries.filter((e): e is Extract<Entry, { kind: 'nav' }> => e.kind === 'nav');
  const corpusEntries = entries.filter((e): e is Extract<Entry, { kind: 'corpus' }> => e.kind === 'corpus');

  const groups = useMemo(() => {
    const map = new Map<string, Extract<Entry, { kind: 'corpus' }>[]>();
    for (const e of corpusEntries) {
      const arr = map.get(e.item.type) ?? [];
      arr.push(e);
      map.set(e.item.type, arr);
    }
    return GROUP_ORDER.filter((t) => map.has(t)).map((t) => ({ type: t, list: map.get(t)! }));
  }, [corpusEntries]);

  const rowStyle = (on: boolean): CSSProperties => ({
    padding: '8px 10px',
    borderRadius: 8,
    cursor: 'pointer',
    background: on ? 'rgba(43, 92, 230, 0.08)' : 'transparent',
  });

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={640}
      destroyOnHidden
      styles={{ body: { padding: 0, overflow: 'hidden' } }}
      title={null}
    >
      <div
        className="d509-cmdk-input"
        style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--ant-color-border-secondary, #eef0f4)' }}
      >
        <Flex gap={10} align="center">
          <SearchOutlined style={{ color: '#97A3B4', fontSize: 16 }} />
          <Input
            ref={inputRef}
            variant="borderless"
            placeholder="跳转页面、打开服务、查命令…（回车直接去搜索也行）"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            style={{ fontSize: 16, padding: 0 }}
          />
          {isFetching && <Spin size="small" />}
        </Flex>
      </div>

      <div style={{ maxHeight: 420, overflowY: 'auto', padding: '4px 8px 10px' }}>
        {/* -------------------------------------------------- 页面命令 */}
        {navEntries.length > 0 && (
          <div>
            <div className="d509-cmdk-group-title">页面</div>
            {navEntries.map((e) => {
              const idx = entries.indexOf(e);
              const on = idx === active;
              return (
                <Flex
                  key={e.id}
                  gap={10}
                  align="center"
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => {
                    onClose();
                    e.run();
                  }}
                  style={rowStyle(on)}
                >
                  <span style={{ color: '#2B5CE6', display: 'inline-flex', width: 18 }}>{e.icon}</span>
                  <Typography.Text strong style={{ fontSize: 13.5, flexShrink: 0 }}>
                    {e.label}
                  </Typography.Text>
                  {e.hint && (
                    <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, minWidth: 0, flex: 1 }}>
                      {e.hint}
                    </Typography.Text>
                  )}
                  {on && <ArrowRightOutlined style={{ color: '#2B5CE6', fontSize: 12 }} />}
                </Flex>
              );
            })}
          </div>
        )}

        {/* -------------------------------------------------- 语料命中 */}
        {groups.map((g) => {
          const meta = TYPE_META[g.type] ?? { label: g.type, icon: <FileSearchOutlined />, color: '#64748B' };
          return (
            <div key={g.type}>
              <div className="d509-cmdk-group-title">{meta.label}</div>
              {g.list.map((e) => {
                const idx = entries.indexOf(e);
                const on = idx === active;
                return (
                  <Flex
                    key={e.id}
                    gap={10}
                    align="center"
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => {
                      onClose();
                      e.run();
                    }}
                    style={rowStyle(on)}
                  >
                    <span style={{ color: meta.color, display: 'inline-flex', width: 18 }}>{meta.icon}</span>
                    <Typography.Text strong style={{ fontSize: 13.5, minWidth: 0, flexShrink: 0 }}>
                      {e.item.title}
                    </Typography.Text>
                    {e.item.subtitle && (
                      <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, minWidth: 0, flex: 1 }}>
                        {e.item.subtitle}
                      </Typography.Text>
                    )}
                    {on && <ArrowRightOutlined style={{ color: meta.color, fontSize: 12 }} />}
                  </Flex>
                );
              })}
            </div>
          );
        })}

        {/* -------------------------------------------------- 空态 / 兜底 */}
        {entries.length === 0 && (
          <div style={{ padding: '28px 16px' }}>
            {q.trim() ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <Flex vertical gap={8} align="center">
                    <span>面板里没有匹配「{q.trim()}」的内容</span>
                    <Typography.Link
                      onClick={() => {
                        onClose();
                        navigate(`/search?q=${encodeURIComponent(q.trim())}`);
                      }}
                      style={{ fontSize: 13 }}
                    >
                      去统一搜索页查一遍 <ArrowRightOutlined style={{ fontSize: 10 }} />
                    </Typography.Link>
                  </Flex>
                }
              />
            ) : (
              <Flex gap={6} wrap justify="center" style={{ padding: '10px 0' }}>
                {(data?.items ?? []).slice(0, 12).map((it) => (
                  <Tag
                    key={`${it.type}-${it.id}`}
                    variant="filled"
                    style={{ cursor: 'pointer', padding: '4px 10px', borderRadius: 8 }}
                    onClick={() => goCorpus(it)}
                  >
                    {it.title}
                  </Tag>
                ))}
              </Flex>
            )}
          </div>
        )}
      </div>

      <Flex
        gap={14}
        align="center"
        justify="flex-end"
        style={{ padding: '8px 14px', borderTop: '1px solid var(--ant-color-border-secondary, #eef0f4)', fontSize: 12 }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          <span className="d509-kbd">↑</span> <span className="d509-kbd">↓</span> 选择
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          <span className="d509-kbd">Enter</span> 打开
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          <span className="d509-kbd">Esc</span> 关闭
        </Typography.Text>
      </Flex>
    </Modal>
  );
}
