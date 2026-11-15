// src/hooks/useRetryOutcome.ts
// How a pressed Retry went, for the status region beside it (the ticker row's, Research's). A screen-reader user who
// presses Retry hears the outcome, also when the same failure comes back (identical text in a live region is not
// announced again), while a load nobody pressed for (the silent refresh, a data-source change) stays silent.
// Phases: idle; begin() → pressed; pressed and busy → running; running and no longer busy → done when nothing fails,
// else idle (the failure line, back in the region, is the outcome); done and failing → idle; a new key → idle.
// `pressed` says nothing yet: the load's start can reach the surface a tick after the press (TanStack notifies through
// a timeout), and a press whose load never starts must not leave the region stuck; it waits for the next load or key.
// State adjusted during render, no effect: the same answer for the same inputs under StrictMode's double render.

import { useCallback, useState } from 'react';

export type RetryOutcome = 'none' | 'retrying' | 'worked';

type Phase = 'idle' | 'pressed' | 'running' | 'done';

/**
 * @param busy - the load a press starts is under way
 * @param failing - the region has a failure line of its own to say
 * @param key - what the surface is about (the ticker); a new key goes back to idle
 * @returns `outcome`: 'retrying' while the pressed load runs, 'worked' once it ended with nothing failing, else
 *   'none'; `begin`, stable, to call at the press, before the load is asked for
 */
export function useRetryOutcome(busy: boolean, failing: boolean, key: string):
  { outcome: RetryOutcome; begin: () => void } {
  const [state, setState] = useState<{ key: string; phase: Phase }>(() => ({ key, phase: 'idle' }));

  let phase: Phase = state.key === key ? state.phase : 'idle';
  if (phase === 'pressed' && busy) phase = 'running';
  if (phase === 'running' && !busy) phase = failing ? 'idle' : 'done';
  if (phase === 'done' && failing) phase = 'idle';

  if (state.key !== key || state.phase !== phase) setState({ key, phase });

  // The key stays the one the state holds: a press belongs to what the surface shows when it is made.
  const begin = useCallback(() => setState((s) => ({ key: s.key, phase: 'pressed' })), []);

  return { outcome: phase === 'running' ? 'retrying' : phase === 'done' ? 'worked' : 'none', begin };
}
