import { Button, Flex, Input, Select, Segmented, Switch, Tag, Typography } from "antd";
import { DeleteOutlined, PlusOutlined, SortAscendingOutlined, UndoOutlined } from "@ant-design/icons";
import { FILTER_TYPE_OPTIONS } from "./fieldComponents";
import type { BaserowPageState } from "./useBaserowPage";

/**
 * 筛选与排序面板：贴在视图栏上的 Popover 内容。
 * 从 BaserowPageState 取依赖，闭包语义与拆分前一致。
 */
export function renderFilterPanelFn(st: BaserowPageState) {
  const {
    newFilterValue,
    setNewFilterType,
    setNewSortOrder,
    fields,
    setNewSortField,
    sortMutation,
    newSortField,
    updateViewMutation,
    setNewFilterField,
    newFilterType,
    filterMutation,
    setNewFilterValue,
    activeView,
    newSortOrder,
    newFilterField,
  } = st;

  /** 筛选与排序面板：贴在视图栏上的 Popover 内容。 */
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
