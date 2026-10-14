// src/components/PremiumGate.tsx
// The lock in front of a premium feature: the feature itself while AuthContext reports a premium access token, else
// the lock screen. The lock is a component of its own, mounted only while locked: a valid token unmounts it with its
// form (setToken's auth-changed lifts the gate through AuthContext), and a re-lock, the token removed or rejected,
// starts from an empty input with the request form closed.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.js';
import RequestAccessForm from './RequestAccessForm.jsx';
import TokenActivationForm from './TokenActivationForm.js';

interface PremiumGateProps {
  /** The lock screen's heading; 'Premium Feature' without one. */
  featureName?: string;
  /** The feature, rendered as it is while the token is premium. */
  children: ReactNode;
}

function PremiumLock({ featureName }: { featureName?: string }) {
  const [showRequest, setShowRequest] = useState(false);

  return (
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 fade-in">
      <div className="flex flex-col items-center gap-4 py-6">
        <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-[var(--color-accent)]/10 border border-[var(--color-accent)]/20">
          <Lock size={20} className="text-[var(--color-accent)]" />
        </div>

        <div className="text-center">
          <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
            {featureName || 'Premium Feature'}
          </h3>
          <p className="text-xs text-[var(--color-text-muted)] mt-1 leading-relaxed">
            Enter your access token to unlock
          </p>
        </div>

        <div className="w-full max-w-sm">
          <TokenActivationForm placeholder="Paste token..." />
        </div>

        <div className="w-full max-w-sm">
          {showRequest ? (
            <div className="space-y-2 pt-1">
              <div className="flex items-center gap-2">
                <hr className="flex-1 border-[var(--color-border-subtle)]" />
                <span className="text-[10px] text-[var(--color-text-muted)]">or</span>
                <hr className="flex-1 border-[var(--color-border-subtle)]" />
              </div>
              <RequestAccessForm compact />
            </div>
          ) : (
            <button
              onClick={() => setShowRequest(true)}
              className="w-full text-center text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors pt-1"
            >
              Don't have a token? <span className="underline">Request access</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PremiumGate({ featureName, children }: PremiumGateProps) {
  const { isPremium } = useAuth();
  if (isPremium) return children;
  return <PremiumLock featureName={featureName} />;
}
