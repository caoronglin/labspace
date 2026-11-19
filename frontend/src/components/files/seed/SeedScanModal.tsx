import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Descriptions,
  Flex,
  Modal,
  Space,
  Spin,
  Typography,
  Upload,
} from 'antd';
import type { UploadProps } from 'antd';
import { CameraOutlined, InboxOutlined, ScanOutlined } from '@ant-design/icons';

import { baserowApi, type SeedOcrResult } from '../../../services/api';

/**
 * 扫码录入：手机拍标签 → 本地 OCR → 预填字段 → 人工确认后入库。
 *
 * 人因上的三个决定
 * ----------------
 * 1. **先拍照，后填表。** 台账字段有二十多个，一次全摆出来会让人无从下手；
 *    拍照这条路只需要四个字段（品种 / 编号 / 数量 / 位置），其余留空后补。
 * 2. **识别结果一律要人确认。** 标签是曲面、反光、手写的，OCR 必然认错；
 *    中文人名尤其容易变成两个字母。所以这里只**预填**，绝��自动入库。
 * 3. **认出什么就显示什么。** 没认出来的字段不假装有值，留给用户手填。
 */

/** OCR 字段 → 种子表字段名的候选关键词（按优先级）。 */
const FIELD_HINTS: { key: string; words: string[]; label: string }[] = [
  { key: 'variety', words: ['品种', '品系', '材料', '名称', '品名'], label: '品种' },
  { key: 'code', words: ['编号', '批次', '批号', '条码', '种子号'], label: '编号' },
  { key: 'quantity', words: ['数量', '库存量', '粒数'], label: '数量' },
  { key: 'location', words: ['位置', '存放', '库位', '冷库', '货架', '冰箱'], label: '存放位置' },
  { key: 'owner', words: ['负责人', '保管人', '联系人'], label: '负责人' },
  { key: 'species', words: ['物种', '种名', '拉丁', '学名'], label: '物种' },
];

export interface SeedScanModalProps {
  open: boolean;
  /** 种子表的字段清单，用来把 OCR 的通用键映射到实际字段名。 */
  fieldNames: string[];
  onClose: () => void;
  /** 把识别结果交给上层去预填新建表单。 */
  onPrefill: (values: Record<string, string>) => void;
}

/**
 * 把 OCR 的通用字段键映射到种子表的真实字段名。
 * 表单字段名是模板里定义的（可能叫「品种」也可能叫「品系」），
 * 所以按关键词模糊匹配一次；匹配不上的就不填。
 */
function mapToFields(
  fields: Record<string, string>,
  fieldNames: string[],
): { values: Record<string, string>; mapping: { label: string; from: string; to: string }[] } {
  const values: Record<string, string> = {};
  const mapping: { label: string; from: string; to: string }[] = [];
  for (const hint of FIELD_HINTS) {
    const raw = fields[hint.key];
    if (!raw) continue;
    const target = fieldNames.find((name) =>
      hint.words.some((w) => name.includes(w) || w.includes(name)),
    );
    if (!target) continue;
    values[target] = raw;
    mapping.push({ label: hint.label, from: raw, to: target });
  }
  return { values, mapping };
}

export default function SeedScanModal({ open, fieldNames, onClose, onPrefill }: SeedScanModalProps) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SeedOcrResult | null>(null);

  const handleFile = async (file: File) => {
    setBusy(true);
    setResult(null);
    try {
      const r = await baserowApi.seedOcr(file);
      setResult(r);
      if (!r.ok) {
        // 认不出来不是故障：拍照环境本来就常常认不出，给个可执行的提示就行。
        message.warning('这张照片没认出文字，请换个角度重拍，或手动填写');
      }
    } catch (e) {
      message.error(`识别失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const uploadProps: UploadProps = {
    accept: 'image/*',
    // capture 让手机直接调起后置摄像头，而不是先进相册再选
    capture: 'environment',
    showUploadList: false,
    multiple: false,
    customRequest: ({ file, onSuccess }) => {
      void handleFile(file as File).then(() => onSuccess?.({}));
    },
  };

  const mapped = result?.ok ? mapToFields(result.fields, fieldNames) : { values: {}, mapping: [] };

  return (
    <Modal
      open={open}
      title={
        <Space>
          <ScanOutlined /> 扫码录入
        </Space>
      }
      onCancel={onClose}
      width={520}
      footer={
        <Flex justify="space-between" align="center">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            识别只做预填，确认无误后再提交
          </Typography.Text>
          <Space>
            <Button onClick={onClose}>取消</Button>
            <Button
              type="primary"
              disabled={mapped.mapping.length === 0}
              onClick={() => {
                onPrefill(mapped.values);
                onClose();
              }}
            >
              填入新建表单（{mapped.mapping.length}）
            </Button>
          </Space>
        </Flex>
      }
    >
      <Flex vertical gap={12}>
        <Upload.Dragger {...uploadProps} disabled={busy}>
          <p className="ant-upload-drag-icon">
            <CameraOutlined style={{ fontSize: 32, color: 'var(--ant-color-primary)' }} />
          </p>
          <p className="ant-upload-text">拍照或选择标签照片</p>
          <p className="ant-upload-hint">
            手机上会直接调起相机。拍正、避开反光，识别率最高。
          </p>
          {busy ? <Spin size="small" style={{ marginTop: 8 }} /> : null}
        </Upload.Dragger>

        {result && !result.ok ? (
          <Alert
            type="info"
            showIcon
            message="没认出可用文字"
            description="可以重拍一张；也可以直接关掉这个窗口手动新建记录。"
          />
        ) : null}

        {result?.ok && mapped.mapping.length === 0 ? (
          <Alert
            type="warning"
            showIcon
            message="认出了文字，但没对上表里的字段"
            description={
              <span>
                原始识别结果：
                <br />
                <Typography.Text code style={{ fontSize: 11 }}>
                  {(result.lines || []).slice(0, 4).join(' / ') || result.text?.slice(0, 120)}
                </Typography.Text>
              </span>
            }
          />
        ) : null}

        {result?.ok && mapped.mapping.length > 0 ? (
          <>
            <Alert
              type="success"
              showIcon
              message={`认出 ${mapped.mapping.length} 个字段`}
              description="请核对下方内容；识别有误可直接改，改完再填入表单。"
            />
            <Descriptions
              size="small"
              bordered
              column={1}
              items={mapped.mapping.map((m) => ({
                key: m.to,
                label: m.to,
                children: (
                  <Typography.Text style={{ fontSize: 13 }}>{m.from}</Typography.Text>
                ),
              }))}
            />
            {result.lines.length > mapped.mapping.length ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                <InboxOutlined /> 其它识别行（未匹配到字段）：
                {result.lines.filter((l) => !mapped.mapping.some((m) => m.from && l.includes(m.from))).slice(0, 3).join(' / ')}
              </Typography.Text>
            ) : null}
          </>
        ) : null}
      </Flex>
    </Modal>
  );
}
