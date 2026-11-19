/**
 * 种子台账的取值渲染：按 Baserow 字段类型把一行里的值显示成人话。
 *
 * 表格单元格、行内编辑、详情抽屉三处共用同一套渲染，
 * 免得同一列在表格里是「3」在抽屉里变成「3.0」。
 */
import { Rate, Space, Tag, Tooltip, Typography } from 'antd';
import { FileImageOutlined, PaperClipOutlined } from '@ant-design/icons';
import type { BaserowField, BaserowFile } from '../../../services/api';
import { selectLabel } from './seedMeta';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);

/** 附件值统一成 BaserowFile 列表。 */
export function toFileList(value: unknown): BaserowFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => v && typeof v === 'object')
    .map((v) => {
      const raw = v as Record<string, unknown>;
      return {
        url: String(raw.url || ''),
        name: String(raw.name || ''),
        visible_name: raw.visible_name ? String(raw.visible_name) : undefined,
        size: typeof raw.size === 'number' ? raw.size : undefined,
        mime: raw.mime_type ? String(raw.mime_type) : undefined,
      };
    })
    .filter((f) => Boolean(f.url && f.name));
}

export function formatBytes(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileIsImage(file: BaserowFile): boolean {
  if (file.mime?.startsWith('image/')) return true;
  const ext = (file.visible_name || file.name).split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXT.has(ext);
}

/** 附件单元格里显示缩略图 + 数量（详情抽屉里再展开完整列表）。 */
export function FileCell({ files }: { files: BaserowFile[] }) {
  if (!files.length) return <Typography.Text type="secondary">—</Typography.Text>;
  const images = files.filter(fileIsImage);
  return (
    <Space size={6} wrap>
      {images.slice(0, 3).map((f, i) => (
        <Tooltip key={`${f.name}-${i}`} title={f.visible_name || f.name}>
          <img
            src={f.url}
            alt={f.visible_name || f.name}
            style={{
              width: 28,
              height: 28,
              objectFit: 'cover',
              borderRadius: 4,
              border: '1px solid var(--ant-color-border-secondary, #EEF0F4)',
            }}
          />
        </Tooltip>
      ))}
      {files.length > images.slice(0, 3).length ? (
        <Tag icon={<PaperClipOutlined />} variant="filled">
          {files.length} 个
        </Tag>
      ) : null}
      {images.length === 0 ? <Tag icon={<FileImageOutlined />} variant="filled">{files.length} 个</Tag> : null}
    </Space>
  );
}

/** 详情抽屉里的附件列表：文件名 + 大小，可直接下载。 */
export function FileList({ files }: { files: BaserowFile[] }) {
  if (!files.length) return <Typography.Text type="secondary">暂无附件</Typography.Text>;
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      {files.map((f, i) => (
        <Space key={`${f.name}-${i}`} size={8} align="center">
          <a href={f.url} target="_blank" rel="noreferrer noopener" download>
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

/** 按字段类型渲染单元格内容。 */
export function renderSeedValue(field: BaserowField, value: unknown) {
  if (value === null || value === undefined || value === '') {
    return <Typography.Text type="secondary">—</Typography.Text>;
  }
  if (field.type === 'boolean') {
    return <Tag color={value ? 'green' : 'default'}>{value ? '是' : '否'}</Tag>;
  }
  if (field.type === 'single_select') {
    const { label, color } = selectLabel(field, value);
    return <Tag color={color || 'default'}>{label}</Tag>;
  }
  if (field.type === 'multiple_select' && Array.isArray(value)) {
    return (
      <Space size={4} wrap>
        {value.map((v, i) => {
          const { label, color } = selectLabel(field, v);
          return (
            <Tag key={i} color={color || 'default'}>
              {label}
            </Tag>
          );
        })}
      </Space>
    );
  }
  if (field.type === 'date') {
    const text = String(value).slice(0, 10);
    return <Typography.Text>{text}</Typography.Text>;
  }
  if (field.type === 'file') {
    return <FileCell files={toFileList(value)} />;
  }
  if (field.type === 'rating' && typeof value === 'number') {
    return <Rate disabled value={value} style={{ fontSize: 12 }} />;
  }
  if (field.type === 'url' && typeof value === 'string') {
    return (
      <a href={value} target="_blank" rel="noreferrer noopener">
        {value}
      </a>
    );
  }
  if (field.type === 'long_text') {
    return (
      <Typography.Text ellipsis={{ tooltip: String(value) }} style={{ maxWidth: 280 }}>
        {String(value)}
      </Typography.Text>
    );
  }
  return <Typography.Text>{String(value)}</Typography.Text>;
}
