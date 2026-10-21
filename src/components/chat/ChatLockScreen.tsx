// src/components/chat/ChatLockScreen.tsx
// The chat panel while no premium access token is stored: the panel's header with its close button, what the Co-Pilot
// does, and the access-token form the Account tab and the feature gates share. A valid token lifts the lock through
// AuthContext (setToken's auth-changed) with no callback here. The shell renders this screen only while the chat is
// open and locked, so a close or an unlock unmounts it with its form, and a reopen or a re-lock starts from an empty
// input. The wrapper gives the form the lock's width, which the form leaves to its parent: in this centred column it
// would otherwise shrink to its content.

import { Lock, Sparkles, X } from 'lucide-react';
import TokenActivationForm from '../TokenActivationForm.js';

interface ChatLockScreenProps {
  /** Closes the chat panel, as the open chat's header does. */
  onClose: () => void;
}

export default function ChatLockScreen({ onClose }: ChatLockScreenProps) {
  return (
    <div className="flex flex-col h-full border-l border-[var(--color-border-subtle)] bg-[var(--color-surface)] w-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border-subtle)]">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-6 h-6 rounded-lg bg-[var(--color-purple-bg)]">
            <Sparkles size={12} className="text-[var(--color-purple)]" />
          </div>
          <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">AI Co-Pilot</h3>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] transition-colors"
          aria-label="Close chat"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 gap-5">
        <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-[var(--color-accent)]/10 border border-[var(--color-accent)]/20">
          <Lock size={24} className="text-[var(--color-accent)]" />
        </div>

        <div className="text-center">
          <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
            Premium Feature
          </h3>
          <p className="text-xs text-[var(--color-text-muted)] mt-1.5 leading-relaxed max-w-[220px]">
            The AI Co-Pilot provides institutional-grade analysis of options flow and gamma exposure.
          </p>
        </div>

        <div className="w-full max-w-xs">
          <TokenActivationForm placeholder="Paste access token..." />
        </div>
      </div>
    </div>
  );
}
