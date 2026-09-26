// src/lib/clientLib.node.test.js — client-side helpers that must stay Node-loadable: retry backoff (F1), store quota
// containment (F18), threshold ordering. useMarketData itself is React-bound and has no test here; the backoff it
// schedules with does. Browser globals are stubbed per test with defineProperty (ES modules are strict) and always
// restored; a test that needs a module loaded after its stand-ins calls vi.resetModules() and imports it fresh.
import { describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { backoffSeconds } from './retry.js';
import { PUT_CALL, DARK_POOL_PCT, PNL_PCT, STALE_AFTER_MIN, RECOMMENDATION } from '../../shared/thresholds.js';
import { memoryStorage, withGlobals } from '../../test/helpers/globals.js';

describe('clientLib', () => {
  it('backoffSeconds: base × 2^failures, capped at 300 s by default or at capSecs', async () => {
    const series = (...args) => [0, 1, 2, 3, 4, 5].map((n) => backoffSeconds(args[0], n, ...args.slice(1)));
    assert.deepEqual(series(60), [60, 120, 240, 300, 300, 300]);
    assert.deepEqual(series(30), [30, 60, 120, 240, 300, 300]);
    assert.deepEqual(series(30, 100), [30, 60, 100, 100, 100, 100]);
    assert.equal(backoffSeconds(60, 1e6), 300, 'a huge count stays at the cap (never Infinity or NaN)');
  });

  it("backoffSeconds: negative, NaN, missing or non-numeric failures give the base; '2' coerces to 2; fractions floor", async () => {
    for (const bad of [-1, -3.5, Number.NaN, undefined, null, 'abc', {}]) {
      assert.equal(backoffSeconds(60, bad), 60, `failures=${String(bad)} should count as 0`);
    }
    assert.equal(backoffSeconds(60, '2'), 240, "a numeric string is coerced: '2' → 60 × 2^2");
    assert.equal(backoffSeconds(60, 1.9), 120, 'a fractional count is floored');
  });

  it('store: a full localStorage never throws; setPosition/setPreference/setChatHistory each warn once about the quota', async () => {
    await withGlobals({ localStorage: memoryStorage({ full: true }) }, async (warnings) => {
      vi.resetModules();
      const store = await import('./store.js'); // fresh instance, loaded after the stub
      for (const [what, key, write] of [
        ['setPosition', 'position_AVGO', () => store.setPosition('AVGO', { costBasis: 1, shares: 1 })],
        ['setPreference', 'chat_sidebar_w', () => store.setPreference('sidebarWidth', 300)],
        ['setChatHistory', 'chat_history_AVGO', () => store.setChatHistory('AVGO', [{ role: 'user', content: 'x' }])],
      ]) {
        warnings.length = 0;
        assert.doesNotThrow(write, `${what} must contain the quota error`);
        assert.equal(warnings.length, 1, `${what} should warn exactly once, warned ${warnings.length} times`);
        const [message, loggedKey] = warnings[0];
        assert.match(String(message), new RegExp(`^${what}: .*quota`), `${what} warning: ${message}`);
        assert.equal(loggedKey, key, `${what} warning should name the storage key`);
      }
    });
  });

  it('store: with room to write, values round-trip and null / empty values remove the key', async () => {
    const storage = memoryStorage();
    await withGlobals({ localStorage: storage }, async (warnings) => {
      vi.resetModules();
      const store = await import('./store.js');
      store.setPosition('AVGO', { costBasis: 101.5, shares: 10 });
      assert.deepEqual(store.getPosition('AVGO'), { costBasis: 101.5, shares: 10 });
      store.setPreference('sidebarWidth', 300);
      assert.equal(store.getPreference('sidebarWidth'), 300);
      store.setPreference('sidebarWidth', null);
      assert.equal(storage.map.has('chat_sidebar_w'), false, 'setPreference(name, null) removes the key');
      assert.equal(store.getPreference('sidebarWidth'), null);
      store.setChatHistory('AVGO', [{ role: 'user', content: 'x' }]);
      assert.deepEqual(store.getChatHistory('AVGO'), [{ role: 'user', content: 'x' }]);
      store.setChatHistory('AVGO', []);
      assert.equal(storage.map.has('chat_history_AVGO'), false, 'an empty chat history deletes the key');
      assert.deepEqual(warnings, [], 'successful writes must not warn');
    });
  });

  it('thresholds: bands are ordered (P/C, dark pool, P&L, staleness); RECOMMENDATION.minFactors >= 1', async () => {
    const ascending = (label, values) => {
      assert.ok(values.every((v) => Number.isFinite(v)), `${label}: every bound must be a finite number (got ${values.join(', ')})`);
      assert.ok(values.every((v, i) => i === 0 || values[i - 1] < v), `${label} (got ${values.join(', ')})`);
    };
    ascending('PUT_CALL.bullishBelow < bearishAbove', [PUT_CALL.bullishBelow, PUT_CALL.bearishAbove]);
    ascending('DARK_POOL_PCT.lowBelow < elevatedAbove', [DARK_POOL_PCT.lowBelow, DARK_POOL_PCT.elevatedAbove]);
    ascending('PNL_PCT.recoveryZoneAbove < 0 < moderateGainAbove < takeProfitAbove',
      [PNL_PCT.recoveryZoneAbove, 0, PNL_PCT.moderateGainAbove, PNL_PCT.takeProfitAbove]);
    ascending('STALE_AFTER_MIN.sessionOpen < sessionClosed', [STALE_AFTER_MIN.sessionOpen, STALE_AFTER_MIN.sessionClosed]);
    assert.ok(RECOMMENDATION.minFactors >= 1, `RECOMMENDATION.minFactors must be >= 1 (got ${RECOMMENDATION.minFactors})`);
  });

  it('Node-loadable: retry.js and store.js import with no DOM (no window, no localStorage)', async () => {
    await withGlobals({ localStorage: undefined, window: undefined }, async () => {
      assert.equal(typeof globalThis.localStorage, 'undefined');
      vi.resetModules();
      const retry = await import('./retry.js');
      const store = await import('./store.js');
      assert.equal(typeof retry.backoffSeconds, 'function');
      for (const name of ['getPosition', 'setPosition', 'getChatHistory', 'setChatHistory', 'getPreference', 'setPreference', 'exportAll', 'importAll']) {
        assert.equal(typeof store[name], 'function', `store export ${name}`);
      }
    });
  });
});
