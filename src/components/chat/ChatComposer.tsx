// src/components/chat/ChatComposer.tsx
// The chat's input row: the textarea that grows with its text (Enter sends, Shift+Enter breaks the line), the button
// that asks for strategic-context updates once the chat holds a reply, and Send, which Stop replaces while a reply
// streams. The textarea's ref is the shell's, passed as a React 19 prop: the shell focuses the input when the chat
// opens (not when the lock lifts) and resets its height after an accepted send, the empty state's suggestions
// included. The children keep their order (the textarea, the suggest button, then Send or Stop), so React turns Send's
// node into Stop: the second click of a double-click on Send lands on Stop, whose guard ignores it.
import type { Ref } from 'react';
import { ListChecks, Send, Square } from 'lucide-react';

interface ChatComposerProps {
  ref?: Ref<HTMLTextAreaElement>;
  value: string;
  onChange: (value: string) => void;
  /** The text as typed: the shell trims it and ignores a blank one. */
  onSend: (text: string) => void;
  /** A reply is streaming: the textarea is disabled and Stop stands in for Send. */
  sending: boolean;
  onStop: () => void;
  /** The chat holds a reply: the suggest button shows, except while sending. */
  canSuggest: boolean;
  onSuggest: () => void;
}

/** Fit the textarea to its text, up to 120 px. */
function autoResize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
}

export default function ChatComposer({ ref, value, onChange, onSend, sending, onStop, canSuggest, onSuggest }: ChatComposerProps) {
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSend(value); }}
      className="flex items-end gap-2 px-3 py-2.5 border-t border-[var(--color-border-subtle)]"
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => { onChange(e.target.value); autoResize(e.target); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSend(value);
          }
        }}
        placeholder="Ask about the flow..."
        rows={1}
        className="flex-1 bg-[var(--color-surface-2)] text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] rounded-lg px-3 py-2 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors resize-none leading-relaxed"
        disabled={sending}
      />
      {canSuggest && !sending && (
        <button
          type="button"
          onClick={onSuggest}
          className="p-2 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors shrink-0"
          aria-label="Suggest updates to Strategic Context"
          title="Suggest updates to Strategic Context"
        >
          <ListChecks size={16} />
        </button>
      )}
      {sending ? (
        <button
          type="button"
          onClick={(e) => {
            // The second click of a double-click on Send lands here; only a fresh click stops the reply.
            if (e.detail > 1) return;
            onStop();
          }}
          className="p-2 rounded-lg bg-[var(--color-bear-bg)] text-[var(--color-bear)] hover:bg-[var(--color-bear)]/20 transition-colors shrink-0"
          aria-label="Stop generating"
          title="Stop generating"
        >
          <Square size={16} />
        </button>
      ) : (
        <button
          type="submit"
          disabled={!value.trim()}
          className="p-2 rounded-lg bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
          aria-label="Send message"
        >
          <Send size={16} />
        </button>
      )}
    </form>
  );
}
