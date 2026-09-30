// src/hooks/useCountdown.ts
// Whole seconds left until a deadline, ticking once a second. useMarketData returns the deadline of its next
// silent refresh (`nextRefreshAt`) instead of a per-second counter, so only the component that calls this hook
// re-renders at 1 Hz, not App (roadmap F12).

import { useNow } from './useNow.js';

/**
 * @param target - the deadline in epoch ms, or null when nothing is scheduled
 * @param maxSecs - the longest countdown the caller can show (the refresh interval, in seconds)
 * @returns the seconds left, rounded up; 0 when `target` is null or already past
 */
export function useCountdown(target: number | null, maxSecs: number): number {
  const now = useNow(1000);
  if (target == null) return 0;
  // `now` is up to one tick old when the target moves (the data just landed), so a fresh deadline a full
  // interval away would read maxSecs + 1 until the next tick; the clamp hides that second.
  return Math.min(maxSecs, Math.max(0, Math.ceil((target - now) / 1000)));
}
