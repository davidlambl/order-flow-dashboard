// src/hooks/useStoreValue.test.jsx — the store hooks' observable contract: a primitive read re-renders only when its
// value changes; usePreference reads and writes a preference and counts a non-primitive stored value as unset;
// useStoreObject keeps its reference until its own item, the whole store or its key changes; and the one
// `store-changed` window listener is attached by the first subscriber and never removed. storeEvents.ts is one module
// instance for the whole file (its listener outlives every test), so listeners are counted by event type and relative
// to the test, and no version is asserted as an absolute; the one test that needs a first subscriber (decision 11)
// loads a fresh instance of its own. src/test/setup.js clears localStorage after each test.
import { StrictMode, useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import { emitStoreChanged, getPosition, getPreference, setPosition } from '../lib/store.js';
import { getStoreVersion, savePreference } from '../lib/storeEvents.js';
import { usePreference, useStoreObject, useStoreValue } from './useStoreValue.js';

// Not a PREF_MAP name, so the localStorage key is the name itself (as CollapsibleSection's test reads it).
const KEY = 'section_test';

/** What an import, a cloud pull or another tab does after rewriting storage: a store-changed without detail. */
const emitWhole = () => act(() => { window.dispatchEvent(new Event('store-changed')); });
/** What a writer of one item does. */
const emitItem = (kind, id) => act(() => { emitStoreChanged({ kind, id }); });

/**
 * A Reader that shows the ticker's stored cost basis, with a child Writer that writes the position and emits its
 * detail from its mount effect (App's own "write then emitStoreChanged" shape): the write lands after the parent's
 * first render and before its subscribe. Built over the store and hook functions it is given: the file's instance
 * (below) or a fresh one (the decision-11 test).
 */
function readerFor({ useStoreObject: useObject, getPosition: readPosition, setPosition: writePosition, emitStoreChanged: emit }) {
  function Writer({ ticker }) {
    useEffect(() => {
      writePosition(ticker, { costBasis: 77, shares: 7 });
      emit({ kind: 'position', id: ticker });
    }, [ticker]);
    return null;
  }
  return function Reader({ ticker }) {
    const position = useObject(() => readPosition(ticker), ticker, 'position', ticker);
    return (
      <>
        <span>{`cost ${String(position.costBasis)}`}</span>
        <Writer ticker={ticker} />
      </>
    );
  };
}
const Reader = readerFor({ useStoreObject, getPosition, setPosition, emitStoreChanged });

/** A section as CollapsibleSection will read it: the stored choice, or "unset". */
function Section() {
  const [saved] = usePreference(KEY);
  return <span>{`section ${String(saved ?? 'unset')}`}</span>;
}

describe('useStoreValue hooks', () => {
  // On a fresh module instance (vi.resetModules() and dynamic imports; React is external to the module graph, so the
  // renderer is the same one), so that this mount is the instance's first subscriber wherever the test sits in the
  // file: the one window listener is attached by the first subscriber and never detached, so only a first mount can
  // miss an event dispatched between its render and its subscribe, and on the file's shared instance an earlier
  // test's subscriber would have attached the listener, which then counts the child's event and masks a missing
  // attach bump. Red on an attach that does not bump the versions.
  it("Regression (decision 11): a parent's useStoreObject shows the position its child wrote and emitted in a mount effect", async () => {
    vi.resetModules();
    const store = await import('../lib/store.js');
    const events = await import('../lib/storeEvents.js');
    const hooks = await import('./useStoreValue.js');
    const FreshReader = readerFor({
      useStoreObject: hooks.useStoreObject,
      getPosition: store.getPosition,
      setPosition: store.setPosition,
      emitStoreChanged: store.emitStoreChanged,
    });
    expect(events.getStoreVersion()).toBe(0); // nobody has subscribed on this instance: the mount below is its first
    const adds = vi.spyOn(window, 'addEventListener');

    render(<FreshReader ticker="AVGO" />);
    expect(adds.mock.calls.filter(([type]) => type === 'store-changed')).toHaveLength(1); // and it attached the listener
    expect(screen.getByText('cost 77')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('position_AVGO'))).toEqual({ costBasis: 77, shares: 7 });
  });

  // Green even without the attach bump: StrictMode re-runs the child's effect after the parent has subscribed.
  it('Pin: the same under StrictMode, with no error logged', () => {
    const error = vi.spyOn(console, 'error');
    render(
      <StrictMode>
        <Reader ticker="NVDA" />
      </StrictMode>,
    );
    expect(screen.getByText('cost 77')).toBeInTheDocument();
    expect(error).not.toHaveBeenCalled();
  });

  it('useStoreValue reads the stored JSON, re-renders when it changes and not for a store-changed that leaves it as it was', () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useStoreValue(() => getPreference(KEY));
    });
    expect(result.current).toBeNull();

    localStorage.setItem(KEY, 'true');
    emitWhole();
    expect(result.current).toBe(true);

    const before = renders;
    emitWhole();
    emitItem('pref', KEY);
    emitItem('position', 'AVGO');
    expect(result.current).toBe(true);
    expect(renders).toBe(before);
  });

  it('usePreference returns [value, write]; write(false) stores "false" and shows false within the act; the writer is stable per name', () => {
    const { result, rerender } = renderHook(({ name }) => usePreference(name), { initialProps: { name: KEY } });
    expect(result.current[0]).toBeNull();
    const write = result.current[1];

    act(() => { write(false); });
    expect(localStorage.getItem(KEY)).toBe('false');
    expect(result.current[0]).toBe(false);
    expect(result.current[1]).toBe(write);

    rerender({ name: KEY });
    expect(result.current[1]).toBe(write);

    rerender({ name: 'section_other' });
    expect(result.current[1]).not.toBe(write);
    expect(result.current[0]).toBeNull();

    act(() => { result.current[1](true); });
    expect(localStorage.getItem('section_other')).toBe('true');
    expect(result.current[0]).toBe(true);
    act(() => { result.current[1](null); });
    expect(localStorage.getItem('section_other')).toBeNull();
    expect(result.current[0]).toBeNull();
  });

  it('Regression (decision 12): usePreference reads a stored JSON object or array as null, without looping or logging', () => {
    const error = vi.spyOn(console, 'error');
    localStorage.setItem(KEY, '{"a":1}');
    const { result } = renderHook(() => usePreference(KEY));
    expect(result.current[0]).toBeNull();
    emitWhole();
    expect(result.current[0]).toBeNull();

    localStorage.setItem(KEY, '[1,2]');
    emitItem('pref', KEY);
    expect(result.current[0]).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it('Regression (decision 10): useStoreObject keeps its reference until its own item or the whole store changes', () => {
    const { result, rerender } = renderHook(
      ({ ticker }) => useStoreObject(() => getPosition(ticker), ticker, 'position', ticker),
      { initialProps: { ticker: 'AVGO' } },
    );
    const first = result.current;
    expect(first).toEqual({ costBasis: null, shares: null });

    rerender({ ticker: 'AVGO' }); // an unrelated re-render passes a new read function
    expect(result.current).toBe(first);
    act(() => { savePreference(KEY, true); });
    expect(result.current).toBe(first);
    emitItem('position', 'NVDA');
    expect(result.current).toBe(first);

    emitWhole();
    const second = result.current;
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
    emitItem('position', 'AVGO');
    expect(result.current).not.toBe(second);
    expect(result.current).toEqual(first);
  });

  it('adds the window store-changed listener at most once across a test and never removes it', () => {
    const adds = vi.spyOn(window, 'addEventListener');
    const removes = vi.spyOn(window, 'removeEventListener');
    const ofStore = (spy) => spy.mock.calls.filter(([type]) => type === 'store-changed').length;

    const a = renderHook(() => useStoreValue(() => getPreference(KEY)));
    const b = renderHook(() => usePreference(KEY));
    a.unmount();
    b.unmount();
    const c = renderHook(() => useStoreObject(() => getPosition('AVGO'), 'AVGO', 'position', 'AVGO'));
    c.unmount();
    const d = renderHook(() => usePreference(KEY));

    expect(ofStore(adds)).toBeLessThanOrEqual(1);
    expect(ofStore(removes)).toBe(0);
    act(() => { savePreference(KEY, false); });
    expect(d.result.current[0]).toBe(false); // the remounted hook still follows the store
  });

  it('Pin: a hook inside <StrictMode> shows the stored value, follows a save and logs no error', () => {
    const error = vi.spyOn(console, 'error');
    localStorage.setItem(KEY, 'false');
    render(
      <StrictMode>
        <Section />
      </StrictMode>,
    );
    expect(screen.getByText('section false')).toBeInTheDocument();
    act(() => { savePreference(KEY, true); });
    expect(screen.getByText('section true')).toBeInTheDocument();
    expect(error).not.toHaveBeenCalled();
  });

  // The key check on its own. App's ticker switch is between two positions whose scoped versions are usually EQUAL
  // (the position saver writes silently, so neither item has had an event and both read the whole-store count), and
  // then only the key comparison makes the switch show the new ticker's position. The versions are asserted equal
  // before the switch and unchanged after it, so the version cannot be what triggered the re-read. Red on a snapshot
  // compared by its version alone (the decision-10 test's AVGO and NVDA have had item events by then, so their
  // versions differ and a key switch between them re-reads on the version alone).
  it("Regression (decision 4): useStoreObject re-reads for a new key whose version equals the old key's, scoped and unscoped", () => {
    localStorage.setItem('position_MSFT', JSON.stringify({ costBasis: 80, shares: 2 }));
    const scopedVersions = () => [getStoreVersion('position', 'TSLA'), getStoreVersion('position', 'MSFT')];

    const scoped = renderHook(
      ({ ticker }) => useStoreObject(() => getPosition(ticker), ticker, 'position', ticker),
      { initialProps: { ticker: 'TSLA' } },
    );
    expect(scoped.result.current).toEqual({ costBasis: null, shares: null });
    const before = scopedVersions();
    expect(before[0]).toBe(before[1]); // neither TSLA nor MSFT has had an item event in this file
    scoped.rerender({ ticker: 'MSFT' });
    expect(scopedVersions()).toEqual(before);
    expect(scoped.result.current).toEqual({ costBasis: 80, shares: 2 });

    const unscoped = renderHook(
      ({ ticker }) => useStoreObject(() => getPosition(ticker), ticker),
      { initialProps: { ticker: 'TSLA' } },
    );
    expect(unscoped.result.current).toEqual({ costBasis: null, shares: null });
    const total = getStoreVersion();
    unscoped.rerender({ ticker: 'MSFT' });
    expect(getStoreVersion()).toBe(total);
    expect(unscoped.result.current).toEqual({ costBasis: 80, shares: 2 });
  });
});
