// src/components/ChunkFailureCard.tsx
// What a lazily loaded part of the page shows when its module failed to load (ChunkBoundary's default failure UI): one
// sentence, Try again (the part imports again) and Reload (the way out for a tab left open across a deploy, whose old
// files are gone). Small enough for a dialog, a 340 px chart card or a phone, and as tall as its container. A part that
// lays out the whole screen itself (the sign-in form, a modal) cannot have a frame around its boundary, which would
// frame the loaded part too, so it puts this card in its own frame through the boundary's `failed` instead.
import { CircleAlert } from 'lucide-react';

interface ChunkFailureCardProps {
  /** ChunkBoundary's retry: the children mount again, and the part imports again. */
  retry: () => void;
}

export default function ChunkFailureCard({ retry }: ChunkFailureCardProps) {
  return (
    <div
      role="alert"
      className="h-full flex flex-col items-center justify-center gap-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 text-center"
    >
      <p className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
        <CircleAlert size={12} className="shrink-0 text-[var(--color-warn)]" />
        This part of the dashboard could not load.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={retry}
          className="rounded-lg px-3 py-1.5 border border-[var(--color-accent)] bg-[var(--color-accent)] text-xs font-semibold text-white hover:bg-[var(--color-accent-hover)] transition-colors"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-lg px-3 py-1.5 border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] text-xs font-semibold text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] transition-colors"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
