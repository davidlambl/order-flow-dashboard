// src/components/chat/ChatEmptyState.tsx
// What an empty chat shows: the prompt naming its ticker, four starter questions that send as if typed, and where the
// history is kept. SUGGESTIONS stays module-local: an array exported beside a component fails
// react-refresh/only-export-components.
import { MessageSquare } from 'lucide-react';

const SUGGESTIONS = [
  'What does the GEX profile suggest?',
  'Is the flow bullish or bearish?',
  'Where are key support/resistance levels?',
  'Summarize the dark pool activity.',
];

interface ChatEmptyStateProps {
  /** The ticker of the market data the chat belongs to; 'the' stands in until the first data lands. */
  ticker: string | undefined;
  /** Sends the suggestion as the question. */
  onSuggest: (text: string) => void;
}

export default function ChatEmptyState({ ticker, onSuggest }: ChatEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-2">
      <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--color-purple-bg)]">
        <MessageSquare size={18} className="text-[var(--color-purple)]" />
      </div>
      <p className="text-xs text-[var(--color-text-muted)] max-w-[200px]">
        Ask questions about {ticker || 'the'} order flow, gamma, or positioning.
      </p>
      <div className="flex flex-col gap-1.5 w-full mt-1">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => onSuggest(s)}
            className="text-left text-xs text-[var(--color-text-secondary)] px-3 py-2 rounded-lg border border-[var(--color-border-subtle)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border)] transition-colors"
          >
            {s}
          </button>
        ))}
      </div>
      <p className="text-[10px] text-[var(--color-text-muted)]/60 mt-2">
        Chat history is saved locally and persists until cleared.
      </p>
    </div>
  );
}
