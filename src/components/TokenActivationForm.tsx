// src/components/TokenActivationForm.tsx
// The access-token form the Account tab and the premium locks share: the input, the Activate button (a spinner while
// the server checks, a shield once the token is stored) and the error line, with an optional hint under them. It
// owns its input and its useTokenActivation, and each parent mounts it only while locked, so the activation unmounts
// it and a re-lock starts from an empty input with no stale status. The heading or label above it, and its width, are
// the parent's.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { CircleAlert, KeyRound, LoaderCircle, ShieldCheck } from 'lucide-react';
import { useTokenActivation } from '../hooks/useTokenActivation.js';

interface TokenActivationFormProps {
  /** 'Paste access token...' in Settings and the chat, 'Paste token...' on the feature gates. */
  placeholder: string;
  /** The muted line under the input and the error, in the form's own paragraph: text or inline nodes, no controls. */
  hint?: ReactNode;
}

export default function TokenActivationForm({ placeholder, hint }: TokenActivationFormProps) {
  const [tokenInput, setTokenInput] = useState('');
  const { status, error, activate, reset } = useTokenActivation();

  return (
    <form onSubmit={(e) => { e.preventDefault(); void activate(tokenInput); }} className="space-y-2">
      <div className="flex gap-2">
        <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] focus-within:border-[var(--color-accent)] transition-colors">
          <KeyRound size={12} className="text-[var(--color-text-muted)] shrink-0" />
          <input
            type="text"
            value={tokenInput}
            onChange={(e) => { setTokenInput(e.target.value); reset(); }}
            placeholder={placeholder}
            spellCheck={false}
            className="flex-1 bg-transparent text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none font-mono"
          />
        </div>
        <button
          type="submit"
          disabled={!tokenInput.trim() || status === 'validating'}
          className="px-3.5 py-2 rounded-lg text-xs font-medium text-white bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        >
          {status === 'validating' ? (
            <LoaderCircle size={14} className="animate-spin" />
          ) : status === 'success' ? (
            <ShieldCheck size={14} />
          ) : (
            'Activate'
          )}
        </button>
      </div>
      {error && (
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-bear)]">
          <CircleAlert size={10} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {hint && (
        <p className="text-[10px] text-[var(--color-text-muted)] leading-relaxed">
          {hint}
        </p>
      )}
    </form>
  );
}
