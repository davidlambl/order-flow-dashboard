// src/hooks/useKeyTester.ts
// The AI tab's "Test" button: one getModels request with the typed key, trimmed as the autosave stores it, and its
// outcome as a status and a sentence. A key that lists models seeds the models cache under that trimmed key, so the
// list useAIModels shows once the tab saves the key is a cache hit, not a second request. A newer test or reset() (an
// edit, a provider switch) drops the reply of one still in flight; the dialog let a slow reply mark a newer key valid.

import { useCallback, useRef, useState } from 'react';
import { fetchModels } from '../lib/api.js';
import { keys, queryClient } from '../lib/queryClient.js';

export type KeyTestStatus = 'idle' | 'testing' | 'success' | 'error';

/** What useKeyTester returns. */
export interface KeyTester {
  status: KeyTestStatus;
  /** Why the last test failed; '' unless the status is 'error'. */
  error: string;
  /**
   * Tests `key` (trimmed; a blank one tests nothing) for `provider`. Resolves true when it listed models and is still
   * the latest test, false otherwise.
   */
  test: (provider: string, key: string) => Promise<boolean>;
  /** Back to idle; the reply of a test in flight is ignored. */
  reset: () => void;
}

export function useKeyTester(): KeyTester {
  const [status, setStatus] = useState<KeyTestStatus>('idle');
  const [error, setError] = useState('');
  // Counts tests and resets: a reply acts only while its test is still the latest.
  const latest = useRef(0);

  const test = useCallback(async (provider: string, key: string) => {
    const k = key.trim();
    if (!k) return false;
    const id = ++latest.current;
    setStatus('testing');
    setError('');
    try {
      const result = await fetchModels(k, provider);
      if (id !== latest.current) return false;
      // The dialog's test, sentences included; `?.` because a reply without `models` reads as listing none.
      if ((result.models?.length ?? 0) > 0) {
        queryClient.setQueryData(keys.models(provider, k), result);
        setStatus('success');
        return true;
      }
      setStatus('error');
      setError(result.error || 'Key returned no models — check that it is valid.');
      return false;
    } catch (err) {
      if (id !== latest.current) return false;
      setStatus('error');
      // fetchModels rejects with Errors only (a failed fetch, an error reply, a reply that is not JSON).
      setError((err as Error).message || 'Could not validate key. Check the format and try again.');
      return false;
    }
  }, []);

  const reset = useCallback(() => {
    latest.current += 1;
    setStatus('idle');
    setError('');
  }, []);

  return { status, error, test, reset };
}
