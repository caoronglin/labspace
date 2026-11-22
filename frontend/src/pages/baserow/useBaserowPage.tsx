import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Form, Grid, Space, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DeleteOutlined, DownloadOutlined, EditOutlined, FieldStringOutlined, PlusOutlined } from "@ant-design/icons";
import type { MenuProps } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import { useNavigate } from "react-router-dom";
import { api, baserowApi, type BaserowField, type BaserowFile, type BaserowMember, type BaserowRow, type BaserowTableRef, type BaserowView, type BaserowWorkspace, type WorkbenchItem } from "../../services/api";
import { errText } from "../../utils/err";
import { handoffToAgent } from "../../utils/agentHandoff";
import { EDITABLE, plainText, dateKey, renderValue, toFormValue, downloadCsv, LinkRowCell } from "./fieldComponents";
import { useBaserowMutations } from "./useBaserowMutations";

/**
 * BaserowPage 的状态层：全部 state / useQuery / 处理函数。
 * useBaserowBase 持有 state 与查询；useBaserowMutations 组装写操作；
 * 本函数再接剩余处理函数并汇总返回。类型全由 ReturnType 推断。
 */
function useBaserowBase() {
  const { message, modal } = App.useApp();
  const screens = Grid.useBreakpoint();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const narrow = !screens.lg;

  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [databaseId, setDatabaseId] = useState<number | null>(null);
  const [tableId, setTableId] = useState<number | null>(null);
  const [viewId, setViewId] = useState<number | null>(null);
  const [viewModal, setViewModal] = useState<null | {
    mode: "create" | "rename";
    view: BaserowView | null;
  }>(null);
  const [viewForm] = Form.useForm<{ name: string; type: string }>();
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchForm] = Form.useForm<{ field: string; value: unknown }>();
  const [trashOpen, setTrashOpen] = useState(false);
  const [newFilterField, setNewFilterField] = useState<number | null>(null);
  const [newFilterType, setNewFilterType] = useState<string | null>(null);
  const [newFilterValue, setNewFilterValue] = useState("");
  const [newSortField, setNewSortField] = useState<number | null>(null);
  const [newSortOrder, setNewSortOrder] = useState<"ASC" | "DESC">("ASC");
  /** 新建视图后要选中的视图 id：等视图列表刷新到再选，避免被旧列表覆盖。 */
  const pendingViewIdRef = useRef<number | null>(null);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(50);
  const [search, setSearch] = useState("");
  const [orderBy, setOrderBy] = useState("");
  const [createKind, setCreateKind] = useState<
    null | "workspace" | "database" | "table"
  >(null);
  const [fieldOpen, setFieldOpen] = useState(false);
  const [rowOpen, setRowOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<BaserowRow | null>(null);
  /**
   * 键盘操作 + 撤销栈。
   *
   * 为什么需要：多维表格之前**完全只能靠鼠标**（审计发现全文 0 处键盘支持）。
   * 实际用起来最难受的两点：
   *   1) 在二十几列里定位一行只能靠眼睛扫 + 拖横向滚动条；
   *   2) 改错一个单元格只能打开抽屉改，没有 Cmd+Z。
   * 这里补：↑↓ 移动行、Enter 打开编辑、Space 勾选、Esc 取消选择、Cmd/Ctrl+Z 撤销上一次编辑。
   */
  const [activeRowId, setActiveRowId] = useState<number | null>(null);
  // 撤销栈：每次保存行编辑前，把**改之前的整行**压进来；Ctrl+Z 取回并写回。
  const editUndoStack = useRef<
    { row: BaserowRow; values: Record<string, unknown> }[]
  >([]);
  const [shareOpen, setShareOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("MEMBER");
  const [renameTarget, setRenameTarget] = useState<BaserowField | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameObject, setRenameObject] = useState<null | {
    kind: "workspace" | "database";
    id: number;
    name: string;
  }>(null);
  const [renameObjectValue, setRenameObjectValue] = useState("");
  const [importing, setImporting] = useState(false);
  const [fieldFormKey, setFieldFormKey] = useState(0);

  const [createForm] = Form.useForm<{ name: string }>();
  const [rowForm] = Form.useForm<Record<string, unknown>>();

  const overview = useQuery({
    queryKey: ["baserow", "overview"],
    queryFn: baserowApi.overview,
  });
  const workspaces = overview.data?.workspaces ?? [];

  const selectedWorkspace: BaserowWorkspace | undefined = useMemo(
    () =>
      workspaces.find((w) => w.id === workspaceId) ??
      workspaces.find((w) => w.databases.some((d) => d.id === databaseId)),
    [workspaces, workspaceId, databaseId],
  );

  const tablesQuery = useQuery({
    queryKey: ["baserow", "tables", databaseId],
    queryFn: () => baserowApi.tables(databaseId as number),
    enabled: databaseId !== null,
  });
  const tables = tablesQuery.data?.tables ?? [];

  const fieldsQuery = useQuery({
    queryKey: ["baserow", "fields", tableId],
    queryFn: () => baserowApi.fields(tableId as number),
    enabled: tableId !== null,
  });
  const fields = fieldsQuery.data?.fields ?? [];

  const viewsQuery = useQuery({
    queryKey: ["baserow", "views", tableId],
    queryFn: () => baserowApi.views(tableId as number),
    enabled: tableId !== null,
  });
  const views = viewsQuery.data?.views ?? [];
  const activeView = useMemo(
    () => views.find((v) => v.id === viewId) ?? null,
    [views, viewId],
  );
  /** 当前视图的类型决定渲染方式；没有视图时退回表格。 */
  const viewType = activeView?.type ?? "grid";

  const fieldOptionsQuery = useQuery({
    queryKey: ["baserow", "view-field-options", tableId, viewId],
    queryFn: () =>
      baserowApi.viewFieldOptions(tableId as number, viewId as number),
    enabled: tableId !== null && viewId !== null && viewType === "grid",
    staleTime: 30_000,
  });
  const fieldOptions = fieldOptionsQuery.data?.field_options ?? {};

  const fieldOptionsMutation = useMutation({
    mutationFn: (vars: { field: number; hidden: boolean }) => {
      const current = { ...fieldOptions };
      Object.entries(current).forEach(([fid, opt]) => {
        current[fid] = { ...opt };
      });
      const key = String(vars.field);
      const prev = current[key] ?? {};
      current[key] = { ...prev, hidden: vars.hidden };
      return baserowApi.updateViewFieldOptions(
        tableId as number,
        viewId as number,
        current,
      );
    },
    onSuccess: async () => {
      await qc.invalidateQueries({
        queryKey: ["baserow", "view-field-options"],
      });
    },
    onError: (e) => message.error(errText(e)),
  });

  const rowsQuery = useQuery({
    queryKey: ["baserow", "rows", tableId, page, size, search, orderBy, viewId],
    queryFn: () =>
      baserowApi.rows(tableId as number, {
        page,
        size,
        search,
        // 视图生效时排序由视图的 sortings 决定，不再叠加临时 order_by
        order_by: viewId ? "" : orderBy,
        view_id: viewId,
      }),
    enabled: tableId !== null,
  });

  const viewRowsQuery = useQuery({
    queryKey: ["baserow", "view-rows", tableId, search, viewId],
    queryFn: () =>
      baserowApi.rows(tableId as number, {
        page: 1,
        size: 200,
        search,
        order_by: viewId ? "" : orderBy,
        view_id: viewId,
      }),
    enabled: tableId !== null && viewType !== "grid",
  });
  const viewRows = viewRowsQuery.data?.results ?? [];

  const membersQuery = useQuery({
    queryKey: ["baserow", "members", selectedWorkspace?.id],
    queryFn: () => baserowApi.members(selectedWorkspace?.id as number),
    enabled: shareOpen && Boolean(selectedWorkspace?.id),
  });
  const members: BaserowMember[] = membersQuery.data?.members ?? [];

  const hasPeopleField = fields.some((f) => f.people);
  const peopleQuery = useQuery({
    queryKey: ["baserow", "people", tableId],
    queryFn: () => baserowApi.people(tableId as number),
    enabled: tableId !== null && hasPeopleField,
    staleTime: 60_000,
  });
  const people = peopleQuery.data?.people ?? [];
  const peopleByRow = useMemo(
    () => new Map(people.map((p) => [p.row_id, p])),
    [people],
  );

  useEffect(() => {
    if (workspaceId === null && workspaces.length)
      setWorkspaceId(workspaces[0].id);
  }, [workspaceId, workspaces]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    const dbs = selectedWorkspace.databases;
    if (databaseId !== null && dbs.some((d) => d.id === databaseId)) return;
    setDatabaseId(dbs[0]?.id ?? null);
    setTableId(null);
  }, [selectedWorkspace, databaseId]);

  useEffect(() => {
    if (databaseId === null) {
      setTableId(null);
      return;
    }
    if (!tablesQuery.isSuccess) return;
    if (tableId === null || !tables.some((t) => t.id === tableId)) {
      setTableId(tables[0]?.id ?? null);
      setPage(1);
      setSearch("");
      setOrderBy("");
    }
  }, [databaseId, tablesQuery.isSuccess, tables, tableId]);

  // 切换工作表时清掉视图与多选状态
  useEffect(() => {
    setViewId(null);
    setSelectedRowKeys([]);
  }, [tableId]);

  // 视图列表变化时（新建/删除/切换表）选中一个可用视图
  useEffect(() => {
    if (!views.length) {
      setViewId(null);
      return;
    }
    if (pendingViewIdRef.current !== null) {
      if (views.some((v) => v.id === pendingViewIdRef.current)) {
        setViewId(pendingViewIdRef.current);
        pendingViewIdRef.current = null;
      }
      return;
    }
    if (viewId === null || !views.some((v) => v.id === viewId))
      setViewId(views[0].id);
  }, [views, viewId]);

  useEffect(() => {
    setSelectedRowKeys([]);
    // 视图自带排序，切换视图时清掉临时 order_by，避免两边冲突
    setOrderBy("");
  }, [viewId]);

  return {
    message,
    modal,
    screens,
    qc,
    navigate,
    narrow,
    workspaceId,
    setWorkspaceId,
    databaseId,
    setDatabaseId,
    tableId,
    setTableId,
    viewId,
    setViewId,
    viewModal,
    setViewModal,
    viewForm,
    filterPanelOpen,
    setFilterPanelOpen,
    selectedRowKeys,
    setSelectedRowKeys,
    batchOpen,
    setBatchOpen,
    batchForm,
    trashOpen,
    setTrashOpen,
    newFilterField,
    setNewFilterField,
    newFilterType,
    setNewFilterType,
    newFilterValue,
    setNewFilterValue,
    newSortField,
    setNewSortField,
    newSortOrder,
    setNewSortOrder,
    pendingViewIdRef,
    page,
    setPage,
    size,
    setSize,
    search,
    setSearch,
    orderBy,
    setOrderBy,
    createKind,
    setCreateKind,
    fieldOpen,
    setFieldOpen,
    rowOpen,
    setRowOpen,
    editingRow,
    setEditingRow,
    activeRowId,
    setActiveRowId,
    editUndoStack,
    shareOpen,
    setShareOpen,
    inviteEmail,
    setInviteEmail,
    inviteRole,
    setInviteRole,
    renameTarget,
    setRenameTarget,
    renameValue,
    setRenameValue,
    renameObject,
    setRenameObject,
    renameObjectValue,
    setRenameObjectValue,
    importing,
    setImporting,
    fieldFormKey,
    setFieldFormKey,
    createForm,
    rowForm,
    overview,
    workspaces,
    selectedWorkspace,
    tablesQuery,
    tables,
    fieldsQuery,
    fields,
    viewsQuery,
    views,
    activeView,
    viewType,
    fieldOptionsQuery,
    fieldOptions,
    fieldOptionsMutation,
    rowsQuery,
    viewRowsQuery,
    viewRows,
    membersQuery,
    members,
    hasPeopleField,
    peopleQuery,
    people,
    peopleByRow,
  };
}

export type BaserowBase = ReturnType<typeof useBaserowBase>;

export function useBaserowPage() {
  const base = useBaserowBase();
  const mut = useBaserowMutations(base);
  const {
    invalidate,
    rowMutation,
    deleteMutation,
  } = mut;
  const {
    message,
    modal,
    qc,
    navigate,
    databaseId,
    tableId,
    viewId,
    selectedRowKeys,
    setSelectedRowKeys,
    search,
    orderBy,
    setCreateKind,
    setRowOpen,
    editingRow,
    setEditingRow,
    setActiveRowId,
    editUndoStack,
    inviteEmail,
    setInviteEmail,
    inviteRole,
    setRenameObject,
    setRenameObjectValue,
    setImporting,
    createForm,
    rowForm,
    overview,
    workspaces,
    selectedWorkspace,
    tablesQuery,
    tables,
    fieldsQuery,
    fields,
    activeView,
    fieldOptions,
    rowsQuery,
    viewRowsQuery,
    peopleByRow,
  } = base;
  const openRenameObject = (kind: "workspace" | "database") => {
    const target = kind === "workspace" ? selectedWorkspace : currentDatabase;
    if (!target) return;
    setRenameObject({ kind, id: target.id, name: target.name });
    setRenameObjectValue(target.name);
  };

  const inviteMutation = useMutation({
    mutationFn: () =>
      baserowApi.inviteMember(
        selectedWorkspace?.id as number,
        inviteEmail.trim(),
        inviteRole,
      ),
    onSuccess: async () => {
      message.success("邀请已发送");
      setInviteEmail("");
      await qc.invalidateQueries({ queryKey: ["baserow", "members"] });
    },
    onError: (e) => message.error(errText(e)),
  });

  const updateMemberMutation = useMutation({
    mutationFn: (vars: { id: number; permissions: string }) =>
      baserowApi.updateMember(
        selectedWorkspace?.id as number,
        vars.id,
        vars.permissions,
      ),
    onSuccess: async () => {
      message.success("权限已更新");
      await qc.invalidateQueries({ queryKey: ["baserow", "members"] });
    },
    onError: (e) => message.error(errText(e)),
  });

  const removeMemberMutation = useMutation({
    mutationFn: (id: number) =>
      baserowApi.removeMember(selectedWorkspace?.id as number, id),
    onSuccess: async () => {
      message.success("已移除成员");
      await qc.invalidateQueries({ queryKey: ["baserow", "members"] });
    },
    onError: (e) => message.error(errText(e)),
  });

  const editableFields = useMemo(
    () => fields.filter((f) => !f.read_only && EDITABLE.has(f.type)),
    [fields],
  );
  /** 只读字段：公式/查找/汇总/自动编号等，置灰展示并给出 Tooltip 说明。 */
  const readOnlyFields = useMemo(
    () => fields.filter((f) => f.read_only || !EDITABLE.has(f.type)),
    [fields],
  );
  const primaryField = fields.find((f) => f.primary) ?? fields[0];
  const groupField = fields.find((f) => f.type === "single_select");
  const dateField = fields.find((f) => f.type === "date");
  const cardFields = fields
    .filter((f) => f.id !== primaryField?.id && f.type !== "file")
    .slice(0, 4);

  const columns: ColumnsType<BaserowRow> = useMemo(() => {
    // 视图字段选项里的 hidden / order 控制列的显示与顺序
    const visibleFields = fields
      .filter((f) => !fieldOptions[String(f.id)]?.hidden)
      .slice()
      .sort((a, b) => {
        const oa = fieldOptions[String(a.id)]?.order;
        const ob = fieldOptions[String(b.id)]?.order;
        if (typeof oa === "number" && typeof ob === "number" && oa !== ob)
          return oa - ob;
        return fields.indexOf(a) - fields.indexOf(b);
      });
    const dataCols: ColumnsType<BaserowRow> = visibleFields.map((f) => {
      // 视图生效时，表头的排序箭头直接反映视图的 sortings
      const viewSort = activeView?.sortings.find((s) => s.field === f.id);
      const sortOrder: "ascend" | "descend" | null = viewSort
        ? viewSort.order === "ASC"
          ? "ascend"
          : "descend"
        : orderBy === `-${f.name}`
          ? "descend"
          : orderBy === f.name
            ? "ascend"
            : null;
      return {
        title: (
          <Space size={4}>
            <span>{f.name}</span>
            {f.primary && <Tag color="blue">主字段</Tag>}
          </Space>
        ),
        dataIndex: f.name,
        key: f.name,
        ellipsis: true,
        // 文件字段无法排序（Baserow 会对 order_by 报错）
        sorter: f.type !== "file",
        sortOrder,
        render: (_: unknown, row: BaserowRow) =>
          f.type === "link_row" ? (
            <LinkRowCell
              tableId={tableId as number}
              field={f}
              value={row[f.name]}
            />
          ) : (
            renderValue(f, row[f.name], peopleByRow)
          ),
      };
    });
    dataCols.push({
      title: "操作",
      key: "__actions",
      width: 96,
      fixed: "right",
      render: (_: unknown, row: BaserowRow) => (
        <Space size={4}>
          <Tooltip title="建为任务">
            <Button
              size="small"
              type="text"
              icon={<PlusOutlined />}
              onClick={() => void createTaskFromRow(row)}
            />
          </Tooltip>
          <Tooltip title="编辑">
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              onClick={() => openRowEdit(row)}
            />
          </Tooltip>
          <Tooltip title="删除">
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              onClick={() => confirmDeleteRow(row)}
            />
          </Tooltip>
        </Space>
      ),
    });
    return dataCols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, editableFields, peopleByRow, fieldOptions, activeView, orderBy]);

  const confirmDeleteRow = (row: BaserowRow) =>
    modal.confirm({
      title: "删除这一行？",
      content: "删掉后下方提示里可以「撤销」。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => deleteMutation.mutateAsync(row),
    });

  // ------------------------------------------------------------ 键盘操作

  /** 把焦点移到指定行（并滚动到可见）。 */
  const focusRow = useCallback((rowId: number) => {
    setActiveRowId(rowId);
    const el = document.querySelector<HTMLElement>(
      `tr[data-row-id="${rowId}"]`,
    );
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  }, []);

  /** 撤销上一次行编辑。 */
  const undoLastEdit = useCallback(async () => {
    const last = editUndoStack.current.pop();
    if (!last) {
      message.info("没有可撤销的编辑");
      return;
    }
    try {
      // 把"改之前的值"写回去：先取当前值，缺失的字段补上旧值。
      const restore: Record<string, unknown> = {};
      for (const f of editableFields) {
        const before = last.row[f.name];
        if (before === null || before === undefined) continue;
        restore[f.name] = before;
      }
      await baserowApi.updateRow(tableId as number, last.row.id, restore);
      message.success("已撤销上一次编辑");
      await invalidate("rows");
    } catch (e) {
      message.error(`撤销失败：${errText(e)}`);
      // 撤销失败就把条目放回去，否则用户再按一次 Ctrl+Z 会跳过一格。
      editUndoStack.current.push(last);
    }
  }, [editableFields, invalidate, message, tableId]);

  // 全局快捷键：Ctrl/Cmd+Z 撤销编辑；Esc 取消选择。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // 用户正在输入框里打字时不要抢快捷键（但 Ctrl+Z 在输入框里是"撤销输入"，不抢）
      const inField =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !inField) {
        e.preventDefault();
        void undoLastEdit();
        return;
      }
      if (e.key === "Escape" && !inField && selectedRowKeys.length) {
        setSelectedRowKeys([]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undoLastEdit, selectedRowKeys.length]);

  const openRowEdit = (row: BaserowRow) => {
    setEditingRow(row);
    rowForm.setFieldsValue(
      Object.fromEntries(
        editableFields.map((f) => [f.name, toFormValue(f, row[f.name])]),
      ),
    );
    setRowOpen(true);
  };

  const openRowCreate = () => {
    setEditingRow(null);
    rowForm.resetFields();
    setRowOpen(true);
  };

  const submitRow = async () => {
    const raw = await rowForm.validateFields();
    const values: Record<string, unknown> = {};
    editableFields.forEach((f) => {
      const value = raw[f.name];
      if (value === undefined) return;
      if (f.type === "password" && value === "") {
        // 密码不回传明文，留空表示不修改
        return;
      }
      if (f.type === "date" && value instanceof Object && "format" in value) {
        values[f.name] = (value as { format: (s: string) => string }).format(
          "YYYY-MM-DD",
        );
        return;
      }
      if (f.type === "file") {
        // Baserow 校验文件字段认的是 user-files 的 name（哈希），只写 url + name
        const files = Array.isArray(value) ? (value as BaserowFile[]) : [];
        values[f.name] = files.map((f2) => ({ url: f2.url, name: f2.name }));
        return;
      }
      values[f.name] = value;
    });
    rowMutation.mutate({ values, row: editingRow ?? undefined });
  };

  const openCreate = (kind: "workspace" | "database" | "table") => {
    createForm.resetFields();
    createForm.setFieldsValue({
      name:
        kind === "workspace"
          ? "新工作区"
          : kind === "database"
            ? "新数据表"
            : "新工作表",
    });
    setCreateKind(kind);
  };

  const exportCsv = async () => {
    if (!tableId) return;
    try {
      const all: BaserowRow[] = [];
      for (let p = 1; p <= 50; p += 1) {
        const res = await baserowApi.rows(tableId, {
          page: p,
          size: 200,
          search,
          order_by: viewId ? "" : orderBy,
          view_id: viewId,
        });
        all.push(...res.results);
        if (!res.next || all.length >= res.count) break;
      }
      const exportFields = fields.filter((f) => f.type !== "file");
      const header = exportFields.map((f) => f.name);
      const byName = new Map(exportFields.map((f) => [f.name, f]));
      const esc = (name: string, v: unknown) =>
        `"${plainText(byName.get(name), v, peopleByRow).replace(/"/g, '""')}"`;
      const lines = [
        header.map((h) => `"${h.replace(/"/g, '""')}"`).join(","),
        ...all.map((r) => header.map((h) => esc(h, r[h])).join(",")),
      ];
      downloadCsv(
        `${currentTable?.name || "工作表"}-${dayjs().format("YYYYMMDD")}.csv`,
        `\ufeff${lines.join("\n")}`,
      );
      message.success(`已导出 ${all.length} 条记录`);
    } catch (e) {
      message.error(`导出失败：${errText(e)}`);
    }
  };

  const runImport = async (file: File) => {
    if (!tableId) return;
    setImporting(true);
    try {
      const res = await baserowApi.importTable(tableId, file);
      message.success(
        `已导入 ${res.created} 行${res.fields_added.length ? `，新增字段：${res.fields_added.join("、")}` : ""}`,
      );
      await invalidate("fields");
      await invalidate("rows");
    } catch (e) {
      message.error(`导入失败：${errText(e)}`);
    } finally {
      setImporting(false);
    }
  };

  /** 把个人工作台的任务导入当前工作表：列名固定，缺列由后端自动建立。 */
  const importFromWorkbench = async () => {
    if (!tableId) return;
    setImporting(true);
    try {
      const { items } = await api.workbenchItems({ limit: 200 });
      const source = items.filter((it: WorkbenchItem) => it.status !== "done");
      if (!source.length) {
        message.info("工作台没有进行中的事项");
        return;
      }
      const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const header = ["标题", "类型", "优先级", "截止日期", "标签", "说明"];
      const lines = [
        header.map(esc).join(","),
        ...source.map((it) =>
          [
            it.title,
            it.kind,
            it.priority,
            it.due_date || "",
            (it.tags || []).join(" "),
            it.content,
          ]
            .map(esc)
            .join(","),
        ),
      ];
      const file = new File([`\ufeff${lines.join("\n")}`], "工作台任务.csv", {
        type: "text/csv",
      });
      const res = await baserowApi.importTable(tableId, file);
      message.success(
        `已从工作台导入 ${res.created} 项${res.fields_added.length ? `，新增字段：${res.fields_added.join("、")}` : ""}`,
      );
      await invalidate("fields");
      await invalidate("rows");
    } catch (e) {
      message.error(`导入失败：${errText(e)}`);
    } finally {
      setImporting(false);
    }
  };

  const createTaskFromRow = async (row: BaserowRow) => {
    const title = primaryField
      ? plainText(primaryField, row[primaryField.name], peopleByRow)
      : "";
    const lines = fields
      .filter((f) => f.type !== "file")
      .map(
        (f) => `${f.name}：${plainText(f, row[f.name], peopleByRow) || "—"}`,
      );
    try {
      const created = await api.workbenchCreateItem({
        kind: "task",
        title: (title || `表格记录 #${row.id}`).slice(0, 60),
        content: `来自多维表格「${currentTable?.name || "工作表"}」记录 #${row.id}\n${lines.join("\n")}`,
        priority: "normal",
        tags: ["多维表格", currentTable?.name || "工作表"].slice(0, 2),
        due_date: dateField ? dateKey(row[dateField.name]) || null : null,
      });
      message.success("已创建任务，可在个人工作台查看");
      qc.invalidateQueries({ queryKey: ["workbench"] });
      return created;
    } catch (e) {
      message.error(`创建任务失败：${errText(e)}`);
      return null;
    }
  };

  /** 把当前表的结构与少量记录交给 Agent 分析，形成表格 → 助手联动。 */
  const analyzeWithAgent = () => {
    if (!tableId) return;
    const sample = (
      viewRowsQuery.data?.results ??
      rowsQuery.data?.results ??
      []
    ).slice(0, 20);
    const preview = sample.map((row) => {
      const cells = fields
        .filter((f) => f.type !== "file")
        .slice(0, 8)
        .map(
          (f) => `${f.name}=${plainText(f, row[f.name], peopleByRow) || "—"}`,
        );
      return `- ${cells.join(" | ")}`;
    });
    const prompt = [
      `请分析多维表格「${currentTable?.name || "工作表"}」的数据。`,
      `字段：${fields.map((f) => `${f.name}(${f.type})`).join("、")}`,
      `记录总数：${rowsQuery.data?.count ?? sample.length}`,
      preview.length ? `样例数据：\n${preview.join("\n")}` : "当前没有记录。",
      "请给出数据质量检查、趋势/异常与下一步建议。",
    ].join("\n");
    navigate(handoffToAgent(prompt));
  };

  const currentTable = tables.find((t: BaserowTableRef) => t.id === tableId);
  const currentDatabase = (selectedWorkspace?.databases ?? []).find(
    (d) => d.id === databaseId,
  );
  const loading =
    overview.isLoading || tablesQuery.isLoading || fieldsQuery.isLoading;
  const noWorkspaces = !overview.isLoading && workspaces.length === 0;

  const moreMenu: MenuProps["items"] = [
    { key: "export", icon: <DownloadOutlined />, label: "导出 CSV" },
    { key: "fields", icon: <FieldStringOutlined />, label: "字段管理" },
    { type: "divider" },
    {
      key: "delete-table",
      icon: <DeleteOutlined />,
      label: "删除工作表",
      danger: true,
    },
  ];

  return { ...base, ...mut, openRenameObject, inviteMutation, updateMemberMutation, removeMemberMutation, editableFields, readOnlyFields, primaryField, groupField, dateField, cardFields, columns, confirmDeleteRow, focusRow, openRowEdit, openRowCreate, submitRow, openCreate, exportCsv, runImport, importFromWorkbench, createTaskFromRow, analyzeWithAgent, currentTable, currentDatabase, loading, noWorkspaces, moreMenu };
}

export type BaserowPageState = ReturnType<typeof useBaserowPage>;
