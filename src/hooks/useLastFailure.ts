// src/hooks/useLastFailure.ts
// A data hook's failure as a surface should say it: kept until a load succeeds or what it is about changes. TanStack
// clears a query's error when a fetch starts for a query that holds no data, and useLiveQuote's refresh() resets its
// query, so a failure that is still the truth leaves the hook's result for as long as the next request runs (the live
// quote's silent refetch every 60 s, a Retry, a demo-mode reload). This hook closes that gap where the hooks meet the
// surfaces, in the same render: no render ever shows the gap.
// State adjusted during render (React's "adjust state when a prop changes", the pattern the data hooks' `seen`
// snapshots use): no effect, no ref, and the same answer for the same inputs, so StrictMode's double render is safe.

import { useState } from 'react';

/**
 * @param error - the data hook's error as it stands
 * @param loaded - the hook holds what its last load brought, so a null `error` then means that load succeeded
 * @param key - what the failure is about (the ticker, say); a new key forgets the kept failure
 * @returns `error` on a new key's first render; else `error` when it is not null; else null when `loaded`; else the
 *   failure returned last (no error and nothing loaded: a request is under way, and the last failure still stands)
 */
export function useLastFailure(error: string | null, loaded: boolean, key: string): string | null {
  const [kept, setKept] = useState<{ key: string; failure: string | null }>(() => ({ key, failure: error }));

  let failure: string | null;
  if (kept.key !== key || error !== null) failure = error;
  else if (loaded) failure = null;
  else failure = kept.failure;

  if (kept.key !== key || kept.failure !== failure) setKept({ key, failure });
  return failure;
}
