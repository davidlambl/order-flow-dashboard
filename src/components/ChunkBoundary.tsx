// src/components/ChunkBoundary.tsx
// The boundary around one lazily loaded part of the page (a lazyWithPreload component, src/lib/lazyWithPreload.ts):
// its Suspense shows `fallback` while the part's module loads, and its error boundary catches a module that failed to
// load and shows a compact card (ChunkFailureCard) in the part's place, with Try again (the children mount again, so the part imports
// again) and Reload (the way out for a tab left open across a deploy, whose old files are gone). `failed` replaces
// the card. Without a boundary of its own, a failed chunk would reach the root ErrorBoundary, which replaces the whole
// app, a chat reply streaming next to the part included; with one around every lazy part, a failure costs only that
// part. Only a ChunkLoadError is handled here: any other error is rethrown, to reach the root boundary as it did
// before the part was lazy.
import { Component, Suspense } from 'react';
import type { ReactNode } from 'react';
import { forgetChunkFailure, isChunkLoadError } from '../lib/lazyWithPreload.js';
import ChunkFailureCard from './ChunkFailureCard.js';

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
    return this.props.failed ? this.props.failed({ retry: this.retry }) : <ChunkFailureCard retry={this.retry} />;
  }
}
