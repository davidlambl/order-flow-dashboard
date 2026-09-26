// src/lib/debouncedSaver.js
// Debounced save of the latest value, checked against a baseline (roadmap D7).
//
// Why a baseline: useAutoSave used to skip "the first change after reset()", assuming that change was the
// stored value arriving in state. When the stored value already equalled state (every modal reopen, and an
// empty field on first use) no such change came, so the skip swallowed the user's first real edit instead:
// a key pasted in one go and the modal closed was never stored. Here the caller primes the saver with the
// value it loaded, and a value equal to that baseline is never written. Priming is idempotent, so StrictMode's
// double mount cannot turn a loaded value into a save.
//
// Each schedule() passes the save function to use, and a pending save keeps the one it was scheduled with:
// an Anthropic key still inside the debounce when the provider switches is not written under ai_key_openai.
//
// No imports and no browser globals. Timers are injectable so src/lib/debouncedSaver.node.test.js drives this
// under Node with a fake clock; nothing there sleeps.

/**
 * @template T
 * @typedef {object} Saver
 * @property {(value: T) => void} prime Set the baseline to the value as stored and drop any pending save
 *   without writing it.
 * @property {(value: T, save: (value: T) => void) => boolean} schedule Queue `save(value)` to run `delay` ms
 *   after the last call, replacing the pending value and save function. A value equal to the baseline cancels
 *   the pending save instead and returns false (nothing is written); otherwise returns true.
 * @property {() => boolean} flush Run the pending save now; returns whether there was one.
 * @property {() => void} cancel Drop the pending save without writing it (the baseline is kept).
 * @property {() => boolean} isPending Whether a save is waiting for its timer.
 */

/**
 * Create a debounced saver. Each write (timer or flush) makes the written value the new baseline, then
 * calls `onSaved`.
 *
 * @template T
 * @param {object} [options]
 * @param {number} [options.delay=600] Quiet time in ms after the last schedule() before the save runs.
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimeout] Starts a timer; the global one by default.
 * @param {(id: unknown) => void} [options.clearTimeout] Stops a timer; the global one by default.
 * @param {(a: T, b: T) => boolean} [options.isEqual=Object.is] Whether a scheduled value equals the baseline.
 * @param {() => void} [options.onSaved] Called after each write.
 * @returns {Saver<T>}
 */
export function createSaver({
  delay = 600,
  setTimeout = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout = (id) => globalThis.clearTimeout(id),
  isEqual = Object.is,
  onSaved,
} = {}) {
  let hasBaseline = false;
  let baseline;
  let pending = null; // { value, save }
  let timer = null;

  const stopTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const cancel = () => {
    stopTimer();
    pending = null;
  };

  // Detach the pending save before running it, so a save that schedules again starts a fresh one.
  const write = () => {
    const { value, save } = pending;
    cancel();
    save(value);
    hasBaseline = true;
    baseline = value;
    onSaved?.();
  };

  return {
    prime(value) {
      cancel();
      hasBaseline = true;
      baseline = value;
    },
    schedule(value, save) {
      if (hasBaseline && isEqual(value, baseline)) {
        cancel();
        return false;
      }
      stopTimer();
      pending = { value, save };
      timer = setTimeout(() => {
        timer = null;
        if (pending) write();
      }, delay);
      return true;
    },
    flush() {
      if (!pending) return false;
      write();
      return true;
    },
    cancel,
    isPending: () => pending !== null,
  };
}
