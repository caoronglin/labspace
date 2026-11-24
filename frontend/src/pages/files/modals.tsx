import {
  Alert,
  Button,
  Empty,
  Flex,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ClearOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  FileOutlined,
  FolderOpenOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { resolveDisplayName } from '../../utils/displayName';
import type { FileAccessEvent, FileTrashItem, PersonalShare } from '../../services/api';
import OpenFilePreview from '../../components/OpenFilePreview';
import { formatSize, formatTime } from '../../components/files/fileMeta';
import { hasPresentation, isOfficeEditable } from '../../components/office/registry';
import { tokens } from '../../theme/tokens';
import { ExtTag, PreviewBody, trashLeft } from './presenters';
import type { FilesDeps } from './actions';

/** Files 页的全部弹窗（从 pages/Files.tsx 原样搬出，JSX 逐字未改）。 */
export function renderMoveModal(deps: FilesDeps) {
  const { moveIds, setMoveIds, batchBusy, doMove, moveTo, setMoveTo, moveTargets, isSharedView } = deps;
  return (
      <Modal
        open={moveIds.length > 0}
        title={`移动到文件夹（${moveIds.length} 项）`}
        okText="移动"
        cancelText="取消"
        confirmLoading={batchBusy}
        onOk={doMove}
        onCancel={() => setMoveIds([])}
        destroyOnHidden
      >
        <Flex vertical gap={12}>
          <Typography.Text type="secondary">
            {isSharedView
              ? '目标目录仅列出可写共享目录与你的个人目录；目标处同名条目会被拒绝，不会覆盖。'
              : '目标目录仅列出你在当前存储源中有读权限的文件夹；目标处同名条目会被拒绝，不会覆盖。'}
          </Typography.Text>
          <Select
            showSearch={{ optionFilterProp: 'label' }}
            open
            value={moveTo}
            onChange={(v) => setMoveTo(v)}
            style={{ width: '100%' }}
            placeholder="选择目标文件夹"
            options={moveTargets.map((d) => ({
              value: d,
              label: d ? d.split('/').join(' / ') : '（存储源根目录）',
            }))}
          />
        </Flex>
      </Modal>
  );
}

export function renderPreviewModal(deps: FilesDeps) {
  const {
    previewId, setPreviewId, previewEntry, canWrite, openOffice,
    nativePreview, bioDirect, preview, setNativePreview,
  } = deps;
  const renderPreviewContent = () => {
    if (!nativePreview && !bioDirect) {
      return (
        <OpenFilePreview
          key={previewId}
          id={previewId!}
          name={previewEntry?.name ?? ''}
          onUnsupported={() => setNativePreview(true)}
        />
      );
    }
    if (preview.isLoading) {
      return (
        <Flex justify="center" style={{ padding: 40 }}>
          <Spin />
        </Flex>
      );
    }
    if (preview.isError) {
      return <Alert type="error" showIcon title="无法预览该文件" description={(preview.error as Error)?.message} />;
    }
    if (preview.data) {
      return (
        <Flex vertical gap={12}>
          <PreviewBody data={preview.data} />
          {preview.data.truncated ? (
            <Typography.Text type="secondary">内容较大，仅展示前一部分。</Typography.Text>
          ) : null}
        </Flex>
      );
    }
    return null;
  };
  return (
      <Modal
        open={Boolean(previewId)}
        title={previewEntry?.name ?? '文件预览'}
        width={960}
        onCancel={() => setPreviewId(null)}
        destroyOnHidden
        footer={
          previewEntry ? (
            <Space wrap>
              <Button onClick={() => setPreviewId(null)}>关闭</Button>
              {isOfficeEditable(previewEntry.name) && canWrite(previewEntry.path) ? (
                <Button icon={<EditOutlined />} onClick={() => openOffice(previewEntry, 'edit')}>
                  网页编辑
                </Button>
              ) : null}
              {hasPresentation(previewEntry.name) ? (
                <Button icon={<PlayCircleOutlined />} onClick={() => openOffice(previewEntry, 'present')}>
                  放映
                </Button>
              ) : null}
              <Button
                type="primary"
                icon={<DownloadOutlined />}
                href={`/api/files/${encodeURIComponent(previewEntry.id)}/download`}
              >
                下载原文件
              </Button>
            </Space>
          ) : null
        }
      >
        {renderPreviewContent()}
      </Modal>
  );
}

export function renderNameDialog(deps: FilesDeps) {
  const { dialog, setDialog, dialogName, setDialogName, busy, submitDialog, baseDir } = deps;
  const isMkdir = dialog?.mode === 'mkdir';
  const dialogTitle = isMkdir ? '新建文件夹' : '重命名';
  const dialogOkText = isMkdir ? '创建' : '保存';
  const dialogPlaceholder = isMkdir ? '文件夹名称' : '新名称';
  return (
      <Modal
        open={Boolean(dialog)}
        title={dialogTitle}
        okText={dialogOkText}
        cancelText="取消"
        confirmLoading={busy}
        onOk={submitDialog}
        onCancel={() => setDialog(null)}
        destroyOnHidden
      >
        <Input
          autoFocus
          value={dialogName}
          maxLength={120}
          placeholder={dialogPlaceholder}
          onChange={(e) => setDialogName(e.target.value)}
          onPressEnter={submitDialog}
        />
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
          {dialog?.mode === 'mkdir'
            ? `创建位置：${baseDir || '当前目录'}`
            : `当前名称：${dialog?.entry?.name ?? ''}`}
        </Typography.Text>
      </Modal>
  );
}

export function renderNewFileDialog(deps: FilesDeps) {
  const {
    newFileOpen, setNewFileOpen, newFileName, setNewFileName,
    newFileBody, setNewFileBody, newFileBusy, submitNewFile, baseDir,
  } = deps;
  return (
    <>
      {/* 新建文件：名字 + 初始内容。留空内容就是空文件，随后可用在线编辑器补。 */}
      <Modal
        open={newFileOpen}
        title="新建文件"
        okText="创建"
        cancelText="取消"
        confirmLoading={newFileBusy}
        onOk={submitNewFile}
        onCancel={() => setNewFileOpen(false)}
        destroyOnHidden
        width={560}
      >
        <Space orientation="vertical" size={10} style={{ width: '100%' }}>
          <Input
            autoFocus
            value={newFileName}
            maxLength={120}
            placeholder="文件名，例如 实验记录.md"
            onChange={(e) => setNewFileName(e.target.value)}
            onPressEnter={submitNewFile}
          />
          <Input.TextArea
            value={newFileBody}
            rows={8}
            placeholder="初始内容（可留空，之后用在线编辑器补）"
            onChange={(e) => setNewFileBody(e.target.value)}
            style={{ fontFamily: 'monospace' }}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            创建位置：{baseDir || '当前目录'}
          </Typography.Text>
        </Space>
      </Modal>
    </>
  );
}

export function renderShareModal(deps: FilesDeps) {
  const {
    shareTarget, setShareTarget, shareBusy, saveShare,
    sharePicks, setSharePicks, shareRecipients,
    shareWritable, setShareWritable, relPath, peopleMap,
  } = deps;
  return (
      <Modal
        open={Boolean(shareTarget)}
        title={`共享「${shareTarget?.name ?? ''}」`}
        okText="保存共享"
        cancelText="取消"
        confirmLoading={shareBusy}
        onOk={saveShare}
        onCancel={() => setShareTarget(null)}
        destroyOnHidden
      >
        <Flex vertical gap={10}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            被选择的同学会在「文件存储 → 个人文件 → 共享给我」中看到该路径，默认只读预览与下载；名单留空保存即收回共享。
          </Typography.Text>
          <Select
            mode="multiple"
            allowClear
            value={sharePicks}
            onChange={setSharePicks}
            placeholder={shareRecipients.length ? '选择共享人' : '暂无可共享的其他账号'}
            showSearch={{ optionFilterProp: 'label' }}
            // 共享名单一律显示**姓名**：value 仍是账号名（后端按账号名授权），
            // 但用户看到的必须是「陈同学」而不是「adminlegacy」。
            options={shareRecipients.map((name) => ({
              value: name,
              label: resolveDisplayName(name, peopleMap, name),
            }))}
            style={{ width: '100%' }}
          />
          <Flex align="center" justify="space-between" gap={12} wrap>
            <Typography.Text style={{ fontSize: 13 }}>允许对方编辑（移动/改名/上传，不含删除）</Typography.Text>
            <Switch
              checked={shareWritable}
              onChange={setShareWritable}
              disabled={!sharePicks.length}
              aria-label="允许对方编辑"
            />
          </Flex>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            路径：{shareTarget ? relPath(shareTarget.path) : ''} · 可共享对象：{shareRecipients.length} 人
          </Typography.Text>
        </Flex>
      </Modal>
  );
}

export function renderManageModal(deps: FilesDeps) {
  const { manageOpen, setManageOpen, personalShares, editShare, revokeShare, peopleMap } = deps;
  return (
      <Modal
        open={manageOpen}
        title="共享管理"
        width={720}
        onCancel={() => setManageOpen(false)}
        footer={
          <Button type="primary" onClick={() => setManageOpen(false)}>
            关闭
          </Button>
        }
      >
        <Flex vertical gap={12}>
          <Alert
            type="info"
            showIcon
            title="个人文件默认仅本人可见；共享默认只读，勾选「允许对方编辑」后对方才能移动/改名/上传（不含删除），名单变更立即生效。"
            description="收回共享后，对方将无法继续预览或下载该路径，但已下载的副本无法追回。删除权始终属于本人。"
          />
          <Table<PersonalShare>
            size="small"
            rowKey="path"
            dataSource={personalShares}
            pagination={false}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有共享任何文件" /> }}
            columns={[
              {
                title: '路径',
                dataIndex: 'path',
                render: (p: string) => <Typography.Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{p}</Typography.Text>,
              },
              {
                title: '共享给',
                dataIndex: 'recipients',
                render: (names: string[]) => (
                  <Space size={4} wrap>
                    {names.map((n) => (
                      <Tag key={n} variant="filled" title={n}>
                        {resolveDisplayName(n, peopleMap, n)}
                      </Tag>
                    ))}
                  </Space>
                ),
              },
              {
                title: '权限',
                dataIndex: 'writable',
                width: 90,
                render: (writable: boolean) => (
                  <Tag color={writable ? 'green' : 'default'} variant="filled">
                    {writable ? '可编辑' : '只读'}
                  </Tag>
                ),
              },
              {
                title: '操作',
                width: 130,
                align: 'right',
                render: (_: unknown, r) => (
                  <Space size={0}>
                    <Button size="small" type="link" onClick={() => editShare(r)}>
                      编辑
                    </Button>
                    <Button size="small" type="link" danger onClick={() => revokeShare(r)}>
                      收回
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
        </Flex>
      </Modal>
  );
}

export function renderTrashModal(deps: FilesDeps) {
  const {
    trashOpen, setTrashOpen, trash, trashItems, emptyTrash,
    retentionHint, restoreItem, purgeItem,
  } = deps;
  return (
      <Modal
        open={trashOpen}
        title="回收站"
        width={920}
        onCancel={() => setTrashOpen(false)}
        footer={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => trash.refetch()} loading={trash.isFetching}>
              刷新
            </Button>
            <Button danger icon={<ClearOutlined />} disabled={!trashItems.length} onClick={emptyTrash}>
              清空回收站
            </Button>
            <Button type="primary" onClick={() => setTrashOpen(false)}>
              关闭
            </Button>
          </Space>
        }
      >
        <Flex vertical gap={12}>
          <Alert
            type="info"
            showIcon
            title={retentionHint}
            description={
              trashItems.length
                ? `当前 ${trashItems.length} 项、${formatSize(trash.data?.totalBytes ?? 0)}，到期后自动清除；彻底删除可立即释放磁盘。`
                : '这里只列出你有权处置的记录，他人删除的内容不会出现在你的回收站里。'
            }
          />
          <Table<FileTrashItem>
            size="small"
            rowKey="id"
            loading={trash.isLoading || trash.isFetching}
            dataSource={trashItems}
            scroll={{ x: 720 }}
            pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="回收站是空的" /> }}
            columns={[
              {
                title: '名称',
                dataIndex: 'name',
                render: (name: string, r) => (
                  <Space size={8}>
                    {r.dir ? (
                      <FolderOpenOutlined style={{ color: tokens.colorWarning }} />
                    ) : (
                      <FileOutlined style={{ color: 'var(--ant-color-text-tertiary)' }} />
                    )}
                    <Typography.Text ellipsis>{name}</Typography.Text>
                    {r.dir ? null : <ExtTag name={name} />}
                  </Space>
                ),
              },
              {
                title: '原位置',
                dataIndex: 'path',
                render: (_: string, r) => (
                  <Flex vertical gap={0}>
                    <Typography.Text style={{ fontSize: 12 }}>{r.sourceLabel || r.source}</Typography.Text>
                    <Typography.Text type="secondary" ellipsis style={{ fontSize: 12 }}>
                      {r.path}
                    </Typography.Text>
                  </Flex>
                ),
              },
              {
                title: '大小',
                dataIndex: 'size',
                width: 130,
                align: 'right',
                render: (n: number, r) => (r.dir ? `${formatSize(n)} · ${r.paths} 项` : formatSize(n)),
              },
              {
                title: '删除',
                dataIndex: 'deletedAt',
                width: 170,
                responsive: ['lg'],
                render: (v: string, r) => (
                  <Flex vertical gap={0}>
                    <Typography.Text style={{ fontSize: 12 }}>{formatTime(v)}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {r.deletedBy} 删除
                    </Typography.Text>
                  </Flex>
                ),
              },
              {
                title: '剩余保留期',
                dataIndex: 'expiresAt',
                width: 120,
                render: (v: string) => {
                  const days = Math.ceil((new Date(v).getTime() - Date.now()) / 86_400_000);
                  return <Tag color={days <= 3 ? 'red' : 'default'}>{trashLeft(v)}</Tag>;
                },
              },
              {
                title: '操作',
                width: 170,
                align: 'right',
                render: (_: unknown, r) => (
                  <Space size={0}>
                    <Tooltip
                      title={r.restorable ? undefined : '当前账号在原来的位置没有写入权限，无法恢复'}
                    >
                      <Button
                        size="small"
                        type="link"
                        icon={<UndoOutlined />}
                        disabled={!r.restorable}
                        onClick={() => restoreItem(r)}
                      >
                        恢复
                      </Button>
                    </Tooltip>
                    <Button size="small" type="link" danger icon={<DeleteOutlined />} onClick={() => purgeItem(r)}>
                      彻底删除
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
        </Flex>
      </Modal>
  );
}

export function renderAuditModal(deps: FilesDeps) {
  const { auditOpen, setAuditOpen, audit, auditAction, setAuditAction, sources } = deps;
  return (
      <Modal
        open={auditOpen}
        title="文件访问记录"
        width={980}
        onCancel={() => setAuditOpen(false)}
        footer={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => audit.refetch()} loading={audit.isFetching}>
              刷新
            </Button>
            <Button type="primary" onClick={() => setAuditOpen(false)}>
              关闭
            </Button>
          </Space>
        }
      >
        <Flex vertical gap={12}>
          <Alert
            type="info"
            showIcon
            title={`记录全站文件的预览与下载行为，保留 ${audit.data?.retentionDays ?? 7} 天，仅管理员可见。`}
            description="事件由服务端在预览/下载成功时写入；服务令牌的内部读取不计入个人记录。"
          />
          <Segmented
            value={auditAction}
            onChange={(v) => setAuditAction(v as 'all' | 'preview' | 'download')}
            options={[
              { label: '全部', value: 'all' },
              { label: '预览', value: 'preview' },
              { label: '下载', value: 'download' },
            ]}
          />
          <Table<FileAccessEvent>
            size="small"
            rowKey="id"
            loading={audit.isLoading || audit.isFetching}
            dataSource={audit.data?.events ?? []}
            scroll={{ x: 820 }}
            pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无访问记录" /> }}
            columns={[
              {
                title: '时间',
                dataIndex: 'at',
                width: 175,
                render: (v: string) => <Typography.Text style={{ fontSize: 12 }}>{formatTime(v)}</Typography.Text>,
              },
              {
                title: '用户',
                dataIndex: 'userId',
                width: 170,
                render: (v: string) => <Typography.Text ellipsis>{v}</Typography.Text>,
              },
              {
                title: '动作',
                dataIndex: 'action',
                width: 80,
                render: (v: string) => {
                  let color = 'default';
                  let label = v;
                  if (v === 'download') {
                    color = 'blue';
                    label = '下载';
                  } else if (v === 'preview') {
                    color = 'green';
                    label = '预览';
                  }
                  return <Tag color={color}>{label}</Tag>;
                },
              },
              {
                title: '文件',
                dataIndex: 'name',
                render: (name: string, r) => (
                  <Flex vertical gap={0}>
                    <Typography.Text ellipsis>{name}</Typography.Text>
                    <Typography.Text type="secondary" ellipsis style={{ fontSize: 12 }}>
                      {sources.data?.sources.find((s) => s.id === r.source)?.label ?? r.source} · {r.path}
                    </Typography.Text>
                  </Flex>
                ),
              },
              {
                title: '大小',
                dataIndex: 'bytes',
                width: 100,
                align: 'right',
                render: (n: number) => formatSize(n),
              },
            ]}
          />
        </Flex>
      </Modal>
  );
}

