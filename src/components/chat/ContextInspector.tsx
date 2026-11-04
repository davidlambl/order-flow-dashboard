// src/components/chat/ContextInspector.tsx
// The model context a send carries, shown in place of the messages with its length and a Copy button. A memo leaf
// whose text is built once per buildContext and minute: the shell memoises buildContext on what the context reads, so
// a composer keystroke or a streamed frame re-renders nothing here, a changed input (the strategic context included)
// rebuilds the text at once, and the TIMESTAMP line moves with useNow's minute instead of on every render; the
// clipboard gets the text shown. The Copied flash and its timer are the leaf's own: closing the inspector unmounts it,
// which resets the label and clears the timer.
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useNow } from '../../hooks/useNow.js';

interface ContextInspectorProps {
  /** The context as of `now` (epoch ms). Its identity is the cache key: the shell keeps it stable with useCallback. */
  buildContext: (now: number) => string;
}

function ContextInspector({ buildContext }: ContextInspectorProps) {
  const now = useNow(60_000);
  const text = useMemo(() => buildContext(now), [buildContext, now]);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  return (
    <div className="flex-1 overflow-y-auto border-b border-[var(--color-border-subtle)]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-2)]">
        <span className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
          Model Context ({text.length.toLocaleString()} chars)
        </span>
        <button
          onClick={() => {
            navigator.clipboard.writeText(text).catch(() => {});
            setCopied(true);
            clearTimeout(copyTimer.current);
            copyTimer.current = setTimeout(() => setCopied(false), 1500);
          }}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
        >
          {copied ? <><Check size={10} className="text-[var(--color-bull)]" /> Copied</> : <><Copy size={10} /> Copy</>}
        </button>
      </div>
      <pre className="p-3 text-[11px] leading-relaxed text-[var(--color-text-secondary)] font-mono whitespace-pre-wrap break-words">
        {text}
      </pre>
    </div>
  );
}

export default memo(ContextInspector);
