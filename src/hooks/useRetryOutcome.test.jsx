// src/hooks/useRetryOutcome.test.jsx — how a pressed Retry went, through each phase: rendered bare and under StrictMode,
// re-rendered through the `busy` and `failing` a surface passes while its data hooks load. A press says nothing until
// its load starts; a load no press started says nothing at all (the silent refresh).
import { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRetryOutcome } from './useRetryOutcome.js';

const MODES = [['bare', undefined], ['StrictMode', StrictMode]];

function setup(initial, wrapper) {
  return renderHook(({ busy, failing, k }) => useRetryOutcome(busy, failing, k), { initialProps: initial, wrapper });
}

const press = (result) => act(() => { result.current.begin(); });

describe.each(MODES)('useRetryOutcome (%s)', (_mode, wrapper) => {
  it("a pressed Retry that works: 'retrying' while its load runs, then 'worked'", () => {
    const { result, rerender } = setup({ busy: false, failing: true, k: 'AVGO' }, wrapper);
    expect(result.current.outcome).toBe('none');
    press(result);
    expect(result.current.outcome).toBe('none'); // the load has not started yet
    rerender({ busy: true, failing: true, k: 'AVGO' });
    expect(result.current.outcome).toBe('retrying');
    rerender({ busy: false, failing: false, k: 'AVGO' });
    expect(result.current.outcome).toBe('worked');
    rerender({ busy: false, failing: false, k: 'AVGO' });
    expect(result.current.outcome).toBe('worked');
  });

  it("a pressed Retry that fails again: 'retrying', then 'none' (the failure line is the outcome)", () => {
    const { result, rerender } = setup({ busy: false, failing: true, k: 'AVGO' }, wrapper);
    press(result);
    rerender({ busy: true, failing: true, k: 'AVGO' });
    expect(result.current.outcome).toBe('retrying');
    rerender({ busy: false, failing: true, k: 'AVGO' });
    expect(result.current.outcome).toBe('none');
  });

  it("'worked' gives way to a later failure", () => {
    const { result, rerender } = setup({ busy: false, failing: true, k: 'AVGO' }, wrapper);
    press(result);
    rerender({ busy: true, failing: true, k: 'AVGO' });
    rerender({ busy: false, failing: false, k: 'AVGO' });
    expect(result.current.outcome).toBe('worked');
    rerender({ busy: false, failing: true, k: 'AVGO' });
    expect(result.current.outcome).toBe('none');
  });

  it("stays 'none' for a press that no load follows", () => {
    const { result, rerender } = setup({ busy: false, failing: true, k: 'AVGO' }, wrapper);
    press(result);
    rerender({ busy: false, failing: true, k: 'AVGO' });
    rerender({ busy: false, failing: false, k: 'AVGO' });
    expect(result.current.outcome).toBe('none');
  });

  it("stays 'none' for a load that no press started (the silent refresh), failing or not", () => {
    const { result, rerender } = setup({ busy: false, failing: true, k: 'AVGO' }, wrapper);
    rerender({ busy: true, failing: true, k: 'AVGO' });
    expect(result.current.outcome).toBe('none');
    rerender({ busy: false, failing: true, k: 'AVGO' });
    expect(result.current.outcome).toBe('none');
    rerender({ busy: true, failing: true, k: 'AVGO' });
    rerender({ busy: false, failing: false, k: 'AVGO' });
    expect(result.current.outcome).toBe('none');
  });

  it("a new key goes back to 'none', from a running retry and from a pending press", () => {
    const { result, rerender } = setup({ busy: false, failing: true, k: 'AVGO' }, wrapper);
    press(result);
    rerender({ busy: true, failing: true, k: 'AVGO' });
    expect(result.current.outcome).toBe('retrying');
    rerender({ busy: true, failing: false, k: 'NVDA' });
    expect(result.current.outcome).toBe('none');
    rerender({ busy: false, failing: false, k: 'NVDA' });
    expect(result.current.outcome).toBe('none');

    rerender({ busy: false, failing: true, k: 'NVDA' });
    press(result);
    rerender({ busy: false, failing: true, k: 'MSFT' });
    rerender({ busy: true, failing: true, k: 'MSFT' });
    expect(result.current.outcome).toBe('none');
  });

  it('begin keeps its identity across renders', () => {
    const { result, rerender } = setup({ busy: false, failing: true, k: 'AVGO' }, wrapper);
    const { begin } = result.current;
    rerender({ busy: true, failing: true, k: 'AVGO' });
    rerender({ busy: false, failing: false, k: 'NVDA' });
    expect(result.current.begin).toBe(begin);
  });
});
