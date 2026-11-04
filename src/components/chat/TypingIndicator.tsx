// src/components/chat/TypingIndicator.tsx
// Three pulsing dots beside the assistant's avatar: the reply's place while it is in flight and no text of it has
// arrived yet.

import { Bot } from 'lucide-react';

export default function TypingIndicator() {
  return (
    <div className="flex gap-2.5 fade-in">
      <div className="flex items-center justify-center w-6 h-6 rounded-lg shrink-0 bg-[var(--color-purple-bg)] text-[var(--color-purple)]">
        <Bot size={12} />
      </div>
      <div className="bg-[var(--color-surface-3)] border border-[var(--color-border-subtle)] rounded-xl px-3 py-2">
        <div className="flex gap-1 items-center h-5">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] pulse-glow" style={{ animationDelay: '0ms' }} />
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] pulse-glow" style={{ animationDelay: '200ms' }} />
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] pulse-glow" style={{ animationDelay: '400ms' }} />
        </div>
      </div>
    </div>
  );
}
