// src/components/chat/ChatMarkdown.tsx
// An assistant's reply rendered as markdown, GitHub's flavour (remark-gfm, for the tables the model answers with), each
// element styled to the chat bubble's type scale. A question or an error line stays plain text (ChatMessage).

import { Children, cloneElement, isValidElement } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components, ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** The code element's props and `block`, the flag `pre` sets on a fenced block's <code>. */
type CodeProps = ComponentPropsWithoutRef<'code'> & ExtraProps & { block?: boolean };

const remarkPlugins = [remarkGfm];

const markdownComponents: Components = {
  strong: ({ children }) => (
    <strong className="text-[var(--color-accent)] font-semibold">{children}</strong>
  ),
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] underline underline-offset-2">{children}</a>
  ),
  // A fenced block is <pre><code>: flag the code element so it renders as a block, not an inline pill.
  pre: ({ children }) => (
    <pre className="bg-[var(--color-surface-2)] rounded-lg p-2 mb-2 overflow-x-auto text-[11px] leading-relaxed">
      {Children.map(children, (c) => (isValidElement<CodeProps>(c) ? cloneElement(c, { block: true }) : c))}
    </pre>
  ),
  code: ({ children, block }: CodeProps) => (block
    ? <code className="font-mono whitespace-pre">{children}</code>
    : <code className="bg-[var(--color-surface-2)] px-1 py-0.5 rounded text-[12px] font-mono">{children}</code>),
  h3: ({ children }) => (
    <h3 className="text-xs font-semibold text-[var(--color-text-primary)] mt-3 mb-1">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-xs font-medium text-[var(--color-text-secondary)] mt-2 mb-1">{children}</h4>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto mb-2 -mx-1">
      <table className="min-w-full text-[11px] border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="border-b border-[var(--color-border-subtle)]">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="px-2 py-1 text-left font-semibold text-[var(--color-text-secondary)] whitespace-nowrap">{children}</th>
  ),
  td: ({ children }) => (
    <td className="px-2 py-1 text-[var(--color-text-primary)] whitespace-nowrap">{children}</td>
  ),
  tr: ({ children }) => (
    <tr className="border-b border-[var(--color-border-subtle)]/50 last:border-0">{children}</tr>
  ),
};

interface ChatMarkdownProps {
  /** The reply's markdown source, as stored and as Copy puts it on the clipboard. */
  content: string;
}

export default function ChatMarkdown({ content }: ChatMarkdownProps) {
  return <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>{content}</ReactMarkdown>;
}
