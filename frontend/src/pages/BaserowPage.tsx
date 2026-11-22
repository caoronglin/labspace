import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Badge, Button, Calendar, Card, Drawer, Dropdown, Empty, Flex, Form, Grid, Input, Modal, Popconfirm, Popover, Select, Segmented, Space, Spin, Switch, Table, Tag, Tooltip, Typography, Upload } from "antd";
import type { ColumnsType } from "antd/es/table";
import { CloudUploadOutlined, DatabaseOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, EllipsisOutlined, FieldStringOutlined, FilterOutlined, HistoryOutlined, PlusOutlined, ReloadOutlined, RobotOutlined, SearchOutlined, ShareAltOutlined, SortAscendingOutlined, TableOutlined, TeamOutlined, UndoOutlined, UnorderedListOutlined } from "@ant-design/icons";
import type { MenuProps } from "antd";
import { Prompts, Welcome } from "@ant-design/x";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import { useNavigate } from "react-router-dom";
import { api, baserowApi, type BaserowField, type BaserowFile, type BaserowMember, type BaserowRow, type BaserowTableRef, type BaserowTrashItem, type BaserowView, type BaserowWorkspace, type WorkbenchItem } from "../services/api";
import { errText } from "../utils/err";
import { handoffToAgent } from "../utils/agentHandoff";
import PageShell from "../components/PageShell";
import { tokens } from "../theme/tokens";
import { palette } from "../theme/palette";
import {
  EDITABLE,
  READ_ONLY_HINTS,
  FIELD_TYPES,
  FIELD_TYPE_LABELS,
  ROLE_OPTIONS,
  VIEW_TYPE_META,
  VIEW_TYPE_OPTIONS,
  FILTER_TYPE_OPTIONS,
  optionId,
  plainText,
  dateKey,
  renderValue,
  type FormValue,
  toFormValue,
  downloadCsv,
  LinkRowCell,
  FieldControl,
  CommentTimeline
} from "./baserow/fieldComponents";

export default function BaserowPage({
  embedded = false,
}: { embedded?: boolean } = {}) {
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

  const invalidate = (
    kind: "overview" | "tables" | "fields" | "rows" | "view-rows",
  ) => {
    if (kind === "rows") {
      qc.invalidateQueries({ queryKey: ["baserow", "rows"] });
      qc.invalidateQueries({ queryKey: ["baserow", "view-rows"] });
      return;
    }
    qc.invalidateQueries({ queryKey: ["baserow", kind] });
  };

  const createMutation = useMutation({
    mutationFn: async (vars: {
      kind: "workspace" | "database" | "table";
      name: string;
    }) => {
      if (vars.kind === "workspace")
        return baserowApi.createWorkspace(vars.name);
      if (vars.kind === "database") {
        if (!selectedWorkspace?.id) throw new Error("请先选择工作区");
        return baserowApi.createDatabase(selectedWorkspace.id, vars.name);
      }
      if (!databaseId) throw new Error("请先选择数据表");
      return baserowApi.createTable(databaseId, vars.name);
    },
    onSuccess: async (data, vars) => {
      message.success("已创建");
      setCreateKind(null);
      createForm.resetFields();
      if (vars.kind === "workspace") {
        await invalidate("overview");
        setWorkspaceId(data.id);
      } else if (vars.kind === "database") {
        await invalidate("overview");
        setWorkspaceId(selectedWorkspace?.id ?? null);
        setDatabaseId(data.id);
      } else {
        await invalidate("tables");
        setTableId(data.id);
        setPage(1);
      }
    },
    onError: (e) => message.error(errText(e)),
  });

  const fieldMutation = useMutation({
    mutationFn: (vars: { name: string; type: string }) =>
      baserowApi.createField(tableId as number, vars.name, vars.type),
    onSuccess: async () => {
      message.success("已新增字段");
      setFieldFormKey((k) => k + 1);
      await invalidate("fields");
    },
    onError: (e) => message.error(errText(e)),
  });

  const renameMutation = useMutation({
    mutationFn: (vars: { field: BaserowField; name: string }) =>
      baserowApi.renameField(tableId as number, vars.field.id, vars.name),
    onSuccess: async () => {
      message.success("字段已重命名");
      setRenameTarget(null);
      await invalidate("fields");
      await invalidate("rows");
    },
    onError: (e) => message.error(errText(e)),
  });

  const deleteFieldMutation = useMutation({
    mutationFn: (fieldId: number) =>
      baserowApi.deleteField(tableId as number, fieldId),
    onSuccess: async () => {
      message.success("字段已删除");
      await invalidate("fields");
      await invalidate("rows");
    },
    onError: (e) => message.error(errText(e)),
  });

  const rowMutation = useMutation({
    mutationFn: (vars: {
      values: Record<string, unknown>;
      row?: BaserowRow;
    }) =>
      vars.row
        ? baserowApi.updateRow(tableId as number, vars.row.id, vars.values)
        : baserowApi.createRow(tableId as number, vars.values),
    onSuccess: async (_result, vars) => {
      message.success(vars.row ? "已保存" : "已新增");
      // 压入撤销栈：保存**之前**的整行，Ctrl+Z 时原样写回。
      if (vars.row) {
        editUndoStack.current.push({ row: vars.row, values: vars.values });
        if (editUndoStack.current.length > 20) editUndoStack.current.shift();
      }
      setRowOpen(false);
      setEditingRow(null);
      rowForm.resetFields();
      await invalidate("rows");
    },
    onError: (e) => message.error(errText(e)),
  });

  const deleteMutation = useMutation({
    // 删除成功后把**原行**带出来：撤销要靠它重建（Baserow 没有单行恢复接口）。
    mutationFn: (row: BaserowRow) =>
      baserowApi.deleteRow(tableId as number, row.id).then(() => row),
    onSuccess: async (row) => {
      const key = `br-undo-${row.id}`;
      message.open({
        key,
        type: "success",
        duration: 6,
        content: (
          <Flex gap={12} align="center">
            <span>已删除该行</span>
            <Button
              size="small"
              type="link"
              style={{ padding: 0, height: "auto" }}
              onClick={() => {
                message.destroy(key);
                undoDeleteMutation.mutate(row);
              }}
            >
              撤销
            </Button>
          </Flex>
        ),
      });
      await invalidate("rows");
    },
    onError: (e) => message.error(errText(e)),
  });

  // 撤销 = 用同一份字段值重建一行。
  const undoDeleteMutation = useMutation({
    mutationFn: async (row: BaserowRow) => {
      if (!tableId) throw new Error("未就绪");
      const values: Record<string, unknown> = {};
      for (const f of fields) {
        if (f.type === "file") continue; // 附件不能凭 id 重建
        const v = row[f.name];
        if (v === null || v === undefined || v === "") continue;
        values[f.name] = v;
      }
      return baserowApi.createRow(tableId, values);
    },
    onSuccess: async () => {
      message.success("已恢复该行");
      await invalidate("rows");
    },
    onError: (e) => message.error(`恢复失败：${errText(e)}`),
  });

  // ------------------------------------------------------------ 视图管理

  const invalidateViews = async () => {
    await qc.invalidateQueries({ queryKey: ["baserow", "views"] });
    await invalidate("rows");
  };

  const createViewMutation = useMutation({
    mutationFn: (vars: { name: string; type: string }) =>
      baserowApi.createView(tableId as number, vars.name, vars.type),
    onSuccess: async (data) => {
      message.success("已创建视图");
      setViewModal(null);
      viewForm.resetFields();
      pendingViewIdRef.current = data.id;
      await invalidateViews();
      setViewId(data.id);
    },
    onError: (e) => message.error(errText(e)),
  });

  const updateViewMutation = useMutation({
    mutationFn: (vars: {
      id: number;
      patch: {
        name?: string;
        filter_type?: string;
        filters_disabled?: boolean;
      };
    }) => baserowApi.updateView(tableId as number, vars.id, vars.patch),
    onSuccess: async () => {
      message.success("视图已更新");
      setViewModal(null);
      viewForm.resetFields();
      await invalidateViews();
    },
    onError: (e) => message.error(errText(e)),
  });

  const deleteViewMutation = useMutation({
    mutationFn: (id: number) => baserowApi.deleteView(tableId as number, id),
    onSuccess: async () => {
      message.success("视图已删除");
      await invalidateViews();
    },
    onError: (e) => message.error(errText(e)),
  });

  const filterMutation = useMutation({
    mutationFn: (vars: {
      action: "create" | "delete" | "update";
      id?: number;
      field?: number;
      type?: string;
      value?: string;
    }) => {
      if (!viewId) throw new Error("请先选择视图");
      if (vars.action === "create") {
        return baserowApi.createViewFilter(tableId as number, viewId, {
          field: vars.field as number,
          type: vars.type as string,
          value: vars.value ?? "",
        });
      }
      if (vars.action === "update") {
        return baserowApi.updateViewFilter(
          tableId as number,
          viewId,
          vars.id as number,
          {
            value: vars.value,
            type: vars.type,
          },
        );
      }
      return baserowApi.deleteViewFilter(
        tableId as number,
        viewId,
        vars.id as number,
      );
    },
    onSuccess: async () => {
      await invalidateViews();
    },
    onError: (e) => message.error(errText(e)),
  });

  const sortMutation = useMutation({
    mutationFn: (vars: {
      action: "create" | "delete" | "update";
      id?: number;
      field?: number;
      order?: "ASC" | "DESC";
    }) => {
      if (!viewId) throw new Error("请先选择视图");
      if (vars.action === "create") {
        return baserowApi.createViewSort(tableId as number, viewId, {
          field: vars.field as number,
          order: vars.order ?? "ASC",
        });
      }
      if (vars.action === "update") {
        return baserowApi.updateViewSort(
          tableId as number,
          viewId,
          vars.id as number,
          {
            order: vars.order ?? "ASC",
          },
        );
      }
      return baserowApi.deleteViewSort(
        tableId as number,
        viewId,
        vars.id as number,
      );
    },
    onSuccess: async () => {
      await invalidateViews();
    },
    onError: (e) => message.error(errText(e)),
  });

  // ------------------------------------------------------------ 批量操作

  // 「选择全部」：把**整张表**（当前筛选/视图下）的行 id 都选上。
  // antd 表头的全选框只选当前页，用户很容易误解；这里给一个显式入口。
  // 记录太多时不做全量拉取（会把几十万行塞进浏览器），改为提示用搜索缩小范围。
  const selectAllMutation = useMutation({
    mutationFn: async () => {
      if (!tableId) throw new Error("未就绪");
      const all = rowsQuery.data?.count ?? 0;
      const CAP = 5000;
      if (all > CAP) {
        throw new Error(
          `共 ${all} 条，超过 ${CAP} 条上限。请先用搜索缩小范围，再选择全部。`,
        );
      }
      const ids: number[] = [];
      const pageSize = 200;
      for (let p = 1; p <= Math.ceil(all / pageSize); p += 1) {
        const res = await baserowApi.rows(tableId, {
          page: p,
          size: pageSize,
          search,
          order_by: viewId ? "" : orderBy,
          view_id: viewId,
        });
        for (const r of res.results ?? []) ids.push(r.id);
        if (!res.results?.length) break;
      }
      return ids;
    },
    onSuccess: (ids) => {
      setSelectedRowKeys(ids);
      message.success(`已选中全部 ${ids.length} 条`);
    },
    onError: (e) => message.error(errText(e)),
  });

  const batchDeleteMutation = useMutation({
    mutationFn: (ids: number[]) =>
      baserowApi.batchDeleteRows(tableId as number, ids),
    onSuccess: async (data) => {
      message.success(`已删除 ${data.deleted} 条记录`);
      setSelectedRowKeys([]);
      await invalidate("rows");
    },
    onError: (e) => message.error(errText(e)),
  });

  const batchUpdateMutation = useMutation({
    mutationFn: (vars: { field: string; value: unknown }) =>
      baserowApi.batchUpdateRows(
        tableId as number,
        selectedRowKeys.map((key) => ({
          id: Number(key),
          [vars.field]: normalizeFieldValue(vars.value),
        })),
      ),
    onSuccess: async (data) => {
      message.success(`已更新 ${data.updated} 条记录`);
      setBatchOpen(false);
      batchForm.resetFields();
      await invalidate("rows");
    },
    onError: (e) => message.error(errText(e)),
  });

  /** 批量修改时把表单值转成 Baserow 认的格式（日期字符串、附件 {url,name}）。 */
  const normalizeFieldValue = (value: unknown): FormValue => {
    if (
      value &&
      typeof value === "object" &&
      "format" in (value as Record<string, unknown>)
    ) {
      return (value as { format: (s: string) => string }).format("YYYY-MM-DD");
    }
    if (
      Array.isArray(value) &&
      value.every((v) => v && typeof v === "object" && "url" in (v as object))
    ) {
      return value.map((f) => ({
        url: (f as BaserowFile).url,
        name: (f as BaserowFile).name,
      }));
    }
    if (value === null || value === undefined) return null;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      return value;
    if (Array.isArray(value))
      return value.map((v) =>
        typeof v === "number" || typeof v === "string" ? v : String(v),
      );
    return String(value);
  };

  // ------------------------------------------------------------ 回收站

  const trashQuery = useQuery({
    queryKey: ["baserow", "trash", selectedWorkspace?.id],
    queryFn: () => baserowApi.trash(selectedWorkspace?.id as number),
    enabled: trashOpen && Boolean(selectedWorkspace?.id),
  });
  const trashItems: BaserowTrashItem[] = trashQuery.data?.items ?? [];

  const restoreMutation = useMutation({
    mutationFn: (item: BaserowTrashItem) =>
      baserowApi.restoreTrash({
        trash_item_id: item.trash_item_id,
        trash_item_type: item.trash_item_type,
        parent_trash_item_id: item.parent_trash_item_id,
      }),
    onSuccess: async () => {
      message.success("已恢复");
      await trashQuery.refetch();
      await invalidate("rows");
    },
    onError: (e) => message.error(errText(e)),
  });

  const deleteTableMutation = useMutation({
    mutationFn: () => baserowApi.deleteTable(tableId as number),
    onSuccess: async () => {
      message.success("工作表已删除");
      setTableId(null);
      await invalidate("tables");
    },
    onError: (e) => message.error(errText(e)),
  });

  const renameObjectMutation = useMutation({
    mutationFn: (vars: {
      kind: "workspace" | "database";
      id: number;
      name: string;
    }) =>
      vars.kind === "workspace"
        ? baserowApi.renameWorkspace(vars.id, vars.name)
        : baserowApi.renameDatabase(vars.id, vars.name),
    onSuccess: async (_data, vars) => {
      message.success(
        vars.kind === "workspace" ? "工作区已重命名" : "数据表已重命名",
      );
      setRenameObject(null);
      await invalidate("overview");
    },
    onError: (e) => message.error(errText(e)),
  });

  const deleteDatabaseMutation = useMutation({
    mutationFn: (databaseId: number) => baserowApi.deleteDatabase(databaseId),
    onSuccess: async () => {
      message.success("数据表已删除");
      await invalidate("overview");
      setDatabaseId(null);
      setTableId(null);
    },
    onError: (e) => message.error(errText(e)),
  });

  const deleteWorkspaceMutation = useMutation({
    mutationFn: (workspaceId: number) =>
      baserowApi.deleteWorkspace(workspaceId),
    onSuccess: async () => {
      message.success("工作区已删除");
      await invalidate("overview");
      setWorkspaceId(null);
      setDatabaseId(null);
      setTableId(null);
    },
    onError: (e) => message.error(errText(e)),
  });

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

  const rowCard = (row: BaserowRow) => (
    <Card
      key={row.id}
      size="small"
      className="baserow-card"
      title={
        <Typography.Text strong ellipsis style={{ maxWidth: 220 }}>
          {primaryField
            ? plainText(primaryField, row[primaryField.name], peopleByRow) ||
              `记录 #${row.id}`
            : `记录 #${row.id}`}
        </Typography.Text>
      }
      extra={
        <Dropdown
          trigger={["click"]}
          menu={{
            items: [
              { key: "task", icon: <PlusOutlined />, label: "建为任务" },
              { key: "edit", icon: <EditOutlined />, label: "编辑" },
              {
                key: "delete",
                icon: <DeleteOutlined />,
                label: "删除",
                danger: true,
              },
            ],
            onClick: ({ key }) => {
              if (key === "task") void createTaskFromRow(row);
              if (key === "edit") openRowEdit(row);
              if (key === "delete") confirmDeleteRow(row);
            },
          }}
        >
          <Button
            size="small"
            type="text"
            icon={<EllipsisOutlined />}
            aria-label="更多操作"
          />
        </Dropdown>
      }
    >
      <Flex vertical gap={4}>
        {cardFields.map((f) => (
          <Flex key={f.id} justify="space-between" gap={8}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {f.name}
            </Typography.Text>
            <Typography.Text
              style={{ fontSize: 12 }}
              ellipsis={{ tooltip: plainText(f, row[f.name], peopleByRow) }}
            >
              {plainText(f, row[f.name], peopleByRow) || "—"}
            </Typography.Text>
          </Flex>
        ))}
      </Flex>
    </Card>
  );

  const galleryView = (
    <Spin spinning={viewRowsQuery.isFetching}>
      {viewRows.length ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(auto-fill, minmax(${narrow ? 240 : 280}px, 1fr))`,
            gap: 12,
          }}
        >
          {viewRows.map(rowCard)}
        </div>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无记录" />
      )}
    </Spin>
  );

  const kanbanView = () => {
    if (!groupField) {
      return (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="看板需要一个单选字段作为分组依据，请先新增「单选」字段"
        />
      );
    }
    const columnsData = [
      ...groupField.select_options.map((o) => ({
        key: String(o.id),
        label: o.value,
        rows: [] as BaserowRow[],
      })),
      { key: "__none", label: "未分组", rows: [] as BaserowRow[] },
    ];
    viewRows.forEach((row) => {
      const id = String(optionId(row[groupField.name]) ?? "");
      const col =
        columnsData.find((c) => c.key === id) ??
        columnsData[columnsData.length - 1];
      col.rows.push(row);
    });
    return (
      <Spin spinning={viewRowsQuery.isFetching}>
        <Flex
          gap={12}
          style={{
            overflowX: "auto",
            paddingBottom: 8,
            alignItems: "flex-start",
          }}
        >
          {columnsData.map((col) => (
            <Card
              key={col.key}
              size="small"
              title={
                <Space size={6}>
                  <Badge color={col.key === "__none" ? palette.neutral.n300 : tokens.colorPrimary} />
                  <span>{col.label}</span>
                  <Tag>{col.rows.length}</Tag>
                </Space>
              }
              style={{
                width: 280,
                flex: "0 0 280px",
                background: "var(--ant-color-fill-quaternary)",
              }}
            >
              <Flex vertical gap={8}>
                {col.rows.length ? (
                  col.rows.map(rowCard)
                ) : (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    暂无记录
                  </Typography.Text>
                )}
              </Flex>
            </Card>
          ))}
        </Flex>
      </Spin>
    );
  };

  const calendarView = () => {
    if (!dateField) {
      return (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="日历需要一个日期字段，请先新增「日期」字段"
        />
      );
    }
    const byDay = new Map<string, BaserowRow[]>();
    viewRows.forEach((row) => {
      const key = dateKey(row[dateField.name]);
      if (!key) return;
      byDay.set(key, [...(byDay.get(key) ?? []), row]);
    });
    return (
      <Spin spinning={viewRowsQuery.isFetching}>
        <Calendar
          fullscreen={!narrow}
          cellRender={(date, info) => {
            if (info.type !== "date") return info.originNode;
            const key = date.format("YYYY-MM-DD");
            const rows = byDay.get(key) ?? [];
            if (!rows.length) return null;
            return (
              <Flex vertical gap={2} style={{ marginTop: 2 }}>
                {rows.slice(0, 3).map((row) => (
                  <div
                    key={row.id}
                    style={{
                      fontSize: 11,
                      lineHeight: "16px",
                      background: "rgba(43,92,230,0.10)",
                      color: tokens.colorPrimary,
                      borderRadius: 4,
                      padding: "0 4px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    onClick={() => openRowEdit(row)}
                  >
                    {primaryField
                      ? plainText(
                          primaryField,
                          row[primaryField.name],
                          peopleByRow,
                        ) || `#${row.id}`
                      : `#${row.id}`}
                  </div>
                ))}
                {rows.length > 3 ? (
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    +{rows.length - 3} 项
                  </Typography.Text>
                ) : null}
              </Flex>
            );
          }}
        />
      </Spin>
    );
  };

  /** 表单视图：像填写表单一样纵向排列每条记录的字段。 */
  const formView = () => (
    <Spin spinning={viewRowsQuery.isFetching}>
      {viewRows.length ? (
        <Flex vertical gap={12}>
          {viewRows.map((row) => (
            <Card
              key={row.id}
              size="small"
              title={
                <Typography.Text strong>
                  {primaryField
                    ? plainText(
                        primaryField,
                        row[primaryField.name],
                        peopleByRow,
                      ) || `记录 #${row.id}`
                    : `记录 #${row.id}`}
                </Typography.Text>
              }
              extra={
                <Button
                  size="small"
                  type="text"
                  icon={<EditOutlined />}
                  onClick={() => openRowEdit(row)}
                >
                  编辑
                </Button>
              }
            >
              <Flex vertical gap={8}>
                {fields.map((f) => (
                  <Flex key={f.id} vertical gap={2}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {f.name}
                    </Typography.Text>
                    {f.type === "link_row" ? (
                      <LinkRowCell
                        tableId={tableId as number}
                        field={f}
                        value={row[f.name]}
                      />
                    ) : (
                      renderValue(f, row[f.name], peopleByRow)
                    )}
                  </Flex>
                ))}
              </Flex>
            </Card>
          ))}
        </Flex>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无记录" />
      )}
    </Spin>
  );

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

  /** 筛选与排序面板：贴在视图栏上的 Popover 内容。 */
  function renderFilterPanel() {
    if (!activeView) return null;
    return (
      <Flex vertical gap={10} style={{ width: 380 }}>
        <Flex align="center" justify="space-between">
          <Typography.Text strong>筛选与排序</Typography.Text>
          <Segmented
            size="small"
            value={activeView.filter_type}
            options={[
              { value: "AND", label: "同时满足" },
              { value: "OR", label: "任一满足" },
            ]}
            onChange={(v) =>
              updateViewMutation.mutate({
                id: activeView.id,
                patch: { filter_type: v as "AND" | "OR" },
              })
            }
          />
        </Flex>
        <Flex align="center" justify="space-between">
          <Typography.Text>启用筛选</Typography.Text>
          <Switch
            size="small"
            checked={!activeView.filters_disabled}
            onChange={(checked) =>
              updateViewMutation.mutate({
                id: activeView.id,
                patch: { filters_disabled: !checked },
              })
            }
          />
        </Flex>
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            筛选条件
          </Typography.Text>
          <Flex vertical gap={4} style={{ marginTop: 6 }}>
            {activeView.filters.length ? (
              activeView.filters.map((f) => (
                <Flex key={f.id} align="center" gap={6}>
                  <Typography.Text
                    style={{ fontSize: 12, width: 110 }}
                    ellipsis
                  >
                    {fields.find((x) => x.id === f.field)?.name ??
                      `#${f.field}`}
                  </Typography.Text>
                  <Tag>
                    {FILTER_TYPE_OPTIONS.find((o) => o.value === f.type)
                      ?.label ?? f.type}
                  </Tag>
                  <Typography.Text style={{ fontSize: 12 }} ellipsis>
                    {String(f.value || "—")}
                  </Typography.Text>
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    aria-label="删除筛选条件"
                    onClick={() =>
                      filterMutation.mutate({ action: "delete", id: f.id })
                    }
                  />
                </Flex>
              ))
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                还没有筛选条件
              </Typography.Text>
            )}
          </Flex>
          <Flex gap={6} style={{ marginTop: 6 }}>
            <Select
              size="small"
              style={{ width: 120 }}
              placeholder="字段"
              value={newFilterField ?? undefined}
              options={fields.map((f) => ({ value: f.id, label: f.name }))}
              onChange={(v) => setNewFilterField(v)}
            />
            <Select
              size="small"
              style={{ width: 110 }}
              placeholder="条件"
              value={newFilterType ?? undefined}
              options={FILTER_TYPE_OPTIONS}
              onChange={(v) => setNewFilterType(v)}
            />
            <Input
              size="small"
              style={{ width: 110 }}
              placeholder="值"
              value={newFilterValue}
              onChange={(e) => setNewFilterValue(e.target.value)}
            />
            <Button
              size="small"
              icon={<PlusOutlined />}
              disabled={!newFilterField || !newFilterType}
              onClick={() => {
                filterMutation.mutate({
                  action: "create",
                  field: newFilterField as number,
                  type: newFilterType as string,
                  value: newFilterValue,
                });
                setNewFilterValue("");
              }}
            >
              添加
            </Button>
          </Flex>
        </div>
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            排序
          </Typography.Text>
          <Flex vertical gap={4} style={{ marginTop: 6 }}>
            {activeView.sortings.length ? (
              activeView.sortings.map((s) => (
                <Flex key={s.id} align="center" gap={6}>
                  <Typography.Text
                    style={{ fontSize: 12, width: 110 }}
                    ellipsis
                  >
                    {fields.find((x) => x.id === s.field)?.name ??
                      `#${s.field}`}
                  </Typography.Text>
                  <Tag
                    icon={
                      s.order === "ASC" ? <SortAscendingOutlined /> : undefined
                    }
                  >
                    {s.order === "ASC" ? "升序" : "降序"}
                  </Tag>
                  <Button
                    size="small"
                    type="text"
                    icon={
                      s.order === "ASC" ? (
                        <SortAscendingOutlined />
                      ) : (
                        <UndoOutlined />
                      )
                    }
                    aria-label="切换排序方向"
                    onClick={() =>
                      sortMutation.mutate({
                        action: "update",
                        id: s.id,
                        field: s.field,
                        order: s.order === "ASC" ? "DESC" : "ASC",
                      })
                    }
                  />
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    aria-label="删除排序"
                    onClick={() =>
                      sortMutation.mutate({ action: "delete", id: s.id })
                    }
                  />
                </Flex>
              ))
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                还没有排序
              </Typography.Text>
            )}
          </Flex>
          <Flex gap={6} style={{ marginTop: 6 }}>
            <Select
              size="small"
              style={{ width: 130 }}
              placeholder="字段"
              value={newSortField ?? undefined}
              options={fields.map((f) => ({ value: f.id, label: f.name }))}
              onChange={(v) => setNewSortField(v)}
            />
            <Select
              size="small"
              style={{ width: 100 }}
              value={newSortOrder}
              options={[
                { value: "ASC", label: "升序" },
                { value: "DESC", label: "降序" },
              ]}
              onChange={(v) => setNewSortOrder(v)}
            />
            <Button
              size="small"
              icon={<PlusOutlined />}
              disabled={!newSortField}
              onClick={() => {
                sortMutation.mutate({
                  action: "create",
                  field: newSortField as number,
                  order: newSortOrder,
                });
              }}
            >
              添加
            </Button>
          </Flex>
        </div>
      </Flex>
    );
  }

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
              suffixIcon={<DatabaseOutlined />}
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

  return (
    <PageShell
      embedded={embedded}
      title="多维表格"
      description="结构化记录实验数据：多视图（表格 / 画廊 / 看板 / 日历 / 表单）、视图级筛选与排序、按字段类型编辑、批量操作、CSV 导入导出、系统人员指派与工作区共享。"
      extra={
        <Space wrap>
          <Button
            icon={<UnorderedListOutlined />}
            onClick={() => setShareOpen(true)}
          >
            成员与权限
          </Button>
          <Button
            icon={<PlusOutlined />}
            onClick={() => openCreate("database")}
            disabled={!selectedWorkspace}
          >
            新建数据表
          </Button>
        </Space>
      }
    >
      <Flex vertical gap={12}>
        {toolbar}
        {content()}
      </Flex>

      <Modal
        title={
          createKind === "workspace"
            ? "新建工作区"
            : createKind === "database"
              ? "新建数据表"
              : "新建工作表"
        }
        open={createKind !== null}
        onCancel={() => setCreateKind(null)}
        onOk={() => createForm.submit()}
        okText="创建"
        cancelText="取消"
        confirmLoading={createMutation.isPending}
        destroyOnHidden
      >
        <Form
          form={createForm}
          layout="vertical"
          onFinish={(v) =>
            createKind &&
            createMutation.mutate({ kind: createKind, name: v.name.trim() })
          }
        >
          <Form.Item
            name="name"
            label="名称"
            rules={[
              { required: true, whitespace: true, message: "请输入名称" },
            ]}
          >
            <Input
              maxLength={64}
              placeholder="例如：实验记录"
              onPressEnter={() => createForm.submit()}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={
          renameObject?.kind === "workspace" ? "重命名工作区" : "重命名数据表"
        }
        open={renameObject !== null}
        onCancel={() => setRenameObject(null)}
        onOk={() => {
          if (renameObject && renameObjectValue.trim()) {
            renameObjectMutation.mutate({
              ...renameObject,
              name: renameObjectValue.trim(),
            });
          }
        }}
        okText="保存"
        cancelText="取消"
        confirmLoading={renameObjectMutation.isPending}
        destroyOnHidden
      >
        <Input
          value={renameObjectValue}
          onChange={(e) => setRenameObjectValue(e.target.value)}
          maxLength={64}
          onPressEnter={() => {
            if (renameObject && renameObjectValue.trim()) {
              renameObjectMutation.mutate({
                ...renameObject,
                name: renameObjectValue.trim(),
              });
            }
          }}
        />
      </Modal>

      <Drawer
        title="字段管理"
        open={fieldOpen}
        onClose={() => setFieldOpen(false)}
        size={narrow ? "100%" : 460}
      >
        <Flex vertical gap={12}>
          {fields.map((f) => (
            <Flex key={f.id} align="center" justify="space-between" gap={8}>
              <Space size={6}>
                <Typography.Text strong={f.primary}>{f.name}</Typography.Text>
                <Tag>{FIELD_TYPE_LABELS[f.type] || f.type}</Tag>
                {f.primary ? <Tag color="blue">主字段</Tag> : null}
                {f.read_only ? <Tag color="default">只读</Tag> : null}
              </Space>
              {!f.read_only ? (
                <Space size={2}>
                  <Button
                    size="small"
                    type="text"
                    icon={<EditOutlined />}
                    aria-label={`重命名字段 ${f.name}`}
                    onClick={() => {
                      setRenameTarget(f);
                      setRenameValue(f.name);
                    }}
                  />
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    aria-label={`删除字段 ${f.name}`}
                    onClick={() =>
                      modal.confirm({
                        title: `删除字段「${f.name}」？`,
                        content: "字段及其数据将被删除，且不可恢复。",
                        okText: "删除",
                        okButtonProps: { danger: true },
                        cancelText: "取消",
                        onOk: () => deleteFieldMutation.mutateAsync(f.id),
                      })
                    }
                  />
                </Space>
              ) : null}
            </Flex>
          ))}
          {hasPeopleField ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              人员字段关联「系统人员（自动同步）」表，账号目录变更后会自动更新；指派仅用于标记负责人。
            </Typography.Text>
          ) : null}
          <Form
            key={fieldFormKey}
            layout="inline"
            style={{ marginTop: 8 }}
            onFinish={(v) =>
              fieldMutation.mutate(v as { name: string; type: string })
            }
            initialValues={{ type: "text" }}
          >
            <Form.Item
              name="name"
              rules={[
                { required: true, whitespace: true, message: "字段名称" },
              ]}
            >
              <Input placeholder="新字段名称" style={{ width: 150 }} />
            </Form.Item>
            <Form.Item name="type">
              <Select options={FIELD_TYPES} style={{ width: 140 }} />
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={fieldMutation.isPending}
            >
              添加
            </Button>
          </Form>
        </Flex>
      </Drawer>

      <Modal
        title="重命名字段"
        open={renameTarget !== null}
        onCancel={() => setRenameTarget(null)}
        onOk={() => {
          if (renameTarget && renameValue.trim())
            renameMutation.mutate({
              field: renameTarget,
              name: renameValue.trim(),
            });
        }}
        okText="保存"
        cancelText="取消"
        confirmLoading={renameMutation.isPending}
        destroyOnHidden
      >
        <Input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          maxLength={64}
        />
      </Modal>

      <Drawer
        title={
          <Space>
            <ShareAltOutlined />
            共享与权限
            {selectedWorkspace ? <Tag>{selectedWorkspace.name}</Tag> : null}
          </Space>
        }
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        size={narrow ? "100%" : 520}
      >
        <Flex vertical gap={16}>
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
            个人空间默认仅自己可见；邀请成员后即成为共享工作区。管理员可管理成员权限，只读成员不能修改数据。
          </Typography.Paragraph>
          <Flex gap={8} wrap>
            <Input
              placeholder="成员邮箱"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              style={{ flex: "1 1 200px" }}
            />
            <Select
              value={inviteRole}
              onChange={setInviteRole}
              options={ROLE_OPTIONS}
              style={{ width: 120 }}
            />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={!inviteEmail.trim()}
              loading={inviteMutation.isPending}
              onClick={() => inviteMutation.mutate()}
            >
              邀请
            </Button>
          </Flex>
          <Spin spinning={membersQuery.isLoading}>
            {members.length ? (
              <Flex vertical gap={8}>
                {members.map((m) => (
                  <Card key={m.id} size="small">
                    <Flex align="center" justify="space-between" gap={8} wrap>
                      <Flex vertical gap={2} style={{ minWidth: 0 }}>
                        <Typography.Text strong ellipsis>
                          {m.name || m.email}
                        </Typography.Text>
                        <Typography.Text
                          type="secondary"
                          style={{ fontSize: 12 }}
                          ellipsis
                        >
                          {m.email}
                        </Typography.Text>
                      </Flex>
                      <Space size={6}>
                        <Select
                          size="small"
                          value={m.permissions}
                          options={ROLE_OPTIONS}
                          style={{ width: 110 }}
                          onChange={(permissions) =>
                            updateMemberMutation.mutate({
                              id: m.id,
                              permissions,
                            })
                          }
                        />
                        <Button
                          size="small"
                          danger
                          type="text"
                          icon={<DeleteOutlined />}
                          aria-label={`移除成员 ${m.email}`}
                          onClick={() =>
                            modal.confirm({
                              title: `移除成员 ${m.email}？`,
                              okText: "移除",
                              okButtonProps: { danger: true },
                              cancelText: "取消",
                              onOk: () =>
                                removeMemberMutation.mutateAsync(m.id),
                            })
                          }
                        />
                      </Space>
                    </Flex>
                  </Card>
                ))}
              </Flex>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="还没有共享成员"
              />
            )}
          </Spin>
        </Flex>
      </Drawer>

      <Modal
        title={editingRow ? "编辑记录" : "新增记录"}
        open={rowOpen}
        onCancel={() => {
          setRowOpen(false);
          setEditingRow(null);
        }}
        onOk={submitRow}
        okText="保存"
        cancelText="取消"
        confirmLoading={rowMutation.isPending}
        destroyOnHidden
        width={640}
      >
        <Form form={rowForm} layout="vertical">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: narrow ? "1fr" : "1fr 1fr",
              gap: 16,
            }}
          >
            {editableFields.map((f) => (
              <Form.Item
                key={f.id}
                name={f.name}
                label={f.name}
                extra={
                  f.people
                    ? "从系统账号中选择负责人；仅做标记，不会自动授予表格访问权限"
                    : f.type === "link_row"
                      ? "关联行：搜索被关联表的记录，保存为行 id 列表"
                      : undefined
                }
              >
                <FieldControl
                  field={f}
                  tableId={tableId as number}
                  people={people}
                  peopleByRow={peopleByRow}
                />
              </Form.Item>
            ))}
          </div>
          {!editableFields.length && (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="当前工作表没有可编辑字段"
            />
          )}
          {readOnlyFields.length ? (
            <div style={{ marginTop: 12 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                只读字段（由 Baserow 自动计算或从其他表同步）
              </Typography.Text>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: narrow ? "1fr" : "1fr 1fr",
                  gap: 12,
                  marginTop: 8,
                }}
              >
                {readOnlyFields.map((f) => (
                  <Tooltip
                    key={f.id}
                    title={READ_ONLY_HINTS[f.type] ?? "该字段不可编辑"}
                  >
                    <Flex
                      vertical
                      gap={2}
                      style={{ opacity: 0.65, cursor: "not-allowed" }}
                    >
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 12 }}
                      >
                        {f.name}
                        <Tag style={{ marginLeft: 6 }}>
                          {FIELD_TYPE_LABELS[f.type] ?? f.type}
                        </Tag>
                      </Typography.Text>
                      <div>
                        {renderValue(f, editingRow?.[f.name], peopleByRow)}
                      </div>
                    </Flex>
                  </Tooltip>
                ))}
              </div>
            </div>
          ) : null}
          {editingRow ? (
            <CommentTimeline
              tableId={tableId as number}
              rowId={editingRow.id}
            />
          ) : null}
        </Form>
      </Modal>

      <Modal
        title={viewModal?.mode === "rename" ? "重命名视图" : "新建视图"}
        open={viewModal !== null}
        onCancel={() => setViewModal(null)}
        onOk={() => viewForm.submit()}
        okText="保存"
        cancelText="取消"
        confirmLoading={
          createViewMutation.isPending || updateViewMutation.isPending
        }
        destroyOnHidden
      >
        <Form
          form={viewForm}
          layout="vertical"
          initialValues={{
            name:
              viewModal?.mode === "rename" ? viewModal.view?.name : "新视图",
            type: viewModal?.mode === "rename" ? viewModal.view?.type : "grid",
          }}
          onFinish={(v) => {
            if (!viewModal) return;
            if (viewModal.mode === "rename" && viewModal.view) {
              updateViewMutation.mutate({
                id: viewModal.view.id,
                patch: { name: v.name.trim() },
              });
              return;
            }
            createViewMutation.mutate({ name: v.name.trim(), type: v.type });
          }}
        >
          <Form.Item
            name="name"
            label="视图名称"
            rules={[
              { required: true, whitespace: true, message: "请输入视图名称" },
            ]}
          >
            <Input maxLength={64} placeholder="例如：进行中的任务" />
          </Form.Item>
          {viewModal?.mode === "create" ? (
            <Form.Item name="type" label="视图类型">
              <Select options={VIEW_TYPE_OPTIONS} />
            </Form.Item>
          ) : null}
        </Form>
      </Modal>

      <Modal
        title={`批量修改（${selectedRowKeys.length} 条）`}
        open={batchOpen}
        onCancel={() => setBatchOpen(false)}
        onOk={() => batchForm.submit()}
        okText="应用"
        cancelText="取消"
        confirmLoading={batchUpdateMutation.isPending}
        destroyOnHidden
      >
        <Form
          form={batchForm}
          layout="vertical"
          onFinish={(v) =>
            batchUpdateMutation.mutate({ field: v.field, value: v.value })
          }
        >
          <Form.Item
            name="field"
            label="要修改的字段"
            rules={[{ required: true, message: "请选择字段" }]}
          >
            <Select
              options={editableFields.map((f) => ({
                value: f.name,
                label: f.name,
              }))}
              onChange={() => batchForm.setFieldValue("value", undefined)}
            />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, next) => prev.field !== next.field}
          >
            {() => {
              const name = batchForm.getFieldValue("field");
              const field = editableFields.find((f) => f.name === name);
              if (!field) return null;
              return (
                <Form.Item name="value" label={`${field.name} 的新值`}>
                  <FieldControl
                    field={field}
                    tableId={tableId as number}
                    people={people}
                    peopleByRow={peopleByRow}
                  />
                </Form.Item>
              );
            }}
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title="最近删除"
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        size={narrow ? "100%" : 520}
      >
        <Spin spinning={trashQuery.isFetching}>
          {trashItems.length ? (
            <Flex vertical gap={8}>
              {trashItems.map((item) => (
                <Card key={item.id} size="small">
                  <Flex align="center" justify="space-between" gap={8} wrap>
                    <Flex vertical gap={2} style={{ minWidth: 0 }}>
                      <Typography.Text strong ellipsis>
                        {item.names?.join("、") ||
                          item.name ||
                          `#${item.trash_item_id}`}
                      </Typography.Text>
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 12 }}
                      >
                        {item.trash_item_type} · {item.parent_name || "—"} ·{" "}
                        {dayjs(item.trashed_at).format("YYYY-MM-DD HH:mm")}
                      </Typography.Text>
                    </Flex>
                    <Button
                      size="small"
                      icon={<UndoOutlined />}
                      loading={restoreMutation.isPending}
                      onClick={() => restoreMutation.mutate(item)}
                    >
                      恢复
                    </Button>
                  </Flex>
                </Card>
              ))}
            </Flex>
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="回收站是空的"
            />
          )}
        </Spin>
      </Drawer>
    </PageShell>
  );
}
