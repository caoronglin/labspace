/**
 * 种子管理页（/seeds）。
 *
 * 页面自己向 Baserow 代理要「种子台账」模板（GET/POST /api/baserow/templates/seed），
 * 拿到 tableId 后用 baserowApi 直接读写行与字段：
 * - 顶部：总数 / 在库数量 / 低活力数 / 待备份数 + 刷新 + 新建记录
 * - 主区：多维表格（按字段类型渲染、行内编辑、分页排序、搜索）
 * - 填写：抽屉 + 表单，按语义分组
 * - 详情：抽屉展示全部字段、附件下载与备份状态
 *
 * 模板接口未就绪时只显示提示，不造假数据。
 */
import { useCallback, useMemo, useState } from "react";
import dayjs from "dayjs";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Divider,
  Empty,
  Flex,
  Grid,
  Input,
  Popover,
  Segmented,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from "antd";
import {
  ColumnHeightOutlined,
  DownloadOutlined,
  PlusOutlined,
  ReloadOutlined,
  ScanOutlined,
  SearchOutlined,
  UploadOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  baserowApi,
  type BaserowField,
  type BaserowRow,
  type BaserowSeedTemplate,
} from "../services/api";
import { errText } from "../utils/err";
import PageShell from "../components/PageShell";
import SeedTable, {
  SeedStatsBar,
  type SeedCellValue,
} from "../components/files/seed/SeedTable";
import SeedViews, {
  SEED_VIEWS,
  type SeedViewKey,
} from "../components/files/seed/SeedViews";
import SeedFormDrawer from "../components/files/seed/SeedFormDrawer";
import SeedScanModal from "../components/files/seed/SeedScanModal";
import SeedDetailDrawer from "../components/files/seed/SeedDetailDrawer";
import {
  computeSeedStats,
  defaultVisibleFieldNames,
  isPendingBackup,
} from "../components/files/seed/seedMeta";

/** 列设置在本地记住（换设备就恢复默认，不上传服务器）。 */
const COLUMN_PREF_KEY = "d509.seed.columns.v1";

function readColumnPref(): string[] {
  try {
    const raw = window.localStorage.getItem(COLUMN_PREF_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

export default function SeedStore() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const screens = Grid.useBreakpoint();

  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [search, setSearch] = useState("");
  const [keyword, setKeyword] = useState("");
  const [orderBy, setOrderBy] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<BaserowRow | null>(null);
  // 扫码录入：识别结果先落在 prefill，由抽屉消费。
  const [scanOpen, setScanOpen] = useState(false);
  const [prefill, setPrefill] = useState<Record<string, string> | null>(null);
  const [detail, setDetail] = useState<BaserowRow | null>(null);
  /** 列设置：空数组 = 用默认列；用户勾选后存到 localStorage。 */
  const [visibleNames, setVisibleNames] = useState<string[]>(readColumnPref);
  /** 只看还没备份的记录（台账里最容易漏的就是备份）。 */
  const [onlyPendingBackup, setOnlyPendingBackup] = useState(false);
  /** 视图切换：表格 / 卡片 / 时间线 / 突变类型看板。 */
  const [view, setView] = useState<SeedViewKey>("table");
  /**
   * 标签筛选（多选）。
   *
   * 「标签」字段是逗号分隔的自由标签（高产 / 抗病 / 待测交…），
   * 台账里最常问的就是「哪些材料带这个标签」。以前只能靠搜索框逐字匹配，
   * 而搜索是全表模糊匹配，混进备注里的同名文字也会命中。
   * 这里按**标签字段拆分后精确匹配**，且只筛当前页数据（不额外请求）。
   */
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  /** Excel 导入：正在解析写入时禁用按钮，避免重复提交。 */
  const [importing, setImporting] = useState(false);

  // 模板：GET 拿已存在的模板；没有就 POST 建一份（幂等）。
  const template = useQuery<BaserowSeedTemplate>({
    queryKey: ["seed", "template"],
    queryFn: async () => {
      try {
        return await baserowApi.seedTemplate();
      } catch (e) {
        // GET 失败就试建模板；两条路都失败才算"服务未就绪"。
        try {
          return await baserowApi.ensureSeedTemplate();
        } catch {
          throw e;
        }
      }
    },
    retry: false,
    staleTime: 300_000,
  });

  const tableId = template.data?.tableId ?? null;

  const fieldsQuery = useQuery({
    queryKey: ["seed", "fields", tableId],
    queryFn: () => baserowApi.fields(tableId as number),
    enabled: Boolean(tableId),
    retry: false,
  });

  const rowsQuery = useQuery({
    queryKey: ["seed", "rows", tableId, page, size, keyword, orderBy],
    queryFn: () =>
      baserowApi.rows(tableId as number, {
        page,
        size,
        search: keyword || undefined,
        order_by: orderBy || undefined,
      }),
    enabled: Boolean(tableId),
    retry: false,
  });

  /**
   * 字段集合以模板为准（模板定义了种子台账该有哪些字段、按什么顺序），
   * 再用 baserowApi.fields 补上选项、是否主字段等元信息。
   */
  const fields: BaserowField[] = useMemo(() => {
    const rich = fieldsQuery.data?.fields ?? [];
    const byId = new Map(rich.map((f) => [f.id, f]));
    const templateFields = template.data?.fields ?? [];
    if (!templateFields.length) return rich;
    return templateFields.map((tf) => {
      const hit = byId.get(tf.id);
      return (
        hit ?? {
          id: tf.id,
          name: tf.name,
          type: tf.type,
          primary: false,
          read_only: false,
          select_options: [],
        }
      );
    });
  }, [template.data, fieldsQuery.data]);
  const rows: BaserowRow[] = useMemo(
    () => rowsQuery.data?.results ?? [],
    [rowsQuery.data],
  );
  const total = rowsQuery.data?.count ?? 0;

  // 列设置：用户勾过的就用勾的，没勾过就用默认关键列。
  const effectiveVisible = useMemo(() => {
    if (visibleNames.length) return visibleNames;
    return defaultVisibleFieldNames(fields);
  }, [visibleNames, fields]);

  const setColumns = (next: string[]) => {
    setVisibleNames(next);
    try {
      window.localStorage.setItem(COLUMN_PREF_KEY, JSON.stringify(next));
    } catch {
      // 隐私模式或存储写满：忽略，列设置只影响本次会话。
    }
  };

  /** 「标签」字段名（模板里可能叫「标签」也可能没有）。 */
  const tagFieldName = useMemo(
    () => fields.find((f) => f.name.includes('标签'))?.name,
    [fields],
  );

  /** 把某行的标签字段拆成数组（逗号可能是中英文、分号）。 */
  const tagsOf = useCallback((row: BaserowRow): string[] => {
    if (!tagFieldName) return [];
    return String(row[tagFieldName] ?? '')
      .split(/[,，;；]/)
      .map((t) => t.trim())
      .filter(Boolean);
  }, [tagFieldName]);

  /** 当前页出现过的所有标签（带出现次数，按次数排序）。 */
  const availableTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      for (const t of tagsOf(r)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, n]) => ({ value, label: `${value}（${n}）` }));
  }, [rows, tagsOf]);

  // 「仅看待备份」+「标签」都是本页筛选：作用在当前页结果上，语义写在提示里。
  const shownRows = useMemo(() => {
    let out = onlyPendingBackup ? rows.filter((r) => isPendingBackup(r, fields)) : rows;
    if (tagFilter.length) {
      out = out.filter((r) => {
        const own = tagsOf(r);
        // 多选取「任一命中」：用户选了两个标签通常是"或"的意思
        return tagFilter.some((t) => own.includes(t));
      });
    }
    return out;
  }, [rows, fields, onlyPendingBackup, tagFilter, tagsOf]);

  // 统计基于当前页数据（服务端一次只给一页），总数用服务端 count。
  const stats = useMemo(
    () => computeSeedStats(rows, fields, total),
    [rows, fields, total],
  );

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ["seed"] });
  };

  const deleteMutation = useMutation({
    // 删除成功后把**原行**带出来（撤销要靠它重建），和 Workbench 的做法一致。
    mutationFn: (row: BaserowRow) =>
      baserowApi.deleteRow(tableId as number, row.id).then(() => row),
    onSuccess: async (row) => {
      // 删除后给一个**撤销**入口（6 秒），照 Workbench 的成熟做法。
      // 台账是长期数据，误删一行（尤其是整批导入后手滑删一条）很难靠记忆补回来，
      // 而"不可恢复"的恐吓并不能替代退路。
      const key = `seed-undo-${row.id}`;
      message.open({
        key,
        type: "success",
        duration: 6,
        content: (
          <Flex gap={12} align="center">
            <span>
              已删除「{String(row["名称"] ?? row["编号"] ?? "该条记录")}」
            </span>
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
      await invalidate();
    },
    onError: (e) => message.error(`删除失败：${errText(e)}`),
  });

  // 撤销 = 用同一份字段值重建一行（Baserow 没有"恢复单行"接口）。
  // 只带**用户可见的业务字段**，避免把 id / order 之类的系统字段写回去。
  const undoDeleteMutation = useMutation({
    mutationFn: async (row: BaserowRow) => {
      if (!tableId) throw new Error("未就绪");
      const values: Record<string, unknown> = {};
      for (const f of fields) {
        if (f.type === "file") continue; // 附件不能凭 id 重建，跳过
        const v = row[f.name];
        if (v === null || v === undefined || v === "") continue;
        values[f.name] = v;
      }
      return baserowApi.createRow(tableId, values);
    },
    onSuccess: async () => {
      message.success("已恢复该条记录");
      await invalidate();
    },
    onError: (e) => message.error(`恢复失败：${errText(e)}`),
  });

  const cellMutation = useMutation({
    mutationFn: (vars: {
      row: BaserowRow;
      field: BaserowField;
      value: SeedCellValue;
    }) =>
      baserowApi.updateRow(tableId as number, vars.row.id, {
        [vars.field.name]: vars.value,
      }),
    onSuccess: async () => {
      message.success("已更新");
      await invalidate();
    },
    onError: (e) => message.error(`更新失败：${errText(e)}`),
  });

  const openCreate = () => {
    setEditing(null);
    setPrefill(null);
    setFormOpen(true);
  };

  const openEdit = (row: BaserowRow) => {
    setEditing(row);
    setPrefill(null);
    setFormOpen(true);
  };

  // ------------------------------------------------------------ Excel 导入导出

  const handleImportExcel = async (file: File) => {
    if (!tableId) return;
    setImporting(true);
    try {
      const r = await baserowApi.importExcel(tableId, file);
      const added = r.fields_added.length
        ? `，新建字段 ${r.fields_added.join("、")}`
        : "";
      message.success(`已导入 ${r.created} 条记录${added}`);
      await invalidate();
    } catch (e) {
      message.error(`导入失败：${errText(e)}`);
    } finally {
      setImporting(false);
    }
  };

  const handleExportExcel = async () => {
    if (!tableId) return;
    try {
      const blob = await baserowApi.exportExcel(tableId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `种子台账-${dayjs().format("YYYYMMDD")}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      message.success("已导出 Excel");
    } catch (e) {
      message.error(`导出失败：${errText(e)}`);
    }
  };

  const narrow = !screens.md;

  const body = () => {
    if (template.isLoading) {
      return (
        <Card size="small">
          <Typography.Text type="secondary">正在准备种子台账…</Typography.Text>
        </Card>
      );
    }
    if (template.isError) {
      return (
        <Alert
          type="warning"
          showIcon
          title="服务未就绪"
          description={`种子台账模板接口暂不可用（${errText(template.error)}）。模板就绪后本页会自动显示记录。`}
          action={
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => void template.refetch()}
            >
              重试
            </Button>
          }
        />
      );
    }
    if (!tableId) {
      return (
        <Alert
          type="warning"
          showIcon
          title="服务未就绪"
          description="尚未拿到种子台账的表信息，请稍后重试或联系管理员初始化模板。"
        />
      );
    }
    if (fieldsQuery.isError) {
      return (
        <Alert
          type="error"
          showIcon
          title="字段读取失败"
          description={errText(fieldsQuery.error)}
          action={
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => void fieldsQuery.refetch()}
            >
              重试
            </Button>
          }
        />
      );
    }
    if (!fields.length) {
      return (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="模板里还没有字段，无法渲染台账"
        />
      );
    }

    return (
      <Flex vertical gap={12}>
        <SeedStatsBar
          total={stats.total}
          inStock={stats.inStock}
          lowVitality={stats.lowVitality}
          pendingBackup={stats.pendingBackup}
          extra={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              「种子总数」是台账全部记录；带「本页」的三项只统计当前页（服务端一次只给一页）
            </Typography.Text>
          }
        />
        <Card size="small" styles={{ body: { padding: 12 } }}>
          <Flex vertical gap={12}>
            <Flex justify="space-between" align="center" gap={12} wrap>
              <Space size={8} wrap>
                <Input
                  allowClear
                  prefix={<SearchOutlined />}
                  placeholder="搜索名称、品种或存放位置"
                  style={{ width: narrow ? "100%" : 280 }}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onPressEnter={() => {
                    setKeyword(search.trim());
                    setPage(1);
                  }}
                />
                <Button
                  onClick={() => {
                    setKeyword(search.trim());
                    setPage(1);
                  }}
                >
                  搜索
                </Button>
                <Tooltip title="只列出当前页里还没备份的记录（备份最容易漏）">
                  <Button
                    type={onlyPendingBackup ? "primary" : "default"}
                    icon={<WarningOutlined />}
                    onClick={() => setOnlyPendingBackup((v) => !v)}
                  >
                    仅看待备份
                    {stats.pendingBackup ? (
                      <Tag
                        color={onlyPendingBackup ? "blue" : "orange"}
                        style={{ marginInlineStart: 6 }}
                      >
                        {stats.pendingBackup}
                      </Tag>
                    ) : null}
                  </Button>
                </Tooltip>
                {/* 标签筛选：按标签字段拆分后精确匹配（比搜索框的全表模糊匹配准） */}
                {availableTags.length ? (
                  <Select
                    mode="multiple"
                    allowClear
                    size="middle"
                    style={{ minWidth: 180, maxWidth: 320 }}
                    placeholder="按标签筛选"
                    value={tagFilter}
                    onChange={setTagFilter}
                    options={availableTags}
                    maxTagCount="responsive"
                  />
                ) : null}
              </Space>
              <Space size={8} wrap>
                <Popover
                  placement="bottomRight"
                  title="列设置"
                  content={
                    <div
                      style={{ width: 220, maxHeight: 320, overflowY: "auto" }}
                    >
                      <Checkbox.Group
                        value={effectiveVisible}
                        onChange={(vals) => setColumns(vals as string[])}
                      >
                        <Flex vertical gap={4}>
                          {fields.map((f) => (
                            <Checkbox key={f.id} value={f.name}>
                              {f.name}
                            </Checkbox>
                          ))}
                        </Flex>
                      </Checkbox.Group>
                      <Divider style={{ margin: "10px 0" }} />
                      <Space size={8}>
                        <Button
                          size="small"
                          onClick={() => setColumns(fields.map((f) => f.name))}
                        >
                          全选
                        </Button>
                        <Button
                          size="small"
                          onClick={() =>
                            setColumns(defaultVisibleFieldNames(fields))
                          }
                        >
                          恢复默认
                        </Button>
                      </Space>
                    </div>
                  }
                >
                  <Button icon={<ColumnHeightOutlined />}>
                    列设置
                    <Tag style={{ marginInlineStart: 6 }}>
                      {effectiveVisible.length}
                    </Tag>
                  </Button>
                </Popover>
                <Segmented
                  value={view}
                  onChange={(v) => setView(v as SeedViewKey)}
                  options={SEED_VIEWS.map((x) => ({
                    value: x.key,
                    label: x.label,
                    icon: x.icon,
                  }))}
                />
                <Button
                  icon={<ReloadOutlined />}
                  loading={rowsQuery.isFetching}
                  onClick={() => void rowsQuery.refetch()}
                >
                  刷新
                </Button>
                <Button
                  icon={<ScanOutlined />}
                  onClick={() => setScanOpen(true)}
                >
                  扫码录入
                </Button>
                <Upload
                  accept=".xlsx"
                  showUploadList={false}
                  beforeUpload={(f) => {
                    void handleImportExcel(f);
                    return Upload.LIST_IGNORE;
                  }}
                >
                  <Button icon={<UploadOutlined />} loading={importing}>
                    导入 Excel
                  </Button>
                </Upload>
                <Button
                  icon={<DownloadOutlined />}
                  onClick={() => void handleExportExcel()}
                >
                  导出 Excel
                </Button>
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={openCreate}
                >
                  新建记录
                </Button>
              </Space>
            </Flex>
            {view === "table" ? (
              <SeedTable
                fields={fields}
                rows={shownRows}
                total={onlyPendingBackup ? shownRows.length : total}
                loading={rowsQuery.isFetching}
                page={page}
                size={size}
                search={keyword}
                orderBy={orderBy}
                visibleFieldNames={effectiveVisible}
                onOrder={(v) => {
                  setOrderBy(v);
                  setPage(1);
                }}
                onPage={(p, s) => {
                  setPage(p);
                  setSize(s);
                }}
                onOpenRow={(row) => setDetail(row)}
                onEditRow={openEdit}
                onSaveCell={(row, field, value) =>
                  cellMutation.mutate({ row, field, value })
                }
                onDeleteRow={(row) => deleteMutation.mutate(row)}
              />
            ) : (
              <SeedViews
                view={view}
                fields={fields}
                rows={shownRows}
                onOpenRow={(row) => setDetail(row)}
              />
            )}
          </Flex>
        </Card>
      </Flex>
    );
  };

  return (
    <PageShell
      title="种子管理"
      description="种子入库、出库、存放与备份的台账，按字段类型自动渲染表格与表单。"
    >
      {body()}
      <SeedFormDrawer
        open={formOpen}
        tableId={tableId}
        fields={fields}
        row={editing}
        prefill={prefill}
        onClose={() => setFormOpen(false)}
        onSaved={() => void invalidate()}
      />
      <SeedScanModal
        open={scanOpen}
        fieldNames={fields.map((f) => f.name)}
        onClose={() => setScanOpen(false)}
        onPrefill={(values) => {
          setPrefill(values);
          setEditing(null);
          setFormOpen(true);
        }}
      />
      <SeedDetailDrawer
        open={Boolean(detail)}
        fields={fields}
        row={detail}
        onClose={() => setDetail(null)}
        onEdit={openEdit}
      />
    </PageShell>
  );
}
