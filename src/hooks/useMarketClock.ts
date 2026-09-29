// src/hooks/useMarketClock.ts
// Which US sessions are open right now, re-checked every 30 s so the market-data hook stops (or starts) its
// auto-refresh at the bell without a reload. The decision itself is pure (src/lib/marketHours.ts, Eastern Time);
// this hook only owns the clock reads. A check that changes nothing keeps the previous state object, so the 30 s
// tick re-renders only at a session boundary.

import { useEffect, useState } from 'react';
import { readMarketState } from '../lib/marketHours.js';
import type { MarketState } from '../lib/marketHours.js';

const RECHECK_MS = 30_000;

// Module level, so the render-time read happens only inside useState's lazy initializer (react-hooks/purity).
function readClock(): MarketState {
  return readMarketState(new Date());
}

export function useMarketClock(): MarketState {
  const [state, setState] = useState(readClock);

  useEffect(() => {
    const id = setInterval(() => {
      setState((prev) => {
        const next = readClock();
        return next.marketOpen === prev.marketOpen
          && next.optionsMarketOpen === prev.optionsMarketOpen
          && next.session === prev.session
          ? prev
          : next;
      });
    }, RECHECK_MS);
    return () => clearInterval(id);
  }, []);

  return state;
}
