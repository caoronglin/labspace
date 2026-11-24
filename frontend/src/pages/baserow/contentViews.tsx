import { Badge, Button, Card, Dropdown, Empty, Flex, Input, Popconfirm, Popover, Select, Space, Switch, Table, Tag, Tooltip, Typography, Upload } from "antd";
import { CloudUploadOutlined, DatabaseOutlined, DeleteOutlined, EditOutlined, EllipsisOutlined, FieldStringOutlined, FilterOutlined, HistoryOutlined, PlusOutlined, ReloadOutlined, RobotOutlined, SearchOutlined, TableOutlined, TeamOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { Prompts, Welcome } from "@ant-design/x";
import type { BaserowRow } from "../../services/api";
import { tokens } from "../../theme/tokens";
import { VIEW_TYPE_META } from "./fieldComponents";
import type { BaserowPageState } from "./useBaserowPage";
import type { renderViewRenderers } from "./viewRenderers";
import { renderFilterPanelFn } from "./filterPanel";

/**
 * 视图栏（切换/筛选/排序）、工具栏与主内容区。
 * 视图渲染器（画廊/看板等）经 vr 传入，content 按视图类型调用。
 */
export function renderContentViews(
  st: BaserowPageState,
  vr: ReturnType<typeof renderViewRenderers>,
) {
  const {
    rowsQuery,
    workspaceId,
    exportCsv,
    filterPanelOpen,
    fields,
    activeView,
    openRowCreate,
    setPage,
    size,
    invalidate,
    loading,
    sortMutation,
    importFromWorkbench,
    activeRowId,
    selectedWorkspace,
    fieldOptionsMutation,
    deleteTableMutation,
    deleteDatabaseMutation,
    openCreate,
    setSearch,
    setSelectedRowKeys,
    createMutation,
    deleteViewMutation,
    openRenameObject,
    setFieldOpen,
    setWorkspaceId,
    columns,
    deleteWorkspaceMutation,
    workspaces,
    setShareOpen,
    setTrashOpen,
    currentDatabase,
    setViewId,
    tablesQuery,
    message,
    databaseId,
    importing,
    analyzeWithAgent,
    fieldOptions,
    tables,
    batchDeleteMutation,
    setBatchOpen,
    moreMenu,
    currentTable,
    selectedRowKeys,
    focusRow,
    setViewModal,
    setTableId,
    selectAllMutation,
    setActiveRowId,
    viewType,
    modal,
    viewId,
    setFilterPanelOpen,
    overview,
    openRowEdit,
    noWorkspaces,
    qc,
    page,
    runImport,
    views,
    setDatabaseId,
    tableId,
    setSize,
    setOrderBy,
  } = st;
  const {
    galleryView,
    kanbanView,
    calendarView,
    formView,
  } = vr;
  // 筛选面板抽到 filterPanel.tsx；提前声明，viewBar 内联调用要用
  const renderFilterPanel = () => renderFilterPanelFn(st);

  /** 视图栏：切换视图、新建/重命名/删除，以及贴在旁边的筛选与排序面板。 */
  const viewBar = (
    <Flex
      align="center"
      gap={8}
      wrap
      style={{
        borderTop: "1px solid var(--ant-color-border-secondary)",
        paddingTop: 10,
      }}
    >
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        视图
      </Typography.Text>
      {views.map((v) => {
        const meta = VIEW_TYPE_META[v.type] ?? {
          label: v.type,
          icon: <TableOutlined />,
        };
        return (
          <Button
            key={v.id}
            size="small"
            type={v.id === viewId ? "primary" : "default"}
            icon={meta.icon}
            onClick={() => {
              setViewId(v.id);
              setPage(1);
            }}
          >
            {v.name}
          </Button>
        );
      })}
      <Button
        size="small"
        icon={<PlusOutlined />}
        disabled={tableId === null}
        onClick={() => setViewModal({ mode: "create", view: null })}
      >
        新建视图
      </Button>
      {activeView ? (
        <>
          {viewType === "grid" ? (
            <Popover
              placement="bottomLeft"
              trigger="click"
              title="显示字段"
              content={
                <Flex
                  vertical
                  gap={4}
                  style={{ width: 220, maxHeight: 320, overflowY: "auto" }}
                >
                  {fields.map((f) => {
                    const hidden = Boolean(fieldOptions[String(f.id)]?.hidden);
                    return (
                      <Flex
                        key={f.id}
                        align="center"
                        justify="space-between"
                        gap={8}
                      >
                        <Typography.Text style={{ fontSize: 12 }} ellipsis>
                          {f.name}
                        </Typography.Text>
                        <Switch
                          size="small"
                          checked={!hidden}
                          loading={fieldOptionsMutation.isPending}
                          onChange={(checked) =>
                            fieldOptionsMutation.mutate({
                              field: f.id,
                              hidden: !checked,
                            })
                          }
                        />
                      </Flex>
                    );
                  })}
                </Flex>
              }
            >
              <Button size="small" icon={<FieldStringOutlined />}>
                显示字段
              </Button>
            </Popover>
          ) : null}
          <Popover
            open={filterPanelOpen}
            onOpenChange={setFilterPanelOpen}
            placement="bottomLeft"
            trigger="click"
            title="筛选与排序"
            content={renderFilterPanel()}
          >
            <Button size="small" icon={<FilterOutlined />}>
              筛选 / 排序
              {activeView.filters.length + activeView.sortings.length
                ? ` (${activeView.filters.length + activeView.sortings.length})`
                : ""}
            </Button>
          </Popover>
          <Tooltip title="重命名视图">
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              aria-label="重命名视图"
              onClick={() => setViewModal({ mode: "rename", view: activeView })}
            />
          </Tooltip>
          <Popconfirm
            title={`删除视图「${activeView.name}」？`}
            description="视图的筛选与排序配置会一并删除，记录本身不受影响。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => deleteViewMutation.mutateAsync(activeView.id)}
          >
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              aria-label="删除视图"
            />
          </Popconfirm>
        </>
      ) : null}
      <span style={{ flex: 1 }} />
      <Tooltip title="最近删除的内容，可恢复">
        <Button
          size="small"
          type="text"
          icon={<HistoryOutlined />}
          onClick={() => setTrashOpen(true)}
        >
          最近删除
        </Button>
      </Tooltip>
    </Flex>
  );
  // 筛选面板抽到 filterPanel.tsx；保留同名包装，调用点不用改

  /** 批量操作条：选中行后出现。 */
  // 表格总条数（当前筛选/视图下），用于说清"选中的范围"。
  const totalCount = rowsQuery.data?.count ?? 0;

  const batchBar = selectedRowKeys.length ? (
    <Flex
      align="center"
      gap={8}
      wrap
      style={{
        borderTop: "1px solid var(--ant-color-border-secondary)",
        paddingTop: 10,
      }}
    >
      {/* 说清"选中的到底是什么范围"。
          antd 表格的表头全选框只选**当前页**，但用户很容易以为选中了全部；
          然后点批量删除，就出现"我明明选了所有，怎么只删了 20 条"的困惑。
          这里把范围写出来，并给一个显式的"选择全部"。 */}
      <Typography.Text style={{ fontSize: 12 }}>
        已选 {selectedRowKeys.length} 条
        {totalCount > selectedRowKeys.length
          ? `（表格共 ${totalCount} 条，当前只选中了这些）`
          : ""}
      </Typography.Text>
      {totalCount > selectedRowKeys.length ? (
        <Button
          size="small"
          type="link"
          style={{ padding: 0 }}
          loading={selectAllMutation.isPending}
          onClick={() => selectAllMutation.mutate()}
        >
          选择全部 {totalCount} 条
        </Button>
      ) : null}
      <Button size="small" onClick={() => setBatchOpen(true)}>
        批量修改
      </Button>
      <Popconfirm
        title={`删除选中的 ${selectedRowKeys.length} 条记录？`}
        description={
          totalCount > selectedRowKeys.length
            ? `只删除这 ${selectedRowKeys.length} 条（表格共 ${totalCount} 条，未选中的不受影响）。删除后不可恢复。`
            : "删除后不可恢复。"
        }
        okText="删除"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        onConfirm={() =>
          batchDeleteMutation.mutateAsync(selectedRowKeys.map((k) => Number(k)))
        }
      >
        <Button size="small" danger icon={<DeleteOutlined />}>
          批量删除
        </Button>
      </Popconfirm>
      <Button size="small" type="text" onClick={() => setSelectedRowKeys([])}>
        取消选择
      </Button>
    </Flex>
  ) : null;

  const toolbar = (
    <Card size="small" styles={{ body: { padding: "10px 14px" } }}>
      <Flex vertical gap={10}>
        <Flex justify="space-between" align="center" wrap gap={10}>
          <Space wrap size={8}>
            <Select
              style={{ minWidth: 150 }}
              value={workspaceId ?? undefined}
              loading={overview.isLoading}
              placeholder="工作区"
              options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
              onChange={(id) => {
                setWorkspaceId(id);
                setDatabaseId(null);
                setTableId(null);
                setPage(1);
              }}
              suffix={<DatabaseOutlined />}
            />
            <Tooltip title="重命名工作区">
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                aria-label="重命名工作区"
                disabled={!selectedWorkspace}
                onClick={() => openRenameObject("workspace")}
              />
            </Tooltip>
            <Popconfirm
              title={`删除工作区「${selectedWorkspace?.name ?? ""}」？`}
              description={
                selectedWorkspace?.databases.length
                  ? `该工作区含 ${selectedWorkspace.databases.length} 个数据库，表与数据都会一并删除，且不可恢复。`
                  : "工作区会一并删除，且不可恢复。"
              }
              okText="删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              disabled={!selectedWorkspace}
              onConfirm={() =>
                selectedWorkspace &&
                deleteWorkspaceMutation.mutateAsync(selectedWorkspace.id)
              }
            >
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                aria-label="删除工作区"
                disabled={!selectedWorkspace}
              />
            </Popconfirm>
            <Select
              style={{ minWidth: 150 }}
              value={databaseId ?? undefined}
              placeholder="数据表"
              disabled={!selectedWorkspace?.databases.length}
              options={(selectedWorkspace?.databases ?? []).map((d) => ({
                value: d.id,
                label: d.name,
              }))}
              onChange={(id) => {
                setDatabaseId(id);
                setTableId(null);
                setPage(1);
              }}
            />
            <Tooltip title="新建数据表">
              <Button
                type="text"
                size="small"
                icon={<PlusOutlined />}
                aria-label="新建数据表"
                disabled={!selectedWorkspace}
                onClick={() => openCreate("database")}
              />
            </Tooltip>
            <Tooltip title="重命名数据表">
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                aria-label="重命名数据表"
                disabled={!currentDatabase}
                onClick={() => openRenameObject("database")}
              />
            </Tooltip>
            <Popconfirm
              title={`删除数据表「${currentDatabase?.name ?? ""}」？`}
              description="数据表中的所有工作表、字段与记录都会一并删除，且不可恢复。"
              okText="删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              disabled={!currentDatabase}
              onConfirm={() =>
                currentDatabase &&
                deleteDatabaseMutation.mutateAsync(currentDatabase.id)
              }
            >
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                aria-label="删除数据表"
                disabled={!currentDatabase}
              />
            </Popconfirm>
            <Select
              style={{ minWidth: 160 }}
              value={tableId ?? undefined}
              placeholder="工作表"
              loading={tablesQuery.isLoading}
              disabled={!tables.length}
              options={tables.map((t) => ({ value: t.id, label: t.name }))}
              onChange={(id) => {
                setTableId(id);
                setPage(1);
                setSearch("");
                setOrderBy("");
              }}
            />
          </Space>{" "}
          <Space wrap size={8}>
            {tableId !== null ? (
              <Input.Search
                allowClear
                placeholder="搜索记录"
                prefix={<SearchOutlined />}
                style={{ width: 220 }}
                onSearch={(v) => {
                  setSearch(v.trim());
                  setPage(1);
                }}
              />
            ) : null}
            {selectedWorkspace && selectedWorkspace.databases.length === 0 ? (
              <Button
                icon={<PlusOutlined />}
                onClick={() => openCreate("database")}
              >
                新建数据表
              </Button>
            ) : null}
            <Upload
              accept=".csv,.tsv,.txt"
              showUploadList={false}
              customRequest={({ file, onSuccess, onError }) => {
                runImport(file as File).then(
                  () => onSuccess?.({}),
                  () => onError?.(new Error("import failed")),
                );
              }}
            >
              <Button
                icon={<CloudUploadOutlined />}
                loading={importing}
                disabled={tableId === null}
              >
                导入表格
              </Button>
            </Upload>
            <Tooltip title="把个人工作台进行中的事项写成表格导入">
              <Button
                icon={<UnorderedListOutlined />}
                loading={importing}
                disabled={tableId === null}
                onClick={() => void importFromWorkbench()}
              >
                从工作台导入
              </Button>
            </Tooltip>
            <Dropdown
              trigger={["click"]}
              menu={{
                items: moreMenu,
                onClick: ({ key }) => {
                  if (key === "export") void exportCsv();
                  if (key === "fields") setFieldOpen(true);
                  if (key === "delete-table" && tableId !== null) {
                    modal.confirm({
                      title: "删除整个工作表？",
                      content: "工作表中的所有字段与记录都会删除，且不可恢复。",
                      okText: "删除",
                      okButtonProps: { danger: true },
                      cancelText: "取消",
                      onOk: () => deleteTableMutation.mutateAsync(),
                    });
                  }
                },
              }}
            >
              <Button icon={<EllipsisOutlined />} aria-label="更多操作" />
            </Dropdown>
            <Tooltip title="共享工作区">
              <Button
                icon={<TeamOutlined />}
                onClick={() => setShareOpen(true)}
                disabled={!selectedWorkspace}
              >
                共享
              </Button>
            </Tooltip>
            <Badge count={workspaces.length} size="small" offset={[-2, 2]}>
              <Button
                icon={<PlusOutlined />}
                onClick={() => openCreate("workspace")}
                aria-label="新建工作区"
              />
            </Badge>
            <Button
              icon={<ReloadOutlined />}
              loading={overview.isFetching || rowsQuery.isFetching}
              onClick={() => {
                invalidate("overview");
                if (databaseId) invalidate("tables");
                if (tableId) {
                  invalidate("fields");
                  invalidate("rows");
                  qc.invalidateQueries({ queryKey: ["baserow", "views"] });
                }
              }}
            >
              刷新
            </Button>
            <Tooltip title="把当前表结构与样例交给 Agent 分析">
              <Button
                icon={<RobotOutlined />}
                disabled={tableId === null}
                onClick={analyzeWithAgent}
              >
                分析数据
              </Button>
            </Tooltip>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={openRowCreate}
              disabled={tableId === null}
            >
              新增记录
            </Button>
          </Space>
        </Flex>
        {viewBar}
        {batchBar}
      </Flex>
    </Card>
  );

  const content = () => {
    if (noWorkspaces) {
      return (
        <Card
          variant="borderless"
          style={{ background: "var(--ant-color-fill-quaternary)" }}
        >
          <Flex
            vertical
            align="center"
            gap={16}
            style={{ padding: "32px 12px" }}
          >
            <Welcome
              variant="borderless"
              icon={
                <TableOutlined style={{ fontSize: 44, color: tokens.colorPrimary }} />
              }
              title="用多维表格整理实验记录"
              description="每位成员拥有独立的工作区，可自由创建数据表、字段与记录；需要协作时可邀请同组成员共享。"
            />
            <Prompts
              wrap
              items={[
                {
                  key: "create",
                  label: "创建我的第一个工作区",
                  description: "默认命名「个人空间」",
                },
                {
                  key: "help",
                  label: "多维表格能做什么？",
                  description: "结构化记录 / 视图 / 协作",
                },
              ]}
              onItemClick={(info) => {
                if (info.data.key === "create")
                  createMutation.mutate({
                    kind: "workspace",
                    name: "个人空间",
                  });
                else
                  message.info(
                    "支持表格、画廊、看板、日历、表单视图：每张工作表可建多个视图，各自带筛选与排序；也可导入 CSV、导出数据并邀请成员共享。",
                  );
              }}
            />
          </Flex>
        </Card>
      );
    }
    if (databaseId === null) {
      return (
        <Card>
          <Empty description="当前工作区还没有数据表">
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => openCreate("database")}
            >
              新建数据表
            </Button>
          </Empty>
        </Card>
      );
    }
    if (tables.length === 0 && !tablesQuery.isLoading) {
      return (
        <Card>
          <Empty description="这个数据表还没有工作表">
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => openCreate("table")}
            >
              新建工作表
            </Button>
          </Empty>
        </Card>
      );
    }
    if (tableId === null) {
      return (
        <Card>
          <Empty description="选择或新建一个工作表" />
        </Card>
      );
    }
    return (
      <Card
        size="small"
        title={
          <Space size={8} wrap>
            <Typography.Text strong>
              {currentTable?.name || "工作表"}
            </Typography.Text>
            <Tag
              color={
                selectedWorkspace?.name.includes("个人") ? "default" : "blue"
              }
            >
              {selectedWorkspace?.name.includes("个人") ? "个人" : "共享"}
            </Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {rowsQuery.data
                ? `共 ${rowsQuery.data.count} 条记录`
                : `${fields.length} 个字段`}
            </Typography.Text>
          </Space>
        }
        extra={
          <Space wrap>
            <Button
              size="small"
              icon={<PlusOutlined />}
              onClick={() => setFieldOpen(true)}
            >
              新增字段
            </Button>
            <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              onClick={openRowCreate}
            >
              新增记录
            </Button>
          </Space>
        }
      >
        {viewType === "grid" ? (
          <Table<BaserowRow>
            size="middle"
            rowKey="id"
            loading={loading || rowsQuery.isFetching}
            dataSource={rowsQuery.data?.results ?? []}
            columns={columns}
            rowSelection={{
              selectedRowKeys,
              onChange: setSelectedRowKeys,
              preserveSelectedRowKeys: true,
            }}
            onRow={(row) => ({
              // 键盘可达：行本身可聚焦，带 data-row-id 供 ↑↓ 定位。
              "data-row-id": row.id,
              tabIndex: 0,
              "aria-selected": activeRowId === row.id || undefined,
              onFocus: () => setActiveRowId(row.id),
              onKeyDown: (e) => {
                const rows = rowsQuery.data?.results ?? [];
                const idx = rows.findIndex((r) => r.id === row.id);
                if (
                  e.key === "ArrowDown" &&
                  idx >= 0 &&
                  idx < rows.length - 1
                ) {
                  e.preventDefault();
                  focusRow(rows[idx + 1].id);
                } else if (e.key === "ArrowUp" && idx > 0) {
                  e.preventDefault();
                  focusRow(rows[idx - 1].id);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  openRowEdit(row);
                } else if (e.key === " ") {
                  e.preventDefault();
                  // 空格勾选/取消这一行（不用去够复选框）
                  const key = row.id;
                  setSelectedRowKeys((prev) =>
                    prev.includes(key)
                      ? prev.filter((k) => k !== key)
                      : [...prev, key],
                  );
                }
              },
            })}
            scroll={{ x: "max-content" }}
            pagination={{
              current: page,
              pageSize: size,
              total: rowsQuery.data?.count ?? 0,
              showSizeChanger: true,
              pageSizeOptions: [20, 50, 100, 200],
              showTotal: (t) => `共 ${t} 条`,
              onChange: (p, s) => {
                setPage(p);
                setSize(s);
              },
            }}
            onChange={(_p, _f, sorter) => {
              const s = Array.isArray(sorter) ? sorter[0] : sorter;
              const field = s?.field;
              if (!s?.order || !field) {
                setOrderBy("");
                return;
              }
              // 视图生效时排序写回视图（Baserow 的 view sortings），否则用临时 order_by
              const target = fields.find((f) => f.name === String(field));
              if (activeView && target) {
                const order = s.order === "descend" ? "DESC" : "ASC";
                const existing = activeView.sortings.find(
                  (x) => x.field === target.id,
                );
                if (existing) {
                  sortMutation.mutate({
                    action: "update",
                    id: existing.id,
                    field: target.id,
                    order,
                  });
                } else {
                  sortMutation.mutate({
                    action: "create",
                    field: target.id,
                    order,
                  });
                }
                setOrderBy("");
                setPage(1);
                return;
              }
              setOrderBy(`${s.order === "descend" ? "-" : ""}${String(field)}`);
              setPage(1);
            }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="暂无记录"
                />
              ),
            }}
          />
        ) : viewType === "gallery" ? (
          galleryView
        ) : viewType === "kanban" ? (
          kanbanView()
        ) : viewType === "calendar" ? (
          calendarView()
        ) : (
          formView()
        )}
      </Card>
    );
  };

  return {
    viewBar,
    totalCount,
    batchBar,
    toolbar,
    content,
    renderFilterPanel,
  };
}
