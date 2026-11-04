// src/components/chat/ChatHeader.tsx
// The chat's header: the title over the model and the ticker the chat belongs to, then the buttons for the context
// inspector, the strategic-context editor, Clear (only while there is a history to clear), Settings and Close. The
// label's parts stay direct text children of one <p>: App.test.jsx finds 'Default · AVGO context' by that element's
// own text, which a <span> around the model name or the ticker would split.
import { FileText, Pencil, Settings, Sparkles, Trash, X } from 'lucide-react';

interface ChatHeaderProps {
  /** The model's display name (the ai_model_name preference; 'Default' without one). */
  modelName: string;
  /** The ticker of the market data the chat belongs to; '—' until the first data lands. */
  ticker: string | undefined;
  /** The inspector shows in place of the messages: its button stays lit. */
  showContext: boolean;
  onToggleContext: () => void;
  onEditContext: () => void;
  hasMessages: boolean;
  onClearHistory: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
}

export default function ChatHeader({
  modelName, ticker, showContext, onToggleContext, onEditContext, hasMessages, onClearHistory, onOpenSettings, onClose,
}: ChatHeaderProps) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border-subtle)]">
      <div className="flex items-center gap-2">
        <div className="flex items-center justify-center w-6 h-6 rounded-lg bg-[var(--color-purple-bg)]">
          <Sparkles size={12} className="text-[var(--color-purple)]" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-text-primary)] leading-none">
            AI Co-Pilot
          </h3>
          <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
            {modelName} · {ticker || '—'} context
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={onToggleContext}
          className={`p-1.5 rounded-lg transition-colors ${
            showContext
              ? 'text-[var(--color-accent)] bg-[var(--color-accent)]/10'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)]'
          }`}
          aria-label="Inspect model context"
          title="View data sent to model"
        >
          <FileText size={14} />
        </button>
        <button
          onClick={onEditContext}
          className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] transition-colors"
          aria-label="Edit strategic context"
          title="Edit Strategic Context"
        >
          <Pencil size={14} />
        </button>
        {hasMessages && (
          <button
            onClick={onClearHistory}
            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-bear)] hover:bg-[var(--color-bear-bg)] transition-colors"
            aria-label="Clear chat history"
            title="Clear chat history"
          >
            <Trash size={14} />
          </button>
        )}
        <button
          onClick={onOpenSettings}
          className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] transition-colors"
          aria-label="Settings"
        >
          <Settings size={14} />
        </button>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] transition-colors"
          aria-label="Close chat"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
