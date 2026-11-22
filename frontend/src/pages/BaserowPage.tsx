import { Button, Card, Drawer, Empty, Flex, Form, Input, Modal, Select, Space, Spin, Tag, Tooltip, Typography } from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined, ShareAltOutlined, UndoOutlined, UnorderedListOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import PageShell from "../components/PageShell";
import { READ_ONLY_HINTS, FIELD_TYPES, FIELD_TYPE_LABELS, ROLE_OPTIONS, VIEW_TYPE_OPTIONS, renderValue, FieldControl, CommentTimeline } from "./baserow/fieldComponents";
import { useBaserowPage } from "./baserow/useBaserowPage";
import { renderViewRenderers } from "./baserow/viewRenderers";
import { renderContentViews } from "./baserow/contentViews";

export default function BaserowPage({
  embedded = false,
}: { embedded?: boolean } = {}) {
  const st = useBaserowPage();
  const vr = renderViewRenderers(st);
  const cv = renderContentViews(st, vr);
  const {
    selectedRowKeys,
    editingRow,
    fields,
    hasPeopleField,
    updateMemberMutation,
    createKind,
    rowMutation,
    setCreateKind,
    shareOpen,
    trashItems,
    editableFields,
    selectedWorkspace,
    rowOpen,
    inviteMutation,
    createForm,
    renameObjectMutation,
    renameObject,
    setInviteEmail,
    batchUpdateMutation,
    openCreate,
    createMutation,
    setInviteRole,
    deleteFieldMutation,
    setFieldOpen,
    setRowOpen,
    inviteRole,
    removeMemberMutation,
    setShareOpen,
    createViewMutation,
    setRenameTarget,
    setRenameValue,
    setTrashOpen,
    setRenameObject,
    members,
    setEditingRow,
    batchOpen,
    inviteEmail,
    restoreMutation,
    fieldMutation,
    setBatchOpen,
    viewModal,
    renameTarget,
    setViewModal,
    fieldOpen,
    viewForm,
    modal,
    renameObjectValue,
    fieldFormKey,
    people,
    renameMutation,
    trashOpen,
    peopleByRow,
    submitRow,
    batchForm,
    membersQuery,
    renameValue,
    readOnlyFields,
    updateViewMutation,
    trashQuery,
    narrow,
    tableId,
    setRenameObjectValue,
    rowForm,
  } = st;
  const {
    toolbar,
    content,
  } = cv;
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
