import { useEffect, useMemo, useState } from 'react';
import { App, Button, Card, Empty, Flex, Input, Space, Tag, Typography } from 'antd';
import { PlayCircleOutlined } from '@ant-design/icons';
import { api, type OfficeContent, type OfficeSlide } from '../../services/api';
import { errText } from '../../utils/err';
import OfficeToolbar from './OfficeToolbar';
import PptPresentation from './PptPresentation';

type Props = {
  entryId: string;
  data: OfficeContent;
  onSaved: () => void;
};

function cloneSlides(slides: OfficeSlide[]): OfficeSlide[] {
  return slides.map((s) => ({
    ...s,
    shapes: s.shapes.map((sh) => ({ ...sh })),
    notes: s.notes ?? '',
  }));
}

function slideLabel(slide: OfficeSlide, index: number): string {
  const title = slide.shapes.find((s) => s.title)?.text?.trim();
  const first = slide.shapes.find((s) => s.text?.trim())?.text?.trim();
  const text = title || first || '';
  return text ? text.replace(/\s+/g, ' ').slice(0, 16) : `第 ${index + 1} 页`;
}

/** PPTX 编辑：逐页编辑文本框和演讲者备注；复杂图形保持原样。 */
export default function PptxEditor({ entryId, data, onSaved }: Props) {
  const { message, modal } = App.useApp();
  const initial = useMemo(() => cloneSlides(data.slides ?? []), [data]);
  const [slides, setSlides] = useState<OfficeSlide[]>(initial);
  const [active, setActive] = useState(0);
  const [base, setBase] = useState(() => JSON.stringify(initial));
  const [saving, setSaving] = useState(false);
  const [presenting, setPresenting] = useState(false);

  useEffect(() => {
    setSlides(initial);
    setBase(JSON.stringify(initial));
    setActive(0);
  }, [initial]);

  const dirty = JSON.stringify(slides) !== base;
  const slide = slides[active];

  const updateShape = (slideIndex: number, shapeId: number, text: string) => {
    setSlides((prev) =>
      prev.map((s, i) =>
        i === slideIndex
          ? { ...s, shapes: s.shapes.map((sh) => (sh.id === shapeId ? { ...sh, text } : sh)) }
          : s,
      ),
    );
  };

  const updateNotes = (slideIndex: number, notes: string) => {
    setSlides((prev) => prev.map((s, i) => (i === slideIndex ? { ...s, notes } : s)));
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.officeSave(entryId, { kind: 'pptx', slides });
      setBase(JSON.stringify(slides));
      message.success(`已保存（${Math.max(1, Math.round(res.size / 1024))} KB）`);
      onSaved();
    } catch (e) {
      message.error(`保存失败：${errText(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    if (!dirty) return;
    modal.confirm({
      title: '还原所有未保存修改？',
      okText: '还原',
      cancelText: '取消',
      onOk: () => {
        setSlides(initial);
        setBase(JSON.stringify(initial));
      },
    });
  };

  if (!slide) {
    return <Empty description="该演示文稿没有可编辑的幻灯片" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
      <OfficeToolbar
        label="PPTX 编辑"
        hint={
          data.normalized
            ? '旧版 .ppt：保存时会自动转回原格式'
            : '编辑文本框与备注；图片、图表和 SmartArt 保持原样'
        }
        dirty={dirty}
        saving={saving}
        onReset={reset}
        onSave={save}
        extra={
          <Button size="small" icon={<PlayCircleOutlined />} onClick={() => setPresenting(true)}>
            放映
          </Button>
        }
      />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '190px minmax(0, 1fr)',
          gap: 12,
          minHeight: 0,
          maxHeight: 'min(72vh, 800px)',
        }}
      >
        <Card size="small" styles={{ body: { padding: 6, maxHeight: 'min(72vh, 800px)', overflowY: 'auto' } }}>
          <Flex vertical gap={4}>
            {slides.map((s, i) => (
              <button
                key={s.index}
                type="button"
                onClick={() => setActive(i)}
                style={{
                  textAlign: 'left',
                  border: `1px solid ${i === active ? 'var(--ant-color-primary)' : 'var(--ant-color-border-secondary)'}`,
                  background: i === active ? 'var(--ant-color-primary-bg)' : 'var(--ant-color-bg-container)',
                  borderRadius: 8,
                  padding: '8px 10px',
                  cursor: 'pointer',
                  color: 'var(--ant-color-text)',
                }}
              >
                <Flex align="center" gap={8}>
                  <Tag variant="filled" style={{ marginInlineEnd: 0 }}>
                    {i + 1}
                  </Tag>
                  <Typography.Text ellipsis style={{ fontSize: 12, flex: 1 }}>
                    {slideLabel(s, i)}
                  </Typography.Text>
                </Flex>
              </button>
            ))}
          </Flex>
        </Card>

        <div style={{ overflowY: 'auto', minWidth: 0 }}>
          <Card
            size="small"
            title={
              <Space size={8}>
                <span>第 {active + 1} 页</span>
                <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                  {slide.shapes.length} 个文本框
                </Typography.Text>
              </Space>
            }
            styles={{ body: { display: 'flex', flexDirection: 'column', gap: 12 } }}
          >
            {slide.shapes.length === 0 ? (
              <Empty description="该页没有文本框" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              slide.shapes.map((shape) => (
                <div key={shape.id}>
                  <Flex align="center" gap={8} style={{ marginBottom: 4 }}>
                    <Tag color={shape.title ? 'blue' : 'default'} variant="filled">
                      {shape.title ? '标题' : shape.name || `形状 ${shape.id}`}
                    </Tag>
                  </Flex>
                  <Input.TextArea
                    value={shape.text}
                    autoSize={{ minRows: 2, maxRows: 8 }}
                    onChange={(e) => updateShape(active, shape.id, e.target.value)}
                    style={{ fontSize: 14, lineHeight: 1.7 }}
                  />
                </div>
              ))
            )}
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                演讲者备注
              </Typography.Text>
              <Input.TextArea
                value={slide.notes}
                autoSize={{ minRows: 2, maxRows: 6 }}
                placeholder="输入演讲者备注（放映时不显示）"
                onChange={(e) => updateNotes(active, e.target.value)}
                style={{ marginTop: 4 }}
              />
            </div>
          </Card>
        </div>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        共 {slides.length} 页；保存后可用顶部「放映」查看真实版式（服务端转 PDF）。
      </Typography.Text>

      <PptPresentation
        entryId={entryId}
        name={data.name}
        open={presenting}
        slides={slides}
        onClose={() => setPresenting(false)}
      />
    </div>
  );
}
