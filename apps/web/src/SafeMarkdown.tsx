// Adapted from HKUDS/LightRAG@aaebfe1 lightrag_webui/src/components/customization/CustomizedMarkdown.tsx.
// Copyright (c) 2025 LightRAG Team. MIT: third_party/LightRAG/LICENSE.
import ReactMarkdown from 'react-markdown';

export function SafeMarkdown({ content }: { content: string }) {
  return <div className="markdown"><ReactMarkdown skipHtml components={{
    // Images remain plain descriptions, so model/document text cannot load remote resources.
    img: ({ alt }) => <span>{alt ? `[图片：${alt}]` : '[图片]'}</span>,
    a: ({ children, href }) => href && /^(https?:\/\/|#)/i.test(href)
      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
  }}>{content}</ReactMarkdown></div>;
}
