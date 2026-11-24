import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { UploadFile } from 'antd';
import {
  CompressOutlined,
  DownloadOutlined,
  FilePdfOutlined,
  FolderOpenOutlined,
  MergeCellsOutlined,
  ScissorOutlined,
  SafetyCertificateOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import PageShell from '../components/PageShell';
import { tokens } from '../theme/tokens';

/**
 * PDF 工具箱（Stirling PDF）—— **antd 原生自绘**，不嵌第三方界面。
 *
 * 为什么不用 iframe 嵌 Stirling 自己的前端
 * --------------------------------------
 * 平台的一致原则：凡是自己能画的就自己画（Baserow 多维表格已经这么做了）。
 * 第三方前端带来三样我们不想要的东西：
 *   1. 它自己的登录页（门户已经鉴权过一遍，用户不该登两次）
 *   2. 它的导航与配色，和门户完全不是一套
 *   3. 它的功能入口按"它认为的重要"排序，不是按实验室的科研流程
 *
 * 接口走**同源**的 /pdf-api/（门户 nginx 转发到 Stirling）：
 * 浏览器里端口不同就是不同源，直接调 :8106 会被 CORS 拦掉。
 *
 * 注意：Stirling 3.3 改过路径（旧的 /general/compress-pdf 已是 /misc/compress-pdf），
 * 下面每条路径都是对**这一版**实测过的。
 */

type OpKey =
  | 'merge'
  | 'split'
  | 'split-count'
  | 'split-chapters'
  | 'split-poster'
  | 'auto-split'
  | 'rotate'
  | 'rearrange'
  | 'remove-pages'
  | 'compress'
  | 'repair'
  | 'add-password'
  | 'remove-password'
  | 'sanitize';

/** 操作分组：按实验室的实际流程排，不按 Stirling 的菜单排。 */
type GroupKey = 'organize' | 'edit' | 'secure';

interface OpField {
  name: string;
  label: string;
  kind: 'text' | 'number' | 'select';
  options?: { value: string | number; label: string }[];
  placeholder?: string;
  required?: boolean;
}

interface Op {
  key: OpKey;
  group: GroupKey;
  label: string;
  path: string;
  multi: boolean;
  icon: React.ReactNode;
  hint: string;
  fields?: OpField[];
  /** 返回 zip（多文件输出）时给出更准确的措辞 */
  zip?: boolean;
}

const GROUPS: { key: GroupKey; label: string }[] = [
  { key: 'organize', label: '整理' },
  { key: 'edit', label: '编辑' },
  { key: 'secure', label: '安全' },
];

const OPS: Op[] = [
  {
    key: 'merge',
    group: 'organize',
    label: '合并',
    path: '/api/v1/general/merge-pdfs',
    multi: true,
    icon: <MergeCellsOutlined />,
    hint: '把多份 PDF 按选择顺序合成一份（顺序 = 上传顺序）。',
  },
  {
    key: 'split',
    group: 'organize',
    label: '拆页',
    path: '/api/v1/general/split-pages',
    multi: false,
    zip: true,
    icon: <ScissorOutlined />,
    hint: '按横切/纵切把一页分成多份（海报拼版前的准备）。',
    fields: [
      {
        name: 'horizontal',
        label: '切分方向',
        kind: 'select',
        options: [
          { value: 'horizontal', label: '横向（左右分栏）' },
          { value: 'vertical', label: '纵向（上下分栏）' },
        ],
      },
    ],
  },
  {
    key: 'split-count',
    group: 'organize',
    label: '按份数拆',
    path: '/api/v1/general/split-by-size-or-count',
    multi: false,
    zip: true,
    icon: <ScissorOutlined />,
    hint: '按"每份几页"或"每份多大"把整份拆成若干份。',
    fields: [
      {
        name: 'splitType',
        label: '拆分依据',
        kind: 'select',
        options: [
          { value: 'size', label: '按大小' },
          { value: 'count', label: '按页数' },
        ],
      },
      { name: 'splitValue', label: '数值（MB 或 页数）', kind: 'number' },
    ],
  },
  {
    key: 'split-chapters',
    group: 'organize',
    label: '按章节拆',
    path: '/api/v1/general/split-pdf-by-chapters',
    multi: false,
    zip: true,
    icon: <FolderOpenOutlined />,
    hint: '按 PDF 书签（大纲）拆成章节 —— 综述、论文的附录最好用。',
  },
  {
    key: 'split-poster',
    group: 'organize',
    label: '海报拼版',
    path: '/api/v1/general/split-for-poster-print',
    multi: false,
    zip: true,
    icon: <ScissorOutlined />,
    hint: '把几页拼成一张大海报（学术海报）。',
  },
  {
    key: 'auto-split',
    group: 'organize',
    label: '自动拆页',
    path: '/api/v1/misc/auto-split-pdf',
    multi: false,
    zip: true,
    icon: <ScissorOutlined />,
    hint: '自动识别页面边界拆开（扫描件常见）。',
  },
  {
    key: 'rotate',
    group: 'edit',
    label: '旋转',
    path: '/api/v1/general/rotate-pdf',
    multi: false,
    icon: <ToolOutlined />,
    hint: '把整份转 90/180/270 度（扫描方向反了）。',
    fields: [
      {
        name: 'angle',
        label: '角度',
        kind: 'select',
        options: [
          { value: 90, label: '90°' },
          { value: 180, label: '180°' },
          { value: 270, label: '270°' },
        ],
      },
    ],
  },
  {
    key: 'rearrange',
    group: 'edit',
    label: '重排',
    path: '/api/v1/general/rearrange-pages',
    multi: false,
    icon: <MergeCellsOutlined />,
    hint: '按页码顺序重新排列页面（抽页后重新装订）。',
  },
  {
    key: 'remove-pages',
    group: 'edit',
    label: '删页',
    path: '/api/v1/general/remove-pages',
    multi: false,
    icon: <ScissorOutlined />,
    hint: '删掉指定页（填页码，逗号分隔，如 1,3,5）。',
    fields: [
      {
        name: 'pageNumbers',
        label: '要删除的页码',
        kind: 'text',
        placeholder: '例如 1,3,5',
        required: true,
      },
    ],
  },
  {
    key: 'compress',
    group: 'edit',
    label: '压缩',
    path: '/api/v1/misc/compress-pdf',
    multi: false,
    icon: <CompressOutlined />,
    hint: '降低体积，便于投稿与传阅。',
    fields: [
      {
        name: 'level',
        label: '压缩强度',
        kind: 'select',
        options: [
          { value: 1, label: '轻度（几乎无损）' },
          { value: 3, label: '中度' },
          { value: 5, label: '重度（最小体积）' },
        ],
      },
    ],
  },
  {
    key: 'repair',
    group: 'edit',
    label: '修复',
    path: '/api/v1/misc/repair',
    multi: false,
    icon: <ToolOutlined />,
    hint: '修复损坏的 PDF（有些编辑器的产物会坏）。',
  },
  {
    key: 'add-password',
    group: 'secure',
    label: '加密码',
    path: '/api/v1/security/add-password',
    multi: false,
    icon: <SafetyCertificateOutlined />,
    hint: '给 PDF 加上打开口令（分享敏感材料时用）。',
    fields: [{ name: 'password', label: '打开口令', kind: 'text', required: true }],
  },
  {
    key: 'remove-password',
    group: 'secure',
    label: '去密码',
    path: '/api/v1/security/remove-password',
    multi: false,
    icon: <SafetyCertificateOutlined />,
    hint: '去掉已知的打开口令。',
    fields: [{ name: 'password', label: '原口令', kind: 'text', required: true }],
  },
  {
    key: 'sanitize',
    group: 'secure',
    label: '净化',
    path: '/api/v1/security/sanitize-pdf',
    multi: false,
    icon: <SafetyCertificateOutlined />,
    hint: '去掉文档里的脚本与元数据（对外分享前做一次）。',
  },
];

export default function PdfTools() {
  const { message } = App.useApp();
  const [searchParams] = useSearchParams();
  /**
   * 从文件存储带过来的文件（?source=&id=&name=）。
   *
   * 这是「文件存储 → PDF 工具箱」的联动：用户不必先下载到本地、
   * 再从本地上传回来 —— 门户直接把那份 PDF 取过来放进待处理列表。
   */
  const incoming = useMemo(
    () => ({
      id: searchParams.get('id') ?? '',
      name: searchParams.get('name') ?? '',
    }),
    [searchParams],
  );

  const [group, setGroup] = useState<GroupKey>('organize');
  const [op, setOp] = useState<OpKey>('merge');
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [result, setResult] = useState<{ name: string; url: string; zip: boolean } | null>(null);

  // 从文件存储自动带入的那份文件：取回来放进待处理列表。
  const incomingFile = useQuery({
    queryKey: ['pdf-incoming', incoming.id],
    queryFn: async () => {
      const res = await fetch(`/api/files/${encodeURIComponent(incoming.id)}/download`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('取回文件失败');
      const blob = await res.blob();
      return new File([blob], incoming.name || 'document.pdf', {
        type: blob.type || 'application/pdf',
      });
    },
    enabled: Boolean(incoming.id),
    staleTime: 60_000,
    retry: false,
  });

  // 带入成功后放进列表（只在 id 变化时放一次，避免覆盖用户后续添加的文件）
  const [incomingDone, setIncomingDone] = useState<string>('');
  useEffect(() => {
    if (!incoming.id || !incomingFile.data || incomingDone === incoming.id) return;
    setIncomingDone(incoming.id);
    setFiles((prev) => {
      if (prev.some((f) => f.name === incomingFile.data?.name)) return prev;
      // antd 的 UploadFile.originFileObj 类型是 RcFile（File + uid），
      // 这里放的是普通 File —— 上传通道只用到 name/size/type，够用。
      const item: UploadFile = {
        uid: `incoming-${incoming.id}`,
        name: incomingFile.data?.name || 'document.pdf',
        originFileObj: incomingFile.data as UploadFile['originFileObj'],
      };
      return [...prev, item];
    });
  }, [incoming.id, incomingFile.data, incomingDone]);

  const visible = useMemo(() => OPS.filter((o) => o.group === group), [group]);
  const current = useMemo(
    () => OPS.find((o) => o.key === op) ?? OPS[0],
    [op],
  );

  const run = useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      const picked = files.filter((f) => f.originFileObj);
      if (!picked.length) throw new Error('请先选择文件');
      const form = new FormData();
      for (const f of picked) {
        // 每个文件都用同一个字段名 fileInput（后端按重复字段收集）
        form.append('fileInput', f.originFileObj as File);
      }
      for (const f of current.fields ?? []) {
        const v = values[f.name];
        if (v === undefined || v === null || v === '') continue;
        form.append(f.name, String(v));
      }
      const res = await fetch(`/pdf-api${current.path.replace(/^\/api\/v1/, '')}`, {
        method: 'POST',
        body: form,
        credentials: 'include',
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          detail = body?.detail ?? body?.message ?? body?.title ?? detail;
        } catch {
          /* 非 JSON 错误体 */
        }
        throw new Error(detail);
      }
      const blob = await res.blob();
      return { url: URL.createObjectURL(blob), zip: blob.type.includes('zip') };
    },
    onSuccess: (r) => {
      const ext = r.zip ? 'zip' : 'pdf';
      setResult({ name: `labspace-${current.label}-${Date.now()}.${ext}`, url: r.url, zip: r.zip });
      message.success('处理完成');
    },
    onError: (e: Error) => message.error(`处理失败：${e.message}`),
  });

  const disabled = files.filter((f) => f.originFileObj).length === 0 || run.isPending;

  const renderResult = () => {
    if (run.isPending) {
      return (
        <Flex vertical gap={12} align="center" style={{ padding: '48px 0' }}>
          <Spin />
          <Typography.Text type="secondary">正在本机处理，请稍候…</Typography.Text>
        </Flex>
      );
    }
    if (result) {
      return (
        <Flex vertical gap={12}>
          <Alert
            type="success"
            showIcon
            title="处理完成"
            description="文件已在本机生成，未上传到任何外部服务。"
          />
          <Flex gap={10} align="center" wrap>
            <Tag color="green" icon={<FilePdfOutlined />}>{result.name}</Tag>
            <Button type="primary" icon={<DownloadOutlined />} href={result.url} download={result.name}>
              下载
            </Button>
            <Button onClick={() => setResult(null)}>继续处理</Button>
          </Flex>
        </Flex>
      );
    }
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="选好操作与文件后点「执行」，结果会出现在这里"
      >
        <Space orientation="vertical" size={4} align="center">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            转换由 Stirling PDF 在本机执行：子进程并发数、单任务超时与上传体积都已设上限。
          </Typography.Text>
        </Space>
      </Empty>
    );
  };

  return (
    <PageShell
      title="PDF 工具箱"
      description="论文 PDF 的整理、编辑与安全处理 —— 全部在本机完成，文件不出内网。"
    >
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={9}>
          <Card title="选择操作" size="small">
            <Segmented
              block
              value={group}
              onChange={(v) => {
                const g = v as GroupKey;
                setGroup(g);
                const first = OPS.find((o) => o.group === g);
                if (first) setOp(first.key);
                setResult(null);
              }}
              options={GROUPS.map((g) => ({ value: g.key, label: g.label }))}
            />
            <Segmented
              block
              style={{ marginTop: 10 }}
              value={op}
              onChange={(v) => {
                setOp(v as OpKey);
                setResult(null);
              }}
              options={visible.map((o) => ({ value: o.key, label: o.label, icon: o.icon }))}
            />
            <Typography.Paragraph
              type="secondary"
              style={{ marginTop: 12, marginBottom: 0, fontSize: 12.5 }}
            >
              {current.hint}
            </Typography.Paragraph>

            <Form
              layout="vertical"
              style={{ marginTop: 12 }}
              initialValues={{
                horizontal: 'horizontal',
                splitType: 'count',
                angle: 90,
                level: 3,
              }}
              onFinish={(v) => run.mutate(v)}
            >
              {(current.fields ?? []).map((f) => {
                let control;
                if (f.kind === 'select') control = <Select options={f.options} />;
                else if (f.kind === 'number') control = <InputNumber style={{ width: '100%' }} min={1} />;
                else control = <Input placeholder={f.placeholder} />;
                return (
                  <Form.Item
                    key={f.name}
                    label={f.label}
                    name={f.name}
                    rules={f.required ? [{ required: true, message: `请填写${f.label}` }] : undefined}
                  >
                    {control}
                  </Form.Item>
                );
              })}
            </Form>
          </Card>

          <Card title="选择文件" size="small" style={{ marginTop: 16 }}>
            <Upload.Dragger
              accept=".pdf,application/pdf"
              multiple={current.multi}
              disabled={!current.multi}
              fileList={files}
              beforeUpload={() => false}
              onChange={({ fileList }) => setFiles(fileList)}
              onRemove={(f: UploadFile) => setFiles((prev) => prev.filter((x) => x.uid !== f.uid))}
            >
              <p className="ant-upload-drag-icon">
                <FilePdfOutlined style={{ fontSize: 34, color: tokens.colorPrimary }} />
              </p>
              <p className="ant-upload-text">点击或拖拽 PDF 到这里</p>
              <p className="ant-upload-hint">
                {current.multi ? '可多选，合并顺序 = 上传顺序' : '此操作一次处理一份文件'}
              </p>
            </Upload.Dragger>

            <Flex gap={8} style={{ marginTop: 12 }} align="center">
              <Button
                type="primary"
                icon={current.icon}
                loading={run.isPending}
                disabled={disabled}
                onClick={() => run.mutate({})}
              >
                {run.isPending ? '处理中…' : `执行${current.label}`}
              </Button>
              {files.length ? (
                <Button type="text" onClick={() => { setFiles([]); setResult(null); }}>
                  清空
                </Button>
              ) : null}
            </Flex>
          </Card>
        </Col>

        <Col xs={24} lg={15}>
          <Card title="结果" size="small">
            {renderResult()}
          </Card>
        </Col>
      </Row>
    </PageShell>
  );
}
