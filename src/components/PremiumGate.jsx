// src/components/PremiumGate.jsx
import { useState } from 'react';
import { Lock, KeyRound, Loader2, ShieldCheck, AlertCircle } from 'lucide-react';
import { setToken, validateToken as validateTokenApi } from '../lib/auth';

export default function PremiumGate({ isPremium, onUnlock, featureName, children }) {
  const [tokenInput, setTokenInput] = useState('');
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');

  if (isPremium) return children;

  const handleActivate = async (e) => {
    e.preventDefault();
    const raw = tokenInput.trim();
    if (!raw) return;

    setStatus('validating');
    setError('');

    try {
      const result = await validateTokenApi(raw);
      if (result.valid) {
        setToken(raw);
        setStatus('success');
        setTimeout(() => onUnlock?.(), 400);
      } else {
        setStatus('error');
        setError(result.error || 'Invalid token');
      }
    } catch {
      setStatus('error');
      setError('Could not validate token. Try again.');
    }
  };

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

        <form onSubmit={handleActivate} className="w-full max-w-sm space-y-2">
          <div className="flex gap-2">
            <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] focus-within:border-[var(--color-accent)] transition-colors">
              <KeyRound size={12} className="text-[var(--color-text-muted)] shrink-0" />
              <input
                type="text"
                value={tokenInput}
                onChange={(e) => { setTokenInput(e.target.value); setStatus(null); setError(''); }}
                placeholder="Paste token..."
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
                <Loader2 size={14} className="animate-spin" />
              ) : status === 'success' ? (
                <ShieldCheck size={14} />
              ) : (
                'Activate'
              )}
            </button>
          </div>

          {error && (
            <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-bear)]">
              <AlertCircle size={10} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
