// src/components/TokenActivationForm.tsx
// The access-token form the Account tab and the premium locks share: the label, the input, the Activate button (a
// spinner while the server checks, a shield once the token is stored) and the error line, with an optional hint under
// them. It owns its input and its useTokenActivation, and each parent mounts it only while locked, so the activation
// unmounts it and a re-lock starts from an empty input with no stale status. The heading above it and the form's width
// are the parent's, and so is the label's text where "Access token" is not the word (the Account tab's "Activate Token").
// The label, the error and the hint are tied to the input by ids from useId: up to three of these forms show at once
// (two premium gates and the chat's lock). The error is an alert that describes the input and marks it invalid until
// the next edit clears it; the hint describes the input too.

import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { CircleAlert, KeyRound, LoaderCircle, ShieldCheck } from 'lucide-react';
import { useTokenActivation } from '../hooks/useTokenActivation.js';

interface TokenActivationFormProps {
  /** The input's visible label: 'Activate Token' on the Account tab, 'Access token' (the default) on the locks. */
  label?: string;
  /** 'Paste access token...' in Settings and the chat, 'Paste token...' on the feature gates. */
  placeholder: string;
  /** The muted line under the input and the error, in the form's own paragraph: text or inline nodes, no controls. */
  hint?: ReactNode;
}

export default function TokenActivationForm({ label = 'Access token', placeholder, hint }: TokenActivationFormProps) {
  const [tokenInput, setTokenInput] = useState('');
  const { status, error, activate, reset } = useTokenActivation();
  const id = useId();
  const inputId = `${id}-token`;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : '', hint ? hintId : ''].filter(Boolean).join(' ');

  return (
    <form onSubmit={(e) => { e.preventDefault(); void activate(tokenInput); }} className="space-y-2">
      <div>
        <label htmlFor={inputId} className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
          {label}
        </label>
        <div className="flex gap-2">
          {/* The box's height comes from the input's own padding, so the whole height of the box takes a click. */}
          <div className="flex-1 flex items-center gap-2 px-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] focus-within:border-[var(--color-accent)] transition-colors">
            <KeyRound size={12} className="text-[var(--color-text-muted)] shrink-0" />
            <input
              id={inputId}
              type="text"
              value={tokenInput}
              onChange={(e) => { setTokenInput(e.target.value); reset(); }}
              placeholder={placeholder}
              spellCheck={false}
              aria-describedby={describedBy || undefined}
              aria-invalid={error ? true : undefined}
              className="flex-1 py-2 bg-transparent text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none font-mono"
            />
          </div>
          <button
            type="submit"
            disabled={!tokenInput.trim() || status === 'validating'}
            className="px-3.5 py-2 rounded-lg text-xs font-medium text-white bg-[var(--color-accent-solid)] hover:bg-[var(--color-accent-solid-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          >
            {/* The icons are hidden from the tree, so each stands with a name. */}
            {status === 'validating' ? (
              <>
                <LoaderCircle size={14} className="animate-spin" />
                <span className="sr-only">Activating</span>
              </>
            ) : status === 'success' ? (
              <>
                <ShieldCheck size={14} />
                <span className="sr-only">Activated</span>
              </>
            ) : (
              'Activate'
            )}
          </button>
        </div>
      </div>
      {error && (
        <div id={errorId} role="alert" className="flex items-center gap-1.5 text-[11px] text-[var(--color-bear)]">
          <CircleAlert size={10} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {hint && (
        <p id={hintId} className="text-[10px] text-[var(--color-text-muted)] leading-relaxed">
          {hint}
        </p>
      )}
    </form>
  );
}
