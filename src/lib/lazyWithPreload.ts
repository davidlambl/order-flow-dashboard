// src/lib/lazyWithPreload.ts
// Code-split components. `const X = lazyWithPreload(() => import('./X.js'))` declares X (the module's default export,
// a function component) at module level and keeps it out of the entry chunk; <X {...props} /> renders it with the same
// props, a ref included, and must sit inside a ChunkBoundary (src/components/ChunkBoundary.tsx), the Suspense and error
// boundary that shows a fallback while the module loads and a card if it fails. X.preload() starts the import early.
//
// Why not React.lazy alone: React.lazy suspends on every first render of its type, even once its promise has resolved,
// so a part that was preloaded would still flash its fallback. Here an instance that mounts after the module is in
// renders the loaded component directly, in the same render, which is what the idle preload (scheduleIdlePreload,
// for lazies created with { idle: true }) buys in production and what the dom tests rely on (src/test/setup.js
// preloads every lazy before a file's first test). Before that, an instance renders through React.lazy and suspends.
// The choice is made once per instance: an instance that mounted through the pending import keeps rendering through
// it after it loads, since a component of another type in its place would remount, dropping the loaded part's state.
// React keeps no state for an instance that suspended before its first commit (it runs the state initializer again
// when it retries), so the import, the loaded component and a failure are kept per lazy, never per instance.
//
// A failed import is not final, unlike React.lazy's, which rethrows its rejection forever: it becomes a
// ChunkLoadError for the boundary to tell apart from a render bug, and the next attempt imports again, through a fresh
// React.lazy. A failure that a render is waiting for stands until a ChunkBoundary has shown it (forgetChunkFailure):
// React retries that render once the import settles, and the retry must find the failure and throw it to the
// boundary, since a fresh import would suspend again and, while the network is down, fail and be retried without end.
// A failure nothing rendered (a preload's) is dropped at once. preload() never rejects and imports at most once at a
// time, however many instances and calls there are. Nothing runs at import: a lazy is only registered.

import { createElement, lazy, useState } from 'react';
import type { LazyExoticComponent, ReactNode } from 'react';

/** What a lazy part's import rejected with, as a render throws it; `cause` is the import's own error. */
export class ChunkLoadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ChunkLoadError';
  }
}

/** True for a lazy part's failed import, false for anything else a render threw. */
export function isChunkLoadError(error: unknown): error is ChunkLoadError {
  return error instanceof ChunkLoadError;
}

/** A lazy module's default export: a function component (a ref arrives as a prop in React 19). */
type LazyTarget<P> = (props: P) => ReactNode;

export interface LazyOptions {
  /** Load it in the idle preload App starts once the dashboard is up (scheduleIdlePreload). */
  idle?: boolean;
}

/** The lazy component: the loaded component's props, plus preload(). */
export type PreloadableComponent<P> = LazyTarget<P> & {
  /** Starts the import unless it is in or under way (again after a failure); settles when it ends, never rejecting. */
  preload: () => Promise<void>;
};

/** One import of a lazy's module. */
interface Attempt<P> {
  /** React.lazy over this import: what an instance that mounts while it is pending renders. */
  readonly type: LazyExoticComponent<LazyTarget<P>>;
  /** Starts the import, once; settles with the component or the failure, never rejecting. */
  readonly start: () => Promise<LazyTarget<P> | ChunkLoadError>;
  /** React rendered `type`: a render may be waiting to show this attempt's failure. */
  rendered: boolean;
  /** Set once the import has failed. */
  error: ChunkLoadError | null;
}

/** A lazy as the registry drives it. */
interface Registered {
  readonly idle: boolean;
  /** preload() with its outcome: the failure, or null once the module is in. */
  load(): Promise<ChunkLoadError | null>;
  forget(error: unknown): void;
  reset(): void;
}

const registry: Registered[] = [];

export function lazyWithPreload<P extends object>(
  load: () => Promise<{ default: LazyTarget<P> }>,
  { idle = false }: LazyOptions = {},
): PreloadableComponent<P> {
  let loaded: LazyTarget<P> | null = null;
  let current: Attempt<P> | null = null;

  /** The import under way or failed, or a new one; a new one starts when React renders its type or preload() asks. */
  function attempt(): Attempt<P> {
    if (current) return current;
    let outcome: Promise<LazyTarget<P> | ChunkLoadError> | null = null;
    const next: Attempt<P> = {
      rendered: false,
      error: null,
      start() {
        // Reading the export inside the chain: a module that cannot hand over its component (a test's mock without a
        // default export throws) fails the attempt instead of rejecting past it.
        outcome ??= load().then((module) => module.default).then(
          (component) => {
            // An attempt reset away by a test may still land; it must not load the lazy for the next one.
            if (current === next) loaded = component;
            return component;
          },
          (cause: unknown) => {
            const error = new ChunkLoadError(cause);
            next.error = error;
            // Nothing rendered this import, so nothing waits to show its failure: the next render imports again.
            if (current === next && !next.rendered) current = null;
            return error;
          },
        );
        return outcome;
      },
      type: lazy(() => {
        next.rendered = true;
        return next.start().then((result) => (
          result instanceof ChunkLoadError ? Promise.reject(result) : { default: result }
        ));
      }),
    };
    current = next;
    return next;
  }

  function preload(): Promise<ChunkLoadError | null> {
    if (loaded) return Promise.resolve(null);
    if (current?.error) current = null;
    return attempt().start().then((result) => (result instanceof ChunkLoadError ? result : null));
  }

  function LazyComponent(props: P) {
    // Chosen once: a later render with the other type would remount the part. React runs this initializer again on
    // each retry of a mount that suspended, so it takes the lazy's attempt rather than making one per instance.
    const [type] = useState<LazyTarget<P>>(() => loaded ?? attempt().type);
    return createElement(type, props);
  }

  registry.push({
    idle,
    load: preload,
    forget(error) {
      if (current?.error === error) current = null;
    },
    reset() {
      loaded = null;
      current = null;
    },
  });
  return Object.assign(LazyComponent, { preload: () => preload().then(() => undefined) });
}

/** Preloads the registered lazies `which` selects, then those their modules registered as they loaded, and so on. */
async function preloadRegistered(which: (entry: Registered) => boolean): Promise<ChunkLoadError[]> {
  const failures: ChunkLoadError[] = [];
  let done = 0;
  while (done < registry.length) {
    const round = registry.slice(done).filter(which);
    done = registry.length;
    for (const failure of await Promise.all(round.map((entry) => entry.load()))) {
      if (failure) failures.push(failure);
    }
  }
  return failures;
}

/**
 * Loads every lazy created so far, those created by the modules it loads included, and resolves with the imports
 * that failed (none: every lazy renders directly from then on). For the dom test setup.
 */
export function preloadAll(): Promise<ChunkLoadError[]> {
  return preloadRegistered(() => true);
}

/**
 * ChunkBoundary, once its card shows `error`: the lazy whose import failed with it imports again on its next render
 * or preload. Anything else is ignored.
 */
export function forgetChunkFailure(error: unknown): void {
  for (const entry of registry) entry.forget(error);
}

/**
 * Returns every lazy to where it started: nothing loaded, no import under way or failed. For the dom test setup, which
 * calls it after each test of a file that drives lazies by hand (src/test/lazy.js).
 */
export function resetLazies(): void {
  for (const entry of registry) entry.reset();
}

/** The parts of `window` the idle preload uses; its tests pass their own. */
export interface IdleHost {
  requestIdleCallback?: (callback: () => void) => number;
  cancelIdleCallback?: (handle: number) => void;
  setTimeout: (callback: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
  /** connection is the Network Information API (Chromium only), which TypeScript's DOM types leave out. */
  navigator: Navigator & { connection?: { saveData?: boolean } };
}

/** Where requestIdleCallback is missing (Safari), how long the dashboard's own first requests get to themselves. */
const IDLE_FALLBACK_MS = 2_000;

/**
 * Preloads the lazies created with { idle: true } once the browser is idle (requestIdleCallback, or a timeout where it
 * is missing), so their first use shows no fallback; nothing on a connection that asks to save data, nor without a
 * window. App calls it once from an effect after the dashboard mounts.
 * @returns cancel, for the effect's cleanup: the preload does not start if it has not yet
 */
export function scheduleIdlePreload(
  host: IdleHost | null = typeof window === 'undefined' ? null : window,
): () => void {
  if (host === null || host.navigator.connection?.saveData === true) return () => {};
  const run = () => { void preloadRegistered((entry) => entry.idle); };
  if (host.requestIdleCallback) {
    const handle = host.requestIdleCallback(run);
    return () => host.cancelIdleCallback?.(handle);
  }
  const handle = host.setTimeout(run, IDLE_FALLBACK_MS);
  return () => host.clearTimeout(handle);
}
