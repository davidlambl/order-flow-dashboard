// scripts/verify/sync.mjs — Phase 3 checks; loaded by scripts/verify-functions.mjs with its helpers.
// SupabaseBackend (hydrate decisions, conflict resolution, the write path) and session.js against a
// recording fake Supabase client: nothing here touches the network or a real project.
// store.js, SupabaseBackend.js and session.js are imported unsuffixed: session.js and the backend import
// ./store.js, so a cache-busted store would be a different instance from theirs. Browser globals are
// swapped per check (inBrowser) and each check starts from a fresh LocalStorageBackend.
import { memoryStorage, withGlobals, fakeWindow, settle } from './helpers.mjs';

const BACKEND_URL = new URL('../../src/lib/SupabaseBackend.js', import.meta.url);
const STORE_URL = new URL('../../src/lib/store.js', import.meta.url);
const SUPABASE_URL = new URL('../../src/lib/supabase.js', import.meta.url);
const SESSION_URL = new URL('../../src/lib/session.js', import.meta.url);

const KEY_COLUMN = { positions: 'ticker', preferences: 'key', chat_histories: 'ticker' };
const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * Fake supabase-js client. `from(table)` returns a thenable query builder: select/eq/is chain,
 * upsert(rows, opts) and delete() too, and awaiting the builder runs the query against the
 * in-memory `tables` (rows are plain objects with user_id + key column). Every read, upsert and
 * delete is recorded; `reads`, `upserts`, `deletes`, `signOuts` and `tables` read the live state
 * (also on `_state`). Options:
 *   tables      – initial rows per table
 *   readError   – { [table]: error } → that table's select resolves { data: null, error, status: 500 }
 *   respond     – ({ table, op, rows, filters }) => { error, status } | undefined; a returned value is
 *                 the write's response and the write is NOT applied (simulates RLS / network failures)
 *   signOutError – returned by auth.signOut()
 *   gate        – a promise every select waits for before it runs (a read still in flight)
 */
export function fakeSupabase({ tables = {}, readError = {}, respond = () => undefined, signOutError = null, gate = null } = {}) {
  const state = {
    tables: { positions: [], preferences: [], chat_histories: [], ...clone(tables) },
    reads: [], upserts: [], deletes: [], signOuts: 0,
  };
  const matches = (row, filters) => filters.every(([col, value]) => row[col] === value);

  function builder(table) {
    const q = { table, op: 'select', filters: [], rows: null, opts: null };
    const rowsOf = () => (state.tables[table] ??= []);
    const run = () => {
      if (q.op === 'select') {
        state.reads.push({ table, filters: q.filters });
        if (readError[table]) return { data: null, error: readError[table], status: 500, statusText: 'Internal Server Error' };
        return { data: clone(rowsOf().filter((r) => matches(r, q.filters))), error: null, status: 200, statusText: 'OK' };
      }
      if (q.op === 'upsert') {
        state.upserts.push({ table, rows: clone(q.rows), opts: q.opts });
        const forced = respond({ table, op: 'upsert', rows: q.rows, opts: q.opts });
        if (forced) return { data: null, ...forced };
        const keyCols = (q.opts?.onConflict || `user_id,${KEY_COLUMN[table]}`).split(',');
        for (const row of q.rows) {
          const i = rowsOf().findIndex((r) => keyCols.every((c) => r[c] === row[c]));
          if (i === -1) rowsOf().push(clone(row));
          else if (!q.opts?.ignoreDuplicates) rowsOf()[i] = { ...rowsOf()[i], ...clone(row) };
        }
        return { data: null, error: null, status: 201, statusText: 'Created' };
      }
      // delete
      state.deletes.push({ table, filters: q.filters });
      const forced = respond({ table, op: 'delete', rows: null, filters: q.filters });
      if (forced) return { data: null, ...forced };
      state.tables[table] = rowsOf().filter((r) => !matches(r, q.filters));
      return { data: null, error: null, status: 204, statusText: 'No Content' };
    };
    const b = {
      select() { return b; },
      eq(col, value) { q.filters.push([col, value]); return b; },
      is(col, value) { q.filters.push([col, value]); return b; },
      upsert(rows, opts) { q.op = 'upsert'; q.rows = Array.isArray(rows) ? rows : [rows]; q.opts = opts ?? null; return b; },
      delete() { q.op = 'delete'; return b; },
      then(resolve, reject) {
        const wait = q.op === 'select' && gate ? gate : undefined;
        return Promise.resolve(wait).then(run).then(resolve, reject);
      },
    };
    return b;
  }

  return {
    get tables() { return state.tables; },
    get reads() { return state.reads; },
    get upserts() { return state.upserts; },
    get deletes() { return state.deletes; },
    get signOuts() { return state.signOuts; },
    from: (table) => builder(table),
    auth: {
      async signOut() { state.signOuts++; return { error: signOutError }; },
    },
    _state: state,
  };
}

const U = 'user-a';
const AT = '2026-09-01T00:00:00.000Z';
const MSGS = [{ role: 'user', content: 'Should I trim?' }, { role: 'assistant', content: 'Watch the call wall.' }];
const MSGS2 = [{ role: 'user', content: 'MSFT outlook?' }];
const SECRET_NAMES = ['ai_key_anthropic', 'ai_key_openai', 'ai_key_gemini', 'data_tradier_key', 'data_finnhub_key'];
const ALL_PREF_NAMES = ['sidebarWidth', 'section_position', 'section_research', 'section_charts', 'strategic_context',
  'ai_provider', 'ai_model', 'ai_model_name', ...SECRET_NAMES];
const posRow = (ticker, cost_basis, shares, extra = {}) => ({ user_id: U, ticker, cost_basis, shares, updated_at: AT, ...extra });
const prefRow = (key, value, extra = {}) => ({ user_id: U, key, value, updated_at: AT, ...extra });
const chatRow = (ticker, messages, extra = {}) => ({ user_id: U, ticker, messages, updated_at: AT, ...extra });

const storeEvents = (win) => win.events.filter((e) => e.type === 'store-changed');
const contents = (storage) => Object.fromEntries([...storage.map].sort(([a], [b]) => a.localeCompare(b)));
const upserted = (client) => client.upserts.map((u) => `${u.table}:${u.rows[0].ticker ?? u.rows[0].key}`).sort();
const cloudKeys = (client) => Object.entries(client.tables)
  .flatMap(([table, rows]) => rows.map((r) => `${table}:${r[KEY_COLUMN[table]]}`)).sort();

/**
 * Runs fn({ storage, win, warnings, store, SupabaseBackend, session, local }) with a fresh localStorage
 * and window, the store reset to a LocalStorageBackend; `local` is a LocalStorageBackend for seeding.
 */
async function inBrowser(fn) {
  const storage = memoryStorage();
  const win = fakeWindow();
  await withGlobals({ localStorage: storage, window: win }, async (warnings) => {
    const store = await import(STORE_URL);
    const { SupabaseBackend } = await import(BACKEND_URL);
    const session = await import(SESSION_URL);
    store.setBackend(new store.LocalStorageBackend());
    await fn({ storage, win, warnings, store, SupabaseBackend, session, local: new store.LocalStorageBackend() });
  });
}

/**
 * The conflict every resolveConflict check starts from. This browser: AVGO 100×10, NVDA 50×2, a
 * strategic context, a sidebar width, the AVGO chat, an API key. The account: AVGO 120×10 (differs),
 * TSLA, another strategic context, ai_provider, a collapsed research section, the MSFT chat.
 */
function seedConflict(local) {
  local.setPosition('AVGO', { costBasis: 100, shares: 10 });
  local.setPosition('NVDA', { costBasis: 50, shares: 2 });
  local.setPreference('strategic_context', 'local plan');
  local.setPreference('sidebarWidth', 300);
  local.setPreference('ai_key_anthropic', 'sk-ant-local');
  local.setChatHistory('AVGO', MSGS);
  return fakeSupabase({
    tables: {
      positions: [posRow('AVGO', 120, 10), posRow('TSLA', 200, 1)],
      preferences: [prefRow('strategic_context', 'cloud plan'), prefRow('ai_provider', 'openai'), prefRow('section_research', false)],
      chat_histories: [chatRow('MSFT', MSGS2)],
    },
  });
}

export default async function run(ctx) {
  console.log('sync');
  const { t, assert } = ctx;

  await t('SupabaseBackend loads under Node (no DOM, no VITE_ env → null default client) and writes through an injected client', async () => {
    const storage = memoryStorage();
    await withGlobals({ localStorage: storage, window: undefined }, async () => {
      const { supabase } = await import(SUPABASE_URL);
      assert.equal(supabase, null, 'no VITE_SUPABASE_* under Node → no default client');
      const { SupabaseBackend } = await import(BACKEND_URL);
      const { LocalStorageBackend } = await import(STORE_URL);
      const client = fakeSupabase();
      const backend = new SupabaseBackend(new LocalStorageBackend(), 'user-a', client);
      backend.setPosition('AVGO', { costBasis: 100, shares: 10 });
      await settle();
      assert.equal(storage.getItem('position_AVGO'), JSON.stringify({ costBasis: 100, shares: 10 }), 'local write-through');
      assert.equal(client._state.upserts.length, 1);
      const { table, rows, opts } = client._state.upserts[0];
      assert.equal(table, 'positions');
      assert.equal(rows[0].user_id, 'user-a');
      assert.equal(rows[0].cost_basis, 100);
      assert.equal(opts.onConflict, 'user_id,ticker');
      assert.deepEqual(client._state.tables.positions.map((r) => r.ticker), ['AVGO'], 'the fake applied the upsert');
    });
  });

  await t('session.js loads under Node with no DOM (no window, localStorage or confirm at import time)', async () => {
    await withGlobals({ localStorage: undefined, window: undefined }, async () => {
      const session = await import(`${SESSION_URL.href}?nodom=1`); // its own instance; ./store.js stays shared
      for (const name of ['signOut', 'claimLocalData']) assert.equal(typeof session[name], 'function', name);
      assert.match(session.SIGN_OUT_CONFIRM, /API keys and the access token on this device are removed; your account's cloud copy is kept\.$/);
    });
  });

  await t('hydrate, data only in the account → pulled: rows applied here (layout too), one store-changed, nothing uploaded; tombstones, API keys, unknown names skipped', async () => {
    await inBrowser(async ({ storage, win, warnings, SupabaseBackend, local }) => {
      local.setPreference('ai_key_openai', 'sk-local');
      const client = fakeSupabase({
        tables: {
          positions: [posRow('AVGO', 100, 10), posRow('TSLA', 1, 1, { deleted_at: AT }), { ...posRow('MSFT', 5, 5), user_id: 'user-b' }],
          preferences: [prefRow('strategic_context', 'Long AVGO'), prefRow('sidebarWidth', 420), prefRow('ai_key_openai', 'sk-cloud'),
            prefRow('auth_skipped', true), prefRow('access_token', 'forged'), prefRow('constructor', 1), prefRow('ai_model', 'x', { deleted_at: AT })],
          chat_histories: [chatRow('AVGO', JSON.stringify(MSGS)), chatRow('NVDA', MSGS, { deleted_at: AT }), chatRow('AMD', [])],
        },
      });
      const report = await new SupabaseBackend(local, U, client).hydrate();
      await settle();
      assert.deepEqual(report, { status: 'pulled', cloud: { positions: 1, prefs: 1, chats: 1 }, local: { positions: 0, prefs: 0, chats: 0 } });
      assert.deepEqual(JSON.parse(storage.getItem('position_AVGO')), { costBasis: 100, shares: 10 });
      assert.equal(storage.getItem('strategic_context'), JSON.stringify('Long AVGO'));
      assert.equal(storage.getItem('chat_sidebar_w'), '420', 'layout preferences come along');
      assert.deepEqual(JSON.parse(storage.getItem('chat_history_AVGO')), MSGS, 'a messages string is parsed');
      for (const key of ['position_TSLA', 'position_MSFT', 'chat_history_NVDA', 'chat_history_AMD', 'ai_model', 'auth_skipped', 'access_token', 'constructor']) {
        assert.equal(storage.getItem(key), null, `${key} must not be written`);
      }
      assert.equal(storage.getItem('ai_key_openai'), JSON.stringify('sk-local'), 'a cloud row never replaces an API key');
      assert.deepEqual(client.reads.map((r) => [r.table, r.filters]),
        [['positions', [['user_id', U]]], ['preferences', [['user_id', U]]], ['chat_histories', [['user_id', U]]]]);
      assert.equal(storeEvents(win).length, 1);
      assert.equal(storeEvents(win)[0].detail, null, 'everything may have changed');
      assert.equal(client.upserts.length, 0, "the account's own rows are not uploaded back");
      assert.equal(client.deletes.length, 0);
      assert.deepEqual(warnings, []);
    });
  });

  await t('hydrate, data only in this browser → pushed: one upsert per item with onConflict, no ignoreDuplicates, updated_at; no API key or device flag ever sent', async () => {
    await inBrowser(async ({ win, warnings, SupabaseBackend, local }) => {
      local.setPosition('AVGO', { costBasis: 100, shares: 10 });
      local.setPosition('NVDA', { costBasis: null, shares: 5 });
      local.setPreference('strategic_context', 'plan');
      local.setPreference('sidebarWidth', 400);
      for (const name of SECRET_NAMES) local.setPreference(name, `secret-${name}`);
      local.setPreference('auth_skipped', true);
      local.setChatHistory('AVGO', MSGS);
      local.setChatHistory('AMD', []);
      // Layout alone is not worth asking about: this is still a first sign-in.
      const client = fakeSupabase({ tables: { preferences: [prefRow('section_charts', false)] } });
      const report = await new SupabaseBackend(local, U, client).hydrate();
      await settle();
      assert.deepEqual(report, { status: 'pushed', cloud: { positions: 0, prefs: 0, chats: 0 }, local: { positions: 2, prefs: 1, chats: 1 } });
      assert.deepEqual(upserted(client),
        ['chat_histories:AVGO', 'positions:AVGO', 'positions:NVDA', 'preferences:sidebarWidth', 'preferences:strategic_context']);
      for (const { table, rows, opts } of client.upserts) {
        assert.equal(rows.length, 1, 'one row per upsert');
        assert.equal(rows[0].user_id, U);
        assert.match(rows[0].updated_at, /^\d{4}-\d{2}-\d{2}T/, 'client-side updated_at');
        assert.equal(opts.onConflict, table === 'preferences' ? 'user_id,key' : 'user_id,ticker');
        assert.ok(!opts.ignoreDuplicates, "a full upsert: the account's row becomes this browser's copy");
      }
      const nvda = client.upserts.find((u) => u.table === 'positions' && u.rows[0].ticker === 'NVDA').rows[0];
      assert.deepEqual([nvda.cost_basis, nvda.shares], [null, 5]);
      assert.deepEqual(client.upserts.find((u) => u.table === 'chat_histories').rows[0].messages, MSGS);
      const sent = JSON.stringify(client.upserts);
      for (const name of [...SECRET_NAMES, 'auth_skipped']) {
        assert.ok(!sent.includes(name) && !sent.includes(`secret-${name}`), `${name} never leaves this browser`);
      }
      assert.equal(storeEvents(win).length, 0, 'nothing changed here');
      assert.deepEqual(warnings, []);
    });
  });

  await t('hydrate, the same data on both sides (JSONB reorders keys; unknown cloud names ignored) → in-sync, nothing written', async () => {
    await inBrowser(async ({ storage, win, warnings, SupabaseBackend, local }) => {
      local.setPosition('AVGO', { costBasis: 101.5, shares: 10 });
      local.setPreference('strategic_context', 'plan');
      local.setPreference('ai_provider', 'anthropic');
      local.setPreference('section_charts', false);
      local.setChatHistory('AVGO', MSGS);
      const before = contents(storage);
      const client = fakeSupabase({
        tables: {
          positions: [{ shares: 10, ticker: 'AVGO', user_id: U, cost_basis: 101.5 }],
          preferences: [prefRow('ai_provider', 'anthropic'), prefRow('strategic_context', 'plan'), prefRow('section_charts', false),
            prefRow('mystery_setting', 'from an old import')],
          chat_histories: [chatRow('AVGO', MSGS.map(({ role, content }) => ({ content, role })))],
        },
      });
      const backend = new SupabaseBackend(local, U, client);
      const report = await backend.hydrate();
      await settle();
      assert.deepEqual(report, { status: 'in-sync', cloud: { positions: 1, prefs: 2, chats: 1 }, local: { positions: 1, prefs: 2, chats: 1 } });
      assert.equal(client.upserts.length + client.deletes.length, 0, 'no write');
      assert.deepEqual(contents(storage), before);
      assert.equal(storage.getItem('mystery_setting'), null);
      assert.equal(storeEvents(win).length, 0);
      assert.deepEqual(warnings, []);
      await assert.rejects(backend.resolveConflict('cloud'), /no conflict/, 'nothing to resolve after in-sync');
      assert.deepEqual(contents(storage), before);
    });
  });

  await t('hydrate, different data on both sides → conflict with per-side counts, and nothing written anywhere', async () => {
    await inBrowser(async ({ storage, win, warnings, SupabaseBackend, local }) => {
      const client = seedConflict(local);
      const before = contents(storage);
      const tablesBefore = clone(client.tables);
      const report = await new SupabaseBackend(local, U, client).hydrate();
      await settle();
      assert.deepEqual(report, { status: 'conflict', cloud: { positions: 2, prefs: 2, chats: 1 }, local: { positions: 2, prefs: 1, chats: 1 } });
      assert.equal(client.upserts.length + client.deletes.length, 0, 'no upload, no delete');
      assert.deepEqual(client.tables, tablesBefore);
      assert.deepEqual(contents(storage), before, 'this browser unchanged');
      assert.equal(storeEvents(win).length, 0);
      assert.deepEqual(warnings, []);
    });
    // Any single difference in what is worth asking about is a conflict.
    const variants = {
      'one more message': (c) => { c.chat_histories[0].messages = [...MSGS, { role: 'user', content: 'and?' }]; },
      'a preference value': (c) => { c.preferences[0].value = 'other plan'; },
      'a position only in the account': (c) => { c.positions.push(posRow('TSLA', 1, 1)); },
      'shares differ': (c) => { c.positions[0].shares = 11; },
    };
    for (const [name, change] of Object.entries(variants)) {
      await inBrowser(async ({ SupabaseBackend, local }) => {
        local.setPosition('AVGO', { costBasis: 100, shares: 10 });
        local.setPreference('strategic_context', 'plan');
        local.setChatHistory('AVGO', MSGS);
        const tables = { positions: [posRow('AVGO', 100, 10)], preferences: [prefRow('strategic_context', 'plan')], chat_histories: [chatRow('AVGO', MSGS)] };
        change(tables);
        const client = fakeSupabase({ tables });
        const { status } = await new SupabaseBackend(local, U, client).hydrate();
        assert.equal(status, 'conflict', name);
        assert.equal(client.upserts.length + client.deletes.length, 0, `${name}: no write`);
      });
    }
  });

  await t('hydrate, same data but layout differs → in-sync; only layout moves: this browser\'s value pushed, a cloud-only one applied (+ store-changed)', async () => {
    await inBrowser(async ({ storage, win, SupabaseBackend, local }) => {
      local.setPosition('AVGO', { costBasis: 100, shares: 10 });
      local.setPreference('sidebarWidth', 300);
      local.setPreference('section_charts', false);
      local.setPreference('section_position', true);
      const client = fakeSupabase({
        tables: {
          positions: [posRow('AVGO', 100, 10)],
          preferences: [prefRow('sidebarWidth', 500), prefRow('section_research', false), prefRow('section_position', true)],
        },
      });
      const report = await new SupabaseBackend(local, U, client).hydrate();
      await settle();
      assert.equal(report.status, 'in-sync');
      assert.deepEqual(upserted(client), ['preferences:section_charts', 'preferences:sidebarWidth'], 'differing and local-only layout keys pushed');
      assert.equal(client.tables.preferences.find((r) => r.key === 'sidebarWidth').value, 300, "this browser's width wins");
      assert.equal(client.deletes.length, 0);
      assert.equal(storage.getItem('section_research'), 'false', 'cloud-only layout key applied here');
      assert.equal(storage.getItem('chat_sidebar_w'), '300');
      assert.equal(storeEvents(win).length, 1);
    });
  });

  await t('hydrate, a read fails ({ error } on any table, or a throw) → offline: nothing written, exactly one warning', async () => {
    const cases = [
      ...['positions', 'preferences', 'chat_histories'].map((table) => [
        `${table} read error`, () => fakeSupabase({ tables: { positions: [posRow('AVGO', 1, 1)] }, readError: { [table]: { message: 'boom' } } }),
      ]),
      ['client throws', () => ({ from() { throw new Error('fetch failed'); } })],
      // No response at all is a failed read, never an empty account (which would upload this browser).
      ['missing response', () => ({ from: () => ({ select() { return this; }, eq: async () => undefined }) })],
    ];
    for (const [name, makeClient] of cases) {
      await inBrowser(async ({ storage, win, warnings, SupabaseBackend, local }) => {
        local.setPosition('NVDA', { costBasis: 50, shares: 2 });
        const before = contents(storage);
        const client = makeClient();
        const report = await new SupabaseBackend(local, U, client).hydrate();
        await settle();
        assert.deepEqual(report, { status: 'offline', cloud: null, local: { positions: 1, prefs: 0, chats: 0 } }, name);
        assert.equal((client.upserts?.length ?? 0) + (client.deletes?.length ?? 0), 0, `${name}: no write`);
        assert.deepEqual(contents(storage), before, `${name}: this browser unchanged`);
        assert.equal(storeEvents(win).length, 0, name);
        assert.equal(warnings.length, 1, `${name}: one warning, got ${warnings.length}`);
      });
    }
  });

  await t("resolveConflict('merge'): union — only-here uploaded, only-in-account applied here, on both sides this browser's copy uploaded; secrets kept", async () => {
    await inBrowser(async ({ storage, win, SupabaseBackend, local }) => {
      const client = seedConflict(local);
      const backend = new SupabaseBackend(local, U, client);
      assert.equal((await backend.hydrate()).status, 'conflict');
      const result = await backend.resolveConflict('merge');
      await settle();
      assert.deepEqual(result, { pushed: 5, pulled: 4, deleted: 0 });
      assert.deepEqual(upserted(client),
        ['chat_histories:AVGO', 'positions:AVGO', 'positions:NVDA', 'preferences:sidebarWidth', 'preferences:strategic_context']);
      assert.equal(client.deletes.length, 0);
      assert.equal(client.tables.positions.find((r) => r.ticker === 'AVGO').cost_basis, 100, "AVGO: this browser's copy won");
      assert.equal(client.tables.preferences.find((r) => r.key === 'strategic_context').value, 'local plan');
      assert.deepEqual(JSON.parse(storage.getItem('position_AVGO')), { costBasis: 100, shares: 10 });
      assert.deepEqual(JSON.parse(storage.getItem('position_TSLA')), { costBasis: 200, shares: 1 }, 'account-only position applied');
      assert.equal(storage.getItem('ai_provider'), JSON.stringify('openai'));
      assert.equal(storage.getItem('section_research'), 'false');
      assert.deepEqual(JSON.parse(storage.getItem('chat_history_MSFT')), MSGS2);
      assert.equal(storage.getItem('strategic_context'), JSON.stringify('local plan'));
      assert.equal(storage.getItem('ai_key_anthropic'), JSON.stringify('sk-ant-local'));
      assert.deepEqual(cloudKeys(client), ['chat_histories:AVGO', 'chat_histories:MSFT', 'positions:AVGO', 'positions:NVDA', 'positions:TSLA',
        'preferences:ai_provider', 'preferences:section_research', 'preferences:sidebarWidth', 'preferences:strategic_context']);
      assert.equal(storeEvents(win).length, 1);
      await assert.rejects(backend.resolveConflict('merge'), /hydrate/, 'the snapshot is used up');
    });
  });

  await t("resolveConflict('cloud'): this browser becomes the account's copy (API keys kept), nothing uploaded or deleted", async () => {
    await inBrowser(async ({ storage, win, SupabaseBackend, local }) => {
      const client = seedConflict(local);
      storage.setItem('access_token', 'jwt');
      const backend = new SupabaseBackend(local, U, client);
      await backend.hydrate();
      const tablesBefore = clone(client.tables);
      const result = await backend.resolveConflict('cloud');
      await settle();
      assert.deepEqual(result, { pushed: 0, pulled: 6, deleted: 0 });
      assert.deepEqual(Object.keys(contents(storage)), ['access_token', 'ai_key_anthropic', 'ai_provider', 'chat_history_MSFT',
        'position_AVGO', 'position_TSLA', 'section_research', 'strategic_context']);
      assert.deepEqual(JSON.parse(storage.getItem('position_AVGO')), { costBasis: 120, shares: 10 });
      assert.equal(storage.getItem('strategic_context'), JSON.stringify('cloud plan'));
      assert.equal(storage.getItem('ai_key_anthropic'), JSON.stringify('sk-ant-local'), 'API keys stay');
      assert.equal(client.upserts.length + client.deletes.length, 0);
      assert.deepEqual(client.tables, tablesBefore);
      assert.equal(storeEvents(win).length, 1);
    });
  });

  await t("resolveConflict('local'): the account becomes this browser's copy — everything here uploaded, account-only rows hard-deleted; nothing changes here", async () => {
    await inBrowser(async ({ storage, win, SupabaseBackend, local }) => {
      const client = seedConflict(local);
      const backend = new SupabaseBackend(local, U, client);
      await backend.hydrate();
      const before = contents(storage);
      const result = await backend.resolveConflict('local');
      await settle();
      assert.deepEqual(result, { pushed: 5, pulled: 0, deleted: 4 });
      assert.deepEqual(upserted(client),
        ['chat_histories:AVGO', 'positions:AVGO', 'positions:NVDA', 'preferences:sidebarWidth', 'preferences:strategic_context']);
      assert.deepEqual(client.deletes.map((d) => [d.table, d.filters]).sort(), [
        ['chat_histories', [['user_id', U], ['ticker', 'MSFT']]],
        ['positions', [['user_id', U], ['ticker', 'TSLA']]],
        ['preferences', [['user_id', U], ['key', 'ai_provider']]],
        ['preferences', [['user_id', U], ['key', 'section_research']]],
      ]);
      assert.deepEqual(cloudKeys(client), ['chat_histories:AVGO', 'positions:AVGO', 'positions:NVDA', 'preferences:sidebarWidth', 'preferences:strategic_context']);
      assert.equal(client.tables.positions.find((r) => r.ticker === 'AVGO').cost_basis, 100);
      assert.deepEqual(contents(storage), before);
      assert.equal(storeEvents(win).length, 1);
    });
  });

  await t('signOut, confirmed: auth.signOut once; positions, chats, every preference, access_token, _import_backup and the owner mark removed; backend reset; store-changed', async () => {
    await inBrowser(async ({ storage, win, warnings, store, SupabaseBackend, session, local }) => {
      const client = fakeSupabase();
      store.setBackend(new SupabaseBackend(local, U, client));
      local.setPosition('AVGO', { costBasis: 100, shares: 10 });
      local.setChatHistory('AVGO', MSGS);
      for (const name of ALL_PREF_NAMES) local.setPreference(name, `v-${name}`);
      storage.setItem('access_token', 'jwt');
      storage.setItem('_import_backup', '{}');
      storage.setItem(session.LOCAL_OWNER_KEY, U);
      storage.setItem('sb-project-auth-token', 'supabase-js removes its own session');
      let asked = null;
      const result = await session.signOut({ client, confirm: (message) => { asked = message; return true; } });
      assert.deepEqual(result, { signedOut: true, error: null });
      assert.equal(asked, session.SIGN_OUT_CONFIRM);
      assert.equal(client.signOuts, 1);
      assert.deepEqual(Object.keys(contents(storage)), ['sb-project-auth-token'], 'nothing of the user is left');
      assert.ok(storeEvents(win).length >= 1 && storeEvents(win).at(-1).detail == null, 'store-changed without detail');
      assert.ok(win.events.some((e) => e.type === 'auth-changed'), 'the access token change is announced');
      store.setPosition('MSFT', { costBasis: 1, shares: 1 });
      await settle();
      assert.equal(client.upserts.length, 0, 'the SupabaseBackend is gone: later writes stay in this browser');
      assert.equal(storage.getItem('position_MSFT'), JSON.stringify({ costBasis: 1, shares: 1 }));
      assert.deepEqual(warnings, []);
    });
  });

  await t('signOut, declined: nothing changes (no auth call, storage and backend as they were)', async () => {
    await inBrowser(async ({ storage, win, store, SupabaseBackend, session, local }) => {
      const client = fakeSupabase();
      store.setBackend(new SupabaseBackend(local, U, client));
      local.setPosition('AVGO', { costBasis: 100, shares: 10 });
      local.setPreference('ai_key_openai', 'sk');
      storage.setItem('access_token', 'jwt');
      const before = contents(storage);
      const result = await session.signOut({ client, confirm: () => false });
      assert.deepEqual(result, { signedOut: false, error: null });
      assert.equal(client.signOuts, 0);
      assert.deepEqual(contents(storage), before);
      assert.equal(win.events.length, 0);
      store.setPosition('MSFT', { costBasis: 1, shares: 1 });
      await settle();
      assert.equal(client.upserts.length, 1, 'still the SupabaseBackend');
    });
  });

  await t('signOut, Supabase fails ({ error } or a throw) or is absent: this browser is cleared anyway and the error reported', async () => {
    const throwing = { auth: { async signOut() { throw new Error('fetch failed'); } } };
    for (const [name, client, message] of [
      ['returned { error }', fakeSupabase({ signOutError: { message: 'network down' } }), 'network down'],
      ['thrown', throwing, 'fetch failed'],
      ['no client', null, null],
    ]) {
      await inBrowser(async ({ storage, warnings, session, local }) => {
        local.setPosition('AVGO', { costBasis: 100, shares: 10 });
        local.setPreference('data_tradier_key', 'tr');
        storage.setItem('access_token', 'jwt');
        const result = await session.signOut({ client, confirm: () => true });
        assert.equal(result.signedOut, true, name);
        assert.equal(result.error?.message ?? null, message, name);
        assert.deepEqual(Object.keys(contents(storage)), [], `${name}: cleared`);
        assert.equal(warnings.length, message ? 1 : 0, `${name}: warnings`);
      });
    }
  });

  await t('a hydrate still reading when the user signs out (or the backend is replaced) writes nothing: no rows land here, no upload', async () => {
    await inBrowser(async ({ storage, warnings, store, SupabaseBackend, session, local }) => {
      let release;
      const client = fakeSupabase({
        tables: { positions: [posRow('AVGO', 100, 10)], chat_histories: [chatRow('AVGO', MSGS)] },
        gate: new Promise((resolve) => { release = resolve; }),
      });
      const backend = new SupabaseBackend(local, U, client);
      store.setBackend(backend);
      const pending = backend.hydrate();
      await settle();
      assert.equal(client.reads.length, 0, 'the reads are in flight');
      await session.signOut({ client, confirm: () => true });
      local.setPosition('NVDA', { costBasis: 5, shares: 5 }); // someone else's data now
      release();
      const report = await pending;
      await settle();
      assert.deepEqual(report, { status: 'offline', cloud: null, local: null });
      assert.equal(storage.getItem('position_AVGO'), null, "the signed-out account's rows never land here");
      assert.equal(storage.getItem('chat_history_AVGO'), null);
      assert.equal(client.upserts.length + client.deletes.length, 0);
      assert.equal(backend.pushLocal(), 0, 'a disposed backend uploads nothing');
      assert.deepEqual(warnings, []);
    });
    // An account switch replaces the backend the same way.
    await inBrowser(async ({ storage, store, SupabaseBackend, local }) => {
      let release;
      const client = fakeSupabase({ tables: { positions: [posRow('AVGO', 100, 10)] }, gate: new Promise((resolve) => { release = resolve; }) });
      const backendA = new SupabaseBackend(local, U, client);
      store.setBackend(backendA);
      const pending = backendA.hydrate();
      store.setBackend(new SupabaseBackend(new store.LocalStorageBackend(), 'user-b', fakeSupabase()));
      release();
      assert.equal((await pending).status, 'offline');
      assert.equal(storage.getItem('position_AVGO'), null);
    });
  });

  await t("claimLocalData: another account's data is cleared (API keys kept) before this account's backend; data with no owner, or this account's, is kept", async () => {
    await inBrowser(async ({ storage, warnings, session, local }) => {
      const seed = () => {
        local.setPosition('AVGO', { costBasis: 100, shares: 10 });
        local.setChatHistory('AVGO', MSGS);
        local.setPreference('strategic_context', 'plan');
        local.setPreference('ai_key_openai', 'sk');
      };
      const userData = () => Object.keys(contents(storage)).filter((k) => k !== session.LOCAL_OWNER_KEY);
      seed();
      assert.equal(session.claimLocalData(U), false, 'nobody owned it (used without signing in): kept for hydrate');
      assert.equal(storage.getItem(session.LOCAL_OWNER_KEY), U);
      assert.equal(session.claimLocalData(U), false, 'same account again (a reload)');
      assert.deepEqual(userData(), ['ai_key_openai', 'chat_history_AVGO', 'position_AVGO', 'strategic_context']);
      assert.equal(warnings.length, 0);

      assert.equal(session.claimLocalData('user-b'), true, 'recorded owner is another account (its session ended elsewhere)');
      assert.deepEqual(userData(), ['ai_key_openai'], 'positions, chats and settings removed; API key kept');
      assert.equal(storage.getItem(session.LOCAL_OWNER_KEY), 'user-b');
      assert.equal(warnings.length, 1);

      seed();
      storage.removeItem(session.LOCAL_OWNER_KEY);
      assert.equal(session.claimLocalData('user-c', { previousUserId: 'user-b' }), true, 'this tab had another account signed in');
      assert.deepEqual(userData(), ['ai_key_openai']);

      seed();
      await session.signOut({ client: null, confirm: () => true });
      assert.equal(storage.getItem(session.LOCAL_OWNER_KEY), null, 'sign-out leaves nobody owning this browser');
      local.setPosition('AVGO', { costBasis: 1, shares: 1 });
      assert.equal(session.claimLocalData('user-d'), false, 'data made after a sign-out is nobody\'s: kept');
      assert.deepEqual(userData(), ['position_AVGO']);
    });
  });
}
