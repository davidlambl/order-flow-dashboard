// src/hooks/useNow.js
// A ticking clock for render code. Components must not read Date.now() or new Date() while
// rendering (react-hooks/purity: the value changes between renders of the same props), and a
// time computed once during render never moves while the page sits idle, so a "stale" warning or
// a "5m ago" label would freeze. useNow keeps the current time in state and refreshes it on an
// interval: render stays pure, and anything derived from `now` re-evaluates on every tick.

import { useEffect, useState } from 'react';

/**
 * @param {number} [intervalMs=60000] - how often `now` advances, in ms
 * @returns {number} the current time in epoch ms, refreshed every `intervalMs`
 */
export function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
