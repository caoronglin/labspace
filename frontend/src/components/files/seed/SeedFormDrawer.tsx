/**
 * 种子记录的填写抽屉：按语义分组（基本信息 / 库存与存放 / 质量与处理 / 备份 / 附件）。
 *
 * 分组不写死字段清单，而是按字段名与类型归类（见 seedMeta），
 * 所以后端调整模板字段时，这里的分组与必填提示仍然成立。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  DatePicker,
  Drawer,
  Flex,
  Form,
  Grid,
  Input,
  InputNumber,
  Select,
  Space,
  Spin,
  Switch,
  Typography,
  Upload,
} from 'antd';
import { PaperClipOutlined, UploadOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { baserowApi, type BaserowField, type BaserowFile, type BaserowRow } from '../../../services/api';
import { errText } from '../../../utils/err';
import {
  defaultDateFieldNames,
  groupFields,
  optionId,
  quantityFieldName,
  requiredFieldNames,
  unitFieldName,
} from './seedMeta';
import { toFileList } from './SeedValue';

/** 表单值的形状：Baserow 字段能接受的几种。 */
type FormValue = string | number | boolean | Dayjs | BaserowFile[] | null | undefined;

export interface SeedFormDrawerProps {
  open: boolean;
  tableId: number | null;
  fields: BaserowField[];
  /** 编辑时传入原记录；新建时为 null。 */
  row: BaserowRow | null;
  /**
   * 新建时的预填值（扫码录入的识别结果）。
   * 只覆盖同名且类型对得上的字段；其余字段保持模板默认值。
   */
  prefill?: Record<string, string> | null;
  onClose: () => void;
  onSaved: () => void;
}

/** 附件字段的表单控件：上传走 Baserow 的 user-files，提交时只写 {url, name}。 */
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
            <Flex key={`${f.name}-${i}`} align="center" justify="space-between" gap={8}>
              <a href={f.url} target="_blank" rel="noreferrer noopener">
                {f.visible_name || f.name}
              </a>
              <Button
                size="small"
                type="text"
                danger
                icon={<PaperClipOutlined />}
                aria-label={`移除附件 ${f.visible_name || f.name}`}
                onClick={() => onChange?.(files.filter((_, idx) => idx !== i))}
              />
            </Flex>
          ))}
        </Flex>
      ) : null}
      <Upload
        showUploadList={false}
        beforeUpload={(f) => {
          void upload(f as File);
          return false;
        }}
      >
        <Button size="small" icon={<UploadOutlined />} loading={uploading}>
          上传附件
        </Button>
      </Upload>
    </Flex>
  );
}

export default function SeedFormDrawer({
  open,
  tableId,
  fields,
  row,
  prefill,
  onClose,
  onSaved,
}: SeedFormDrawerProps) {
  const { message } = App.useApp();
  const screens = Grid.useBreakpoint();
  const [form] = Form.useForm<Record<string, FormValue>>();
  const [saving, setSaving] = useState(false);

  const groups = useMemo(() => groupFields(fields), [fields]);
  const required = useMemo(() => requiredFieldNames(fields), [fields]);
  const qtyName = useMemo(() => quantityFieldName(fields), [fields]);
  const unitName = useMemo(() => unitFieldName(fields), [fields]);

  // 数量与单位联动：填了数量就提醒必须配单位，并实时回显合计。
  // useWatch 必须无条件调用（字段集合随模板变化，条件调用会破坏 Hook 顺序）。
  const qtyValue = Form.useWatch(qtyName ?? '__qty__', form);
  const unitValue = Form.useWatch(unitName ?? '__unit__', form);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (!row) {
      // 新建：日期类字段给今天作为默认值，省一次手选。
      const defaults: Record<string, FormValue> = {};
      for (const name of defaultDateFieldNames(fields)) defaults[name] = dayjs();
      // 扫码预填：只填**确实存在**且类型对得上的字段。
      // OCR 可能把「数量」认成 "250 粒"，数量字段是 number 类型，
      // 直接塞字符串会让 Baserow 拒绝整行写入，所以这里做一次类型收敛。
      if (prefill) {
        for (const f of fields) {
          const raw = prefill[f.name];
          if (raw === undefined || raw === '') continue;
          if (f.type === 'number') {
            const n = Number(String(raw).replace(/[^\d.\-]/g, ''));
            if (Number.isFinite(n)) defaults[f.name] = n;
          } else if (f.type === 'long_text' || f.type === 'text' || f.type === 'single_select') {
            defaults[f.name] = String(raw);
          }
        }
      }
      form.setFieldsValue(defaults);
      return;
    }
    const values: Record<string, FormValue> = {};
    for (const f of fields) {
      const raw = row[f.name];
      if (raw === null || raw === undefined || raw === '') continue;
      if (f.type === 'date') {
        const d = dayjs(String(raw));
        values[f.name] = d.isValid() ? d : undefined;
      } else if (f.type === 'single_select') {
        const id = optionId(raw);
        values[f.name] = id === undefined ? undefined : (typeof id === 'number' ? id : String(id));
      } else if (f.type === 'file') {
        values[f.name] = toFileList(raw);
      } else if (f.type === 'number') {
        values[f.name] = typeof raw === 'number' ? raw : Number(raw);
      } else if (f.type === 'boolean') {
        values[f.name] = Boolean(raw);
      } else {
        values[f.name] = String(raw);
      }
    }
    form.setFieldsValue(values);
  }, [open, row, fields, form]);

  const submit = async () => {
    if (!tableId) return;
    const raw = await form.validateFields();
    const payload: Record<string, unknown> = {};
    for (const f of fields) {
      const value = raw[f.name];
      if (value === undefined) continue;
      if (f.type === 'date') {
        payload[f.name] =
          value && typeof value === 'object' && 'format' in (value as object)
            ? (value as Dayjs).format('YYYY-MM-DD')
            : null;
        continue;
      }
      if (f.type === 'file') {
        const files = Array.isArray(value) ? (value as BaserowFile[]) : [];
        payload[f.name] = files.map((f2) => ({ url: f2.url, name: f2.name }));
        continue;
      }
      payload[f.name] = value === '' ? null : value;
    }
    setSaving(true);
    try {
      if (row) {
        await baserowApi.seedUpdateRow(row.id, payload);
        message.success('已保存');
      } else {
        await baserowApi.seedCreateRow(payload);
        message.success('已新建记录');
      }
      onSaved();
      onClose();
    } catch (e) {
      message.error(`保存失败：${errText(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const narrow = !screens.md;

  return (
    <Drawer
      open={open}
      title={row ? '编辑种子记录' : '新建种子记录'}
      size={narrow ? '100%' : 640}
      onClose={onClose}
      destroyOnHidden
      extra={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={() => void submit()}>
            保存
          </Button>
        </Space>
      }
    >
      {!tableId ? (
        <Spin />
      ) : (
        <Form form={form} layout="vertical" requiredMark="optional">
          {groups.map((g) => (
            <div key={g.key} style={{ marginBottom: 20 }}>
              <Typography.Title level={5} style={{ marginBottom: 2 }}>
                {g.label}
              </Typography.Title>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {g.hint}
              </Typography.Text>
              <div style={{ marginTop: 12 }}>
                {g.fields.map((f) => {
                  const isRequired = required.has(f.name);
                  const rules = isRequired
                    ? [{ required: true, message: `请填写${f.name}` }]
                    : undefined;
                  // 数量填了但单位空着 → 单位跟着必填（数量与单位联动）。
                  const unitRules =
                    f.name === unitName && qtyName
                      ? [
                          {
                            validator: async (_rule: unknown, value: unknown) => {
                              const qty = form.getFieldValue(qtyName);
                              if (qty !== undefined && qty !== null && qty !== '' && !value) {
                                throw new Error('填写数量时必须同时填写单位');
                              }
                            },
                          },
                        ]
                      : undefined;
                  return (
                    <Form.Item
                      key={f.id}
                      name={f.name}
                      label={f.name}
                      rules={rules ?? unitRules}
                      extra={
                        f.name === qtyName && unitName
                          ? `合计 ${qtyValue ?? 0} ${unitValue ?? '（未填单位）'}`
                          : undefined
                      }
                    >
                      {f.type === 'long_text' ? (
                        <Input.TextArea rows={3} placeholder={`请输入${f.name}`} />
                      ) : f.type === 'number' ? (
                        <InputNumber style={{ width: '100%' }} placeholder={`请输入${f.name}`} min={0} />
                      ) : f.type === 'date' ? (
                        <DatePicker style={{ width: '100%' }} placeholder={`请选择${f.name}`} />
                      ) : f.type === 'boolean' ? (
                        <Switch />
                      ) : f.type === 'single_select' ? (
                        <Select
                          allowClear
                          placeholder={`请选择${f.name}`}
                          options={f.select_options.map((o) => ({ value: o.id, label: o.value }))}
                        />
                      ) : f.type === 'multiple_select' ? (
                        <Select
                          mode="multiple"
                          allowClear
                          placeholder={`请选择${f.name}`}
                          options={f.select_options.map((o) => ({ value: o.id, label: o.value }))}
                        />
                      ) : f.type === 'file' ? (
                        <FileFieldInput tableId={tableId} />
                      ) : (
                        <Input placeholder={`请输入${f.name}`} />
                      )}
                    </Form.Item>
                  );
                })}
              </div>
            </div>
          ))}
          {qtyName && unitName && qtyValue !== undefined && qtyValue !== null && qtyValue !== '' ? (
            <Alert
              type="info"
              showIcon
              title="数量与单位需配套填写"
              description="数量按「数值 + 单位」记录，缺单位会让台账对不上账。"
            />
          ) : null}
        </Form>
      )}
    </Drawer>
  );
}
