import { Input, InputNumber, Select, Switch } from 'antd';

export type FieldKind = 'textarea' | 'text' | 'number' | 'select' | 'switch' | 'list';

/**
 * 一个工具参数的定义。工具清单（`TOOLS`）只写这些声明，
 * 控件渲染交给 `ToolFieldInput`，加参数不需要再动 JSX。
 */
export type ToolField = {
  name: string;
  label: string;
  kind: FieldKind;
  /** 默认值：新建表单时预填，减少"从空表格开始"的负担 */
  value?: string | number | boolean;
  options?: { label: string; value: string | number }[];
  placeholder?: string;
  hint?: string;
  /** 数字字段的取值范围（后端也有校验，这里只是提前拦住手滑） */
  min?: number;
  max?: number;
  /** 只在指定条件下显示（例如「按坐标提取」才需要 start/end） */
  showWhen?: (values: Record<string, unknown>) => boolean;
};

/**
 * 按参数类型渲染对应控件。
 *
 * 每种 kind 的宽度/字体在这里统一，页面只负责「哪个字段、当前值、改了就写回」。
 */
export default function ToolFieldInput({
  field,
  value,
  onChange,
}: {
  field: ToolField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (field.kind === 'textarea') {
    return (
      <Input.TextArea
        rows={6}
        value={String(value ?? '')}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
      />
    );
  }
  if (field.kind === 'number') {
    return (
      <InputNumber
        value={value as number | undefined}
        min={field.min}
        max={field.max}
        placeholder={field.placeholder}
        onChange={(v) => onChange(v ?? undefined)}
        style={{ width: 200 }}
      />
    );
  }
  if (field.kind === 'select') {
    return (
      <Select
        value={value as string | number | undefined}
        options={field.options}
        onChange={(v) => onChange(v)}
        style={{ width: 240 }}
      />
    );
  }
  if (field.kind === 'switch') {
    return <Switch checked={Boolean(value)} onChange={(v) => onChange(v)} />;
  }
  // text / list：都只是一行自由文本，list 在提交时按逗号/换行拆成数组
  return (
    <Input
      value={String(value ?? '')}
      placeholder={field.placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{ maxWidth: 420 }}
    />
  );
}
