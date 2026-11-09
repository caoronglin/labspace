import { Button, Flex, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { FILE_SOURCE_LABEL, FILE_SOURCE_ORDER } from './shared';
import type { FileGrant } from '../../services/api';

export function AccessTag({ grant }: { grant: FileGrant }) {
  const source = FILE_SOURCE_LABEL[grant.source] ?? grant.source;
  const label = grant.path ? `${source}/${grant.path}` : source;
  if (grant.access === 'deny') {
    return <Tag color="error">{label} · 已收回</Tag>;
  }
  if (grant.access === 'write') {
    return (
      <Tag color="cyan" variant="filled">
        {label} · 读写
      </Tag>
    );
  }
  return <Tag>{label} · 只读</Tag>;
}

/** 授权摘要：按源顺序展示，空配置由调用方给出贴合场景的说明。 */
export function GrantList({ grants, empty }: { grants: FileGrant[]; empty: string }) {
  const list = grants ?? [];
  if (!list.length) {
    return <Typography.Text type="secondary">{empty}</Typography.Text>;
  }
  const ordered = [...list].sort(
    (a, b) =>
      FILE_SOURCE_ORDER.indexOf(a.source) - FILE_SOURCE_ORDER.indexOf(b.source) ||
      a.path.localeCompare(b.path),
  );
  return (
    <Space size={[4, 4]} wrap>
      {ordered.map((g) => (
        <AccessTag key={`${g.source}-${g.path}-${g.access}`} grant={g} />
      ))}
    </Space>
  );
}

/** 目录级权限编辑器：只读 / 读写 / 单独收回，未授权目录不可见。 */
export function GrantEditor({
  grants,
  directories,
  disabled,
  onChange,
}: {
  grants: FileGrant[];
  directories: Record<string, string[]>;
  disabled?: boolean;
  onChange: (next: FileGrant[]) => void;
}) {
  const update = (index: number, patch: Partial<FileGrant>) => {
    onChange(grants.map((g, i) => (i === index ? { ...g, ...patch } : g)));
  };
  const add = () => {
    const source = FILE_SOURCE_ORDER.find((s) => (directories[s] ?? []).length > 0) ?? 'public';
    onChange([...grants, { source, path: '', access: 'read' }]);
  };
  return (
    <Flex vertical gap={8}>
      {grants.map((grant, index) => {
        const paths = directories[grant.source] ?? [''];
        const value = paths.includes(grant.path) ? grant.path : '';
        return (
          <Flex key={`${index}-${grant.source}-${grant.path}`} gap={8} align="center">
            <Select
              style={{ width: 112 }}
              value={grant.source}
              disabled={disabled}
              options={FILE_SOURCE_ORDER.map((s) => ({
                value: s,
                label: FILE_SOURCE_LABEL[s] ?? s,
              }))}
              onChange={(source) => update(index, { source, path: '' })}
            />
            <Select
              style={{ flex: 1, minWidth: 120 }}
              value={value}
              showSearch={{ optionFilterProp: 'label' }}
              disabled={disabled}
              options={paths.map((p) => ({ value: p, label: p || '根目录' }))}
              onChange={(p) => update(index, { path: p })}
            />
            <Select
              style={{ width: 104 }}
              value={grant.access}
              disabled={disabled}
              options={[
                { value: 'read', label: '只读' },
                { value: 'write', label: '读写' },
                { value: 'deny', label: '单独收回' },
              ]}
              onChange={(access) => update(index, { access: access as FileGrant['access'] })}
            />
            <Popconfirm
              title="移除这条授权？"
              description="保存后立即生效。"
              okText="移除"
              cancelText="取消"
              onConfirm={() => onChange(grants.filter((_, i) => i !== index))}
            >
              <Button
                type="text"
                danger
                size="small"
                disabled={disabled}
                icon={<DeleteOutlined />}
                aria-label="移除该目录授权"
              />
            </Popconfirm>
          </Flex>
        );
      })}
      <Space size={8} wrap>
        <Button size="small" icon={<PlusOutlined />} disabled={disabled} onClick={add}>
          添加目录授权
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          只读可查看/下载；读写可上传/修改/删除；单独收回优先于用户组与管理员身份；未授权目录不可见。
        </Typography.Text>
      </Space>
    </Flex>
  );
}
