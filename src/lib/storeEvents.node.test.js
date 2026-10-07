// src/lib/storeEvents.node.test.js — the `store-changed` subscription layer: the one window listener (attached by the
// first subscriber, never detached), the versions it counts (every event; one kind's; one item's), the fan-out and its
// removal rules, and savePreference's write-plus-event. EVERY test runs vi.resetModules() and imports the module inside
// its stand-ins: the listener binds to the window present at the first subscribe and the counters only grow, so a
// shared instance would carry one test's state into the next. store.js is re-imported with it, with a fresh
// LocalStorageBackend set before any write, and versions are asserted as deltas, never as absolutes.
import { describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { memoryStorage, withGlobals, fakeWindow } from '../../test/helpers/globals.js';

/** A fresh store and storeEvents pair, loaded after the stand-ins are in place. */
async function load() {
  vi.resetModules();
  const store = await import('./store.js');
  store.setBackend(new store.LocalStorageBackend());
  const events = await import('./storeEvents.js');
  return { store, events };
}

const PREF_X = { kind: 'pref', id: 'x' };
const POSITION_X = { kind: 'position', id: 'x' };
const storeChanged = (win) => win.events.filter((e) => e.type === 'store-changed');

/** Every scope a reader can follow, read at once; deltas are taken between two of these. */
const versions = (events) => ({
  all: events.getStoreVersion(),
  pref: events.getStoreVersion('pref'),
  prefX: events.getStoreVersion('pref', 'x'),
  prefY: events.getStoreVersion('pref', 'y'),
  position: events.getStoreVersion('position'),
  positionX: events.getStoreVersion('position', 'x'),
});
const delta = (before, after) => Object.fromEntries(Object.keys(before).map((k) => [k, after[k] - before[k]]));
const every = (n) => ({ all: n, pref: n, prefX: n, prefY: n, position: n, positionX: n });

describe('storeEvents', () => {
  it('without a window: subscribeStore returns a no-op, the versions stay 0 and savePreference still writes', async () => {
    const storage = memoryStorage();
    await withGlobals({ localStorage: storage, window: undefined }, async (warnings) => {
      const { events } = await load();
      const unsubscribe = events.subscribeStore(() => {});
      assert.equal(typeof unsubscribe, 'function');
      assert.doesNotThrow(() => { unsubscribe(); unsubscribe(); });
      assert.deepEqual(versions(events), every(0));
      events.savePreference('sidebarWidth', 300);
      assert.equal(storage.getItem('chat_sidebar_w'), '300', 'the write does not need a window');
      assert.deepEqual(versions(events), every(0));
      assert.deepEqual(warnings, []);
    });
  });

  it('the first subscriber attaches the one window listener and bumps every version once; a second attaches nothing', async () => {
    const win = fakeWindow();
    await withGlobals({ localStorage: memoryStorage(), window: win }, async () => {
      const { events } = await load();
      const before = versions(events);
      assert.equal(win.listenerCount('store-changed'), 0, 'importing attaches nothing');
      events.subscribeStore(() => {});
      assert.equal(win.listenerCount('store-changed'), 1);
      const afterFirst = versions(events);
      assert.deepEqual(delta(before, afterFirst), every(1));
      events.subscribeStore(() => {});
      assert.equal(win.listenerCount('store-changed'), 1);
      assert.deepEqual(delta(afterFirst, versions(events)), every(0));
    });
  });

  it('every subscriber gets each event: a CustomEvent detail as it is, an event without one as null', async () => {
    const win = fakeWindow();
    await withGlobals({ localStorage: memoryStorage(), window: win }, async () => {
      const { events } = await load();
      const seenA = [];
      const seenB = [];
      events.subscribeStore((detail) => seenA.push(detail));
      events.subscribeStore((detail) => seenB.push(detail));
      win.dispatchEvent(new CustomEvent('store-changed', { detail: PREF_X }));
      win.dispatchEvent({ type: 'store-changed' });
      win.dispatchEvent(new CustomEvent('store-changed'));
      assert.deepEqual(seenA, [PREF_X, null, null]);
      assert.deepEqual(seenB, seenA);
    });
  });

  it('each event moves the total; a detail moves its kind and its item only; a no-detail event moves every version', async () => {
    const win = fakeWindow();
    await withGlobals({ localStorage: memoryStorage(), window: win }, async () => {
      const { events } = await load();
      events.subscribeStore(() => {});
      const base = versions(events);
      win.dispatchEvent(new CustomEvent('store-changed', { detail: PREF_X }));
      const afterPref = versions(events);
      assert.deepEqual(delta(base, afterPref), { all: 1, pref: 1, prefX: 1, prefY: 0, position: 0, positionX: 0 });
      win.dispatchEvent(new CustomEvent('store-changed', { detail: POSITION_X }));
      const afterPosition = versions(events);
      assert.deepEqual(delta(afterPref, afterPosition), { all: 1, pref: 0, prefX: 0, prefY: 0, position: 1, positionX: 1 });
      win.dispatchEvent({ type: 'store-changed' });
      assert.deepEqual(delta(afterPosition, versions(events)), every(1));
    });
  });

  it('a listener removed earlier in the same dispatch does not run, one removing itself finishes, and neither gets a later event', async () => {
    const win = fakeWindow();
    await withGlobals({ localStorage: memoryStorage(), window: win }, async () => {
      const { events } = await load();
      const calls = [];
      let unsubscribeB = () => {};
      events.subscribeStore(() => { calls.push('A'); unsubscribeB(); });
      unsubscribeB = events.subscribeStore(() => { calls.push('B'); });
      const unsubscribeC = events.subscribeStore(() => { calls.push('C'); unsubscribeC(); calls.push('C done'); });
      win.dispatchEvent({ type: 'store-changed' });
      assert.deepEqual(calls, ['A', 'C', 'C done']);
      calls.length = 0;
      win.dispatchEvent({ type: 'store-changed' });
      assert.deepEqual(calls, ['A']);
    });
  });

  it('unsubscribing twice is a no-op and leaves the other subscribers in place', async () => {
    const win = fakeWindow();
    await withGlobals({ localStorage: memoryStorage(), window: win }, async () => {
      const { events } = await load();
      const calls = [];
      const unsubscribeA = events.subscribeStore(() => calls.push('A'));
      events.subscribeStore(() => calls.push('B'));
      unsubscribeA();
      assert.doesNotThrow(unsubscribeA);
      win.dispatchEvent({ type: 'store-changed' });
      assert.deepEqual(calls, ['B']);
    });
  });

  it('after the last unsubscribe the window listener stays and keeps counting: a later subscriber reads the moved version', async () => {
    const win = fakeWindow();
    await withGlobals({ localStorage: memoryStorage(), window: win }, async () => {
      const { events } = await load();
      const unsubscribe = events.subscribeStore(() => {});
      unsubscribe();
      assert.equal(win.listenerCount('store-changed'), 1, 'never detached');
      const before = versions(events);
      win.dispatchEvent({ type: 'store-changed' });
      assert.deepEqual(delta(before, versions(events)), every(1), 'counted with nobody subscribed');
      const seen = [];
      events.subscribeStore((detail) => seen.push(detail));
      assert.equal(win.listenerCount('store-changed'), 1, 'attached once for the page');
      assert.deepEqual(delta(before, versions(events)), every(1), 'no second attach, so no second bump');
      win.dispatchEvent(new CustomEvent('store-changed', { detail: PREF_X }));
      assert.deepEqual(seen, [PREF_X]);
    });
  });

  it("savePreference writes the JSON through the backend and dispatches one store-changed with { kind: 'pref', id: name }; null removes the key", async () => {
    const storage = memoryStorage();
    const win = fakeWindow();
    await withGlobals({ localStorage: storage, window: win }, async (warnings) => {
      const { events } = await load();
      const seen = [];
      events.subscribeStore((detail) => seen.push(detail));
      events.savePreference('sidebarWidth', 300);
      assert.equal(storage.getItem('chat_sidebar_w'), '300');
      assert.equal(storeChanged(win).length, 1);
      assert.deepEqual(storeChanged(win)[0].detail, { kind: 'pref', id: 'sidebarWidth' });
      assert.deepEqual(seen, [{ kind: 'pref', id: 'sidebarWidth' }]);
      events.savePreference('section_test', false); // a name outside PREF_MAP is its own key, as for setPreference
      assert.equal(storage.getItem('section_test'), 'false');
      events.savePreference('sidebarWidth', null);
      assert.equal(storage.getItem('chat_sidebar_w'), null);
      assert.deepEqual(storeChanged(win).map((e) => e.detail), [
        { kind: 'pref', id: 'sidebarWidth' }, { kind: 'pref', id: 'section_test' }, { kind: 'pref', id: 'sidebarWidth' },
      ]);
      assert.equal(seen.length, 3);
      assert.deepEqual(warnings, []);
    });
  });

  it('a listener subscribed during a dispatch gets the next event, not the one in flight; one re-subscribing itself in its callback runs once per event', async () => {
    const win = fakeWindow();
    await withGlobals({ localStorage: memoryStorage(), window: win }, async () => {
      const { events } = await load();
      const calls = [];
      let lateSubscribed = false;
      events.subscribeStore(() => {
        calls.push('A');
        if (!lateSubscribed) { lateSubscribed = true; events.subscribeStore(() => calls.push('late')); }
      });
      let resubscribed = false;
      let unsubscribeB = () => {};
      const listenerB = () => {
        calls.push('B');
        if (!resubscribed) { resubscribed = true; unsubscribeB(); unsubscribeB = events.subscribeStore(listenerB); }
      };
      unsubscribeB = events.subscribeStore(listenerB);
      win.dispatchEvent({ type: 'store-changed' });
      assert.deepEqual(calls, ['A', 'B'], 'the dispatch runs over a copy: neither the late subscriber nor the re-added B is reached');
      calls.length = 0;
      win.dispatchEvent({ type: 'store-changed' });
      assert.deepEqual([...calls].sort(), ['A', 'B', 'late'], 'both are subscribed for the next event');
    });
  });

  it('a kind outside the three (a JS caller) reads as a number, the whole-store count until its own events move it, never NaN', async () => {
    const win = fakeWindow();
    await withGlobals({ localStorage: memoryStorage(), window: win }, async () => {
      const { events } = await load();
      events.subscribeStore(() => {});
      const read = () => ({ ...versions(events), positions: events.getStoreVersion('positions'), positionsX: events.getStoreVersion('positions', 'x') });
      const base = read();
      assert.ok(Number.isInteger(base.positions), `a number, not ${base.positions}`);
      assert.equal(base.positions, base.position, 'without events of its own it reads the whole-store count, as a known kind without events does');
      win.dispatchEvent(new CustomEvent('store-changed', { detail: { kind: 'positions', id: 'x' } }));
      const afterOwn = read();
      assert.deepEqual(delta(base, afterOwn), { ...every(0), all: 1, positions: 1, positionsX: 1 });
      win.dispatchEvent({ type: 'store-changed' });
      assert.deepEqual(delta(afterOwn, read()), { ...every(1), positions: 1, positionsX: 1 });
    });
  });
});
