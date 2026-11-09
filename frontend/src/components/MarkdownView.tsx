import XMarkdown from '@ant-design/x-markdown';

/**
 * 统一 Markdown 渲染：基于 Ant Design X 的 XMarkdown（marked + DOMPurify）。
 * 命令说明、课题/任务描述、交付反馈等都走这里，排版由 .d509-prose 统一控制。
 *
 * 安全约束：内容可能来自导师/管理员等用户输入，开启 escapeRawHtml，
 * 原始 HTML 一律按纯文本展示；链接统一新窗口打开并带 rel 保护。
 */
export default function MarkdownView({ source }: { source?: string | null }) {
  if (!source || !source.trim()) return null;

  return (
    <div className="d509-prose d509-md">
      <XMarkdown
        content={source}
        escapeRawHtml
        openLinksInNewTab
        disableDefaultStyles
      />
    </div>
  );
}