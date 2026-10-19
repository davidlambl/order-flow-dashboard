// src/components/settings/SecretInput.tsx
// An API key field of the settings tabs (the AI provider's key, the Tradier and Finnhub keys): the label with the
// autosave's Saved flash, the password input with its reveal toggle, and the hint under it. Whether the key shows is the
// field's own state, so a remount hides it again: the AI tab keys its field on the provider for that.
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Eye, EyeOff } from 'lucide-react';

interface SecretInputProps {
  /** The label above the input: '<service> API Key'. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** useAutoSave's `saved`: the Saved flash beside the label, for a moment after each write. */
  saved: boolean;
  /** A control in the input's row (the AI tab's Test button), which then shares the row with the input. */
  action?: ReactNode;
  /** Lines between the input and the hint (the AI tab's test result). */
  status?: ReactNode;
  /** The muted hint under the input. */
  children: ReactNode;
}

function SavedIndicator({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="text-[10px] text-[var(--color-bull)] fade-in flex items-center gap-1">
      <Check size={10} /> Saved
    </span>
  );
}

export default function SecretInput({ label, value, onChange, placeholder, saved, action, status, children }: SecretInputProps) {
  const [revealed, setRevealed] = useState(false);

  const field = (
    <>
      <input
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-[var(--color-surface-2)] text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] rounded-lg pl-3 pr-9 py-2 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors"
      />
      {value && (
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
          aria-label={revealed ? 'Hide key' : 'Reveal key'}
        >
          {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      )}
    </>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs font-medium text-[var(--color-text-secondary)]">
          {label}
        </label>
        <SavedIndicator show={saved} />
      </div>
      {action ? (
        <div className="flex gap-2">
          <div className="flex-1 relative">
            {field}
          </div>
          {action}
        </div>
      ) : (
        <div className="relative">
          {field}
        </div>
      )}
      {status}
      <p className="text-[10px] text-[var(--color-text-muted)] mt-1.5 leading-relaxed">
        {children}
      </p>
    </div>
  );
}
