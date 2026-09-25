// src/lib/staleness.js
// "Is this options snapshot too old to act on?" — one rule for the position panel
// and the chat context. Pure: the clock is injected, so callers pass a `now`
// (a ticking value from a hook, or a fixed instant in tests). Node-loadable, so
// relative imports carry their extension.

import { STALE_AFTER_MIN } from '../../shared/thresholds.js';

/**
 * @param {string|number|Date|null|undefined} lastUpdated - ISO timestamp, epoch ms or Date of the snapshot
 * @param {number} nowMs - the current time in epoch ms
 * @param {boolean} sessionOpen - true while the equity or options session is open (the tighter bar)
 * @returns {boolean} false whenever either instant is missing or invalid: unknown age is not "stale"
 */
export function isStaleData(lastUpdated, nowMs, sessionOpen) {
  if (lastUpdated == null || lastUpdated === '') return false;
  const type = typeof lastUpdated;
  if (type !== 'string' && type !== 'number' && !(lastUpdated instanceof Date)) return false;
  const updatedMs = new Date(lastUpdated).getTime();
  const now = Number(nowMs);
  if (!Number.isFinite(updatedMs) || !Number.isFinite(now)) return false;
  const limitMin = sessionOpen ? STALE_AFTER_MIN.sessionOpen : STALE_AFTER_MIN.sessionClosed;
  return (now - updatedMs) / 60_000 > limitMin;
}
