// src/hooks/useLastFailure.test.jsx — a data hook's failure kept until a load succeeds or the key changes, in the same
// render: rendered bare and under StrictMode, re-rendered through the transitions the data hooks really produce (a
// query with no data loses its error while the next fetch runs). Every render's return value is recorded, so a test
// can say that no render ever showed the gap.
import { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useLastFailure } from './useLastFailure.js';

const MODES = [['bare', undefined], ['StrictMode', StrictMode]];

/** The hook over `props`, every render's answer in `seen`. */
function setup(initial, wrapper) {
  const seen = [];
  const view = renderHook(({ error, loaded, k }) => {
    const value = useLastFailure(error, loaded, k);
    seen.push(value);
    return value;
  }, { initialProps: initial, wrapper });
  return { ...view, seen };
}

describe.each(MODES)('useLastFailure (%s)', (_mode, wrapper) => {
  it('returns the error as it stands, and null while nothing failed', () => {
    const { result, rerender } = setup({ error: null, loaded: false, k: 'AVGO' }, wrapper);
    expect(result.current).toBeNull(); // a first load under way: nothing failed yet
    rerender({ error: null, loaded: true, k: 'AVGO' });
    expect(result.current).toBeNull();
    rerender({ error: 'Down', loaded: true, k: 'AVGO' });
    expect(result.current).toBe('Down');
  });

  it('keeps the failure through the next request of a query with no data, never returning the gap', () => {
    const { result, rerender, seen } = setup({ error: 'Down', loaded: false, k: 'AVGO' }, wrapper);
    expect(result.current).toBe('Down');
    seen.length = 0;
    rerender({ error: null, loaded: false, k: 'AVGO' }); // the fetch started: TanStack cleared the error
    rerender({ error: null, loaded: false, k: 'AVGO' });
    expect(seen.every((value) => value === 'Down')).toBe(true);
    rerender({ error: 'Down again', loaded: false, k: 'AVGO' }); // it failed again, another reason
    expect(result.current).toBe('Down again');
  });

  it('forgets the failure once a load succeeds', () => {
    const { result, rerender } = setup({ error: 'Down', loaded: false, k: 'AVGO' }, wrapper);
    rerender({ error: null, loaded: false, k: 'AVGO' });
    expect(result.current).toBe('Down');
    rerender({ error: null, loaded: true, k: 'AVGO' });
    expect(result.current).toBeNull();
    rerender({ error: null, loaded: false, k: 'AVGO' }); // a later reset: nothing to keep
    expect(result.current).toBeNull();
  });

  it("a new key returns the new key's error in its first render, forgetting the old one's", () => {
    const { result, rerender, seen } = setup({ error: 'Down', loaded: false, k: 'AVGO' }, wrapper);
    seen.length = 0;
    rerender({ error: null, loaded: false, k: 'NVDA' });
    expect(seen.every((value) => value === null)).toBe(true);
    expect(result.current).toBeNull();
    seen.length = 0;
    rerender({ error: 'Refused', loaded: false, k: 'MSFT' });
    expect(seen.every((value) => value === 'Refused')).toBe(true);
    rerender({ error: null, loaded: false, k: 'MSFT' });
    expect(result.current).toBe('Refused');
  });

  it('the same value on a re-render that changes nothing (a string or null, never a new object)', () => {
    const { result, rerender } = setup({ error: 'Down', loaded: false, k: 'AVGO' }, wrapper);
    const first = result.current;
    rerender({ error: 'Down', loaded: false, k: 'AVGO' });
    expect(result.current).toBe(first);
  });
});
