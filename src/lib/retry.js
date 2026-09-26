// src/lib/retry.js
// Exponential backoff for background retries. useMarketData spaces its silent
// auto-refreshes with this after failures: each consecutive failure doubles the
// wait, and the cap keeps a long outage retrying every few minutes instead of
// hammering the function or giving up. Pure and import-free, so it loads under
// Node for the node test project (src/lib/clientLib.node.test.js).

/**
 * Seconds to wait before the next background attempt.
 * @param {number} baseSecs - the normal refresh interval, used when nothing has failed
 * @param {number} failures - consecutive failures so far; a negative, NaN or non-numeric
 *   count is treated as 0 (a numeric string is coerced, fractions are floored)
 * @param {number} [capSecs=300] - upper bound on the wait
 * @returns {number} min(capSecs, baseSecs × 2^failures)
 */
export function backoffSeconds(baseSecs, failures, capSecs = 300) {
  const n = Math.floor(Number(failures));
  const exponent = n > 0 ? n : 0; // NaN > 0 is false, so NaN and negatives count as 0
  return Math.min(capSecs, baseSecs * 2 ** exponent);
}
