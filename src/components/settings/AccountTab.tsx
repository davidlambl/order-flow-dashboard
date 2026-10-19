// src/components/settings/AccountTab.tsx
// The Account tab, from AuthContext: the cloud session (signed in, with the e-mail and Sign out; or signed out, with
// Sign in while cloud sign-in is configured), then the access token: its tier, days left and removal while one is
// stored, else the activation form and the offer to request access. The form is mounted only while no token is, so an
// activation unmounts it and a token removed later brings back an empty one. Sign out and Sign in flush nothing: no
// key edit can be pending while this tab shows (SettingsDialog says why).
import { useState } from 'react';
import { Check, ShieldCheck, Star } from 'lucide-react';
import { clearToken } from '../../lib/auth.js';
import { useAuth } from '../../contexts/AuthContext.js';
import TokenActivationForm from '../TokenActivationForm.js';
import RequestAccessForm from '../RequestAccessForm.jsx';

export default function AccountTab() {
  const { isPremium, tokenTier: tier, daysLeft: days, userEmail, signOut, signIn } = useAuth();
  const [showRequest, setShowRequest] = useState(false);

  return (
    <div className="p-6 space-y-4 fade-in">
      {/* Cloud sync account */}
      {userEmail ? (
        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-[var(--color-bull)]" />
              <span className="text-xs font-medium text-[var(--color-text-primary)]">Signed in</span>
            </div>
            <button
              onClick={() => { void signOut(); }}
              className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-bear)] transition-colors"
            >
              Sign out
            </button>
          </div>
          <p className="text-[11px] text-[var(--color-text-secondary)] pl-4">{userEmail}</p>
          <p className="text-[10px] text-[var(--color-text-muted)] pl-4">
            Your data syncs to the cloud automatically.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-[var(--color-text-muted)]">
              Not signed in — data is stored locally only.
            </p>
            {signIn && (
              <button
                type="button"
                onClick={() => signIn()}
                className="px-3 py-1.5 text-[11px] font-medium rounded-lg border border-[var(--color-accent)]/30 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors shrink-0"
              >
                Sign in
              </button>
            )}
          </div>
        </div>
      )}

      <hr className="border-[var(--color-border-subtle)]" />

      {/* Premium token */}
      {isPremium ? (
        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-4 space-y-3">
          {/* Tier + expiry */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldCheck size={16} className="text-[var(--color-bull)]" />
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${
                tier === 'pro'
                  ? 'text-[var(--color-accent)] bg-[var(--color-accent)]/10 border-[var(--color-accent)]/20'
                  : 'text-[var(--color-purple)] bg-[var(--color-purple-bg)] border-[var(--color-purple)]/20'
              }`}>
                {tier === 'pro' ? 'PRO' : 'TRIAL'}
              </span>
            </div>
            <span className="text-xs text-[var(--color-text-secondary)] tabular-nums">
              {days} day{days !== 1 ? 's' : ''} remaining
            </span>
          </div>

          {/* Feature list */}
          <ul className="text-[11px] text-[var(--color-text-secondary)] space-y-1.5 pl-1">
            <li className="flex items-center gap-1.5">
              <Check size={10} className="text-[var(--color-bull)] shrink-0" />
              AI Co-Pilot with streaming analysis
            </li>
            <li className="flex items-center gap-1.5">
              <Check size={10} className="text-[var(--color-bull)] shrink-0" />
              Position Analysis with P&L tracking
            </li>
            <li className="flex items-center gap-1.5">
              <Check size={10} className="text-[var(--color-bull)] shrink-0" />
              Ticker Research (earnings, analysts, technicals)
            </li>
          </ul>

          {/* Remove the token from this browser (not a sign-out: the account stays signed in) */}
          <div className="pt-2 border-t border-[var(--color-border-subtle)] space-y-1">
            {/* Not revoked on the server (D9). clearToken, like setToken, dispatches auth-changed, which AuthContext
                follows, so the tab tells nobody itself: this block gives way to an empty activation form. */}
            <button
              type="button"
              onClick={() => clearToken()}
              className="text-[10px] text-[var(--color-bear)] hover:text-[var(--color-bear)]/80 transition-colors"
            >
              Remove access token
            </button>
            <p className="text-[10px] text-[var(--color-text-muted)] leading-relaxed">
              Deletes the token from this browser. Premium features lock until a token is activated again.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
              Activate Token
            </label>
            <TokenActivationForm
              placeholder="Paste access token..."
              hint="Unlocks premium features: AI Co-Pilot, Position Analysis, and Ticker Research."
            />
          </div>

          {/* Request access */}
          {showRequest ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <hr className="flex-1 border-[var(--color-border-subtle)]" />
                <span className="text-[10px] text-[var(--color-text-muted)]">or request access</span>
                <hr className="flex-1 border-[var(--color-border-subtle)]" />
              </div>
              <RequestAccessForm compact={false} />
            </div>
          ) : (
            <div className="flex items-center gap-3 p-3 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border-subtle)]">
              <Star size={14} className="text-[var(--color-accent)] shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-[var(--color-text-primary)]">Don't have a token?</p>
                <p className="text-[10px] text-[var(--color-text-muted)]">Request early access to premium features.</p>
              </div>
              <button
                onClick={() => setShowRequest(true)}
                className="px-3 py-1.5 text-[11px] font-medium rounded-lg border border-[var(--color-accent)]/30 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors shrink-0"
              >
                Request
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
