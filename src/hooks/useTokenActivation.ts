// src/hooks/useTokenActivation.ts
// Activating a premium access token: the one handler behind TokenActivationForm, which the Account tab and the premium
// locks share. The server decides (validateToken); on a yes, setToken stores the token and dispatches auth-changed, so
// the gates lift through AuthContext with no callback and take the form with them (each parent mounts it only while
// locked): 'success' records the activation, and the user sees the feature instead.
// A reply is dropped when reset() or a newer activate() came after its request: the user has edited the input since,
// and an answer about the old text must neither show nor store a token. An unmount drops nothing, so a token still
// being checked when the dialog closes is activated all the same, as the per-form handlers this replaces did.

import { useCallback, useRef, useState } from 'react';
import { setToken, validateToken } from '../lib/auth.js';
import type { ValidateTokenResult } from '../lib/auth.js';

export type ActivationStatus = 'idle' | 'validating' | 'success' | 'error';

export interface TokenActivation {
  status: ActivationStatus;
  /** Why the last activation failed: the server's reason, 'Invalid token' without one, or the network sentence. */
  error: string;
  /** Trims `raw`; true once the token is stored, false otherwise (empty input, refused, failed or dropped). */
  activate: (raw: string) => Promise<boolean>;
  /** Back to idle, dropping the reply to any request still in flight; the forms call it on every edit. */
  reset: () => void;
}

/** One sentence for both ways no verdict arrives: the request failed, or a 200 whose body is not JSON. */
const NO_VERDICT = 'Could not validate token. Try again.';

export function useTokenActivation(): TokenActivation {
  const [status, setStatus] = useState<ActivationStatus>('idle');
  const [error, setError] = useState('');
  // Bumped by every activate() and reset(); a reply is applied only while its request is still the latest.
  const latestRef = useRef(0);

  const activate = useCallback(async (raw: string) => {
    const token = raw.trim();
    if (!token) return false;
    const request = ++latestRef.current;
    setStatus('validating');
    setError('');
    // validateToken resolves null for a 200 that is not JSON (auth.ts); null here also stands for a thrown request.
    let result: ValidateTokenResult | null;
    try {
      result = await validateToken(token);
    } catch {
      result = null;
    }
    if (request !== latestRef.current) return false;
    if (result?.valid) {
      setToken(token);
      setStatus('success');
      return true;
    }
    setStatus('error');
    setError(result ? result.error || 'Invalid token' : NO_VERDICT);
    return false;
  }, []);

  const reset = useCallback(() => {
    latestRef.current += 1;
    setStatus('idle');
    setError('');
  }, []);

  return { status, error, activate, reset };
}
