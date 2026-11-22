import type { ReactNode } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Dropdown,
  Flex,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  BookOutlined,
  CloudUploadOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EllipsisOutlined,
  EyeOutlined,
  FolderOpenOutlined,
  PlayCircleOutlined,
  SnippetsOutlined,
  SwapOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { resolveDisplayName } from '../../utils/displayName';
import type { FileSortKey } from '../../services/api';
import TimelineView from '../../components/files/TimelineView';
import { extOf, fileVisual, formatSize, formatTime } from '../../components/files/fileMeta';
import { hasPresentation } from '../../components/office/registry';
import { ExtTag, FileThumb, SORT_KEYS, TIMELINE_FIRST_SOURCES, type FileRow } from './presenters';
import type { FilesDeps } from './actions';

/** Files 页的列表主卡：拖拽上传区 + 批量操作条 + 列表/网格/详情/时间线视图
 *  （从 pages/Files.tsx 原样搬出，JSX 逐字未改）。 */
export function renderListCard(deps: FilesDeps) {
  const {
    writable, setDragging, writableHere, handleDrop, dragging,
    list, activeSource,
    selectedEntries, ingestibleSelection, selectedBytes,
    clipboard, batchBusy, pasteHere, batchDownload, copyToClipboard,
    ingestSelection, removableSelection, openMove, batchRemove, setSelectedKeys,
    viewMode, rows, selectedKeys, sortKey, order, setSortKey, setOrder,
    searching, isSharedView, isPersonal, homePath, shareOf, peopleMap, sharedWritableOf,
    openEntry, openPreview, openOffice, openShare, rowMenu, rowActions, openRow, toggleSelect,
    emptyView, emptyDescription, source,
  } = deps;
  return (
      <Card
        size="small"
        onDragOver={(e) => {
          if (!writable) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          setDragging(false);
          if (!writableHere) return;
          void handleDrop(e);
        }}
        style={{
          borderColor: dragging ? 'var(--ant-color-primary)' : undefined,
          boxShadow: dragging ? '0 0 0 2px var(--ant-color-primary-border)' : undefined,
        }}
      >
        {dragging ? (
          <Flex align="center" justify="center" gap={8} style={{ padding: 16, color: 'var(--ant-color-primary)' }}>
            <CloudUploadOutlined />
            <span>松开即可上传到当前目录</span>
          </Flex>
        ) : null}
        {list.isLoading ? (
          <Flex justify="center" style={{ padding: 48 }}>
            <Spin />
          </Flex>
        ) : activeSource && !activeSource.listable ? (
          <Alert
            type="warning"
            showIcon
            title="当前账号没有该文件源的访问权限"
            description="如需访问，请联系管理员调整文件共享权限。"
          />
        ) : (
          <>
            {selectedEntries.length ? (
              <Flex
                justify="space-between"
                align="center"
                wrap
                gap={12}
                style={{
                  padding: '8px 12px',
                  marginBottom: 12,
                  background: 'var(--ant-color-fill-secondary)',
                  borderRadius: 8,
                }}
              >
                <Space size={8} wrap>
                  <Typography.Text strong>已选 {selectedEntries.length} 项</Typography.Text>
                  <Typography.Text type="secondary">
                    {ingestibleSelection.length} 个文件 · {formatSize(selectedBytes)}
                  </Typography.Text>
                </Space>
                <Space size={8} wrap>
                  {writable && clipboard ? (
                    <Button type="primary" icon={<SnippetsOutlined />} loading={batchBusy} onClick={() => void pasteHere()}>
                      粘贴 {clipboard.ids.length} 项到此目录
                    </Button>
                  ) : null}
                  <Button icon={<DownloadOutlined />} onClick={batchDownload}>
                    批量下载
                  </Button>
                  {writable ? (
                    <Button icon={<CopyOutlined />} onClick={() => copyToClipboard(selectedEntries)}>
                      复制
                    </Button>
                  ) : null}
                  <Button
                    icon={<BookOutlined />}
                    onClick={ingestSelection}
                    disabled={!ingestibleSelection.length}
                  >
                    入库知识库
                  </Button>
                  {writable ? (
                    <>
                      {!isSharedView ? (
                        <Button
                          icon={<SwapOutlined />}
                          disabled={!removableSelection.length}
                          onClick={() => openMove(selectedEntries)}
                        >
                          移动
                        </Button>
                      ) : null}
                      <Button
                        danger
                        icon={<DeleteOutlined />}
                        loading={batchBusy}
                        disabled={!removableSelection.length}
                        onClick={batchRemove}
                      >
                        批量删除
                      </Button>
                    </>
                  ) : null}
                  <Button type="text" onClick={() => setSelectedKeys([])}>
                    取消选择
                  </Button>
                </Space>
              </Flex>
            ) : null}
            {viewMode === 'list' ? (
            <Table<FileRow>
              className="d509-files-table"
              size="middle"
              rowKey="id"
              dataSource={rows}
              sticky
              rowSelection={{
                selectedRowKeys: selectedKeys,
                onChange: (keys) => setSelectedKeys(keys),
                columnWidth: 44,
              }}
              scroll={{ x: 720 }}
            onChange={(_pagination, _filters, sorter) => {
              const active = Array.isArray(sorter) ? sorter[0] : sorter;
              const field = active?.field as FileSortKey | undefined;
              if (!active?.order || !field || !SORT_KEYS.includes(field)) {
                setSortKey('name');
                setOrder('asc');
                return;
              }
              setSortKey(field);
              setOrder(active.order === 'descend' ? 'desc' : 'asc');
            }}
            pagination={{ pageSize: 50, hideOnSinglePage: true, showSizeChanger: false }}
            locale={{
              emptyText: emptyView,
            }}
            columns={[
              {
                title: '名称',
                dataIndex: 'name',
                sorter: true,
                sortOrder: sortKey === 'name' ? (order === 'asc' ? 'ascend' : 'descend') : null,
                render: (name: string, r) => {
                  // 次要信息合并进名称列：窄屏时不再靠横向滚动才能看到大小与时间，
                  // 宽屏仍保留独立列（lg/xl 断点显示）。
                  const meta: ReactNode[] = [];
                  if (!r.dir) meta.push(formatSize(r.size));
                  meta.push(formatTime(r.modified));
                  return (
                    <Flex vertical gap={2} style={{ minWidth: 0 }}>
                      <Space size={8} style={{ minWidth: 0 }}>
                        <FileThumb id={r.id} name={name} size={26} />
                        {r.dir ? (
                          <Typography.Link onClick={() => openEntry(r)} ellipsis style={{ fontWeight: 500 }}>
                            {name}
                          </Typography.Link>
                        ) : (
                          <Typography.Link onClick={() => openPreview(r.id)} ellipsis style={{ fontWeight: 500 }}>
                            {name}
                          </Typography.Link>
                        )}
                        {!r.dir ? <ExtTag name={name} /> : null}
                      </Space>
                      <Typography.Text
                        type="secondary"
                        ellipsis
                        style={{ fontSize: 12, paddingLeft: 24, lineHeight: 1.4 }}
                      >
                        {searching
                          ? `${r.path.split('/').slice(0, -1).join('/') || '根目录'} · ${meta.join(' · ')}`
                          : meta.join(' · ')}
                        {isSharedView ? (
                          <>
                            {' · '}
                            <TeamOutlined /> {resolveDisplayName(r.owner, peopleMap, r.path.split('/')[0])}
                          </>
                        ) : null}
                      </Typography.Text>
                      {isSharedView && sharedWritableOf(r.path) ? (
                        <Space size={4} style={{ paddingLeft: 24 }} wrap>
                          <Tag color="green" variant="filled" style={{ fontSize: 11, marginInlineEnd: 0 }}>
                            可编辑
                          </Tag>
                        </Space>
                      ) : null}
                      {isPersonal && !isSharedView && !searching && shareOf(r.path) ? (
                        <Space size={4} style={{ paddingLeft: 24 }} wrap>
                          <TeamOutlined style={{ fontSize: 11, color: 'var(--ant-color-text-tertiary)' }} />
                          {shareOf(r.path)!.recipients.map((n) => (
                            <Tag
                              key={n}
                              variant="filled"
                              title={n}
                              style={{ fontSize: 11, marginInlineEnd: 0 }}
                            >
                              {resolveDisplayName(n, peopleMap, n)}
                            </Tag>
                          ))}
                        </Space>
                      ) : null}
                    </Flex>
                  );
                },
              },
              {
                title: '大小',
                dataIndex: 'size',
                width: 104,
                align: 'right',
                responsive: ['lg'],
                sorter: true,
                sortOrder: sortKey === 'size' ? (order === 'asc' ? 'ascend' : 'descend') : null,
                // 目录自身字节数为 0，展示"—"，真实占用见用量标签
                render: (n: number, r) => (
                  <Typography.Text
                    type={r.dir && !r.dirSize ? 'secondary' : undefined}
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                    title={r.dir ? '目录内所有文件的字节数之和' : undefined}
                  >
                    {r.dir ? (r.dirSize ? formatSize(r.dirSize) : '空') : formatSize(n)}
                  </Typography.Text>
                ),
              },
              {
                title: '修改时间',
                dataIndex: 'modified',
                width: 168,
                responsive: ['xl'],
                sorter: true,
                sortOrder: sortKey === 'modified' ? (order === 'asc' ? 'ascend' : 'descend') : null,
                render: (v: string) => (
                  <Typography.Text type="secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {formatTime(v)}
                  </Typography.Text>
                ),
              },
              {
                title: '创建时间',
                dataIndex: 'created',
                width: 168,
                responsive: ['xxl'],
                sorter: true,
                sortOrder: sortKey === 'created' ? (order === 'asc' ? 'ascend' : 'descend') : null,
                render: (v: string) => (
                  <Typography.Text type="secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {formatTime(v)}
                  </Typography.Text>
                ),
              },
              {
                title: '',
                key: 'actions',
                width: 148,
                align: 'right',
                render: (_: unknown, r) => (
                  <Space size={2}>
                    {r.dir ? (
                      <Button size="small" type="text" icon={<FolderOpenOutlined />} onClick={() => openEntry(r)}>
                        打开
                      </Button>
                    ) : (
                      <>
                        <Tooltip title="预览">
                          <Button
                            size="small"
                            type="text"
                            icon={<EyeOutlined />}
                            aria-label="预览"
                            onClick={() => openPreview(r.id)}
                          />
                        </Tooltip>
                        <Tooltip title="下载">
                          <Button
                            size="small"
                            type="text"
                            icon={<DownloadOutlined />}
                            aria-label="下载"
                            href={`/api/files/${encodeURIComponent(r.id)}/download`}
                          />
                        </Tooltip>
                        {hasPresentation(r.name) ? (
                          <Tooltip title="放映幻灯片">
                            <Button
                              size="small"
                              type="text"
                              icon={<PlayCircleOutlined />}
                              aria-label="放映幻灯片"
                              onClick={() => openOffice(r, 'present')}
                            />
                          </Tooltip>
                        ) : null}
                      </>
                    )}
                    {isPersonal && !isSharedView && r.path !== homePath ? (
                      <Tooltip title={shareOf(r.path) ? '共享设置' : '共享给…'}>
                        <Button
                          size="small"
                          type="text"
                          icon={<TeamOutlined />}
                          aria-label="共享"
                          onClick={() => openShare(r)}
                        />
                      </Tooltip>
                    ) : null}
                    <Dropdown trigger={['click']} menu={{ items: rowMenu(r) }}>
                      <Button size="small" type="text" icon={<EllipsisOutlined />} aria-label="更多操作" />
                    </Dropdown>
                  </Space>
                ),
              },
            ]}
            />

            ) : viewMode === 'grid' ? (
              rows.length ? (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
                    gap: 12,
                  }}
                >
                  {rows.map((r) => {
                    const v = fileVisual(r.name, r.dir);
                    const selected = selectedKeys.includes(r.id);
                    const shared = isPersonal && !isSharedView && shareOf(r.path);
                    return (
                      <Card
                        key={r.id}
                        size="small"
                        hoverable
                        onClick={() => openRow(r)}
                        style={{
                          borderColor: selected ? 'var(--ant-color-primary)' : undefined,
                          boxShadow: selected ? '0 0 0 2px var(--ant-color-primary-border)' : undefined,
                        }}
                        styles={{ body: { padding: 14, display: 'flex', flexDirection: 'column', gap: 8 } }}
                      >
                        <Flex justify="space-between" align="flex-start">
                          <span style={{ fontSize: 28, lineHeight: 1, color: v.color }}>{v.icon}</span>
                          <Checkbox
                            checked={selected}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggleSelect(r.id)}
                            aria-label={`选择 ${r.name}`}
                          />
                        </Flex>
                        <Tooltip title={r.name}>
                          <Typography.Text strong ellipsis>
                            {r.name}
                          </Typography.Text>
                        </Tooltip>
                        <Space size={4} wrap>
                          {r.dir ? (
                            <Tag variant="filled">文件夹</Tag>
                          ) : (
                            <Tag variant="filled">
                              {extOf(r.name).toUpperCase() || '文件'} · {formatSize(r.size)}
                            </Tag>
                          )}
                          {shared ? (
                            <Tag color="blue" variant="filled">
                              共享中
                            </Tag>
                          ) : null}
                        </Space>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                          {formatTime(r.modified)}
                        </Typography.Text>
                        <Flex
                          justify="space-between"
                          align="center"
                          onClick={(e) => e.stopPropagation()}
                          style={{ marginTop: 'auto' }}
                        >
                          <Space size={0}>
                            {r.dir ? (
                              <Button size="small" type="link" onClick={() => openEntry(r)}>
                                打开
                              </Button>
                            ) : (
                              <>
                                <Button
                                  size="small"
                                  type="link"
                                  icon={<EyeOutlined />}
                                  onClick={() => openPreview(r.id)}
                                />
                                {hasPresentation(r.name) ? (
                                  <Tooltip title="放映幻灯片">
                                    <Button
                                      size="small"
                                      type="link"
                                      icon={<PlayCircleOutlined />}
                                      onClick={() => openOffice(r, 'present')}
                                    />
                                  </Tooltip>
                                ) : null}
                                <Button
                                  size="small"
                                  type="link"
                                  icon={<DownloadOutlined />}
                                  href={`/api/files/${encodeURIComponent(r.id)}/download`}
                                />
                              </>
                            )}
                          </Space>
                          <Dropdown trigger={['click']} menu={{ items: rowMenu(r) }}>
                            <Button size="small" type="text" icon={<EllipsisOutlined />} aria-label="更多操作" />
                          </Dropdown>
                        </Flex>
                      </Card>
                    );
                  })}
                </div>
              ) : (
                emptyView
              )
            ) : viewMode === 'details' ? (
              rows.length ? (
                <Flex vertical gap={8}>
                  {rows.map((r) => {
                    const v = fileVisual(r.name, r.dir);
                    return (
                      <Card key={r.id} size="small" styles={{ body: { padding: '10px 14px' } }}>
                        <Flex align="center" gap={12} wrap>
                          <Checkbox
                            checked={selectedKeys.includes(r.id)}
                            onChange={() => toggleSelect(r.id)}
                            aria-label={`选择 ${r.name}`}
                          />
                          <span style={{ fontSize: 22, lineHeight: 1, color: v.color }}>{v.icon}</span>
                          <div style={{ flex: 1, minWidth: 180 }}>
                            <Tooltip title={r.name}>
                              <Typography.Link strong ellipsis onClick={() => openRow(r)}>
                                {r.name}
                              </Typography.Link>
                            </Tooltip>
                            <div>
                              <Typography.Text
                                type="secondary"
                                ellipsis
                                style={{ fontSize: 12, fontFamily: 'monospace' }}
                              >
                                {r.path}
                              </Typography.Text>
                            </div>
                          </div>
                          <Space size={22} wrap>
                            <div>
                              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                                大小
                              </Typography.Text>
                              <div>{r.dir ? '—' : formatSize(r.size)}</div>
                            </div>
                            <div>
                              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                                修改时间
                              </Typography.Text>
                              <div style={{ fontSize: 12 }}>{formatTime(r.modified)}</div>
                            </div>
                            <div>
                              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                                创建时间
                              </Typography.Text>
                              <div style={{ fontSize: 12 }}>{formatTime(r.created)}</div>
                            </div>
                            {isSharedView ? (
                              <Tag variant="filled" color="blue">
                                {(r as FileRow).owner ?? r.path.split('/')[0]} 共享
                              </Tag>
                            ) : null}
                            {isSharedView && sharedWritableOf(r.path) ? (
                              <Tag variant="filled" color="green">
                                可编辑
                              </Tag>
                            ) : null}
                          </Space>
                          {rowActions(r)}
                        </Flex>
                      </Card>
                    );
                  })}
                </Flex>
              ) : (
                emptyView
              )
            ) : (
              <TimelineView
                entries={rows}
                groupBy={TIMELINE_FIRST_SOURCES.has(source) ? 'created' : 'modified'}
                emptyText={emptyDescription}
                onOpen={(entry) => openRow(entry)}
                renderActions={(entry) => (
                  <Dropdown trigger={['click']} menu={{ items: rowMenu(entry) }}>
                    <Button size="small" type="text" icon={<EllipsisOutlined />} aria-label="更多操作" />
                  </Dropdown>
                )}
              />
            )}
          </>
        )}
        {list.isError ? (
          <Alert
            style={{ marginTop: 12 }}
            type="error"
            showIcon
            title="文件列表加载失败"
            description={(list.error as Error)?.message}
          />
        ) : null}
      </Card>
  );
}

