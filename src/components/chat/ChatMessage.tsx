// src/components/chat/ChatMessage.tsx
// One bubble of the conversation: the role's avatar, the text (plain for a question or an error line, markdown for a
// reply) and, on hover, Copy (the raw markdown; 'Copied!' for 1.5 s) and Delete. Memoised on its props, so a render of
// the shell (a keystroke in the composer, a streaming frame) re-renders only the bubbles whose message changed: a frame
// gives a new object only to the reply it extends, and ReactMarkdown runs once per frame instead of once per message.
// That holds while onDelete keeps one identity, which is why the bubble takes its index and hands it back rather than
// a callback made for each message.
//
// The markdown renderer (ChatMarkdown, with react-markdown and remark-gfm) is loaded on demand: by the first reply on
// screen, or before it in the idle preload. Once it is in, a bubble renders it directly, with nothing suspending in
// between, so ReactMarkdown still runs once per frame, for the reply the frame extends. Until then a reply shows its
// raw text in the block a question renders in, rebuilt from each frame's content, so a reply that streams while the
// renderer loads stays readable and keeps growing; if the renderer cannot load, the raw text stays, with no failure
// card inside a bubble. A bubble that fell back asks for nothing more, and switches to markdown in place once a later
// import (the next reply's, say) brings the renderer in.

import { memo, useEffect, useRef, useState } from 'react';
import { Bot, Check, CircleAlert, Copy, Trash, User } from 'lucide-react';
import type { ChatMessage } from '../../lib/store.js';
import { lazyWithPreload } from '../../lib/lazyWithPreload.js';
import ChunkBoundary from '../ChunkBoundary.js';

/** The bubbles showing raw text after the renderer failed to load, each told when an import brings it in. */
const awaitingRenderer = new Set<() => void>();

const ChatMarkdown = lazyWithPreload(async () => {
  const module = await import('./ChatMarkdown.js');
  for (const arrived of awaitingRenderer) arrived();
  return module;
}, { idle: true });

interface ChatMessageProps {
  msg: ChatMessage;
  /** The message's place in the history, handed back to onDelete. */
  index: number;
  /** Deletes the message at `index`: the history's deleteMessage itself, never a function made per render. */
  onDelete: (index: number) => void;
}

/** A message's text as written: a question, an error line, or a reply without its renderer. */
function RawText({ content }: { content: string }) {
  return <div className="whitespace-pre-wrap">{content}</div>;
}

/**
 * A reply's raw text where the renderer failed to load. When an import brings the renderer in, retry() mounts the
 * markdown in its place, inside the same bubble; preload() first, so that mount finds the renderer loaded.
 */
function RawTextUntilRenderer({ content, retry }: { content: string; retry: () => void }) {
  useEffect(() => {
    let mounted = true;
    const arrived = () => {
      void ChatMarkdown.preload().then(() => {
        if (mounted) retry();
      });
    };
    awaitingRenderer.add(arrived);
    return () => {
      mounted = false;
      awaitingRenderer.delete(arrived);
    };
  }, [retry]);
  return <RawText content={content} />;
}

function ChatMessage({ msg, index, onDelete }: ChatMessageProps) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const isUser = msg.role === 'user';
  const isError = msg.role === 'error';

  const handleCopy = () => {
    navigator.clipboard.writeText(msg.content).catch(() => {});
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`group/msg flex gap-2.5 ${isUser ? 'flex-row-reverse' : ''} fade-in`}>
      <div
        className={`flex items-center justify-center w-6 h-6 rounded-lg shrink-0 mt-0.5 ${
          isUser
            ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
            : isError
            ? 'bg-[var(--color-bear-bg)] text-[var(--color-bear)]'
            : 'bg-[var(--color-purple-bg)] text-[var(--color-purple)]'
        }`}
      >
        {isUser ? <User size={12} /> : isError ? <CircleAlert size={12} /> : <Bot size={12} />}
      </div>
      <div className="flex flex-col max-w-[85%]">
        <div
          className={`text-[13px] leading-relaxed rounded-xl px-3 py-2 ${
            isUser
              ? 'bg-[var(--color-accent)]/10 text-[var(--color-text-primary)] border border-[var(--color-accent)]/20'
              : isError
              ? 'bg-[var(--color-bear-bg)] text-[var(--color-bear)] border border-[var(--color-bear)]/20'
              : 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)] border border-[var(--color-border-subtle)]'
          }`}
        >
          {isUser || isError ? (
            <RawText content={msg.content} />
          ) : (
            <ChunkBoundary
              fallback={<RawText content={msg.content} />}
              failed={({ retry }) => <RawTextUntilRenderer content={msg.content} retry={retry} />}
            >
              <ChatMarkdown content={msg.content} />
            </ChunkBoundary>
          )}
        </div>
        <div className={`flex gap-0.5 mt-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity ${isUser ? 'justify-end' : ''}`}>
          <button
            onClick={handleCopy}
            className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
            aria-label="Copy message"
            title={copied ? 'Copied!' : 'Copy markdown'}
          >
            {copied ? <Check size={11} className="text-[var(--color-bull)]" /> : <Copy size={11} />}
          </button>
          <button
            onClick={() => onDelete(index)}
            className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-bear)] transition-colors"
            aria-label="Delete message"
            title="Delete message"
          >
            <Trash size={11} />
          </button>
        </div>
      </div>
    </div>
  );
}

export default memo(ChatMessage);
