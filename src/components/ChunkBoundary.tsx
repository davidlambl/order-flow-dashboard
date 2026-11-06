// src/components/ChunkBoundary.tsx
// The boundary around one lazily loaded part of the page (a lazyWithPreload component, src/lib/lazyWithPreload.ts):
// its Suspense shows `fallback` while the part's module loads, and its error boundary catches a module that failed to
// load and shows a compact card in the part's place, with Try again (the children mount again, so the part imports
// again) and Reload (the way out for a tab left open across a deploy, whose old files are gone). `failed` replaces
// the card. Without a boundary of its own, a failed chunk would reach the root ErrorBoundary, which replaces the whole
// app, a chat reply streaming next to the part included; with one around every lazy part, a failure costs only that
// part. Only a ChunkLoadError is handled here: any other error is rethrown, to reach the root boundary as it did
// before the part was lazy.
import { Component, Suspense } from 'react';
import type { ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { forgetChunkFailure, isChunkLoadError } from '../lib/lazyWithPreload.js';

interface ChunkBoundaryProps {
  /** What shows while the part's module loads. */
  fallback: ReactNode;
  children: ReactNode;
  /** The failure UI instead of the card; retry() mounts the children again, and the part imports again. */
  failed?: (failure: { retry: () => void }) => ReactNode;
}

interface ChunkBoundaryState {
  hasError: boolean;
  error: unknown;
}

export default class ChunkBoundary extends Component<ChunkBoundaryProps, ChunkBoundaryState> {
  state: ChunkBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: unknown): ChunkBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: unknown) {
    // The failure is on screen now, so the part may import again: on retry, or wherever it mounts next.
    forgetChunkFailure(error);
  }

  // The failure UI took the children's place, so they mount afresh, and the part's lazy imports again.
  retry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    const { hasError, error } = this.state;
    if (!hasError) return <Suspense fallback={this.props.fallback}>{this.props.children}</Suspense>;
    if (!isChunkLoadError(error)) throw error;
    return this.props.failed ? this.props.failed({ retry: this.retry }) : <ChunkFailure retry={this.retry} />;
  }
}

/** The default failure UI: small enough for a dialog, a 340 px chart card or a phone, and as tall as its container. */
function ChunkFailure({ retry }: { retry: () => void }) {
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
