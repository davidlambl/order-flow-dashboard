// src/components/SyncChoice.jsx
// Shown when hydrate() finds different data in this browser and in the signed-in account (roadmap D1, D6).
// Blocking on purpose: no close button, no backdrop dismiss. Until the user picks, neither copy is written
// over the other, and there is no safe default to fall back on.
import { Loader2, RefreshCw } from 'lucide-react';

const CHOICES = [
  {
    id: 'merge',
    label: 'Merge',
    recommended: true,
    description: "Keeps both. Where an item exists in both places, this browser's copy is kept.",
  },
  { id: 'cloud', label: 'Use cloud copy', description: "Replaces this browser's data with your account's." },
  { id: 'local', label: "Use this browser's copy", description: "Replaces your account's data with this browser's." },
];

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function summary(counts) {
  const { positions = 0, chats = 0, prefs = 0 } = counts ?? {};
  return `${plural(positions, 'position')} · ${plural(chats, 'chat')} · ${plural(prefs, 'setting')}`;
}

/**
 * @param {{ report: { local: object, cloud: object }, onChoose: (choice: 'merge'|'cloud'|'local') => void, busy: boolean }} props
 *   report: hydrate()'s conflict report (counts per side)
 */
export default function SyncChoice({ report, onChoose, busy }) {
  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sync-choice-title"
      aria-describedby="sync-choice-description"
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      <div className="relative w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-2xl p-6 space-y-4">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-[var(--color-purple-bg)]">
            <RefreshCw size={14} className="text-[var(--color-purple)]" />
          </div>
          <h2 id="sync-choice-title" className="text-sm font-semibold text-[var(--color-text-primary)]">
            Sync your data
          </h2>
        </div>

        <p id="sync-choice-description" className="text-xs text-[var(--color-text-secondary)]">
          This browser and your account both have saved data. Choose what to keep.
        </p>

        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-3 space-y-1.5 text-xs">
          <p>
            <span className="text-[var(--color-text-muted)]">This browser:</span>{' '}
            <span className="text-[var(--color-text-primary)] tabular-nums">{summary(report?.local)}</span>
          </p>
          <p>
            <span className="text-[var(--color-text-muted)]">Your account:</span>{' '}
            <span className="text-[var(--color-text-primary)] tabular-nums">{summary(report?.cloud)}</span>
          </p>
        </div>

        <div className="space-y-2">
          {CHOICES.map((choice) => (
            <button
              key={choice.id}
              type="button"
              onClick={() => onChoose(choice.id)}
              disabled={busy}
              autoFocus={choice.recommended}
              className={`w-full text-left rounded-lg px-3 py-2.5 border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                choice.recommended
                  ? 'bg-[var(--color-accent)] border-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)]'
                  : 'bg-[var(--color-surface-2)] border-[var(--color-border-subtle)] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)]'
              }`}
            >
              <span className="flex items-center gap-2 text-xs font-semibold">
                {choice.label}
                {choice.recommended && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-white/15">Recommended</span>
                )}
              </span>
              <span className={`block mt-0.5 text-[11px] ${choice.recommended ? 'text-white/80' : 'text-[var(--color-text-secondary)]'}`}>
                {choice.description}
              </span>
            </button>
          ))}
        </div>

        {busy && (
          <p role="status" className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
            <Loader2 size={11} className="animate-spin" /> Syncing…
          </p>
        )}
      </div>
    </div>
  );
}
