// src/hooks/useMediaQuery.ts
// Whether a CSS media query matches, followed as it changes: useSyncExternalStore over window.matchMedia, so a render
// never sees a stale answer and a change re-renders at once. App asks for Tailwind's `md` as `(min-width: 48rem)`,
// which is equivalent to the `(width >= 48rem)` the stylesheet's `md:` variant compiles to, so the layout the
// JavaScript chooses and the one the CSS draws switch at the same width; it is written as `min-width` because that is
// the form the tests' matchMedia stand-in parses. Where matchMedia is missing it answers false and listens to nothing.

import { useCallback, useMemo, useSyncExternalStore } from 'react';

const listenToNothing = () => () => {};

/** Whether `query` (a media query list, e.g. '(min-width: 48rem)') matches now. */
export function useMediaQuery(query: string): boolean {
  // One list per query for as long as the component keeps it: its `matches` is live, and its `change` event fires
  // when the answer flips.
  const list = useMemo(
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(query) : null),
    [query],
  );
  const subscribe = useCallback((onChange: () => void) => {
    if (!list) return listenToNothing();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [list]);
  const getSnapshot = useCallback(() => list?.matches ?? false, [list]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
