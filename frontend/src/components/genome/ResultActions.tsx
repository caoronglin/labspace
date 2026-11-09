import { useState } from 'react';
import { App, Button, Space } from 'antd';
import { BookOutlined, ExportOutlined, RobotOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import SaveKnowledgeModal from '../SaveKnowledgeModal';
import { handoffToAgent } from '../../utils/agentHandoff';

/**
 * 结果区的统一「出口」。
 *
 * 服务本身只算半个功能：结果要能存进知识库、交给 Agent 继续分析、或在基因组浏览器
 * 里定位到具体区间，几个服务才算连成一条链路。各页面把结果文本丢给这个组件即可，
 * 不必各自重复实现弹窗与跳转。
 */

interface Props {
  /** 知识条目标题，同时作为交给 Agent 的问题抬头 */
  title: string;
  /** 结果正文（纯文本或 Markdown） */
  body: string;
  /** JBrowse 区间，形如 seqid:start-end（1-based 闭区间） */
  loc?: string;
  /** 由父页面切到浏览器视图并定位；不传则只给新窗口链接 */
  onLocate?: (loc: string) => void;
  category?: string;
  tags?: string[];
  size?: 'small' | 'middle';
}

const AGENT_LIMIT = 4000;

export default function ResultActions({ title, body, loc, onLocate, category, tags, size = 'small' }: Props) {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [kbOpen, setKbOpen] = useState(false);
  const disabled = !body.trim();

  return (
    <>
      <Space size={6} wrap>
        <Button size={size} icon={<BookOutlined />} disabled={disabled} onClick={() => setKbOpen(true)}>
          存入知识库
        </Button>
        <Button
          size={size}
          icon={<RobotOutlined />}
          disabled={disabled}
          onClick={() =>
            navigate(
              handoffToAgent(
                `请基于「${title}」的结果继续分析，先指出关键结论与可疑之处，再给出下一步验证方案。\n\n${
                  body.length > AGENT_LIMIT ? `${body.slice(0, AGENT_LIMIT)}\n……（已截断）` : body
                }`,
              ),
            )
          }
        >
          交给 Agent
        </Button>
        {loc && onLocate ? (
          <Button size={size} icon={<ExportOutlined />} onClick={() => onLocate(loc)}>
            在 JBrowse 查看
          </Button>
        ) : null}
        {loc && !onLocate ? (
          <Button
            size={size}
            icon={<ExportOutlined />}
            href={`/jbrowse/index.html?loc=${encodeURIComponent(loc)}`}
            target="_blank"
            rel="noreferrer"
          >
            在 JBrowse 查看
          </Button>
        ) : null}
      </Space>
      <SaveKnowledgeModal
        open={kbOpen}
        title={title}
        body={body}
        category={category}
        tags={tags}
        onClose={() => setKbOpen(false)}
        onSaved={() => message.success('已存入知识库')}
      />
    </>
  );
}
