// src/hooks/useAutoSave.js
// Debounced auto-save for a controlled input: prime() with the value loaded from storage (or hand that value over at
// mount, as the third argument), schedule() on every edit, flush() before anything that must see the stored value
// (closing, signing out, switching provider).
// The debounce and the baseline compare live in src/lib/debouncedSaver.js (roadmap D7); this hook adds the
// "Saved" flash and flushes on unmount and on pagehide, so an edit inside the debounce window is not lost.
import { useState, useEffect, useCallback, useRef } from 'react';
import { createSaver } from '../lib/debouncedSaver.js';

const SAVED_FLASH_MS = 1500;

/**
 * @template T
 * @param {(value: T) => void} saveFn Writes a value. The function current when an edit is scheduled is the
 *   one that saves it, even if saveFn changes before the timer fires.
 * @param {number} [delay=600] Debounce in ms (read once, on mount).
 * @param {NoInfer<T>} [initialValue] Primes the saver at creation, as prime() would: the value the component read in
 *   its own lazy initializer, so no effect has to prime it. Read once, like delay; a later value does not re-prime,
 *   call prime(). Omitted (undefined), there is no baseline until prime(). NoInfer: T comes from saveFn alone, so a
 *   literal here ('') does not narrow what prime() and schedule() take.
 * @returns {{ prime: (value: T) => void, schedule: (value: T) => boolean, flush: () => boolean, saved: boolean }}
 *   `prime`, `schedule` and `flush` are stable; `saved` is true for a moment after each write.
 */
export function useAutoSave(saveFn, delay = 600, initialValue) {
  const [saved, setSaved] = useState(false);
  const saveFnRef = useRef(saveFn);
  useEffect(() => { saveFnRef.current = saveFn; }, [saveFn]);

  // One saver per mount, primed here when the caller passed the value it loaded. onSaved runs from the saver's timer
  // or from flush(), never during render; the fade timer id is a closure variable because a ref captured here would
  // count as read during render.
  const [{ saver, stopFade }] = useState(() => {
    let fade = null;
    const saver = createSaver({
      delay,
      onSaved: () => {
        setSaved(true);
        clearTimeout(fade);
        fade = setTimeout(() => setSaved(false), SAVED_FLASH_MS);
      },
    });
    if (initialValue !== undefined) saver.prime(initialValue);
    return { saver, stopFade: () => clearTimeout(fade) };
  });

  const prime = useCallback((value) => saver.prime(value), [saver]);
  const flush = useCallback(() => saver.flush(), [saver]);
  const schedule = useCallback((value) => {
    const queued = saver.schedule(value, saveFnRef.current);
    if (queued) setSaved(false); // an unsaved edit is pending again
    return queued;
  }, [saver]);

  // Closing the tab or unmounting inside the debounce window saves the edit instead of dropping it.
  useEffect(() => {
    const onPageHide = () => { saver.flush(); };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      saver.flush();
      stopFade(); // after the flush, which may have started a new fade
    };
  }, [saver, stopFade]);

  return { prime, schedule, flush, saved };
}
