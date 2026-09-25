// scripts/verify/saver.mjs — Phase 3 checks; loaded by scripts/verify-functions.mjs with its helpers.
// The debounced saver behind useAutoSave (src/lib/debouncedSaver.js): baseline compare instead of a
// skip flag, one save per edit burst, flush and cancel. Timers are injected, so nothing waits.

export default async function run(ctx) {
  console.log('saver');
  const { t: _t, assert: _assert } = ctx;
  // Checks land with the debouncedSaver module (Phase 3, PR a).
}
