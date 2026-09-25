// scripts/verify/store.mjs — Phase 3 checks; loaded by scripts/verify-functions.mjs with its helpers.
// store.js persistence rules: the key sets that decide what syncs, exports or clears, clearAll
// options, cross-tab notifications and import. deepEqual (used by hydrate) lives here too.
// store.js is imported unsuffixed (the instance sync.mjs and session.js share); browser globals are
// swapped per check and every check that touches the store starts from a fresh LocalStorageBackend.
import { memoryStorage, withGlobals, fakeWindow, settle } from './helpers.mjs';

const STORE_URL = new URL('../../src/lib/store.js', import.meta.url);
const DEEP_EQUAL_URL = new URL('../../src/lib/deepEqual.js', import.meta.url);

// Every localStorage key PREF_MAP writes, by preference name.
const PREF_STORAGE_KEYS = {
  sidebarWidth: 'chat_sidebar_w', section_position: 'section_position', section_research: 'section_research',
  section_charts: 'section_charts', strategic_context: 'strategic_context', ai_provider: 'ai_provider',
  ai_model: 'ai_model', ai_model_name: 'ai_model_name', ai_key_anthropic: 'ai_key_anthropic',
  ai_key_openai: 'ai_key_openai', ai_key_gemini: 'ai_key_gemini', data_tradier_key: 'data_tradier_key',
  data_finnhub_key: 'data_finnhub_key',
};
const SECRET_STORAGE_KEYS = ['ai_key_anthropic', 'ai_key_gemini', 'ai_key_openai', 'data_finnhub_key', 'data_tradier_key'];
// Keys the store does not own: clearAll must leave them alone (sign-out removes the token itself).
const FOREIGN_KEYS = ['access_token', '_import_backup', 'sb-project-auth-token', 'local_data_owner'];

/** A storage holding two positions, two chats, every preference and some keys the store does not own. */
function filledStorage() {
  const storage = memoryStorage();
  storage.setItem('position_AVGO', JSON.stringify({ costBasis: 100, shares: 10 }));
  storage.setItem('position_NVDA', JSON.stringify({ costBasis: null, shares: 5 }));
  storage.setItem('chat_history_AVGO', JSON.stringify([{ role: 'user', content: 'hi' }]));
  storage.setItem('chat_history_NVDA', JSON.stringify([{ role: 'user', content: 'yo' }]));
  for (const key of Object.values(PREF_STORAGE_KEYS)) storage.setItem(key, JSON.stringify(`v-${key}`));
  for (const key of FOREIGN_KEYS) storage.setItem(key, 'x');
  return storage;
}

const storeEvents = (win) => win.events.filter((e) => e.type === 'store-changed');

export default async function run(ctx) {
  console.log('store');
  const { t, assert } = ctx;

  await t('key sets: DEVICE_KEYS is the five secrets plus auth_skipped; LAYOUT_KEYS are the four layout prefs', async () => {
    await withGlobals({ localStorage: undefined, window: undefined }, async () => {
      const { SECRET_KEYS, DEVICE_KEYS, LAYOUT_KEYS } = await import(STORE_URL);
      assert.deepEqual([...SECRET_KEYS].sort(), ['ai_key_anthropic', 'ai_key_gemini', 'ai_key_openai', 'data_finnhub_key', 'data_tradier_key']);
      for (const key of SECRET_KEYS) assert.ok(DEVICE_KEYS.has(key), `${key} must be a device key`);
      assert.ok(DEVICE_KEYS.has('auth_skipped'), 'auth_skipped never leaves the device');
      assert.equal(DEVICE_KEYS.size, SECRET_KEYS.size + 1);
      assert.deepEqual([...LAYOUT_KEYS].sort(), ['section_charts', 'section_position', 'section_research', 'sidebarWidth']);
      for (const key of LAYOUT_KEYS) assert.ok(!DEVICE_KEYS.has(key), `${key} is synced, not device-only`);
    });
  });

  await t('deepEqual: key order ignored, arrays by index, nested values, primitives and null/undefined', async () => {
    const { deepEqual } = await import(DEEP_EQUAL_URL);
    assert.equal(deepEqual({ role: 'user', content: 'x' }, { content: 'x', role: 'user' }), true, 'JSONB reorders keys');
    assert.equal(deepEqual([{ a: 1, b: [1, 2] }], [{ b: [1, 2], a: 1 }]), true);
    assert.equal(deepEqual([1, 2], [2, 1]), false, 'array order matters');
    assert.equal(deepEqual({ a: 1 }, { a: 1, b: undefined }), false, 'an extra key differs');
    assert.equal(deepEqual({ a: null }, { a: undefined }), false);
    assert.equal(deepEqual(null, null), true);
    assert.equal(deepEqual(null, {}), false);
    assert.equal(deepEqual([], {}), false, 'array vs object');
    assert.equal(deepEqual(101.5, 101.5), true);
    assert.equal(deepEqual('1', 1), false, 'no coercion');
    assert.equal(deepEqual(NaN, NaN), true);
  });

  await t('clearAll({ keepSecrets: true }) keeps exactly the five API keys; clearAll() removes them too; other keys untouched', async () => {
    for (const via of ['store', 'backend']) {
      const storage = filledStorage();
      await withGlobals({ localStorage: storage, window: undefined }, async () => {
        const store = await import(STORE_URL);
        store.setBackend(new store.LocalStorageBackend());
        const clear = via === 'store' ? store.clearAll : (opts) => new store.LocalStorageBackend().clearAll(opts);

        clear({ keepSecrets: true });
        assert.deepEqual([...storage.map.keys()].sort(), [...SECRET_STORAGE_KEYS, ...FOREIGN_KEYS].sort(),
          `${via}: positions, chats and every non-secret preference removed; secrets and foreign keys kept`);
        for (const key of SECRET_STORAGE_KEYS) assert.equal(storage.getItem(key), JSON.stringify(`v-${key}`), `${via}: ${key} unchanged`);

        clear();
        assert.deepEqual([...storage.map.keys()].sort(), [...FOREIGN_KEYS].sort(), `${via}: clearAll() removes the secrets as well`);
      });
    }
  });

  await t('describeStorageKey: position_X, chat_history_X, PREF_MAP storage keys (reverse lookup), anything else → null', async () => {
    await withGlobals({ localStorage: undefined, window: undefined }, async () => {
      const { describeStorageKey } = await import(STORE_URL);
      assert.deepEqual(describeStorageKey('position_AVGO'), { kind: 'position', id: 'AVGO' });
      assert.deepEqual(describeStorageKey('chat_history_BRK.B'), { kind: 'chat', id: 'BRK.B' });
      assert.deepEqual(describeStorageKey('chat_sidebar_w'), { kind: 'pref', id: 'sidebarWidth' }, 'storage key → preference name');
      for (const [name, key] of Object.entries(PREF_STORAGE_KEYS)) {
        assert.deepEqual(describeStorageKey(key), { kind: 'pref', id: name }, key);
      }
      for (const key of ['sidebarWidth', 'access_token', '_import_backup', 'sb-project-auth-token', 'local_data_owner',
        'auth_skipped', 'constructor', 'toString', '__proto__', 'position_', 'chat_history_', '', null, undefined]) {
        assert.equal(describeStorageKey(key), null, `${String(key)} is not a store key`);
      }
    });
  });

  await t('emitStoreChanged: store-changed with the detail when given, without one otherwise; no window → no-op', async () => {
    const win = fakeWindow();
    await withGlobals({ localStorage: memoryStorage(), window: win }, async () => {
      const { emitStoreChanged } = await import(STORE_URL);
      emitStoreChanged();
      emitStoreChanged({ kind: 'chat', id: 'AVGO' });
      const [all, one] = storeEvents(win);
      assert.equal(storeEvents(win).length, 2);
      assert.equal(all.detail, null, 'no detail: everything may have changed');
      assert.deepEqual(one.detail, { kind: 'chat', id: 'AVGO' });
    });
    await withGlobals({ localStorage: undefined, window: undefined }, async () => {
      const { emitStoreChanged } = await import(STORE_URL);
      assert.doesNotThrow(() => emitStoreChanged({ kind: 'pref', id: 'ai_model' }));
    });
  });

  await t('subscribeCrossTab: one store key → one event with its detail; unknown key → nothing; a burst of several or a clear → one event without detail; unsubscribe stops it', async () => {
    const storage = memoryStorage();
    const win = fakeWindow();
    await withGlobals({ localStorage: storage, window: win }, async () => {
      const { subscribeCrossTab } = await import(STORE_URL);
      const storageEvent = (key, storageArea = storage) => win.dispatchEvent({ type: 'storage', key, storageArea });
      const unsubscribe = subscribeCrossTab();
      assert.equal(win.listenerCount('storage'), 1);

      storageEvent('position_AVGO');
      assert.equal(storeEvents(win).length, 0, 'coalesced: nothing until the macrotask');
      await settle();
      assert.equal(storeEvents(win).length, 1);
      assert.deepEqual(storeEvents(win)[0].detail, { kind: 'position', id: 'AVGO' });

      storageEvent('access_token');
      storageEvent('sb-project-auth-token');
      await settle();
      assert.equal(storeEvents(win).length, 1, 'keys the store does not own are ignored');

      storageEvent('chat_history_AVGO');
      storageEvent('access_token');
      storageEvent('chat_history_AVGO');
      await settle();
      assert.equal(storeEvents(win).length, 2);
      assert.deepEqual(storeEvents(win)[1].detail, { kind: 'chat', id: 'AVGO' }, 'the same item twice is still one item');

      storageEvent('chat_sidebar_w');
      storageEvent('position_NVDA');
      await settle();
      assert.equal(storeEvents(win).length, 3, 'a burst is one event');
      assert.equal(storeEvents(win)[2].detail, null, 'several items: no detail');

      storageEvent(null);
      await settle();
      assert.equal(storeEvents(win).length, 4);
      assert.equal(storeEvents(win)[3].detail, null, 'storage cleared: no detail');

      storageEvent('ai_provider', memoryStorage()); // a sessionStorage write
      await settle();
      assert.equal(storeEvents(win).length, 4, 'other storage areas are ignored');

      storageEvent('position_AVGO');
      unsubscribe();
      await settle();
      storageEvent('position_AVGO');
      await settle();
      assert.equal(storeEvents(win).length, 4, 'unsubscribe drops the pending event and stops listening');
      assert.equal(win.listenerCount('storage'), 0);
    });
    await withGlobals({ localStorage: undefined, window: undefined }, async () => {
      const { subscribeCrossTab } = await import(STORE_URL);
      const unsubscribe = subscribeCrossTab();
      assert.equal(typeof unsubscribe, 'function', 'no window: a no-op unsubscribe');
      unsubscribe();
    });
  });
}
