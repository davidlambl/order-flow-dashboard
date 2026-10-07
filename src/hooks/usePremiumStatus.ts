// src/hooks/usePremiumStatus.ts
// The premium state (the PRO / TRIAL badge, the gates, the Account tab) read straight from the stored access token
// through useSyncExternalStore on the auth-changed event (roadmap F11). setToken, clearToken and clearTokenIfDead
// dispatch that event, so a token the server rejects mid-session drops PRO at once, with no onUnlock / onAuthChange
// callback threaded down from App. The snapshot is the token string itself (a primitive, so an event that leaves the
// token as it was re-renders nothing) and the status is derived once per token. The clock is read when the token
// changes, as App's lazy initializers did, so a token that expires mid-session still shows as premium until the
// server rejects a request and clearTokenIfDead clears it (unchanged behaviour).

import { useMemo, useSyncExternalStore } from 'react';
import { describeToken, getToken, subscribeAuth } from '../lib/auth.js';
import type { TokenStatus } from '../lib/auth.js';

export function usePremiumStatus(): TokenStatus {
  const token = useSyncExternalStore(subscribeAuth, getToken);
  return useMemo(() => describeToken(token), [token]);
}
