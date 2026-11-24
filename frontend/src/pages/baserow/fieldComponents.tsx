import { useRef, useState } from "react";
import { App, Button, Card, DatePicker, Flex, Input, InputNumber, Rate, Select, Space, Switch, Tag, Typography, Upload } from "antd";
import { AppstoreOutlined, BarsOutlined, CalendarOutlined, CommentOutlined, DeleteOutlined, FormOutlined, PaperClipOutlined, ProfileOutlined, TableOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import { baserowApi, type BaserowField, type BaserowFile, type BaserowLinkRow, type BaserowPerson, type BaserowRowComment } from "../../services/api";
import { errText } from "../../utils/err";

/** 可编辑字段类型：其余类型（公式/查找/汇总/自动编号等）由 Baserow 计算，只读置灰。 */
export const EDITABLE = new Set([
  "text",
  "long_text",
  "number",
  "rating",
  "boolean",
  "date",
  "url",
  "email",
  "phone_number",
  "single_select",
  "multiple_select",
  "people",
  "file",
  "duration",
  "password",
  "link_row",
]);
/** 只读字段类型 → 置灰提示文案。 */
export const READ_ONLY_HINTS: Record<string, string> = {
  formula: "公式字段由 Baserow 自动计算，不可编辑",
  lookup: "查找字段的值来自关联表，不可编辑",
  rollup: "汇总字段由 Baserow 自动统计，不可编辑",
  autonumber: "自动编号由 Baserow 生成，不可编辑",
  uuid: "UUID 由 Baserow 生成，不可编辑",
  created_on: "创建时间由 Baserow 记录，不可编辑",
  last_modified_on: "最后修改时间由 Baserow 记录，不可编辑",
  created_by: "创建人由 Baserow 记录，不可编辑",
  last_modified_by: "最后修改人由 Baserow 记录，不可编辑",
  count: "计数字段由 Baserow 自动统计，不可编辑",
  button: "按钮字段不支持直接编辑",
  multiple_collaborators: "多协作者字段暂不支持编辑",
};
export const FIELD_TYPES = [
  { value: "text", label: "单行文本" },
  { value: "long_text", label: "多行文本" },
  { value: "number", label: "数字" },
  { value: "rating", label: "评分" },
  { value: "boolean", label: "是 / 否" },
  { value: "date", label: "日期" },
  { value: "url", label: "链接" },
  { value: "email", label: "邮箱" },
  { value: "phone_number", label: "电话" },
  { value: "duration", label: "时长" },
  { value: "password", label: "密码" },
  { value: "single_select", label: "单选" },
  { value: "multiple_select", label: "多选" },
  { value: "people", label: "人员（系统账号）" },
];
export const FIELD_TYPE_LABELS: Record<string, string> = {
  people: "人员",
  single_select: "单选",
  multiple_select: "多选",
  long_text: "多行文本",
  text: "文本",
  number: "数字",
  rating: "评分",
  boolean: "是 / 否",
  date: "日期",
  url: "链接",
  email: "邮箱",
  phone_number: "电话",
  duration: "时长",
  password: "密码",
  link_row: "关联",
  file: "文件",
  formula: "公式",
  lookup: "查找",
  rollup: "汇总",
  autonumber: "自动编号",
  created_on: "创建时间",
  last_modified_on: "最后修改",
  count: "计数",
};
export const ROLE_OPTIONS = [
  { value: "ADMIN", label: "管理员" },
  { value: "MEMBER", label: "成员" },
  { value: "VIEWER", label: "只读" },
];
/** 视图类型 → 展示图标与中文名（Baserow 支持 grid/gallery/kanban/calendar/form）。 */
export const VIEW_TYPE_META: Record<string, { label: string; icon: React.ReactNode }> =
  {
    grid: { label: "表格", icon: <TableOutlined /> },
    gallery: { label: "画廊", icon: <AppstoreOutlined /> },
    kanban: { label: "看板", icon: <ProfileOutlined /> },
    calendar: { label: "日历", icon: <CalendarOutlined /> },
    form: { label: "表单", icon: <FormOutlined /> },
    timeline: { label: "时间线", icon: <BarsOutlined /> },
  };
export const VIEW_TYPE_OPTIONS = Object.entries(VIEW_TYPE_META).map(
  ([value, meta]) => ({
    value,
    label: meta.label,
  }),
);
/** 视图筛选条件类型（Baserow 的 view filter type）。 */
export const FILTER_TYPE_OPTIONS = [
  { value: "equal", label: "等于" },
  { value: "not_equal", label: "不等于" },
  { value: "contains", label: "包含" },
  { value: "contains_not", label: "不包含" },
  { value: "starts_with", label: "开头是" },
  { value: "higher_than", label: "大于" },
  { value: "higher_than_or_equal", label: "大于等于" },
  { value: "lower_than", label: "小于" },
  { value: "lower_than_or_equal", label: "小于等于" },
  { value: "date_is", label: "日期等于" },
  { value: "date_is_before", label: "日期早于" },
  { value: "date_is_after", label: "日期晚于" },
];
/** 附件上传的扩展名白名单（与后端 /api/baserow/tables/{id}/files 保持一致）。 */
const FILE_ACCEPT = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "docx",
  "xlsx",
  "pptx",
  "csv",
  "txt",
  "md",
  "zip",
  "tif",
  "tiff",
  "fasta",
  "fa",
  "gtf",
  "gff",
  "bed",
  "bam",
  "vcf",
  "gz",
]
  .map((ext) => `.${ext}`)
  .join(",");

export function optionId(value: unknown): number | string | undefined {
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    return (v.id as number) ?? (v.value as string);
  }
  return value as number | string | undefined;
}

function selectLabel(
  field: BaserowField,
  value: unknown,
): { label: string; color?: string } {
  const id = optionId(value);
  const hit = field.select_options.find((o) => o.id === id || o.value === id);
  return { label: hit?.value ?? String(id ?? ""), color: hit?.color };
}

function personRowId(value: unknown): number | undefined {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>).id
      : value;
  const id = Number(raw);
  return Number.isFinite(id) ? id : undefined;
}

function personLabel(
  value: unknown,
  peopleByRow?: Map<number, BaserowPerson>,
): string {
  const id = personRowId(value);
  if (id === undefined) return "";
  const person = peopleByRow?.get(id);
  if (person) return person.displayName;
  if (value && typeof value === "object") {
    const raw = (value as Record<string, unknown>).value;
    if (raw !== undefined && raw !== null && raw !== "") return String(raw);
  }
  return peopleByRow ? `#${id}` : String(id);
}

function linkRowIds(value: unknown): number[] {
  const list = Array.isArray(value)
    ? value
    : value === null || value === undefined
      ? []
      : [value];
  return list
    .map((v) =>
      v && typeof v === "object" ? (v as Record<string, unknown>).id : v,
    )
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
}

export function plainText(
  field: BaserowField | undefined,
  value: unknown,
  peopleByRow?: Map<number, BaserowPerson>,
): string {
  if (value === null || value === undefined || value === "") return "";
  if (field?.type === "people") {
    if (Array.isArray(value))
      return value
        .map((v) => personLabel(v, peopleByRow))
        .filter(Boolean)
        .join(", ");
    return personLabel(value, peopleByRow);
  }
  if (field?.type === "link_row") {
    const ids = linkRowIds(value);
    return ids.length ? ids.map((id) => `#${id}`).join(", ") : "";
  }
  if (field?.type === "single_select") return selectLabel(field, value).label;
  if (field?.type === "multiple_select" && Array.isArray(value)) {
    return value.map((v) => selectLabel(field, v).label).join(", ");
  }
  if (field?.type === "boolean") return value ? "是" : "否";
  if (field?.type === "duration") return formatDuration(value);
  if (field?.type === "password") return value ? "已设置" : "";
  if (field?.type === "date" && typeof value === "string") {
    const d = dayjs(value);
    return d.isValid() ? d.format("YYYY-MM-DD") : value;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function dateKey(value: unknown): string {
  if (!value) return "";
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    const inner = v.value ?? v.date ?? v.start;
    return inner ? dateKey(inner) : "";
  }
  const d = dayjs(String(value));
  return d.isValid() ? d.format("YYYY-MM-DD") : "";
}

export function renderValue(
  field: BaserowField,
  value: unknown,
  peopleByRow?: Map<number, BaserowPerson>,
) {
  if (value === null || value === undefined || value === "")
    return <Typography.Text type="secondary">—</Typography.Text>;
  if (field.type === "boolean")
    return <Tag color={value ? "green" : "default"}>{value ? "是" : "否"}</Tag>;
  if (field.type === "people") {
    const items = Array.isArray(value) ? value : [value];
    return (
      <Space size={4} wrap>
        {items.map((v, i) => (
          <Tag key={i} color="blue">
            {personLabel(v, peopleByRow) || "—"}
          </Tag>
        ))}
      </Space>
    );
  }
  if (field.type === "single_select") {
    const { label, color } = selectLabel(field, value);
    return <Tag color={color || "default"}>{label}</Tag>;
  }
  if (field.type === "multiple_select" && Array.isArray(value)) {
    return (
      <Space size={4} wrap>
        {value.map((v, i) => {
          const { label, color } = selectLabel(field, v);
          return (
            <Tag key={i} color={color || "default"}>
              {label}
            </Tag>
          );
        })}
      </Space>
    );
  }
  if (field.type === "url" && typeof value === "string") {
    return (
      <a href={value} target="_blank" rel="noreferrer noopener">
        {value}
      </a>
    );
  }
  if (field.type === "file" && Array.isArray(value))
    return <FileLinks files={toFileList(value)} />;
  if (field.type === "rating" && typeof value === "number")
    return <Rate disabled value={value} style={{ fontSize: 12 }} />;
  if (field.type === "duration") {
    const text = formatDuration(value);
    return text ? (
      <Typography.Text>{text}</Typography.Text>
    ) : (
      <Typography.Text type="secondary">—</Typography.Text>
    );
  }
  if (field.type === "password") {
    return value ? (
      <Typography.Text type="secondary">已设置</Typography.Text>
    ) : (
      <Typography.Text type="secondary">未设置</Typography.Text>
    );
  }
  if (typeof value === "object") return JSON.stringify(value);
  const text = String(value);
  return field.type === "long_text" ? (
    <Typography.Text ellipsis={{ tooltip: text }} style={{ maxWidth: 320 }}>
      {text}
    </Typography.Text>
  ) : (
    text
  );
}

/** 表单值：只允许这些形状，避免把任意 JSON 直接塞进 Form.Item。 */
export type FormValue =
  | string
  | number
  | boolean
  | Array<string | number>
  | BaserowFile[]
  | null
  | undefined;

/** 附件字段的值统一成 BaserowFile 列表（Baserow 返回的是对象数组）。 */
function toFileList(value: unknown): BaserowFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => v && typeof v === "object")
    .map((v) => {
      const raw = v as Record<string, unknown>;
      return {
        url: String(raw.url || ""),
        name: String(raw.name || ""),
        visible_name: raw.visible_name ? String(raw.visible_name) : undefined,
        size: typeof raw.size === "number" ? raw.size : undefined,
        mime: raw.mime_type ? String(raw.mime_type) : undefined,
      };
    })
    .filter((f) => Boolean(f.url && f.name));
}

function formatBytes(bytes?: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0)
    return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") {
    const total = Math.round(value);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
  }
  return String(value);
}

export function toFormValue(field: BaserowField, value: unknown): FormValue {
  if (value === null || value === undefined)
    return field.type === "boolean" ? false : undefined;
  if (field.type === "single_select") return optionId(value);
  if (field.type === "multiple_select" && Array.isArray(value)) {
    return value
      .map(optionId)
      .filter((v): v is string | number => v !== undefined && v !== null);
  }
  if (field.type === "people") {
    const list = Array.isArray(value) ? value : [value];
    return list.map(personRowId).filter((v): v is number => v !== undefined);
  }
  if (field.type === "link_row") {
    // Baserow 的关联行返回 [{id, value, order}]，保存时只写行 id 列表
    const list = Array.isArray(value) ? value : [value];
    return list
      .map((v) =>
        v && typeof v === "object" ? (v as Record<string, unknown>).id : v,
      )
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v));
  }
  if (field.type === "file") return toFileList(value);
  if (field.type === "duration") return formatDuration(value);
  if (field.type === "password") {
    // Baserow 不回传密码明文（已设置时返回 true），所以编辑时留空表示不修改
    return typeof value === "string" ? value : "";
  }
  // 其余类型（文本/数字/日期/评分/时长等）按原值交给 Form；对象/数组不在白名单内，落到 undefined
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? value
    : undefined;
}

export function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 附件链接列表：文件名 + 大小，点击可直接下载。 */
function FileLinks({ files }: { files: BaserowFile[] }) {
  if (!files.length)
    return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Space size={8} wrap>
      {files.map((f, i) => (
        <Space key={`${f.name}-${i}`} size={4}>
          <a href={f.url} target="_blank" rel="noreferrer noopener">
            {f.visible_name || f.name}
          </a>
          {formatBytes(f.size) ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatBytes(f.size)}
            </Typography.Text>
          ) : null}
        </Space>
      ))}
    </Space>
  );
}

/**
 * 文件字段的表单控件：自建上传 + 已有附件列表（可下载、可单个移除）。
 *
 * 上传走门户自己的接口（Baserow 的 user-files），成功后拿到带 url/name 的对象，
 * 提交时只写回 {url, name} —— Baserow 校验文件字段时认的是这个 name。
 */
function FileFieldInput({
  value,
  onChange,
  tableId,
}: {
  value?: BaserowFile[];
  onChange?: (next: BaserowFile[]) => void;
  tableId: number;
}) {
  const { message } = App.useApp();
  const [uploading, setUploading] = useState(false);
  const files = Array.isArray(value) ? value : [];
  // 连续上传时用 ref 取最新列表，避免两次请求同时返回时后一个覆盖前一个
  const filesRef = useRef<BaserowFile[]>(files);
  filesRef.current = files;

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const uploaded = await baserowApi.uploadFile(tableId, file);
      onChange?.([...filesRef.current, uploaded]);
      message.success(`已上传 ${file.name}`);
    } catch (e) {
      message.error(`上传失败：${errText(e)}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <Flex vertical gap={6}>
      {files.length ? (
        <Flex vertical gap={2}>
          {files.map((f, i) => (
            <Flex
              key={`${f.name}-${i}`}
              align="center"
              justify="space-between"
              gap={8}
            >
              <Space size={6}>
                <a href={f.url} target="_blank" rel="noreferrer noopener">
                  {f.visible_name || f.name}
                </a>
                {formatBytes(f.size) ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {formatBytes(f.size)}
                  </Typography.Text>
                ) : null}
              </Space>
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                aria-label={`移除附件 ${f.visible_name || f.name}`}
                onClick={() => onChange?.(files.filter((_, idx) => idx !== i))}
              />
            </Flex>
          ))}
        </Flex>
      ) : null}
      <Upload
        showUploadList={false}
        accept={FILE_ACCEPT}
        beforeUpload={(f) => {
          void upload(f as File);
          return false;
        }}
      >
        <Button size="small" icon={<PaperClipOutlined />} loading={uploading}>
          上传附件
        </Button>
      </Upload>
    </Flex>
  );
}

/**
 * 关联行选择器：搜索被关联表的行，保存值为 [rowId, ...]（Baserow 的 link_row 格式）。
 */
function LinkRowField({
  tableId,
  linkedTableId,
  value,
  onChange,
}: {
  tableId: number;
  linkedTableId: number;
  value?: unknown;
  onChange?: (next: unknown) => void;
}) {
  const [keyword, setKeyword] = useState("");
  const query = useQuery({
    queryKey: ["baserow", "link-rows", linkedTableId, keyword],
    queryFn: () => baserowApi.linkRows(tableId, linkedTableId, keyword),
    enabled: Boolean(linkedTableId),
    staleTime: 30_000,
  });
  const options: { value: number; label: string }[] = (
    query.data?.rows ?? []
  ).map((r) => ({
    value: r.id,
    label: r.label,
  }));
  const selected = Array.isArray(value) ? (value as number[]) : [];
  return (
    <Select
      mode="multiple"
      allowClear
      showSearch={{ onSearch: setKeyword, filterOption: false }}
      value={selected}
      onChange={(v) => onChange?.(v)}
      loading={query.isFetching}
      placeholder="搜索并选择关联行"
      options={options}
    />
  );
}

/**
 * 关联行单元格：把 [rowId, ...] 渲染成被关联表的主字段值。
 *
 * 关联表的行在编辑时由 LinkRowField 拉取，这里再拉一次用于展示，
 * 标签取不到时回退到 #id。
 */
export function LinkRowCell({
  tableId,
  field,
  value,
}: {
  tableId: number;
  field: BaserowField;
  value: unknown;
}) {
  const ids = linkRowIds(value);
  const linkedTableId = field.link_row_table_id ?? 0;
  const query = useQuery({
    queryKey: ["baserow", "link-rows", linkedTableId, ""],
    queryFn: () => baserowApi.linkRows(tableId, linkedTableId, ""),
    enabled: Boolean(linkedTableId) && ids.length > 0,
    staleTime: 30_000,
  });
  const labels = new Map(
    (query.data?.rows ?? []).map((r: BaserowLinkRow) => [r.id, r.label]),
  );
  if (!ids.length) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Space size={4} wrap>
      {ids.map((id) => (
        <Tag key={id} color="blue">
          {labels.get(id) ?? `#${id}`}
        </Tag>
      ))}
    </Space>
  );
}

/**
 * 按字段类型渲染可编辑控件。
 *
 * Form.Item 会把 value / onChange 注入到这里，所以内部全部走受控写法。
 */
export function FieldControl({
  field,
  value,
  onChange,
  tableId,
  people,
  peopleByRow,
}: {
  field: BaserowField;
  value?: unknown;
  onChange?: (next: unknown) => void;
  tableId: number;
  people: BaserowPerson[];
  peopleByRow: Map<number, BaserowPerson>;
}) {
  const text = value === null || value === undefined ? "" : String(value);
  switch (field.type) {
    case "boolean":
      return (
        <Switch
          checked={Boolean(value)}
          onChange={(checked) => onChange?.(checked)}
        />
      );
    case "number":
      return (
        <InputNumber
          style={{ width: "100%" }}
          value={typeof value === "number" ? value : undefined}
          onChange={(v) => onChange?.(v)}
        />
      );
    case "rating":
      return (
        <Rate
          value={typeof value === "number" ? value : 0}
          onChange={(v) => onChange?.(v)}
        />
      );
    case "date":
      return (
        <DatePicker
          style={{ width: "100%" }}
          value={text ? dayjs(text) : null}
          onChange={(d) => onChange?.(d ? d.format("YYYY-MM-DD") : null)}
        />
      );
    case "long_text":
      return (
        <Input.TextArea
          rows={3}
          maxLength={10000}
          value={text}
          onChange={(e) => onChange?.(e.target.value)}
        />
      );
    case "url":
      return (
        <Input
          type="url"
          value={text}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder="https://"
        />
      );
    case "email":
      return (
        <Input
          type="email"
          value={text}
          onChange={(e) => onChange?.(e.target.value)}
        />
      );
    case "phone_number":
      return (
        <Input
          type="tel"
          value={text}
          onChange={(e) => onChange?.(e.target.value)}
        />
      );
    case "password":
      return (
        <Input.Password
          value={text}
          onChange={(e) => onChange?.(e.target.value)}
        />
      );
    case "duration":
      return (
        <Input
          value={text}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder="如 01:30:00"
        />
      );
    case "single_select":
      return (
        <Select
          allowClear
          value={optionId(value)}
          options={field.select_options.map((o) => ({
            value: o.id,
            label: o.value,
          }))}
          onChange={(v) => onChange?.(v ?? null)}
          placeholder="请选择"
        />
      );
    case "multiple_select": {
      const selected = Array.isArray(value)
        ? value
            .map(optionId)
            .filter((v): v is string | number => v !== undefined && v !== null)
        : [];
      return (
        <Select
          mode="multiple"
          allowClear
          value={selected}
          options={field.select_options.map((o) => ({
            value: o.id,
            label: o.value,
          }))}
          onChange={(v) => onChange?.(v)}
          placeholder="请选择"
        />
      );
    }
    case "people": {
      const selected = Array.isArray(value) ? (value as number[]) : [];
      return (
        <Select
          mode="multiple"
          allowClear
          showSearch={{
            filterOption: (input, option) => {
              const p = peopleByRow.get(Number(option?.value));
              const haystack = [
                p?.displayName,
                p?.name,
                p?.email,
                ...(p?.groups ?? []),
              ]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
              return haystack.includes(input.trim().toLowerCase());
            },
          }}
          value={selected}
          onChange={(v) => onChange?.(v)}
          loading={false}
          placeholder={people.length ? "搜索并选择人员" : "暂无可选人员"}
          options={people.map((p) => ({
            value: p.row_id,
            label: p.displayName || p.name,
          }))}
          optionRender={(option) => {
            const p = peopleByRow.get(Number(option.value));
            const meta = [p?.email, (p?.groups ?? []).join(" / ")]
              .filter(Boolean)
              .join(" · ");
            return (
              <Flex vertical gap={0}>
                <span>{p?.displayName || String(option.label ?? "")}</span>
                {meta ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {meta}
                  </Typography.Text>
                ) : null}
              </Flex>
            );
          }}
        />
      );
    }
    case "link_row":
      return (
        <LinkRowField
          tableId={tableId}
          linkedTableId={field.link_row_table_id ?? 0}
          value={value}
          onChange={onChange}
        />
      );
    case "file":
      return (
        <FileFieldInput
          tableId={tableId}
          value={Array.isArray(value) ? (value as BaserowFile[]) : []}
          onChange={(next) => onChange?.(next)}
        />
      );
    default:
      return (
        <Input value={text} onChange={(e) => onChange?.(e.target.value)} />
      );
  }
}

/**
 * 行评论时间线。
 *
 * Baserow 的 row_comments 是商业版能力，未开启时上游返回 402，这里降级为提示。
 */
export function CommentTimeline({
  tableId,
  rowId,
}: {
  tableId: number;
  rowId: number;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const query = useQuery({
    queryKey: ["baserow", "comments", tableId, rowId],
    queryFn: () => baserowApi.comments(tableId, rowId),
    retry: false,
  });
  const comments: BaserowRowComment[] = query.data?.comments ?? [];
  const addMutation = useMutation({
    mutationFn: (msg: string) => baserowApi.addComment(tableId, rowId, msg),
    onSuccess: async () => {
      setText("");
      await qc.invalidateQueries({
        queryKey: ["baserow", "comments", tableId, rowId],
      });
    },
    onError: (e) => message.error(errText(e)),
  });
  if (query.isError) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        评论功能在当前数据表部署中未启用。
      </Typography.Text>
    );
  }
  return (
    <Flex vertical gap={8} style={{ marginTop: 16 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        <CommentOutlined /> 评论
      </Typography.Text>
      {comments.length ? (
        <Flex vertical gap={6}>
          {comments.map((c) => (
            <Card
              key={c.id}
              size="small"
              styles={{ body: { padding: "8px 10px" } }}
            >
              <Flex vertical gap={2}>
                <Typography.Text style={{ fontSize: 12 }}>
                  {c.message}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {c.first_name || "匿名"} ·{" "}
                  {dayjs(c.created_on).format("YYYY-MM-DD HH:mm")}
                </Typography.Text>
              </Flex>
            </Card>
          ))}
        </Flex>
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          还没有评论
        </Typography.Text>
      )}
      <Flex gap={8}>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="写下评论…"
          onPressEnter={() => {
            if (text.trim()) addMutation.mutate(text.trim());
          }}
        />
        <Button
          icon={<CommentOutlined />}
          loading={addMutation.isPending}
          disabled={!text.trim()}
          onClick={() => addMutation.mutate(text.trim())}
        >
          发送
        </Button>
      </Flex>
    </Flex>
  );
}
