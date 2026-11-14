// src/components/chat/TypingIndicator.tsx
// Three pulsing dots beside the assistant's avatar: the reply's place while it is in flight and no text of it has
// arrived yet. For a screen reader reading the chat, its one line, visually hidden, says the assistant is typing. It is
// not a live region: the shell's status line, in the tree from the chat's first render, announces that a reply has
// started and how it ended (a status that mounts together with its text is not read by every screen reader). The
// avatar and the dots are decoration.

import { Bot } from 'lucide-react';

export default function TypingIndicator() {
  return (
    <div className="flex gap-2.5 fade-in">
      <div
        aria-hidden="true"
        className="flex items-center justify-center w-6 h-6 rounded-lg shrink-0 bg-[var(--color-purple-bg)] text-[var(--color-purple)]"
      >
        <Bot size={12} />
      </div>
      <div className="bg-[var(--color-surface-3)] border border-[var(--color-border-subtle)] rounded-xl px-3 py-2">
        <span className="sr-only">The assistant is typing</span>
        <div aria-hidden="true" className="flex gap-1 items-center h-5">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] pulse-glow" style={{ animationDelay: '0ms' }} />
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] pulse-glow" style={{ animationDelay: '200ms' }} />
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] pulse-glow" style={{ animationDelay: '400ms' }} />
        </div>
      </div>
    </div>
  );
}
