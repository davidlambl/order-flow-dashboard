// scripts/verify/store.mjs — Phase 3 checks; loaded by scripts/verify-functions.mjs with its helpers.
// store.js persistence rules: the key sets that decide what syncs, exports or clears, clearAll
// options, cross-tab notifications, import (D8: secrets kept, names validated, events, replaceCloud)
// and the no-ticker chat-write guard. deepEqual (used by hydrate) lives here too.
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
const contents = (storage) => Object.fromEntries([...storage.map].sort(([a], [b]) => a.localeCompare(b)));

const MSFT_CHAT = [{ role: 'user', content: 'Trim?' }, { role: 'assistant', content: 'Watch the call wall.' }];

// A backup as exportAll() writes it, plus what an old version or a hand edit can put in one: API keys and a
// device flag (exports never contain them), unknown names (one a prototype key, which JSON.parse makes an own
// property), items the backend would not store (a position with neither field, an empty chat, a null
// preference) and entries of the wrong shape. JSON text, so `__proto__` arrives as the file has it.
const IMPORT_FILE = `{
  "version": 2,
  "exportedAt": "2026-09-01T00:00:00.000Z",
  "positions": {
    "MSFT": { "costBasis": 400, "shares": 3, "note": "not a position field" },
    "TSLA": { "shares": 7 },
    "AMD": { "costBasis": null, "shares": null },
    "BAD": [1, 2],
    "NUL": null
  },
  "chatHistories": { "MSFT": ${JSON.stringify(MSFT_CHAT)}, "EMPTY": [], "BAD": "not an array" },
  "preferences": {
    "foo": 1,
    "strategic_context": "Long MSFT",
    "data_tradier_key": "tr-from-file",
    "sidebarWidth": 420,
    "access_token": "forged",
    "ai_key_openai": "sk-from-file",
    "constructor": "x",
    "ai_provider": "openai",
    "auth_skipped": "1",
    "__proto__": { "polluted": true },
    "ai_key_anthropic": "sk-ant-from-file",
    "ai_model": null
  }
}`;
// What importAll(IMPORT_FILE) writes, as the snapshot replaceCloud receives, and the names it reports.
const IMPORTED_SNAPSHOT = {
  positions: { MSFT: { costBasis: 400, shares: 3 }, TSLA: { costBasis: null, shares: 7 } },
  chatHistories: { MSFT: MSFT_CHAT },
  preferences: { strategic_context: 'Long MSFT', sidebarWidth: 420, ai_provider: 'openai' },
};
const IMPORT_SKIPPED = ['foo', 'data_tradier_key', 'access_token', 'ai_key_openai', 'constructor', 'auth_skipped', '__proto__', 'ai_key_anthropic'];

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

  await t('importAll (D8): the API keys here are kept; API keys, auth_skipped and unknown names in the file are not imported and are listed in skipped (file order, once each); positions, chats and known prefs written and counted; store-changed, ai-settings-changed, data-source-changed', async () => {
    const storage = filledStorage();
    const win = fakeWindow();
    await withGlobals({ localStorage: storage, window: win }, async (warnings) => {
      const store = await import(STORE_URL);
      store.setBackend(new store.LocalStorageBackend());
      const result = store.importAll(JSON.parse(IMPORT_FILE));
      assert.deepEqual(result, { imported: { positions: 2, chats: 1, prefs: 3 }, skipped: IMPORT_SKIPPED });
      assert.deepEqual(contents(storage), {
        // this device's API keys, as they were (the file's never replace them)
        ...Object.fromEntries(SECRET_STORAGE_KEYS.map((key) => [key, JSON.stringify(`v-${key}`)])),
        // keys the store does not own, untouched ('forged' is not written); the backup is gone once the import is written
        access_token: 'x', local_data_owner: 'x', 'sb-project-auth-token': 'x',
        // the file: positions with their two fields only, the chat, the known preferences; everything else cleared
        position_MSFT: JSON.stringify({ costBasis: 400, shares: 3 }),
        position_TSLA: JSON.stringify({ costBasis: null, shares: 7 }),
        chat_history_MSFT: JSON.stringify(MSFT_CHAT),
        strategic_context: JSON.stringify('Long MSFT'),
        chat_sidebar_w: '420',
        ai_provider: JSON.stringify('openai'),
      });
      assert.equal({}.polluted, undefined, 'a __proto__ entry pollutes nothing');
      assert.deepEqual(win.events.map((e) => e.type), ['store-changed', 'ai-settings-changed', 'data-source-changed']);
      assert.equal(win.events[0].detail, null, 'store-changed without detail: everything may have changed');
      assert.deepEqual(warnings, []);
    });
  });

  await t('importAll(exportAll()) restores positions, chats and preferences in another browser (its API key kept, its other data replaced), nothing skipped; a v1 file with preferences only still imports', async () => {
    let exported;
    await withGlobals({ localStorage: filledStorage(), window: fakeWindow() }, async () => {
      const store = await import(STORE_URL);
      store.setBackend(new store.LocalStorageBackend());
      exported = JSON.parse(JSON.stringify(store.exportAll())); // through JSON, like the downloaded file
    });
    const target = memoryStorage();
    target.setItem('ai_key_openai', JSON.stringify('sk-target'));
    target.setItem('position_OLD', JSON.stringify({ costBasis: 1, shares: 1 }));
    await withGlobals({ localStorage: target, window: fakeWindow() }, async (warnings) => {
      const store = await import(STORE_URL);
      store.setBackend(new store.LocalStorageBackend());
      assert.deepEqual(store.importAll(exported), { imported: { positions: 2, chats: 2, prefs: 8 }, skipped: [] });
      const again = store.exportAll();
      for (const section of ['positions', 'chatHistories', 'preferences']) assert.deepEqual(again[section], exported[section], section);
      assert.equal(target.getItem('position_OLD'), null, 'an import replaces what was here');
      assert.equal(target.getItem('ai_key_openai'), JSON.stringify('sk-target'), "this browser's API key is kept");

      assert.deepEqual(store.importAll({ version: 1, preferences: { strategic_context: 'from v1' } }),
        { imported: { positions: 0, chats: 0, prefs: 1 }, skipped: [] });
      assert.equal(target.getItem('position_MSFT'), null);
      assert.equal(target.getItem('strategic_context'), JSON.stringify('from v1'));
      assert.deepEqual(warnings, []);
    });
  });

  await t('importAll → replaceCloud: a backend with one is called once, during the import, with exactly what was written (no API key); not awaited; a rejection or a throw is one warning; a plain backend has none to call', async () => {
    const unhandled = [];
    const onUnhandled = (reason) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      for (const [name, respond, warns] of [
        ['resolves', () => Promise.resolve({ pushed: 6, deleted: 2 }), 0],
        ['never settles', () => new Promise(() => {}), 0],
        ['rejects', () => Promise.reject(new Error('offline')), 1],
        ['throws', () => { throw new Error('no session'); }, 1],
      ]) {
        const storage = filledStorage();
        await withGlobals({ localStorage: storage, window: fakeWindow() }, async (warnings) => {
          const store = await import(STORE_URL);
          const calls = [];
          // The store's method surface (a LocalStorageBackend) plus replaceCloud, recording its argument and
          // what this browser held when it was called.
          class CloudBackend extends store.LocalStorageBackend {
            replaceCloud(snapshot) {
              calls.push({ snapshot, localMSFT: storage.getItem('position_MSFT') });
              return respond();
            }
          }
          store.setBackend(new CloudBackend());
          const result = store.importAll(JSON.parse(IMPORT_FILE));
          assert.equal(typeof result?.then, 'undefined', `${name}: importAll returns its result, not a promise`);
          assert.deepEqual(result, { imported: { positions: 2, chats: 1, prefs: 3 }, skipped: IMPORT_SKIPPED }, name);
          assert.equal(calls.length, 1, `${name}: called once, before importAll returned`);
          assert.deepEqual(calls[0].snapshot, IMPORTED_SNAPSHOT, `${name}: the imported snapshot`);
          assert.equal(calls[0].localMSFT, JSON.stringify({ costBasis: 400, shares: 3 }), `${name}: called after the local writes`);
          assert.doesNotMatch(JSON.stringify(calls[0].snapshot), /sk-|tr-from-file|v-ai_key|v-data_/, `${name}: no API key`);
          await settle();
          assert.equal(warnings.length, warns, `${name}: warnings`);
          if (warns) assert.match(String(warnings[0][0]), /could not replace the cloud copy/, name);
          assert.equal(storage.getItem('position_MSFT'), JSON.stringify({ costBasis: 400, shares: 3 }), `${name}: this browser holds the import`);
          store.setBackend(new store.LocalStorageBackend());
        });
      }
      await withGlobals({ localStorage: filledStorage(), window: fakeWindow() }, async (warnings) => {
        const store = await import(STORE_URL);
        store.setBackend(new store.LocalStorageBackend());
        assert.equal('replaceCloud' in store.LocalStorageBackend.prototype, false);
        assert.deepEqual(store.importAll(JSON.parse(IMPORT_FILE)).imported, { positions: 2, chats: 1, prefs: 3 });
        await settle();
        assert.deepEqual(warnings, [], 'a plain backend: nothing to call, nothing to warn about');
      });
      assert.deepEqual(unhandled, [], 'no unhandled rejection');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  await t('importAll: a file it cannot read throws before anything changes (no clear, no backup, no event, no cloud call)', async () => {
    for (const [name, input, message] of [
      ['null', null, /Invalid data format/],
      ['a string', 'backup', /Invalid data format/],
      ['no version', { positions: {} }, /Missing schema version/],
      ['a string version', { version: '2', positions: {} }, /Missing schema version/],
      ['a newer schema', { version: 3, positions: {} }, /Unsupported schema v3/],
      ['no section', { version: 2 }, /no valid sections/],
      ['sections of the wrong shape', { version: 2, positions: [], chatHistories: 'x', preferences: null }, /no valid sections/],
    ]) {
      const storage = filledStorage();
      const win = fakeWindow();
      await withGlobals({ localStorage: storage, window: win }, async (warnings) => {
        const store = await import(STORE_URL);
        let cloudCalls = 0;
        class CloudBackend extends store.LocalStorageBackend {
          replaceCloud() { cloudCalls++; return Promise.resolve({ pushed: 0, deleted: 0 }); }
        }
        store.setBackend(new CloudBackend());
        const before = contents(storage);
        assert.throws(() => store.importAll(input), message, name);
        assert.deepEqual(contents(storage), before, `${name}: storage untouched`);
        assert.equal(win.events.length, 0, `${name}: no event`);
        assert.equal(cloudCalls, 0, `${name}: the cloud copy untouched`);
        assert.deepEqual(warnings, [], name);
        store.setBackend(new store.LocalStorageBackend());
      });
    }
  });

  await t('setChatHistory / deleteChatHistory without a ticker reach no backend (ChatBot saving "the previous ticker" when market data first arrives writes nothing)', async () => {
    await withGlobals({ localStorage: memoryStorage(), window: undefined }, async () => {
      const store = await import(STORE_URL);
      const calls = [];
      class Recording extends store.LocalStorageBackend {
        setChatHistory(...args) { calls.push(['set', ...args]); }
        deleteChatHistory(...args) { calls.push(['delete', ...args]); }
      }
      store.setBackend(new Recording());
      for (const ticker of [undefined, null, '']) {
        store.setChatHistory(ticker, []);
        store.setChatHistory(ticker, MSFT_CHAT);
        store.deleteChatHistory(ticker);
      }
      assert.deepEqual(calls, [], 'a falsy ticker never reaches the backend (a SupabaseBackend would queue a cloud write)');
      store.setChatHistory('AVGO', []);
      store.deleteChatHistory('AVGO');
      assert.deepEqual(calls, [['set', 'AVGO', []], ['delete', 'AVGO']]);
      store.setBackend(new store.LocalStorageBackend());
    });
  });
}
