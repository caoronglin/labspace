/**
 * 强制改密弹窗（首次登录）。
 *
 * 服务端对「初始口令未改」的账号返回 428（除白名单外的接口全部拦下），
 * 所以这里必须**不可关闭**：不能点遮罩、不能按 ESC、不能点取消。
 * 改完口令后刷新 /api/me，标记消失，弹窗自动退场。
 */
import { useState } from 'react';
import { Alert, App, Form, Input, Modal, Space, Typography } from 'antd';
import { KeyOutlined, LockOutlined } from '@ant-design/icons';
import { api } from '../services/api';
import { errText } from '../utils/err';

const { Paragraph, Text } = Typography;

interface Props {
  /** 初始口令还没改时为 true。 */
  mustChange: boolean;
  /** 改密成功后调用，用来刷新 /api/me。 */
  onChanged: () => void;
}

export default function ForcePasswordChange({ mustChange, onChanged }: Props) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ oldPassword: string; newPassword: string; confirm: string }>();
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const values = await form.validateFields();
    if (values.newPassword !== values.confirm) {
      message.error('两次输入的新口令不一致');
      return;
    }
    setSaving(true);
    try {
      await api.changeMyPassword(values.oldPassword, values.newPassword);
      message.success('口令已更新，现在可以正常使用工作台');
      form.resetFields();
      onChanged();
    } catch (e) {
      message.error(`改密失败：${errText(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={mustChange}
      title={
        <Space>
          <KeyOutlined />
          请先修改初始口令
        </Space>
      }
      // 不可关闭：服务端已经用 428 挡住其它接口，这里必须与之一致。
      closable={false}
      mask={{ closable: false }}
      keyboard={false}
      onCancel={() => undefined}
      okText="保存新口令"
      cancelButtonProps={{ style: { display: 'none' } }}
      confirmLoading={saving}
      onOk={() => void submit()}
      width={460}
      destroyOnHidden
    >
      <Alert
        type="warning"
        showIcon
        title="这是首次登录，必须先改口令"
        description="初始口令是公开的临时口令，改完才能使用工作台的其它功能。"
        style={{ marginBottom: 12 }}
      />
      <Paragraph type="secondary" style={{ fontSize: 13 }}>
        新口令至少 10 位，且不能与初始口令相同。
      </Paragraph>
      <Form form={form} layout="vertical" onFinish={() => void submit()}>
        <Form.Item
          name="oldPassword"
          label="当前口令"
          rules={[{ required: true, message: '请输入当前口令' }]}
        >
          <Input.Password prefix={<LockOutlined />} placeholder="ChangeMe#2026" autoComplete="current-password" />
        </Form.Item>
        <Form.Item
          name="newPassword"
          label="新口令"
          rules={[
            { required: true, message: '请输入新口令' },
            { min: 10, message: '新口令至少 10 位' },
          ]}
        >
          <Input.Password prefix={<LockOutlined />} placeholder="至少 10 位，建议字母 + 数字 + 符号" autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="confirm"
          label="确认新口令"
          dependencies={['newPassword']}
          rules={[
            { required: true, message: '请再输入一次新口令' },
            ({ getFieldValue }) => ({
              validator: (_rule, value) =>
                !value || getFieldValue('newPassword') === value
                  ? Promise.resolve()
                  : Promise.reject(new Error('两次输入的口令不一致')),
            }),
          ]}
        >
          <Input.Password prefix={<LockOutlined />} placeholder="再输入一次新口令" autoComplete="new-password" />
        </Form.Item>
        <Text type="secondary" style={{ fontSize: 12 }}>
          改完口令后，其他账号（导师、组员）也请各自改一次自己的初始口令。
        </Text>
      </Form>
    </Modal>
  );
}
