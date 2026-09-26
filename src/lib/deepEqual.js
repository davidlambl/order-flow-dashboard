// src/lib/deepEqual.js
// Structural equality for the JSON-shaped values the store keeps (positions,
// preferences, chat messages). Key order is ignored: Postgres hands JSONB objects
// back with their keys reordered, so comparing JSON.stringify output would call
// identical documents different. Pure and import-free, so it loads under Node
// for the node test project (src/lib/store.node.test.js).

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean} true when a and b have the same shape and leaf values
 *   (Object.is on leaves; arrays by index; objects by own enumerable keys)
 */
export function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !deepEqual(a[key], b[key])) return false;
  }
  return true;
}
