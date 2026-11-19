/**
 * 文本文件在线编辑。
 *
 * 打开时拉一次正文（带 etag），保存时把 etag 一起回传：
 * 别人在这期间改过同一个文件，服务端会返回 409，这里提示"内容已被他人修改"，
 * 让用户自己选"重新加载"还是"覆盖保存"，不做静默覆盖。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Flex, Input, Modal, Space, Spin, Switch, Typography } from 'antd';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { api, FileContentConflictError, type FileEntry } from '../../services/api';
import { errText } from '../../utils/err';

export interface TextEditorModalProps {
  open: boolean;
  /** 被编辑的文件；为 null 时不渲染内容。 */
  entry: FileEntry | null;
  onClose: () => void;
  /** 保存成功后回调（供调用方刷新列表）。 */
  onSaved?: (entry: FileEntry) => void;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

const LINE_HEIGHT = 20;
const FONT_SIZE = 13;

export default function TextEditorModal({ open, entry, onClose, onSaved }: TextEditorModalProps) {
  const { message } = App.useApp();
  const [state, setState] = useState<LoadState>('idle');
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [etag, setEtag] = useState('');
  const [saving, setSaving] = useState(false);
  /** 冲突信息：覆盖保存时该带的 etag（409 会带上服务端当前版本）。
   *  服务端没带版本号时传空串，表示无条件覆盖。 */
  const [conflict, setConflict] = useState<{ etagToSend: string } | null>(null);
  const [showLineNumbers, setShowLineNumbers] = useState(true);
  const gutterRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!entry) return;
    setState('loading');
    setError('');
    setConflict(null);
    try {
      const res = await api.fileContent(entry.id);
      setText(res.text);
      setEtag(res.etag);
      setState('ready');
    } catch (e) {
      setError(errText(e));
      setState('error');
    }
  }, [entry]);

  useEffect(() => {
    if (!open) {
      setState('idle');
      setText('');
      setEtag('');
      setError('');
      setConflict(null);
      return;
    }
    void load();
  }, [open, load]);

  const save = async (overrideEtag?: string) => {
    if (!entry) return;
    setSaving(true);
    try {
      await api.fileSaveContent(
        entry.id,
        text,
        overrideEtag !== undefined ? overrideEtag : etag,
      );
      setConflict(null);
      message.success('已保存');
      onSaved?.(entry);
      onClose();
    } catch (e) {
      if (e instanceof FileContentConflictError) {
        // 冲突时不覆盖用户的输入：让用户决定重新加载还是用当前内容强制覆盖。
        setConflict({ etagToSend: e.etag ?? '' });
        message.warning('内容已被他人修改，请选择重新加载或覆盖保存');
      } else {
        message.error(`保存失败：${errText(e)}`);
      }
    } finally {
      setSaving(false);
    }
  };

  const lineCount = text.split('\n').length;

  return (
    <Modal
      open={open}
      title={entry ? `在线编辑：${entry.name}` : '在线编辑'}
      width={880}
      onCancel={onClose}
      destroyOnHidden
      footer={
        <Space wrap>
          <Button onClick={onClose}>关闭</Button>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => void load()}
            loading={state === 'loading'}
            disabled={!entry}
          >
            重新加载
          </Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={saving}
            disabled={state !== 'ready'}
            onClick={() => void save()}
          >
            保存
          </Button>
        </Space>
      }
    >
      {state === 'loading' ? (
        <Flex justify="center" style={{ padding: 40 }}>
          <Spin />
        </Flex>
      ) : state === 'error' ? (
        <Alert type="error" showIcon title="无法读取文件内容" description={error} />
      ) : state === 'ready' ? (
        <Flex vertical gap={10}>
          {conflict !== null ? (
            <Alert
              type="warning"
              showIcon
              title="内容已被他人修改"
              description="你打开后该文件被其他人改过。重新加载会丢弃当前输入；覆盖保存会用你的内容替换服务器上的版本。"
              action={
                <Space wrap>
                  <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>
                    重新加载
                  </Button>
                  <Button
                    size="small"
                    type="primary"
                    danger
                    icon={<SaveOutlined />}
                    loading={saving}
                    onClick={() => void save(conflict.etagToSend)}
                  >
                    覆盖保存
                  </Button>
                </Space>
              }
            />
          ) : null}
          <Flex align="center" justify="space-between" gap={12} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {lineCount} 行 · 版本 {etag ? etag.slice(0, 12) : '—'}
            </Typography.Text>
            <Flex align="center" gap={8}>
              <Typography.Text style={{ fontSize: 12 }}>显示行号</Typography.Text>
              <Switch
                size="small"
                checked={showLineNumbers}
                onChange={setShowLineNumbers}
                aria-label="显示行号"
              />
            </Flex>
          </Flex>
          <Flex align="stretch" gap={8} style={{ border: '1px solid var(--ant-color-border-secondary)', borderRadius: 6, padding: 8 }}>
            {showLineNumbers ? (
              <div
                ref={gutterRef}
                aria-hidden="true"
                style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: FONT_SIZE,
                  lineHeight: `${LINE_HEIGHT}px`,
                  color: 'var(--ant-color-text-quaternary)',
                  textAlign: 'right',
                  paddingRight: 8,
                  overflow: 'hidden',
                  userSelect: 'none',
                  minWidth: 32,
                }}
              >
                {Array.from({ length: lineCount }, (_, i) => (
                  <div key={i}>{i + 1}</div>
                ))}
              </div>
            ) : null}
            <Input.TextArea
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="文件内容"
              autoSize={{ minRows: 20, maxRows: 30 }}
              spellCheck={false}
              wrap="off"
              styles={{
                textarea: {
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: FONT_SIZE,
                  lineHeight: `${LINE_HEIGHT}px`,
                  whiteSpace: 'pre',
                  overflowWrap: 'normal',
                  resize: 'none',
                },
              }}
              onScroll={(e) => {
                // 行号栏与正文同步滚动，避免长文件时行号对不上。
                if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
              }}
            />
          </Flex>
        </Flex>
      ) : null}
    </Modal>
  );
}
