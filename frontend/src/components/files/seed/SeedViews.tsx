import { Card, Empty, Flex, Tag, Timeline, Tooltip, Typography } from "antd";
import {
  CalendarOutlined,
  ExperimentOutlined,
  FolderOpenOutlined,
  TagsOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";

import type { BaserowField, BaserowRow } from "../../../services/api";
import { selectLabel } from "./seedMeta";

/**
 * 种子台账的多种视图。
 *
 * 人因上的出发点：一台多维表格如果只有「一张横着的表」，用户要回答的问题
 * 各不相同，表格对其中大部分都不友好：
 * - 「这批材料是哪类突变？」→ 表格要横向扫一列，**看板**一眼可见
 * - 「什么时候入库的？批次节奏如何？」→ **时间线**按日期排，比表格直观
 * - 「这个编号对应的是谁、放在哪？」→ **卡片**把一行摊开成一张卡
 *
 * 三种视图都复用同一份行数据（不额外请求），切换不花时间。
 * 颜色来自 Baserow 的 select_options —— 突变类型的每个选项本来就带颜色，
 * 视图直接沿用，不在前端另定一套色板（避免两处颜色对不上）。
 */

export type SeedViewKey = "table" | "card" | "timeline" | "mutation";

export const SEED_VIEWS: {
  key: SeedViewKey;
  label: string;
  icon: React.ReactNode;
}[] = [
  { key: "table", label: "表格", icon: <TagsOutlined /> },
  { key: "card", label: "卡片", icon: <ExperimentOutlined /> },
  { key: "timeline", label: "时间线", icon: <CalendarOutlined /> },
  { key: "mutation", label: "突变类型", icon: <ExperimentOutlined /> },
];

function fieldValue(
  fields: BaserowField[],
  row: BaserowRow,
  names: string[],
): string {
  for (const n of names) {
    const f = fields.find((x) => x.name === n);
    if (!f) continue;
    const raw = row[n];
    if (raw === null || raw === undefined || raw === "") continue;
    if (f.type === "single_select") {
      const { label } = selectLabel(f, raw);
      if (label) return label;
    }
    return String(raw);
  }
  return "";
}

function fieldOf(
  fields: BaserowField[],
  names: string[],
): BaserowField | undefined {
  return fields.find((f) => names.includes(f.name));
}

/** 取某字段的显示色（single_select 的选项色）。 */
function colorOf(
  fields: BaserowField[],
  row: BaserowRow,
  names: string[],
): string | undefined {
  const f = fieldOf(fields, names);
  if (!f) return undefined;
  const { color } = selectLabel(f, row[names[0]]);
  return color;
}

export interface SeedViewsProps {
  view: SeedViewKey;
  fields: BaserowField[];
  rows: BaserowRow[];
  onOpenRow: (row: BaserowRow) => void;
}

/** 卡片视图：一行一张卡，把关键信息摊开。 */
function CardView({ fields, rows, onOpenRow }: Omit<SeedViewsProps, "view">) {
  if (!rows.length) return <Empty description="没有匹配的记录" />;
  const nameF = fieldOf(fields, ["名称", "品名", "编号"]);
  return (
    <div className="d509-grid d509-grid-sm">
      {rows.map((row) => {
        const name = nameF ? String(row[nameF.name] ?? "") : "";
        const code = fieldValue(fields, row, ["编号", "条码"]);
        const mutation = fieldValue(fields, row, ["突变类型"]);
        const gene = fieldValue(fields, row, ["突变基因"]);
        const qty = fieldValue(fields, row, ["数量", "库存量"]);
        const unit = fieldValue(fields, row, ["单位"]);
        const loc = fieldValue(fields, row, ["存放位置", "库位"]);
        const tags = fieldValue(fields, row, ["标签"]);
        const color = colorOf(fields, row, ["突变类型"]);
        return (
          <Card
            key={String(row.id)}
            size="small"
            hoverable
            onClick={() => onOpenRow(row)}
            styles={{ body: { padding: 12 } }}
            style={
              color
                ? { borderInlineStart: `3px solid var(--ant-color-${color})` }
                : undefined
            }
          >
            <Flex vertical gap={6}>
              <Flex align="center" justify="space-between" gap={8}>
                <Typography.Text
                  strong
                  ellipsis
                  style={{ flex: 1, fontSize: 13.5 }}
                >
                  {name || code || "未命名"}
                </Typography.Text>
                {mutation ? (
                  <Tag
                    color={color || "default"}
                    style={{ marginInlineEnd: 0, fontSize: 11 }}
                  >
                    {mutation}
                  </Tag>
                ) : null}
              </Flex>
              <Flex gap={8} wrap style={{ fontSize: 12 }}>
                {code ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {code}
                  </Typography.Text>
                ) : null}
                {qty ? (
                  <Typography.Text style={{ fontSize: 12 }}>
                    {qty}
                    {unit ? ` ${unit}` : ""}
                  </Typography.Text>
                ) : null}
              </Flex>
              {gene ? (
                <Typography.Text style={{ fontSize: 12 }}>
                  <ExperimentOutlined /> {gene}
                </Typography.Text>
              ) : null}
              {loc ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  <FolderOpenOutlined /> {loc}
                </Typography.Text>
              ) : null}
              {tags ? (
                <Flex gap={4} wrap>
                  {tags
                    .split(/[,，;；]/)
                    .map((t) => t.trim())
                    .filter(Boolean)
                    .map((t) => (
                      <Tag key={t} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                        {t}
                      </Tag>
                    ))}
                </Flex>
              ) : null}
            </Flex>
          </Card>
        );
      })}
    </div>
  );
}

/** 时间线视图：按入库日期排，一眼看出批次节奏。 */
function TimelineView({
  fields,
  rows,
  onOpenRow,
}: Omit<SeedViewsProps, "view">) {
  if (!rows.length) return <Empty description="没有匹配的记录" />;
  const dateF = fieldOf(fields, ["入库日期", "采集日期", "日期"]);
  const items = rows
    .map((row) => {
      const raw = dateF ? row[dateF.name] : null;
      const d = raw ? dayjs(String(raw)) : null;
      return { row, d: d && d.isValid() ? d : null };
    })
    .sort((a, b) => (b.d?.valueOf() ?? 0) - (a.d?.valueOf() ?? 0));

  return (
    <Timeline
      items={items.map(({ row, d }) => ({
        color: colorOf(fields, row, ["突变类型"]),
        dot: d ? (
          <span style={{ fontSize: 11 }}>{d.format("MM-DD")}</span>
        ) : undefined,
        children: (
          <Card
            size="small"
            hoverable
            onClick={() => onOpenRow(row)}
            styles={{ body: { padding: "8px 12px" } }}
          >
            <Flex align="center" justify="space-between" gap={8}>
              <Typography.Text strong ellipsis style={{ fontSize: 13 }}>
                {fieldValue(fields, row, ["名称", "品名", "编号"])}
              </Typography.Text>
              <Flex gap={6} align="center">
                {fieldValue(fields, row, ["突变类型"]) ? (
                  <Tag
                    color={colorOf(fields, row, ["突变类型"]) || "default"}
                    style={{ marginInlineEnd: 0, fontSize: 11 }}
                  >
                    {fieldValue(fields, row, ["突变类型"])}
                  </Tag>
                ) : null}
                {d ? (
                  <Tooltip title={d.format("YYYY-MM-DD")}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {d.format("YYYY-MM-DD")}
                    </Typography.Text>
                  </Tooltip>
                ) : null}
              </Flex>
            </Flex>
          </Card>
        ),
      }))}
    />
  );
}

/** 突变类型看板：按类型分列，列内按数量排。 */
function MutationView({
  fields,
  rows,
  onOpenRow,
}: Omit<SeedViewsProps, "view">) {
  if (!rows.length) return <Empty description="没有匹配的记录" />;
  const buckets = new Map<string, { rows: BaserowRow[]; color?: string }>();
  for (const row of rows) {
    const key = fieldValue(fields, row, ["突变类型"]) || "未标注";
    const bucket = buckets.get(key) ?? {
      rows: [],
      color: colorOf(fields, row, ["突变类型"]),
    };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  }
  // 列多的时候按记录数排：多的在前，先看到主要材料
  const ordered = [...buckets.entries()].sort(
    (a, b) => b[1].rows.length - a[1].rows.length,
  );
  return (
    <div
      style={{ display: "flex", gap: 14, overflowX: "auto", paddingBottom: 6 }}
    >
      {ordered.map(([key, bucket]) => (
        <div key={key} style={{ minWidth: 220, flex: "0 0 220px" }}>
          <Flex align="center" gap={6} style={{ marginBottom: 8 }}>
            <Tag
              color={bucket.color || "default"}
              style={{ marginInlineEnd: 0 }}
            >
              {key}
            </Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {bucket.rows.length}
            </Typography.Text>
          </Flex>
          <Flex vertical gap={8}>
            {bucket.rows.map((row) => {
              const name = fieldValue(fields, row, ["名称", "品名", "编号"]);
              const gene = fieldValue(fields, row, ["突变基因"]);
              const qty = fieldValue(fields, row, ["数量", "库存量"]);
              return (
                <Card
                  key={String(row.id)}
                  size="small"
                  hoverable
                  onClick={() => onOpenRow(row)}
                  styles={{ body: { padding: "8px 10px" } }}
                >
                  <Typography.Text
                    strong
                    ellipsis
                    style={{ display: "block", fontSize: 12.5 }}
                  >
                    {name || "未命名"}
                  </Typography.Text>
                  {gene ? (
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 11.5 }}
                    >
                      {gene}
                    </Typography.Text>
                  ) : null}
                  {qty ? (
                    <Typography.Text style={{ fontSize: 11.5 }}>
                      {qty}
                    </Typography.Text>
                  ) : null}
                </Card>
              );
            })}
          </Flex>
        </div>
      ))}
    </div>
  );
}

export default function SeedViews({
  view,
  fields,
  rows,
  onOpenRow,
}: SeedViewsProps) {
  if (view === "card")
    return <CardView fields={fields} rows={rows} onOpenRow={onOpenRow} />;
  if (view === "timeline") {
    return <TimelineView fields={fields} rows={rows} onOpenRow={onOpenRow} />;
  }
  if (view === "mutation") {
    return <MutationView fields={fields} rows={rows} onOpenRow={onOpenRow} />;
  }
  return null;
}
