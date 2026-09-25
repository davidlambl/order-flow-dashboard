// src/hooks/useAutoSave.js
// Shared debounced auto-save hook with flush/reset support.
import { useState, useEffect, useCallback, useRef } from 'react';

export function useAutoSave(value, saveFn, delay = 600) {
  const [saved, setSaved] = useState(false);
  const timeoutRef = useRef(null);
  const fadeRef = useRef(null);
  const initialRef = useRef(true);
  const pendingRef = useRef(null); // tracks { value, saveFn } when a timer is queued
  const saveFnRef = useRef(saveFn);
  useEffect(() => { saveFnRef.current = saveFn; }, [saveFn]);

  useEffect(() => {
    // Clear any in-flight timers first
    clearTimeout(timeoutRef.current);
    clearTimeout(fadeRef.current);

    // Skip initial mount — don't save the value loaded from storage
    if (initialRef.current) { initialRef.current = false; pendingRef.current = null; return; }
    setSaved(false);

    pendingRef.current = { value, saveFn: saveFnRef.current };
    timeoutRef.current = setTimeout(() => {
      pendingRef.current = null;
      saveFnRef.current(value);
      setSaved(true);
      fadeRef.current = setTimeout(() => setSaved(false), 1500);
    }, delay);

    return () => { clearTimeout(timeoutRef.current); clearTimeout(fadeRef.current); };
  }, [value, delay]);

  // Reset initial flag when the hook is re-mounted (modal reopen)
  const reset = useCallback(() => {
    clearTimeout(timeoutRef.current);
    clearTimeout(fadeRef.current);
    pendingRef.current = null;
    initialRef.current = true;
    setSaved(false);
  }, []);

  // Flush any pending debounced save immediately (call on close/unmount)
  const flush = useCallback(() => {
    if (pendingRef.current) {
      clearTimeout(timeoutRef.current);
      clearTimeout(fadeRef.current);
      pendingRef.current.saveFn(pendingRef.current.value);
      pendingRef.current = null;
    }
  }, []);

  return { saved, reset, flush };
}
