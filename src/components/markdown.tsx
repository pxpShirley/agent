import { useMemo } from 'react';
import MarkdownIt from 'markdown-it';

/**
 * 对话输出渲染：用 markdown-it 把星澜的回复按 Markdown 渲染。
 * 安全：html:false → 原始 HTML 被转义，LLM 输出不会注入脚本。
 * 配置：linkify 自动识别链接，breaks 让单换行呈现为 <br>（更贴近聊天语感）。
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

export function renderMarkdown(src: string): string {
  if (!src) return '';
  return md.render(src);
}

/** 渲染一段 Markdown 文本为带 .rs-md 样式的 HTML 容器。 */
export function Markdown({ content, className }: { content: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(content), [content]);
  return (
    <div
      className={`rs-md ${className ?? ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
