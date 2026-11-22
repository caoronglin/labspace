import { Badge, Button, Calendar, Card, Dropdown, Empty, Flex, Space, Spin, Tag, Typography } from "antd";
import { DeleteOutlined, EditOutlined, EllipsisOutlined, PlusOutlined } from "@ant-design/icons";
import type { BaserowRow } from "../../services/api";
import { tokens } from "../../theme/tokens";
import { palette } from "../../theme/palette";
import { optionId, plainText, dateKey, renderValue, LinkRowCell } from "./fieldComponents";
import type { BaserowPageState } from "./useBaserowPage";

/**
 * 视图渲染器：画廊卡片 / 看板 / 日历 / 表单 / 行卡片。
 * 全部数据与回调从 BaserowPageState 取，闭包语义与拆分前一致。
 */
export function renderViewRenderers(st: BaserowPageState) {
  const {
    fields,
    viewRows,
    confirmDeleteRow,
    cardFields,
    createTaskFromRow,
    viewRowsQuery,
    groupField,
    primaryField,
    openRowEdit,
    peopleByRow,
    dateField,
    narrow,
    tableId,
  } = st;
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
  return {
    rowCard,
    galleryView,
    kanbanView,
    calendarView,
    formView,
  };
}
