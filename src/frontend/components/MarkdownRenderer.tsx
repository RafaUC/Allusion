import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  zoom?: number;
}

export const MarkdownRenderer = ({ content, className = '', zoom = 1 }: MarkdownRendererProps) => {
  return (
    <div
      className={`markdown-container ${className}`}
      style={{ '--md-zoom-factor': zoom } as React.CSSProperties}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
};
