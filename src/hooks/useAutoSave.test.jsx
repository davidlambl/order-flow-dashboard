// src/hooks/useAutoSave.test.jsx — the React half of auto-save (roadmap D7): a primed value is never written (StrictMode
// included), the 600 ms debounce keeps the latest value and the save function current when it was scheduled, the
// "Saved" flash lasts 1500 ms, and flush(), unmount and pagehide write an edit still inside the debounce window.
// The debounce and baseline compare themselves are unit-tested in src/lib/debouncedSaver.node.test.js.
// No network here, so plain fake timers and synchronous act.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAutoSave } from './useAutoSave.js';

const advance = (ms) => act(() => { vi.advanceTimersByTime(ms); });

/** Render the hook with `save` as a prop, so a rerender can swap it. */
const renderAutoSave = (save, options) => renderHook(({ fn }) => useAutoSave(fn), { initialProps: { fn: save }, ...options });

describe('useAutoSave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never writes the primed value, even on unmount', () => {
    const save = vi.fn();
    const { result, unmount } = renderAutoSave(save);
    let queued;
    act(() => {
      result.current.prime('a');
      queued = result.current.schedule('a');
    });
    expect(queued).toBe(false);
    advance(10_000);
    unmount();
    expect(save).not.toHaveBeenCalled();
  });

  it('under StrictMode the double mount writes nothing, and an edit is written once', () => {
    const save = vi.fn();
    const { result, unmount } = renderAutoSave(save, { wrapper: StrictMode });
    act(() => {
      result.current.prime('a');
      result.current.schedule('a');
    });
    advance(10_000);
    expect(save).not.toHaveBeenCalled();

    act(() => { result.current.schedule('b'); });
    advance(600);
    unmount();
    expect(save.mock.calls).toEqual([['b']]);
  });

  it('priming drops a pending edit without writing it', () => {
    const save = vi.fn();
    const { result } = renderAutoSave(save);
    act(() => { result.current.schedule('draft'); });
    act(() => { result.current.prime('stored'); });
    advance(10_000);
    expect(save).not.toHaveBeenCalled();
  });

  it('debounces 600 ms after the last edit and writes only the latest value', () => {
    const save = vi.fn();
    const { result } = renderAutoSave(save);
    act(() => { result.current.prime('a'); });
    let queued;
    act(() => { queued = result.current.schedule('b'); });
    expect(queued).toBe(true);
    advance(500);
    act(() => { result.current.schedule('c'); });
    advance(599);
    expect(save).not.toHaveBeenCalled();
    advance(1);
    expect(save.mock.calls).toEqual([['c']]);
  });

  it('an edit back to the saved value cancels the pending write', () => {
    const save = vi.fn();
    const { result } = renderAutoSave(save);
    act(() => { result.current.prime('a'); });
    act(() => { result.current.schedule('b'); });
    act(() => { result.current.schedule('a'); });
    advance(10_000);
    expect(save).not.toHaveBeenCalled();
  });

  it('the delay argument replaces the 600 ms default', () => {
    const save = vi.fn();
    const { result } = renderHook(() => useAutoSave(save, 200));
    act(() => { result.current.schedule('b'); });
    advance(199);
    expect(save).not.toHaveBeenCalled();
    advance(1);
    expect(save.mock.calls).toEqual([['b']]);
  });

  it('writes with the save function current when the edit was scheduled', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderAutoSave(first);
    act(() => { result.current.schedule('for-first'); });
    rerender({ fn: second });
    advance(600);
    expect(first.mock.calls).toEqual([['for-first']]);
    expect(second).not.toHaveBeenCalled();

    act(() => { result.current.schedule('for-second'); });
    advance(600);
    expect(second.mock.calls).toEqual([['for-second']]);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('saved turns true on a write and false 1500 ms later; a new edit clears it at once', () => {
    const { result } = renderAutoSave(vi.fn());
    act(() => { result.current.schedule('b'); });
    expect(result.current.saved).toBe(false);
    advance(600);
    expect(result.current.saved).toBe(true);
    advance(1499);
    expect(result.current.saved).toBe(true);
    advance(1);
    expect(result.current.saved).toBe(false);

    act(() => { result.current.schedule('c'); });
    advance(600);
    expect(result.current.saved).toBe(true);
    act(() => { result.current.schedule('d'); });
    expect(result.current.saved).toBe(false);
  });

  it('a second write restarts the 1500 ms flash', () => {
    const { result } = renderAutoSave(vi.fn());
    act(() => { result.current.schedule('b'); });
    advance(600); // written at t = 600
    act(() => { result.current.schedule('c'); });
    advance(600); // written at t = 1200
    advance(900); // t = 2100, past the first write's fade
    expect(result.current.saved).toBe(true);
    advance(599);
    expect(result.current.saved).toBe(true);
    advance(1);
    expect(result.current.saved).toBe(false);
  });

  it('flush() writes the pending edit at once and returns true; with nothing pending it returns false', () => {
    const save = vi.fn();
    const { result } = renderAutoSave(save);
    act(() => { result.current.schedule('b'); });
    let flushed;
    act(() => { flushed = result.current.flush(); });
    expect(flushed).toBe(true);
    expect(save.mock.calls).toEqual([['b']]);
    expect(result.current.saved).toBe(true);

    advance(10_000);
    act(() => { flushed = result.current.flush(); });
    expect(flushed).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('unmounting inside the debounce window writes the edit', () => {
    const save = vi.fn();
    const { result, unmount } = renderAutoSave(save);
    act(() => { result.current.schedule('b'); });
    advance(300);
    unmount();
    expect(save.mock.calls).toEqual([['b']]);
    advance(10_000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('pagehide writes the pending edit', () => {
    const save = vi.fn();
    const { result } = renderAutoSave(save);
    act(() => { result.current.schedule('b'); });
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(save.mock.calls).toEqual([['b']]);
    advance(10_000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('prime, schedule and flush keep their identity across rerenders and writes', () => {
    const { result, rerender } = renderAutoSave(vi.fn());
    const { prime, schedule, flush } = result.current;
    rerender({ fn: vi.fn() });
    act(() => { result.current.schedule('b'); });
    advance(600);
    expect(result.current.saved).toBe(true);
    expect(result.current.prime).toBe(prime);
    expect(result.current.schedule).toBe(schedule);
    expect(result.current.flush).toBe(flush);
  });
});
