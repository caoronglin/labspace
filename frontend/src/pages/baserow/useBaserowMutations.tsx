import { Button, Flex } from "antd";
import { useMutation, useQuery } from "@tanstack/react-query";
import { baserowApi, type BaserowField, type BaserowFile, type BaserowRow, type BaserowTrashItem } from "../../services/api";
import { errText } from "../../utils/err";
import type { FormValue } from "./fieldComponents";

import type { BaserowBase } from "./useBaserowPage";

/**
 * 集中放 BaserowPage 的全部 useMutation：条目/字段/视图/批量/回收站。
 * 依赖（qc、invalidate、字段列表等）从 base 传入，类型由 ReturnType 推断。
 */
export function useBaserowMutations(base: BaserowBase) {
  const {
    message,
    qc,
    setWorkspaceId,
    databaseId,
    setDatabaseId,
    tableId,
    setTableId,
    viewId,
    setViewId,
    setViewModal,
    viewForm,
    selectedRowKeys,
    setSelectedRowKeys,
    setBatchOpen,
    batchForm,
    trashOpen,
    pendingViewIdRef,
    setPage,
    search,
    orderBy,
    setCreateKind,
    setRowOpen,
    setEditingRow,
    editUndoStack,
    setRenameTarget,
    setRenameObject,
    setFieldFormKey,
    createForm,
    rowForm,
    selectedWorkspace,
    fields,
    rowsQuery,
  } = base;
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

  return {
    invalidate,
    createMutation,
    fieldMutation,
    renameMutation,
    deleteFieldMutation,
    rowMutation,
    deleteMutation,
    undoDeleteMutation,
    invalidateViews,
    createViewMutation,
    updateViewMutation,
    deleteViewMutation,
    filterMutation,
    sortMutation,
    selectAllMutation,
    batchDeleteMutation,
    batchUpdateMutation,
    normalizeFieldValue,
    trashQuery,
    trashItems,
    restoreMutation,
    deleteTableMutation,
    renameObjectMutation,
    deleteDatabaseMutation,
    deleteWorkspaceMutation,
  };
}
