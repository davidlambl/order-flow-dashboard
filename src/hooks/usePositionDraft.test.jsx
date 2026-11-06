// src/hooks/usePositionDraft.test.jsx — the position draft's writer through renderHook under StrictMode, on the real
// store (its default LocalStorageBackend; nothing here builds another) and jsdom's localStorage, which
// src/test/setup.js clears after each test. What is stored for a ticker, and when (roadmap D10): an edit shows at once
// and is stored 300 ms after its last keystroke, one write per pause, a cleared field as null and a cleared pair as no
// stored position; a pagehide or an unmount inside the debounce stores the edit, and no save emits; a whole-store
// change or this ticker's position changing elsewhere stores a pending edit first and then shows the store, while
// another item's change is ignored, with no render; a ticker change alone hides the old ticker's edit, whose save
// still lands on its own ticker, and shows it again on the way back, while settle() in the same batch stores it and
// drops it; edits and the listener follow the new ticker; flush and settle keep one identity; one saver per mount. The
// real saver is counted through a pass-through mock; no network here, so plain fake timers and synchronous act.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { emitStoreChanged } from '../lib/store.js';
import { savePreference } from '../lib/storeEvents.js';
import { createSaver } from '../lib/debouncedSaver.js';
import { usePositionDraft } from './usePositionDraft.js';

vi.mock('../lib/debouncedSaver.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createSaver: vi.fn(actual.createSaver) };
});

/** The hook on `ticker`, a prop that rerender() changes; renders() counts its body's runs (StrictMode makes two). */
function mount(ticker = 'AVGO') {
  let count = 0;
  const hook = renderHook(({ t }) => {
    count += 1;
    return usePositionDraft(t);
  }, { initialProps: { t: ticker }, wrapper: StrictMode });
  return { ...hook, renders: () => count };
}

/** A ticker's stored position, parsed; null while it has none. */
const stored = (ticker = 'AVGO') => JSON.parse(localStorage.getItem(`position_${ticker}`) ?? 'null');
/** Another writer's position (an import, a cloud pull, another tab): straight into storage, with no event. */
const storeElsewhere = (ticker, costBasis, shares) => {
  localStorage.setItem(`position_${ticker}`, JSON.stringify({ costBasis, shares }));
};
/** What the inputs show: [costBasis, shares]. */
const shown = (result) => [result.current.costBasis, result.current.shares];
const advance = (ms) => act(() => { vi.advanceTimersByTime(ms); });
/** `store-changed` with this detail; null (or none) is a whole-store change. */
const emit = (detail) => act(() => { emitStoreChanged(detail); });

/** The position keys written from here on; restoreMocks puts the real setItem back before the next test. */
function positionWrites() {
  const setItem = vi.spyOn(Storage.prototype, 'setItem');
  return () => setItem.mock.calls.map(([key]) => key).filter((key) => key.startsWith('position_'));
}

/** Every `store-changed` detail from here on (null for a whole-store change). */
function storeEvents() {
  const details = [];
  const onChange = (e) => details.push(e.detail ?? null);
  window.addEventListener('store-changed', onChange);
  onTestFinished(() => window.removeEventListener('store-changed', onChange));
  return details;
}

describe('usePositionDraft', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps one saver for its life (StrictMode builds two at mount, keeps one) and runs no timer until an edit', () => {
    const before = createSaver.mock.calls.length;
    const writes = positionWrites();
    const { result, rerender } = mount();
    expect(createSaver.mock.calls.length - before).toBe(2);
    expect(vi.getTimerCount()).toBe(0);

    rerender({ t: 'AVGO' });
    rerender({ t: 'NVDA' });
    act(() => { result.current.update(95, null); });
    expect(createSaver.mock.calls.length - before).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
    expect(writes()).toEqual([]);
  });

  it('shows an edit at once and stores it 300 ms after the last keystroke, once per pause: cost, then shares', () => {
    const writes = positionWrites();
    const { result } = mount();
    expect(shown(result)).toEqual([null, null]);

    act(() => { result.current.update(9, null); }); // '9'
    advance(200);
    act(() => { result.current.update(95, null); }); // '95'
    expect(shown(result)).toEqual([95, null]);
    advance(100);
    expect(stored()).toBeNull(); // not yet: 100 ms after the last keystroke, 300 after the first
    advance(199);
    expect(stored()).toBeNull();
    advance(1);
    expect(stored()).toEqual({ costBasis: 95, shares: null });

    // A shares edit sends the whole draft, the cost beside it.
    act(() => { result.current.update(95, 10); });
    expect(shown(result)).toEqual([95, 10]);
    advance(299);
    expect(stored()).toEqual({ costBasis: 95, shares: null });
    advance(1);
    expect(stored()).toEqual({ costBasis: 95, shares: 10 });
    expect(writes()).toEqual(['position_AVGO', 'position_AVGO']); // the '9' was never written
    expect(vi.getTimerCount()).toBe(0);
    expect(shown(result)).toEqual([95, 10]);
  });

  it('stores a cleared field as null, and removes the stored position once both are cleared', () => {
    storeElsewhere('AVGO', 50, 1);
    const { result } = mount();
    expect(shown(result)).toEqual([50, 1]);

    act(() => { result.current.update(null, 1); });
    expect(shown(result)).toEqual([null, 1]);
    advance(300);
    expect(stored()).toEqual({ costBasis: null, shares: 1 });

    act(() => { result.current.update(null, null); });
    expect(shown(result)).toEqual([null, null]);
    advance(300);
    expect(localStorage.getItem('position_AVGO')).toBeNull();
  });

  it('with no edit typed shows the stored position, re-read when it or the whole store changes and per ticker', () => {
    storeElsewhere('AVGO', 50, 1);
    storeElsewhere('NVDA', 80, 2);
    const { result, rerender } = mount();
    expect(shown(result)).toEqual([50, 1]);

    storeElsewhere('AVGO', 60, 2);
    emit({ kind: 'position', id: 'AVGO' });
    expect(shown(result)).toEqual([60, 2]);
    storeElsewhere('AVGO', 70, 3);
    emit(null);
    expect(shown(result)).toEqual([70, 3]);
    localStorage.removeItem('position_AVGO');
    emit(null);
    expect(shown(result)).toEqual([null, null]);

    rerender({ t: 'NVDA' });
    expect(shown(result)).toEqual([80, 2]);
  });

  it("ignores another item's change, with no render: another ticker's position, this ticker's chat, a preference", () => {
    storeElsewhere('AVGO', 50, 1);
    const { result, renders } = mount();
    act(() => { result.current.update(95, 1); });
    const rendered = renders();

    const otherItems = [{ kind: 'position', id: 'NVDA' }, { kind: 'chat', id: 'AVGO' }, { kind: 'pref', id: 'AVGO' }];
    for (const detail of otherItems) {
      emit(detail);
      expect(shown(result)).toEqual([95, 1]);
      expect(stored()).toEqual({ costBasis: 50, shares: 1 }); // the edit is still inside its debounce
    }
    act(() => { savePreference('section_charts', false); }); // a section toggle
    expect(shown(result)).toEqual([95, 1]);
    expect(stored()).toEqual({ costBasis: 50, shares: 1 });
    expect(renders()).toBe(rendered);

    advance(300);
    expect(stored()).toEqual({ costBasis: 95, shares: 1 });
  });

  it.each([
    ["this ticker's position changing elsewhere (another tab)", { kind: 'position', id: 'AVGO' }],
    ['a whole-store change (an import, a cloud pull, a sign-out)', null],
  ])('%s: a pending edit is stored first and stays shown; an edit already stored yields to the store', (_, detail) => {
    storeElsewhere('AVGO', 50, 1);
    const { result } = mount();
    act(() => { result.current.update(95, 1); });
    storeElsewhere('AVGO', 70, 3);
    emit(detail);
    expect(stored()).toEqual({ costBasis: 95, shares: 1 }); // over the other writer's value, at once
    expect(shown(result)).toEqual([95, 1]);
    expect(vi.getTimerCount()).toBe(0);

    // An edit its own timer stored, then a change elsewhere: the store's value shows.
    act(() => { result.current.update(96, 1); });
    advance(300);
    expect(stored()).toEqual({ costBasis: 96, shares: 1 });
    storeElsewhere('AVGO', 70, 3);
    emit(detail);
    expect(shown(result)).toEqual([70, 3]);
    expect(stored()).toEqual({ costBasis: 70, shares: 3 });
  });

  it('pagehide stores a pending edit at once, leaving nothing pending; the edit stays shown and no save emits', () => {
    const events = storeEvents();
    const writes = positionWrites();
    const { result } = mount();
    act(() => { result.current.update(95, null); });

    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(stored()).toEqual({ costBasis: 95, shares: null });
    expect(shown(result)).toEqual([95, null]);
    expect(vi.getTimerCount()).toBe(0);

    act(() => { window.dispatchEvent(new Event('pagehide')); });
    advance(1_000);
    expect(writes()).toEqual(['position_AVGO']);
    expect(events).toEqual([]);
  });

  it('an unmount inside the debounce stores the edit, leaving no timer; with nothing pending it writes nothing', () => {
    const events = storeEvents();
    const writes = positionWrites();
    const first = mount();
    act(() => { first.result.current.update(95, null); });
    first.unmount();
    expect(stored()).toEqual({ costBasis: 95, shares: null });
    expect(vi.getTimerCount()).toBe(0);

    mount().unmount();
    expect(writes()).toEqual(['position_AVGO']);
    expect(events).toEqual([]);
  });

  it('a ticker change alone hides the old edit, whose save lands on its own ticker; on the way back it shows again', () => {
    storeElsewhere('NVDA', 80, 2);
    const { result, rerender } = mount();
    act(() => { result.current.update(95, null); });

    rerender({ t: 'NVDA' });
    expect(shown(result)).toEqual([80, 2]); // the edit was typed for AVGO
    act(() => { result.current.flush(); });
    expect(stored('AVGO')).toEqual({ costBasis: 95, shares: null });
    expect(stored('NVDA')).toEqual({ costBasis: 80, shares: 2 });

    // AVGO changes elsewhere while NVDA shows: back on AVGO the edit shows over that change, which is why a ticker
    // change settles first.
    storeElsewhere('AVGO', 70, 3);
    emit({ kind: 'position', id: 'AVGO' });
    rerender({ t: 'AVGO' });
    expect(shown(result)).toEqual([95, null]);
    expect(stored('AVGO')).toEqual({ costBasis: 70, shares: 3 });
  });

  it("settle() with the ticker change stores and drops the edit: on the way back the store's value shows", () => {
    storeElsewhere('NVDA', 80, 2);
    const { result, rerender } = mount();
    act(() => { result.current.update(95, null); });

    act(() => { // the ticker change: settle(), then the new ticker, in one handler
      result.current.settle();
      rerender({ t: 'NVDA' });
    });
    expect(stored('AVGO')).toEqual({ costBasis: 95, shares: null });
    expect(vi.getTimerCount()).toBe(0);
    expect(shown(result)).toEqual([80, 2]);

    storeElsewhere('AVGO', 70, 3);
    emit({ kind: 'position', id: 'AVGO' }); // AVGO changes elsewhere while NVDA shows
    act(() => {
      result.current.settle();
      rerender({ t: 'AVGO' });
    });
    expect(shown(result)).toEqual([70, 3]); // never the old edit
  });

  it('after a ticker change, edits and the store listener follow the new ticker', () => {
    storeElsewhere('NVDA', 80, 2);
    const { result, rerender } = mount();
    rerender({ t: 'NVDA' });
    act(() => { result.current.update(85, 2); });
    expect(shown(result)).toEqual([85, 2]);

    storeElsewhere('NVDA', 1, 1);
    emit({ kind: 'position', id: 'NVDA' });
    expect(stored('NVDA')).toEqual({ costBasis: 85, shares: 2 }); // the pending edit, written first
    expect(stored('AVGO')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flush and settle keep one identity for the hook's life, across rerenders, edits, writes, events and tickers", () => {
    const { result, rerender } = mount();
    const { flush, settle } = result.current;
    const same = () => {
      expect(result.current.flush).toBe(flush);
      expect(result.current.settle).toBe(settle);
    };

    rerender({ t: 'AVGO' });
    same();
    act(() => { result.current.update(1, 2); });
    same();
    advance(300);
    emit(null);
    same();
    act(() => { result.current.update(3, 4); });
    act(() => { result.current.flush(); });
    same();
    act(() => {
      result.current.settle();
      rerender({ t: 'NVDA' });
    });
    same();
  });
});
