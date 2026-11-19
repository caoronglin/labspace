/**
 * 通用时间线视图：把文件条目按日期分组铺成一条时间轴。
 *
 * 用途不同、时间含义不同的存储都可以复用它：
 * - 课题资料 → groupBy="created"（按加入时间）
 * - 组会汇报 → groupBy="modified"（按汇报周期内的最新改动）
 * - 种子管理 → 外部按出入库日期喂数据，本组件只负责渲染
 *
 * 组件本身不碰接口也不做权限判断：点击条目后的行为交给调用方的 onOpen。
 */
import { useMemo, type ReactNode } from 'react';
import { Empty, Flex, Tag, Timeline, Tooltip, Typography } from 'antd';
import type { FileEntry } from '../../services/api';
import { fileVisual, formatSize, formatTime } from './fileMeta';

export interface TimelineViewProps {
  entries: FileEntry[];
  /** 分组依据：created=加入时间，modified=最后修改时间；默认按修改时间。 */
  groupBy?: 'created' | 'modified';
  /** 空列表时的提示文案。 */
  emptyText?: string;
  /** 点击条目回调；不传则条目不可点击。 */
  onOpen?: (entry: FileEntry) => void;
  /** 条目右侧的附加操作（如文件页的“更多操作”菜单）；不传则不渲染。 */
  renderActions?: (entry: FileEntry) => ReactNode;
}

/** 时间桶：越靠前的时间越新。 */
type TimeBucket = 'today' | 'yesterday' | 'week' | 'earlier';

const BUCKET_ORDER: TimeBucket[] = ['today', 'yesterday', 'week', 'earlier'];

const BUCKET_LABEL: Record<TimeBucket, string> = {
  today: '今天',
  yesterday: '昨天',
  week: '本周',
  earlier: '更早',
};

const DAY_MS = 86_400_000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 本周从周一开始算（周一 00:00 到今天）。 */
function startOfWeek(d: Date): number {
  const daysSinceMonday = (d.getDay() + 6) % 7;
  return startOfDay(d) - daysSinceMonday * DAY_MS;
}

function bucketOf(ts: number, now: Date): TimeBucket {
  const today = startOfDay(now);
  if (ts >= today) return 'today';
  if (ts >= today - DAY_MS) return 'yesterday';
  if (ts >= startOfWeek(now)) return 'week';
  return 'earlier';
}

function entryTime(entry: FileEntry, groupBy: 'created' | 'modified'): string {
  return groupBy === 'created' ? entry.created : entry.modified;
}

/** 单条时间线条目：名称 + 大小 + 时间，整行可点、可键盘触发。 */
function TimelineEntry({
  entry,
  time,
  onOpen,
  renderActions,
}: {
  entry: FileEntry;
  time: string;
  onOpen?: (entry: FileEntry) => void;
  renderActions?: (entry: FileEntry) => ReactNode;
}) {
  const actionable = Boolean(onOpen);
  return (
    <div
      role="button"
      tabIndex={actionable ? 0 : -1}
      aria-label={`${entry.name}${entry.dir ? '（文件夹）' : ''}`}
      onClick={() => onOpen?.(entry)}
      onKeyDown={(e) => {
        if (!onOpen) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(entry);
        }
      }}
      style={{ cursor: actionable ? 'pointer' : 'default' }}
    >
      <Flex align="center" gap={10} wrap>
        <Tooltip title={entry.name}>
          <Typography.Text strong ellipsis style={{ maxWidth: 320 }}>
            {entry.name}
          </Typography.Text>
        </Tooltip>
        <Tag variant="filled">{entry.dir ? '文件夹' : formatSize(entry.size)}</Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {formatTime(time)}
        </Typography.Text>
        {renderActions ? (
          <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            {renderActions(entry)}
          </span>
        ) : null}
      </Flex>
      <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, display: 'block' }}>
        {entry.path}
      </Typography.Text>
    </div>
  );
}

export default function TimelineView({
  entries,
  groupBy = 'modified',
  emptyText = '暂无文件',
  onOpen,
  renderActions,
}: TimelineViewProps) {
  const groups = useMemo(() => {
    const now = new Date();
    const buckets = new Map<TimeBucket, { entry: FileEntry; time: string }[]>();
    for (const entry of entries) {
      const raw = entryTime(entry, groupBy);
      const ts = new Date(raw).getTime();
      if (Number.isNaN(ts)) continue;
      const bucket = bucketOf(ts, now);
      const list = buckets.get(bucket) ?? [];
      list.push({ entry, time: raw });
      buckets.set(bucket, list);
    }
    // 组内按时间倒序：最近改动的排最前。
    for (const list of buckets.values()) {
      list.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
    }
    return buckets;
  }, [entries, groupBy]);

  const visible = BUCKET_ORDER.filter((b) => (groups.get(b) ?? []).length > 0);
  if (!visible.length) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />;
  }

  return (
    <Flex vertical gap={16}>
      {visible.map((bucket) => {
        const list = groups.get(bucket) ?? [];
        return (
          <div key={bucket}>
            <Flex align="center" gap={8} style={{ marginBottom: 8 }}>
              <Tag color="blue" variant="filled">
                {BUCKET_LABEL[bucket]}
              </Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {list.length} 项
              </Typography.Text>
            </Flex>
            <Timeline
              items={list.map(({ entry, time }) => {
                const visual = fileVisual(entry.name, entry.dir);
                return {
                  key: entry.id,
                  color: 'gray' as const,
                  icon: (
                    <span style={{ color: visual.color, fontSize: 14, lineHeight: 1 }}>
                      {visual.icon}
                    </span>
                  ),
                  children: (
                    <TimelineEntry
                      entry={entry}
                      time={time}
                      onOpen={onOpen}
                      renderActions={renderActions}
                    />
                  ),
                };
              })}
            />
          </div>
        );
      })}
    </Flex>
  );
}
