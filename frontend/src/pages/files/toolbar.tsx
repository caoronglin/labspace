import {
  Alert,
  Badge,
  Breadcrumb,
  Button,
  Card,
  Flex,
  Input,
  Progress,
  Segmented,
  Space,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import {
  AppstoreOutlined,
  ArrowLeftOutlined,
  ClockCircleOutlined,
  CloudUploadOutlined,
  DatabaseOutlined,
  FileAddOutlined,
  FolderAddOutlined,
  HistoryOutlined,
  ProfileOutlined,
  ReloadOutlined,
  RestOutlined,
  ShareAltOutlined,
  TeamOutlined,
  UnorderedListOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { formatSize } from '../../components/files/fileMeta';
import { fileErrorText, sourceHint, TIMELINE_FIRST_SOURCES } from './presenters';
import type { FilesDeps } from './actions';

/** Files 页顶部工具栏与筛选卡（从 pages/Files.tsx 原样搬出，JSX 逐字未改）。 */
export function renderToolbar(deps: FilesDeps) {
  const {
    writableHere, mkdirHere, setDialog, setDialogName,
    setNewFileOpen, setNewFileName, setNewFileBody,
    message, uploading, uploadOne, uploadTree,
    isPersonal, isSharedView, personalShares, setManageOpen,
    isAdmin, setAuditOpen, trashItems, setTrashOpen, list,
  } = deps;
  return (
        <Space wrap>
          {writableHere ? (
            <>
              {mkdirHere ? (
                <Button
                  icon={<FolderAddOutlined />}
                  onClick={() => {
                    setDialog({ mode: 'mkdir' });
                    setDialogName('');
                  }}
                >
                  新建文件夹
                </Button>
              ) : null}
              {/* 新建文件：手机上是刚需（不能先在本地建好再传） */}
              <Button
                icon={<FileAddOutlined />}
                onClick={() => {
                  setNewFileOpen(true);
                  setNewFileName('');
                  setNewFileBody('');
                }}
              >
                新建文件
              </Button>
              <Upload
                multiple
                showUploadList={false}
                customRequest={async ({ file, onSuccess, onError }) => {
                  try {
                    await uploadOne(file as File);
                    onSuccess?.({});
                  } catch (e) {
                    message.error(`上传失败：${fileErrorText((e as Error).message)}`);
                    onError?.(e as Error);
                  }
                }}
              >
                <Button type="primary" icon={<UploadOutlined />} loading={Boolean(uploading)}>
                  上传文件
                </Button>
              </Upload>
              {/* 文件夹上传：按 webkitRelativePath 还原目录结构（见 uploadTree） */}
              <Upload
                multiple
                directory
                showUploadList={false}
                customRequest={async ({ file, onSuccess, onError }) => {
                  // directory 模式下 antd 仍然逐文件回调；这里只做单文件兜底，
                  // 真正的树状上传由下方的 onBatch 统一处理。
                  onSuccess?.({});
                  void file;
                  void onError;
                }}
                beforeUpload={(file, fileList) => {
                  // 只在最后一个文件时触发一次批量处理，避免每文件重复建目录。
                  if (file === fileList[fileList.length - 1]) {
                    void uploadTree(fileList as File[]);
                  }
                  return Upload.LIST_IGNORE;
                }}
              >
                <Button icon={<FolderAddOutlined />} loading={Boolean(uploading)}>
                  上传文件夹
                </Button>
              </Upload>
            </>
          ) : null}
          {isPersonal && !isSharedView && personalShares.length ? (
            <Badge count={personalShares.length} size="small" offset={[-2, 2]}>
              <Button icon={<TeamOutlined />} onClick={() => setManageOpen(true)}>
                共享管理
              </Button>
            </Badge>
          ) : null}
          {isAdmin ? (
            <Button icon={<HistoryOutlined />} onClick={() => setAuditOpen(true)}>
              访问记录
            </Button>
          ) : null}
          <Badge count={trashItems.length} size="small" offset={[-2, 2]}>
            <Button icon={<RestOutlined />} onClick={() => setTrashOpen(true)}>
              回收站
            </Button>
          </Badge>
          <Button icon={<ReloadOutlined />} onClick={() => list.refetch()} loading={list.isFetching}>
            刷新
          </Button>
        </Space>
  );
}

export function renderFilterCard(deps: FilesDeps) {
  const {
    source, setSource, setDir, setQ, setPersonalScope, listableSources,
    isPersonal, personalScope, homePath, sharedWith,
    stats, activeSource, isSharedView, sharedRoots, canWrite, sourceWritable, writable,
    viewMode, setViewMode, setViewPinned, q, breadcrumb, parentDir, canGoUp,
  } = deps;
  return (
      <Card size="small">
        <Flex vertical gap={12}>
          <Flex justify="space-between" align="center" wrap gap={12}>
            <Space size={8} wrap>
              <Segmented
                value={source}
                onChange={(v) => {
                  setSource(String(v));
                  setDir('');
                  setQ('');
                  setPersonalScope('mine');
                }}
                options={listableSources.map((s) => ({
                  value: s.id,
                  label: s.label,
                }))}
              />
              {isPersonal ? (
                <Segmented
                  size="small"
                  value={personalScope}
                  onChange={(v) => {
                    const next = v as 'mine' | 'shared';
                    setPersonalScope(next);
                    setQ('');
                    setDir(next === 'mine' ? homePath : '');
                  }}
                  options={[
                    { value: 'mine', label: '我的文件' },
                    { value: 'shared', label: `共享给我${sharedWith.length ? ` (${sharedWith.length})` : ''}` },
                  ]}
                />
              ) : null}
            </Space>
            <Space size={8} wrap>
              <Tooltip title="当前目录内直接包含的文件数与占用；整源用量见下一项">
                <Tag icon={<ShareAltOutlined />} color="default">
                  当前目录 {stats.files} 个文件 · {formatSize(stats.size)}
                </Tag>
              </Tooltip>
              <Tooltip
                title={
                  isPersonal
                    ? isSharedView
                      ? '他人共享给我的文件数与占用'
                      : '我的个人空间文件数与占用'
                    : `整个「${activeSource?.label ?? source}」可见范围内的文件数与占用`
                }
              >
                <Tag icon={<DatabaseOutlined />} color="default">
                  共 {stats.totalFiles} 个文件 · {formatSize(stats.totalSize)}
                </Tag>
              </Tooltip>
              {activeSource?.shared ? <Tag color="green">共享空间</Tag> : <Tag>私人空间</Tag>}
              {isSharedView ? (
                <Tag color="blue">
                  {/* 「只能上传」也是可写：不区分的话，学生明明能传材料却被标成只读 */}
                  他人共享
                  {sharedWith.some((s) => s.writable)
                    ? ' · 部分可编辑'
                    : sharedRoots.some((r) => canWrite(r))
                      ? ' · 可上传'
                      : ' · 只读'}
                </Tag>
              ) : null}
              {!isSharedView && activeSource && activeSource.listable && !writable ? (
                <Tag color="default">{sourceWritable ? '当前目录只读' : '只读'}</Tag>
              ) : null}
            </Space>
          </Flex>
          <Flex justify="space-between" align="center" wrap gap={12}>
            <Space size={8} wrap>
              {canGoUp ? (
                <Button
                  size="small"
                  icon={<ArrowLeftOutlined />}
                  onClick={() => setDir(parentDir)}
                >
                  上级
                </Button>
              ) : null}
              <Breadcrumb items={breadcrumb} />
            </Space>
            <Space size={8} wrap>
              <Tooltip
                title={
                  TIMELINE_FIRST_SOURCES.has(source)
                    ? '公共资料/基因组按“加入时间”浏览更顺手，已默认时间线视图'
                    : '个人文件按名称检索更快，已默认列表视图'
                }
              >
                <Segmented
                  size="small"
                  value={viewMode}
                  onChange={(v) => {
                    setViewMode(v as typeof viewMode);
                    setViewPinned(true);
                  }}
                  options={[
                    { value: 'list', icon: <UnorderedListOutlined />, title: '列表视图' },
                    { value: 'grid', icon: <AppstoreOutlined />, title: '网格视图' },
                    { value: 'details', icon: <ProfileOutlined />, title: '详情视图' },
                    { value: 'timeline', icon: <ClockCircleOutlined />, title: '时间线视图' },
                  ]}
                />
              </Tooltip>
              <Input.Search
                allowClear
                placeholder="在文件源中搜索名称或路径"
                style={{ width: 280 }}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </Space>
          </Flex>
          {activeSource ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {sourceHint(activeSource)}
            </Typography.Text>
          ) : null}
        </Flex>
      </Card>
  );
}

export function renderUploadAlerts(deps: FilesDeps) {
  const { uploading, uploadErrors, setUploadErrors } = deps;
  return (
    <>
      {/* 上传进度：批量/文件夹上传时给实时反馈，避免界面像卡死 */}
      {uploading ? (
        <Alert
          type="info"
          showIcon
          icon={<CloudUploadOutlined />}
          title={`正在上传 ${uploading.done} / ${uploading.total}`}
          description={
            <Flex vertical gap={6}>
              <Progress
                percent={uploading.total ? Math.round((uploading.done / uploading.total) * 100) : 0}
                size="small"
                status="active"
              />
              <Typography.Text type="secondary" ellipsis style={{ fontSize: 12 }}>
                {uploading.current}
              </Typography.Text>
            </Flex>
          }
        />
      ) : null}

      {/* 失败明细：把"哪几个失败、为什么"摊开，而不是只弹一条 message */}
      {uploadErrors.length ? (
        <Alert
          type="warning"
          showIcon
          title={`有 ${uploadErrors.length} 个文件没有上传成功`}
          description={
            <Flex vertical gap={2} style={{ maxHeight: 140, overflowY: 'auto' }}>
              {uploadErrors.slice(0, 20).map((e, i) => (
                <Typography.Text key={`${e.name}-${i}`} style={{ fontSize: 12 }}>
                  <Typography.Text strong>{e.name}</Typography.Text>
                  <Typography.Text type="secondary"> — {e.reason}</Typography.Text>
                </Typography.Text>
              ))}
              {uploadErrors.length > 20 ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  …另有 {uploadErrors.length - 20} 个
                </Typography.Text>
              ) : null}
            </Flex>
          }
          action={
            <Button size="small" onClick={() => setUploadErrors([])}>
              知道了
            </Button>
          }
        />
      ) : null}

    </>
  );
}

