// scripts/verify/sync.mjs — Phase 3 checks; loaded by scripts/verify-functions.mjs with its helpers.
// SupabaseBackend (hydrate decisions, conflict resolution, the write path: outbox, tombstones,
// last-writer-wins dates, replaceCloud), the outbox itself (syncOutbox.js) and session.js against a
// recording fake Supabase client: nothing here touches the network or a real project, and nothing
// sleeps (timers and `now` are injected from a fake clock).
// store.js, SupabaseBackend.js and session.js are imported unsuffixed: session.js and the backend import
// ./store.js, so a cache-busted store would be a different instance from theirs. Browser globals are
// swapped per check (inBrowser) and each check starts from a fresh LocalStorageBackend.
import { readFile } from 'node:fs/promises';
import { memoryStorage, withGlobals, fakeWindow, fakeClock, settle } from './helpers.mjs';

const BACKEND_URL = new URL('../../src/lib/SupabaseBackend.js', import.meta.url);
const OUTBOX_URL = new URL('../../src/lib/syncOutbox.js', import.meta.url);
const STORE_URL = new URL('../../src/lib/store.js', import.meta.url);
const SUPABASE_URL = new URL('../../src/lib/supabase.js', import.meta.url);
const SESSION_URL = new URL('../../src/lib/session.js', import.meta.url);

const KEY_COLUMN = { positions: 'ticker', preferences: 'key', chat_histories: 'ticker' };
const clone = (v) => JSON.parse(JSON.stringify(v));

// postgrest-js responses. A fetch that fails resolves (it does not throw) with code '' and status 0.
const OK = { error: null, status: 201 };
const NETWORK = { error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' }, status: 0 };
const RLS = { error: { message: 'new row violates row-level security policy for table "positions"', code: '42501' }, status: 403 };
const NO_COLUMN = { error: { message: "Could not find the 'deleted_at' column of 'positions' in the schema cache", code: 'PGRST204' }, status: 400 };
const NOT_NULL = { error: { message: 'null value in column "value" of relation "preferences" violates not-null constraint', code: '23502' }, status: 400 };

/**
 * Fake supabase-js client. `from(table)` returns a thenable query builder: select/eq/is chain,
 * upsert(rows, opts) and delete() too, and awaiting the builder runs the query against the
 * in-memory `tables` (rows are plain objects with user_id + key column). Every read, upsert and
 * delete is recorded; `reads`, `upserts`, `deletes`, `signOuts` and `tables` read the live state
 * (also on `_state`). Options:
 *   tables      – initial rows per table
 *   readError   – { [table]: error } → that table's select resolves { data: null, error, status: 500 }
 *   respond     – ({ table, op, rows, filters }) => { error, status } | undefined; a returned value is
 *                 the write's response and the write is NOT applied (simulates RLS / network failures,
 *                 a database without migration 005); a throw rejects the write like a failed fetch
 *                 would with throwOnError. Every attempt is recorded either way.
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
// Later times, for last-writer-wins: AT < T1 < T2 < T3 < NOW.
const T1 = '2026-09-02T00:00:00.000Z';
const T2 = '2026-09-03T00:00:00.000Z';
const T3 = '2026-09-04T00:00:00.000Z';
const NOW = '2026-09-10T00:00:00.000Z';
const EPOCH = new Date(0).toISOString();
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
const keyOf = (upsert) => `${upsert.table}:${upsert.rows[0].ticker ?? upsert.rows[0].key}`;
const upserted = (client) => client.upserts.map(keyOf).sort();
const cloudKeys = (client) => Object.entries(client.tables)
  .flatMap(([table, rows]) => rows.map((r) => `${table}:${r[KEY_COLUMN[table]]}`)).sort();
// The account's rows that hold an item, and its tombstones (deleted_at set).
const rowKeys = (client, keep) => Object.entries(client.tables)
  .flatMap(([table, rows]) => rows.filter(keep).map((r) => `${table}:${r[KEY_COLUMN[table]]}`)).sort();
const live = (client) => rowKeys(client, (r) => !r.deleted_at);
const tombstoned = (client) => rowKeys(client, (r) => r.deleted_at);
// Upserts that write content (deleted_at null or absent) and tombstone upserts.
const contentUpserts = (client) => client.upserts.filter((u) => !u.rows[0].deleted_at);
const tombstoneUpserts = (client) => client.upserts.filter((u) => u.rows[0].deleted_at);
// A tombstone as the backend sends it (content nulled, deleted_at = updated_at = the time of the delete),
// and the tombstones a client received in that form, in table:key order.
const NULLED = { positions: { cost_basis: null, shares: null }, preferences: { value: null }, chat_histories: { messages: null } };
const tombRow = (table, key, at) => ({ table, row: { user_id: U, [KEY_COLUMN[table]]: key, ...NULLED[table], deleted_at: at, updated_at: at } });
const tombstonesSent = (client) => tombstoneUpserts(client)
  .sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
  .map((u) => ({ table: u.table, row: u.rows[0] }));
// The sync bookkeeping in localStorage: the outbox and the per-item dates.
const isSyncKey = (key) => key.startsWith('sync_outbox_') || key.startsWith('sync_meta_');
const syncKeys = (storage) => [...storage.map.keys()].filter(isSyncKey).sort();
const userData = (storage) => Object.fromEntries(Object.entries(contents(storage)).filter(([key]) => !isSyncKey(key)));
const metaOf = (storage, userId = U) => JSON.parse(storage.getItem(`sync_meta_${userId}`) ?? 'null');
const outboxOf = (storage, userId = U) => JSON.parse(storage.getItem(`sync_outbox_${userId}`) ?? 'null');
/** SupabaseBackend options that put its clock and timers on a fake clock. */
const onClock = (clock) => ({
  now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  setInterval: clock.setInterval, clearInterval: clock.clearInterval,
});
/** Comments stripped, string literals kept (so a '//' inside a string is not taken for one). */
const stripComments = (src) => src.replace(
  /('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_, str) => str ?? '');

/**
 * Runs fn({ storage, win, warnings, store, SupabaseBackend, session, local }) with a fresh localStorage
 * and window (and `document` when given), the store reset to a LocalStorageBackend; `local` is a
 * LocalStorageBackend for seeding.
 */
async function inBrowser(fn, { document } = {}) {
  const storage = memoryStorage();
  const win = fakeWindow();
  await withGlobals({ localStorage: storage, window: win, document }, async (warnings) => {
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
 * Nothing here is dated (seeded straight into localStorage), so this browser's copies win a merge.
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

/**
 * An outbox for `userId` on a fake clock, saving into `storage`, with a scripted send: each call takes the
 * next `script` entry (a response, an Error to throw, or a function of the op returning either, possibly
 * as a promise); once the script runs out, every send succeeds. `sent` records the ops sent, in order, and
 * `warnings` each warn() call.
 */
async function outboxRig({ storage = memoryStorage(), script = [], userId = U, clock = fakeClock(Date.parse(AT)) } = {}) {
  const { createOutbox } = await import(OUTBOX_URL);
  const sent = [];
  const warnings = [];
  const send = async (op) => {
    sent.push(clone(op));
    let next = script.shift();
    if (typeof next === 'function') next = await next(op);
    if (next instanceof Error) throw next;
    return next ?? OK;
  };
  const outbox = createOutbox({
    userId, send, storage, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    warn: (...args) => { warnings.push(args); },
  });
  return { outbox, clock, sent, warnings, storage, script };
}

const posOp = (key, extra = {}) => ({ table: 'positions', key, op: 'upsert', row: { ticker: key, cost_basis: 1, shares: 1 }, ts: 1, ...extra });
const sentKeys = (sent) => sent.map((op) => op.key);
// The outbox saves its queue in a microtask after a burst of changes: one microtask later it is there.
const tick = () => Promise.resolve();

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

  await t("hydrate, the same data on both sides (JSONB reorders keys; unknown cloud names ignored) → in-sync: nothing written to the account or to this browser's data; its copies take the account's dates", async () => {
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
      assert.deepEqual(userData(storage), before);
      // Dated by the account's rows, so a later edit or delete made elsewhere is recognized as newer
      // (an undated copy would win against it). The AVGO row carries no updated_at: the epoch.
      assert.deepEqual(metaOf(storage), { 'positions:AVGO': EPOCH, 'preferences:ai_provider': AT, 'preferences:strategic_context': AT,
        'preferences:section_charts': AT, 'chat_histories:AVGO': AT });
      assert.equal(storage.getItem('mystery_setting'), null);
      assert.equal(storeEvents(win).length, 0);
      assert.deepEqual(warnings, []);
      await assert.rejects(backend.resolveConflict('cloud'), /no conflict/, 'nothing to resolve after in-sync');
      assert.deepEqual(userData(storage), before);
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

  await t("resolveConflict('cloud'): this browser becomes the account's copy (API keys kept, copies dated by the account's rows), nothing uploaded or deleted", async () => {
    await inBrowser(async ({ storage, win, SupabaseBackend, local }) => {
      const client = seedConflict(local);
      storage.setItem('access_token', 'jwt');
      const backend = new SupabaseBackend(local, U, client);
      await backend.hydrate();
      const tablesBefore = clone(client.tables);
      const result = await backend.resolveConflict('cloud');
      await settle();
      assert.deepEqual(result, { pushed: 0, pulled: 6, deleted: 0 });
      assert.deepEqual(Object.keys(userData(storage)), ['access_token', 'ai_key_anthropic', 'ai_provider', 'chat_history_MSFT',
        'position_AVGO', 'position_TSLA', 'section_research', 'strategic_context']);
      assert.deepEqual(metaOf(storage), { 'positions:AVGO': AT, 'positions:TSLA': AT, 'preferences:strategic_context': AT,
        'preferences:ai_provider': AT, 'preferences:section_research': AT, 'chat_histories:MSFT': AT });
      assert.deepEqual(JSON.parse(storage.getItem('position_AVGO')), { costBasis: 120, shares: 10 });
      assert.equal(storage.getItem('strategic_context'), JSON.stringify('cloud plan'));
      assert.equal(storage.getItem('ai_key_anthropic'), JSON.stringify('sk-ant-local'), 'API keys stay');
      assert.equal(client.upserts.length + client.deletes.length, 0);
      assert.deepEqual(client.tables, tablesBefore);
      assert.equal(storeEvents(win).length, 1);
    });
  });

  await t("resolveConflict('local'): the account becomes this browser's copy — everything here uploaded, account-only rows tombstoned (content nulled, deleted_at set; no hard delete); nothing changes here", async () => {
    await inBrowser(async ({ storage, win, SupabaseBackend, local }) => {
      const client = seedConflict(local);
      const backend = new SupabaseBackend(local, U, client, { now: () => Date.parse(NOW) });
      await backend.hydrate();
      const before = contents(storage);
      const result = await backend.resolveConflict('local');
      await settle();
      assert.deepEqual(result, { pushed: 5, pulled: 0, deleted: 4 });
      assert.deepEqual(contentUpserts(client).map(keyOf).sort(),
        ['chat_histories:AVGO', 'positions:AVGO', 'positions:NVDA', 'preferences:sidebarWidth', 'preferences:strategic_context']);
      assert.deepEqual(tombstonesSent(client), [
        tombRow('chat_histories', 'MSFT', NOW),
        tombRow('positions', 'TSLA', NOW),
        tombRow('preferences', 'ai_provider', NOW),
        tombRow('preferences', 'section_research', NOW),
      ]);
      assert.equal(client.deletes.length, 0, 'no hard delete: a device that still holds these learns they were deleted');
      assert.deepEqual(live(client), ['chat_histories:AVGO', 'positions:AVGO', 'positions:NVDA', 'preferences:sidebarWidth', 'preferences:strategic_context']);
      assert.deepEqual(tombstoned(client), ['chat_histories:MSFT', 'positions:TSLA', 'preferences:ai_provider', 'preferences:section_research']);
      assert.equal(client.tables.positions.find((r) => r.ticker === 'AVGO').cost_basis, 100);
      assert.deepEqual(userData(storage), before);
      assert.equal(storeEvents(win).length, 1);
    });
  });

  await t('auth_skipped: a raw device flag under AUTH_SKIPPED_KEY, read back as a boolean, cleared with false; never a preference', async () => {
    await inBrowser(async ({ storage, store, session }) => {
      assert.equal(session.AUTH_SKIPPED_KEY, 'auth_skipped');
      assert.ok(store.DEVICE_KEYS.has(session.AUTH_SKIPPED_KEY), 'guarded against ever syncing or exporting');
      assert.equal(session.isAuthSkipped(), false);
      session.setAuthSkipped(true);
      assert.equal(storage.getItem('auth_skipped'), '1');
      assert.equal(session.isAuthSkipped(), true);
      assert.equal(store.getPreference('auth_skipped'), 1, 'a raw key, not JSON (getPreference would parse "1")');
      assert.deepEqual(store.exportAll().preferences, {}, 'not exported');
      session.setAuthSkipped(false);
      assert.equal(storage.getItem('auth_skipped'), null);
      assert.equal(session.isAuthSkipped(), false);
    });
    await withGlobals({ localStorage: undefined, window: undefined }, async () => {
      const session = await import(SESSION_URL);
      assert.equal(session.isAuthSkipped(), false, 'no storage: not skipped');
      assert.doesNotThrow(() => session.setAuthSkipped(true), 'no storage: no throw');
    });
  });

  await t('signOut, confirmed: auth.signOut once; positions, chats, every preference, access_token, _import_backup, the owner mark, the outbox and the sync dates removed; backend reset; store-changed', async () => {
    await inBrowser(async ({ storage, win, warnings, store, SupabaseBackend, session, local }) => {
      const clock = fakeClock(Date.parse(T1));
      let online = false;
      const client = fakeSupabase({ respond: () => (online ? undefined : NETWORK) });
      store.setBackend(new SupabaseBackend(local, U, client, onClock(clock)));
      local.setPosition('AVGO', { costBasis: 100, shares: 10 });
      local.setChatHistory('AVGO', MSGS);
      for (const name of ALL_PREF_NAMES) local.setPreference(name, `v-${name}`);
      storage.setItem('access_token', 'jwt');
      storage.setItem('_import_backup', '{}');
      storage.setItem(session.LOCAL_OWNER_KEY, U);
      session.setAuthSkipped(true);
      storage.setItem('sb-project-auth-token', 'supabase-js removes its own session');
      store.setPosition('NVDA', { costBasis: 5, shares: 5 }); // through the backend, while the network is down
      await settle();
      assert.deepEqual(syncKeys(storage), ['sync_meta_user-a', 'sync_outbox_user-a'], 'a write waits in the outbox, dated');
      let asked = null;
      const result = await session.signOut({ client, confirm: (message) => { asked = message; return true; } });
      const attempts = client.upserts.length; // the sign-out tried once more to send the queued write (network still down)
      assert.deepEqual(result, { signedOut: true, error: null });
      assert.equal(asked, session.SIGN_OUT_CONFIRM);
      assert.equal(client.signOuts, 1);
      assert.deepEqual(Object.keys(contents(storage)), ['sb-project-auth-token'], 'nothing of the user is left (no sync_outbox_* or sync_meta_*)');
      assert.equal(session.isAuthSkipped(), false, 'the sign-in screen comes back after a sign-out');
      assert.ok(storeEvents(win).length >= 1 && storeEvents(win).at(-1).detail == null, 'store-changed without detail');
      assert.ok(win.events.some((e) => e.type === 'auth-changed'), 'the access token change is announced');
      assert.equal(clock.queued, 0, 'the disposed backend left no retry behind');
      online = true;
      clock.advance(10 * 60 * 1000);
      store.setPosition('MSFT', { costBasis: 1, shares: 1 });
      await settle();
      assert.equal(client.upserts.length, attempts, 'the SupabaseBackend is gone: its queued write was dropped, later writes stay in this browser');
      assert.equal(storage.getItem('position_MSFT'), JSON.stringify({ costBasis: 1, shares: 1 }));
      assert.equal(warnings.length, 1, `a network failure is retried, not reported; only the sign-out names the dropped write: ${JSON.stringify(warnings)}`);
      assert.match(String(warnings[0][0]), /1 change\(s\) could not be sent/, 'the write the sign-out dropped is reported once');
    });
  });

  await t('signOut sends writes still queued first (a retry waiting for its backoff goes at once), so the account really keeps the copy', async () => {
    await inBrowser(async ({ storage, warnings, store, SupabaseBackend, session, local }) => {
      const clock = fakeClock(Date.parse(T1));
      let online = false;
      const client = fakeSupabase({ respond: () => (online ? undefined : NETWORK) });
      store.setBackend(new SupabaseBackend(local, U, client, onClock(clock)));
      store.setPosition('NVDA', { costBasis: 5, shares: 5 });
      await settle();
      assert.equal(client.tables.positions.length, 0, 'the first attempt failed; a retry waits for its backoff');
      assert.ok(clock.queued > 0, 'a retry is scheduled');
      online = true;
      const result = await session.signOut({ client, confirm: () => true });
      assert.deepEqual(result, { signedOut: true, error: null });
      assert.deepEqual(client.tables.positions.map((r) => [r.ticker, r.cost_basis]), [['NVDA', 5]], 'sent before the sign-out, without waiting for the backoff');
      assert.equal(client.signOuts, 1);
      assert.deepEqual(syncKeys(storage), [], 'outbox and dates gone afterwards');
      assert.equal(storage.getItem('position_NVDA'), null, 'this browser is cleared as before');
      assert.deepEqual(warnings, [], 'nothing was dropped, nothing to report');
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

  // ── The outbox (syncOutbox.js) ─────────────────────────────────────────────

  await t('syncOutbox.js imports only ./retry.js and reads no browser global (bar a default globalThis.localStorage); without storage the queue lives in memory; bad arguments throw', async () => {
    const code = stripComments(await readFile(OUTBOX_URL, 'utf8'));
    assert.deepEqual([...code.matchAll(/\bimport\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]), ['./retry.js']);
    assert.doesNotMatch(code, /\bimport\s*\(/);
    assert.equal(code.match(/(?<!globalThis\.)\b(?:window|document|localStorage|sessionStorage|navigator)\b/g), null);
    await withGlobals({ localStorage: undefined, window: undefined }, async () => {
      const { createOutbox } = await import(`${OUTBOX_URL.href}?nodom=1`);
      const clock = fakeClock();
      const sent = [];
      const outbox = createOutbox({ userId: U, send: async (op) => { sent.push(op.key); return OK; }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
      outbox.enqueue(posOp('AVGO'));
      await outbox.flush();
      assert.deepEqual(sent, ['AVGO']);
      assert.throws(() => createOutbox({ send: async () => OK }), /userId/);
      assert.throws(() => createOutbox({ userId: U }), /send/);
      assert.throws(() => outbox.enqueue({ table: 'positions', key: 'AVGO', op: 'patch' }), TypeError);
    });
  });

  await t('syncOutbox: ops coalesce per (table, key) (the latest replaces an earlier one and moves to the tail); the queue is saved as JSON under sync_outbox_<uid> after every change (a burst of changes in one save) and read back by a new outbox', async () => {
    const storage = memoryStorage();
    let saves = 0;
    const counting = { getItem: (k) => storage.getItem(k), setItem: (k, v) => { saves++; storage.setItem(k, v); }, removeItem: (k) => storage.removeItem(k) };
    const summary = () => outboxOf(storage)?.map((o) => `${o.table}:${o.key}:${o.op}`) ?? null;
    const { outbox, sent } = await outboxRig({ storage: counting, script: [NETWORK] });
    outbox.enqueue(posOp('AVGO'));
    await tick();
    assert.deepEqual(summary(), ['positions:AVGO:upsert'], 'saved in the same tick it is queued');
    await settle();
    assert.equal(sent.length, 1, 'sent at once; it failed (network), so a retry now waits');
    const savesBefore = saves;
    outbox.enqueue(posOp('NVDA'));
    outbox.enqueue({ table: 'preferences', key: 'AVGO', op: 'upsert', row: { key: 'AVGO', value: 1 } }); // same key, another table
    outbox.enqueue(posOp('AVGO', { row: { ticker: 'AVGO', cost_basis: 2, shares: 2 }, ts: 2 }));
    await tick();
    assert.equal(saves - savesBefore, 1, 'three changes in one run: one save');
    assert.deepEqual(summary(), ['positions:NVDA:upsert', 'preferences:AVGO:upsert', 'positions:AVGO:upsert'], 'the newer AVGO op replaced the first and went to the tail');
    outbox.enqueue(posOp('NVDA', { op: 'delete', row: null, ts: 3 }));
    await settle();
    assert.equal(sent.length, 1, 'nothing is sent while the retry waits');
    assert.equal(outbox.size(), 3);
    assert.deepEqual(outboxOf(storage), [
      { table: 'preferences', key: 'AVGO', op: 'upsert', row: { key: 'AVGO', value: 1 }, ts: Date.parse(AT) },
      { table: 'positions', key: 'AVGO', op: 'upsert', row: { ticker: 'AVGO', cost_basis: 2, shares: 2 }, ts: 2 },
      { table: 'positions', key: 'NVDA', op: 'delete', row: null, ts: 3 },
    ], 'whole ops, the latest per item; an op without ts is dated by now()');
    outbox.dispose();

    const reloaded = await outboxRig({ storage }); // a reload: a new outbox for the same user
    assert.equal(reloaded.outbox.size(), 3);
    await reloaded.outbox.flush();
    assert.deepEqual(reloaded.sent.map((o) => `${o.table}:${o.key}:${o.op}`), ['preferences:AVGO:upsert', 'positions:AVGO:upsert', 'positions:NVDA:delete']);
    assert.equal(reloaded.outbox.size(), 0);
    assert.equal(storage.getItem('sync_outbox_user-a'), null, 'an empty queue leaves no key behind');
    storage.setItem('sync_outbox_user-b', '{not json');
    assert.equal((await outboxRig({ storage, userId: 'user-b' })).outbox.size(), 0, 'a corrupted copy starts empty');
  });

  await t('syncOutbox flush: one op at a time from the head; success shifts; { error } without a code (or a throw) keeps the op at the head and retries after backoffSeconds(2, failures, 300) s on the injected timer; force retries at once; ops queued mid-flush go out; a success resets the backoff', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { outbox, clock, sent, warnings, storage, script } = await outboxRig({
      script: [NETWORK, { error: { message: '<html>Bad Gateway</html>' }, status: 502 }, new Error('fetch failed'), OK, () => gate.then(() => OK)],
    });
    outbox.enqueue(posOp('AVGO'));
    outbox.enqueue(posOp('NVDA'));
    outbox.enqueue(posOp('TSLA'));
    await settle();
    assert.deepEqual(sentKeys(sent), ['AVGO'], 'the head failed: the rest wait behind it');
    assert.deepEqual(clock.pending(), [{ in: 4000, every: 0 }], 'retry in backoffSeconds(2, 1) = 4 s');
    clock.advance(3999);
    await settle();
    assert.equal(sent.length, 1);
    clock.advance(1);
    await settle();
    assert.deepEqual(sentKeys(sent), ['AVGO', 'AVGO'], 'retried after 4 s (a 502 without a code fails again)');
    assert.deepEqual(clock.pending(), [{ in: 8000, every: 0 }]);
    clock.advance(8000);
    await settle();
    assert.equal(sent.length, 3, 'a throw is retryable too');
    assert.deepEqual(clock.pending(), [{ in: 16000, every: 0 }]);
    await outbox.flush();
    assert.equal(sent.length, 3, 'flush() while a retry waits does nothing');
    const forced = outbox.flush({ force: true });
    assert.equal(clock.queued, 0, 'force cancels the wait');
    await settle();
    assert.deepEqual(sentKeys(sent), ['AVGO', 'AVGO', 'AVGO', 'AVGO', 'NVDA'], 'AVGO landed; NVDA is in flight');
    outbox.flush();
    outbox.flush({ force: true });
    outbox.enqueue(posOp('MSFT'));
    await settle();
    assert.equal(sent.length, 5, 'one request at a time: a running flush is joined, not started again');
    release();
    await forced;
    assert.deepEqual(sentKeys(sent), ['AVGO', 'AVGO', 'AVGO', 'AVGO', 'NVDA', 'TSLA', 'MSFT'], 'the op queued mid-flush went out in the same flush');
    assert.equal(outbox.size(), 0);
    assert.equal(storage.getItem('sync_outbox_user-a'), null);
    script.push(NETWORK);
    outbox.enqueue(posOp('AMD'));
    await settle();
    assert.deepEqual(clock.pending(), [{ in: 4000, every: 0 }], 'failures reset on success: 4 s again, not 32 s');
    assert.deepEqual(warnings, [], 'retryable failures are not reported');
    outbox.dispose();
  });

  await t('syncOutbox: a deterministic error (42501, 22P02, 23505, PGRST…, another 4xx) drops that op with one warning naming table, key and code, and the next op goes out; isRetryable() on postgrest responses', async () => {
    const { outbox, sent, warnings, clock } = await outboxRig({ script: [RLS, OK] });
    outbox.enqueue(posOp('AVGO'));
    outbox.enqueue(posOp('NVDA'));
    await outbox.flush();
    assert.deepEqual(sentKeys(sent), ['AVGO', 'NVDA']);
    assert.equal(outbox.size(), 0);
    assert.equal(clock.queued, 0, 'no retry for a rejected write');
    assert.equal(warnings.length, 1);
    const text = warnings[0].join(' ');
    for (const part of ['positions', 'AVGO', '42501']) assert.ok(text.includes(part), `the warning names ${part}: ${text}`);

    const { isRetryable } = await import(OUTBOX_URL);
    const withCode = (code, status) => ({ error: { code, message: code }, status });
    const retryable = {
      'no response': undefined,
      'network (code "", status 0)': NETWORK,
      '502 without a code (gateway page)': { error: { message: '<html>' }, status: 502 },
      '503 PGRST002 (schema cache)': withCode('PGRST002', 503),
      '500 with a code': withCode('XX000', 500),
      '401 PGRST303 (JWT expired: refreshed by the auth client)': withCode('PGRST303', 401),
      '408': withCode('57014', 408),
      '429': withCode('RATE', 429),
    };
    const final = {
      'success': OK,
      '42501 (RLS)': RLS,
      '22P02 (bad input)': withCode('22P02', 400),
      '23505 (unique)': withCode('23505', 409),
      'PGRST204 (no column)': NO_COLUMN,
      '23502 (not null)': NOT_NULL,
      '413 with a code': withCode('PGRST413', 413),
    };
    for (const [name, response] of Object.entries(retryable)) assert.equal(isRetryable(response), true, name);
    for (const [name, response] of Object.entries(final)) assert.equal(isRetryable(response), false, name);
  });

  await t('syncOutbox: clear() drops the queue, its saved copy and a waiting retry, and the outbox stays usable; dispose() cancels the retry and stops (an op in flight stays saved for the next outbox)', async () => {
    const storage = memoryStorage();
    const { outbox, clock, sent } = await outboxRig({ storage, script: [NETWORK] });
    outbox.enqueue(posOp('AVGO'));
    await settle();
    assert.equal(clock.queued, 1, 'a retry waits');
    outbox.clear();
    await tick();
    assert.equal(outbox.size(), 0);
    assert.equal(storage.getItem('sync_outbox_user-a'), null);
    assert.equal(clock.queued, 0, 'the retry is cancelled');
    outbox.enqueue(posOp('NVDA'));
    await settle();
    assert.deepEqual(sentKeys(sent), ['AVGO', 'NVDA'], 'usable after clear(): sent at once, no backoff left over');

    const idle = await outboxRig({ storage, script: [NETWORK] });
    idle.outbox.enqueue(posOp('TSLA'));
    await settle();
    idle.outbox.dispose();
    assert.equal(idle.clock.queued, 0);
    idle.clock.advance(10 * 60 * 1000);
    await idle.outbox.flush({ force: true });
    idle.outbox.enqueue(posOp('MSFT'));
    await settle();
    assert.deepEqual(sentKeys(idle.sent), ['TSLA'], 'nothing is sent or queued after dispose()');
    assert.deepEqual(outboxOf(storage).map((o) => o.key), ['TSLA'], "the saved queue stays for this user's next outbox");

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const busy = await outboxRig({ storage: memoryStorage(), script: [() => gate.then(() => OK)] });
    busy.outbox.enqueue(posOp('AMD'));
    await settle();
    busy.outbox.dispose();
    release();
    await settle();
    assert.equal(busy.outbox.size(), 1, 'the answer to a send in flight at dispose() is ignored');
    assert.deepEqual(outboxOf(busy.storage).map((o) => o.key), ['AMD']);
  });

  // ── SupabaseBackend: the write path ────────────────────────────────────────

  await t('SupabaseBackend writes go through the outbox: a setPosition while the network fails is saved (sync_outbox_<uid>), retried after the backoff and lands; a reload (a new backend on the same storage) sends what the old page could not', async () => {
    await inBrowser(async ({ storage, warnings, store, SupabaseBackend, local }) => {
      const clock = fakeClock(Date.parse(T1));
      let online = false;
      const client = fakeSupabase({ respond: () => (online ? undefined : NETWORK) });
      const backend = new SupabaseBackend(local, U, client, onClock(clock));
      backend.setPosition('AVGO', { costBasis: 100, shares: 10 });
      await settle();
      assert.equal(client.upserts.length, 1, 'tried at once');
      assert.deepEqual(client.tables.positions, [], 'nothing landed');
      assert.deepEqual(outboxOf(storage), [{ table: 'positions', key: 'AVGO', op: 'upsert', row: { ticker: 'AVGO', cost_basis: 100, shares: 10 }, ts: Date.parse(T1) }]);
      clock.advance(3999);
      await settle();
      assert.equal(client.upserts.length, 1, 'no retry inside the backoff');
      clock.advance(1);
      await settle();
      assert.equal(client.upserts.length, 2, 'retried after 4 s');
      online = true;
      clock.advance(8000);
      await settle();
      assert.equal(client.upserts.length, 3);
      assert.deepEqual(client.tables.positions, [{ user_id: U, ticker: 'AVGO', cost_basis: 100, shares: 10, updated_at: T1, deleted_at: null }],
        'landed, dated by the edit');
      assert.equal(storage.getItem('sync_outbox_user-a'), null);
      assert.deepEqual(warnings, [], 'a network failure is retried, not reported');
      backend.dispose();

      online = false;
      const page = new SupabaseBackend(local, U, client, onClock(fakeClock(Date.parse(T2))));
      page.setChatHistory('AVGO', MSGS);
      await settle();
      assert.deepEqual(outboxOf(storage).map((o) => `${o.table}:${o.key}`), ['chat_histories:AVGO']);
      online = true; // the page is reloaded (no dispose() runs on unload)
      const reloaded = new SupabaseBackend(new store.LocalStorageBackend(), U, client, onClock(fakeClock(Date.parse(T3))));
      await settle();
      assert.deepEqual(client.tables.chat_histories.map((r) => [r.ticker, r.messages, r.updated_at]), [['AVGO', MSGS, T2]],
        'the new page sends it, dated by the edit');
      assert.equal(storage.getItem('sync_outbox_user-a'), null);
      page.dispose();
      reloaded.dispose();
    });
  });

  await t('SupabaseBackend in a browser: retried at once on `online` and when the tab becomes visible (not when hidden), and every 60 s while writes wait; dispose() removes the listeners, the 60 s retry and the backoff timer', async () => {
    const doc = Object.assign(fakeWindow(), { visibilityState: 'hidden' });
    await inBrowser(async ({ win, SupabaseBackend, local }) => {
      const clock = fakeClock(Date.parse(T1));
      let online = false;
      const client = fakeSupabase({ respond: () => (online ? undefined : NETWORK) });
      const backend = new SupabaseBackend(local, U, client, onClock(clock));
      assert.equal(win.listenerCount('online'), 1);
      assert.equal(doc.listenerCount('visibilitychange'), 1);
      assert.equal(clock.queued, 0, 'no timer while nothing waits');
      backend.setPreference('strategic_context', 'plan');
      await settle();
      assert.deepEqual(clock.pending(), [{ in: 4000, every: 0 }, { in: 60000, every: 60000 }], 'the backoff retry and the 60 s retry');
      win.dispatchEvent({ type: 'online' });
      await settle();
      assert.equal(client.upserts.length, 2, 'online: tried at once');
      doc.dispatchEvent({ type: 'visibilitychange' });
      await settle();
      assert.equal(client.upserts.length, 2, 'hidden: no attempt');
      doc.visibilityState = 'visible';
      doc.dispatchEvent({ type: 'visibilitychange' });
      await settle();
      assert.equal(client.upserts.length, 3, 'visible: tried at once');
      win.dispatchEvent({ type: 'online' });
      await settle();
      win.dispatchEvent({ type: 'online' });
      await settle();
      assert.equal(client.upserts.length, 5);
      assert.deepEqual(clock.pending(), [{ in: 60000, every: 60000 }, { in: 64000, every: 0 }], 'after five failures the backoff (64 s) is longer than the 60 s retry');
      online = true;
      clock.advance(60000);
      await settle();
      assert.equal(client.upserts.length, 6, 'the 60 s retry sent it');
      assert.deepEqual(client.tables.preferences.map((r) => [r.key, r.value]), [['strategic_context', 'plan']]);
      assert.equal(clock.queued, 0, 'nothing waits: the backoff was cancelled and the 60 s retry stopped');

      online = false;
      backend.setPosition('AVGO', { costBasis: 1, shares: 1 });
      await settle();
      assert.equal(clock.queued, 2);
      backend.dispose();
      assert.equal(clock.queued, 0, 'dispose(): no backoff, no 60 s retry');
      assert.equal(win.listenerCount('online'), 0);
      assert.equal(doc.listenerCount('visibilitychange'), 0);
      online = true;
      win.dispatchEvent({ type: 'online' });
      doc.dispatchEvent({ type: 'visibilitychange' });
      clock.advance(10 * 60 * 1000);
      await settle();
      assert.equal(client.upserts.length, 7, 'a disposed backend sends nothing');
    }, { document: doc });
  });

  await t('a content upsert carries deleted_at: null (a write clears a tombstone); without migration 005 (PGRST204) it is sent again without the column, with one warning per backend', async () => {
    await inBrowser(async ({ warnings, SupabaseBackend, local }) => {
      const client = fakeSupabase({ tables: { positions: [posRow('AVGO', null, null, { deleted_at: AT })] } });
      new SupabaseBackend(local, U, client).setPosition('AVGO', { costBasis: 100, shares: 10 });
      await settle();
      assert.equal(client.upserts.length, 1);
      assert.ok(Object.hasOwn(client.upserts[0].rows[0], 'deleted_at') && client.upserts[0].rows[0].deleted_at === null);
      assert.deepEqual([client.tables.positions[0].cost_basis, client.tables.positions[0].deleted_at], [100, null], 'the deleted item is back');
      assert.deepEqual(warnings, []);

      const old = fakeSupabase({ respond: ({ rows }) => (Object.hasOwn(rows[0], 'deleted_at') ? NO_COLUMN : undefined) });
      const backend = new SupabaseBackend(local, U, old);
      backend.setPosition('NVDA', { costBasis: 5, shares: 1 });
      backend.setPreference('strategic_context', 'plan');
      await settle();
      assert.deepEqual(old.upserts.map((u) => [keyOf(u), Object.hasOwn(u.rows[0], 'deleted_at')]),
        [['positions:NVDA', true], ['positions:NVDA', false], ['preferences:strategic_context', true], ['preferences:strategic_context', false]]);
      assert.deepEqual(live(old), ['positions:NVDA', 'preferences:strategic_context'], 'both landed');
      assert.equal(warnings.length, 1, 'one warning per backend');
      assert.match(warnings[0].join(' '), /supabase\/migrations\/005_sync_tombstones\.sql/);
    });
  });

  await t('every delete is a tombstone upsert (content nulled, deleted_at = updated_at = the time of the delete), never a hard delete: deletePosition, setPosition with neither field, setPreference(name, null), setChatHistory(t, []), deleteChatHistory; an API key is never sent, not even as a delete', async () => {
    await inBrowser(async ({ storage, warnings, SupabaseBackend, local }) => {
      const client = fakeSupabase({
        tables: {
          positions: [posRow('AVGO', 100, 10), posRow('NVDA', 50, 2)],
          preferences: [prefRow('strategic_context', 'plan')],
          chat_histories: [chatRow('AVGO', MSGS), chatRow('MSFT', MSGS2)],
        },
      });
      const backend = new SupabaseBackend(local, U, client, { now: () => Date.parse(T1) });
      backend.deletePosition('AVGO');
      backend.setPosition('NVDA', { costBasis: null, shares: null });
      backend.setPreference('strategic_context', null);
      backend.setPreference('ai_key_openai', null);
      backend.setChatHistory('AVGO', []);
      backend.deleteChatHistory('MSFT');
      await settle();
      assert.equal(client.deletes.length, 0, 'no hard delete');
      assert.deepEqual(client.upserts.map((u) => ({ table: u.table, row: u.rows[0] })), [
        tombRow('positions', 'AVGO', T1),
        tombRow('positions', 'NVDA', T1),
        tombRow('preferences', 'strategic_context', T1),
        tombRow('chat_histories', 'AVGO', T1),
        tombRow('chat_histories', 'MSFT', T1),
      ]);
      assert.ok(client.upserts.every((u) => u.opts.onConflict === `user_id,${KEY_COLUMN[u.table]}` && !u.opts.ignoreDuplicates));
      assert.deepEqual(live(client), [], 'every row is a tombstone now');
      assert.deepEqual(tombstoned(client), ['chat_histories:AVGO', 'chat_histories:MSFT', 'positions:AVGO', 'positions:NVDA', 'preferences:strategic_context']);
      assert.deepEqual(metaOf(storage), { 'positions:AVGO': T1, 'positions:NVDA': T1, 'preferences:strategic_context': T1,
        'chat_histories:AVGO': T1, 'chat_histories:MSFT': T1 }, 'a delete here is dated; the API key is not');
      assert.deepEqual(warnings, []);
    });
  });

  await t('without migration 005 a delete falls back to a hard delete (PGRST204: no deleted_at column; 23502: content still NOT NULL), with one warning per backend', async () => {
    await inBrowser(async ({ warnings, SupabaseBackend, local }) => {
      const client = fakeSupabase({
        tables: { positions: [posRow('AVGO', 100, 10)], preferences: [prefRow('strategic_context', 'plan')] },
        respond: ({ table, op, rows }) => (op === 'upsert' && rows[0].deleted_at ? (table === 'positions' ? NO_COLUMN : NOT_NULL) : undefined),
      });
      const backend = new SupabaseBackend(local, U, client);
      backend.deletePosition('AVGO');
      backend.setPreference('strategic_context', null);
      await settle();
      assert.equal(tombstoneUpserts(client).length, 2, 'the tombstone is tried first');
      assert.deepEqual(client.deletes.map((d) => [d.table, d.filters]), [
        ['positions', [['user_id', U], ['ticker', 'AVGO']]],
        ['preferences', [['user_id', U], ['key', 'strategic_context']]],
      ]);
      assert.deepEqual(cloudKeys(client), [], 'hard-deleted');
      assert.equal(warnings.length, 1);
      assert.match(warnings[0].join(' '), /supabase\/migrations\/005_sync_tombstones\.sql/);
    });
  });

  // ── Last writer wins, tombstones ───────────────────────────────────────────

  await t("sync_meta_<uid> dates this browser's copies: a write or a delete here stamps now, a cloud row applied here its updated_at (Postgres times read); API keys are never dated", async () => {
    await inBrowser(async ({ storage, SupabaseBackend, local }) => {
      const clock = fakeClock(Date.parse(T1));
      const backend = new SupabaseBackend(local, U, fakeSupabase(), onClock(clock));
      backend.setPosition('AVGO', { costBasis: 1, shares: 1 });
      backend.setPreference('ai_key_openai', 'sk');
      clock.advance(Date.parse(T2) - Date.parse(T1));
      backend.setChatHistory('AVGO', MSGS);
      backend.deletePosition('NVDA');
      assert.deepEqual(metaOf(storage), { 'positions:AVGO': T1, 'chat_histories:AVGO': T2, 'positions:NVDA': T2 });
      await settle();
      backend.dispose();
    });
    await inBrowser(async ({ storage, SupabaseBackend, local }) => {
      const client = fakeSupabase({
        tables: {
          positions: [posRow('AVGO', 1, 1, { updated_at: '2026-09-01T12:34:56.789012+00:00' })],
          preferences: [prefRow('strategic_context', 'plan', { updated_at: T2 })],
          chat_histories: [chatRow('MSFT', MSGS2, { updated_at: T3 })],
        },
      });
      assert.equal((await new SupabaseBackend(local, U, client).hydrate()).status, 'pulled');
      assert.deepEqual(metaOf(storage), { 'positions:AVGO': '2026-09-01T12:34:56.789Z', 'preferences:strategic_context': T2, 'chat_histories:MSFT': T3 });
    });
  });

  await t("resolveConflict('merge') is last-writer-wins per item: the more recently changed copy wins either way, an undated copy here wins, equal copies never move and take the account's date; equal content is never a conflict whatever the dates", async () => {
    await inBrowser(async ({ storage, SupabaseBackend, local }) => {
      local.setPosition('AVGO', { costBasis: 100, shares: 10 }); // changed here at T2; the account's copy is from T1 → this one
      local.setPosition('NVDA', { costBasis: 50, shares: 2 }); // here T1, the account T2 → the account's
      local.setPreference('strategic_context', 'local plan'); // here T1, the account T3 → the account's
      local.setPreference('ai_provider', 'anthropic'); // the same on both sides, dated differently → nothing moves
      local.setChatHistory('AVGO', MSGS); // undated here, the account T3 → this one (never lost)
      storage.setItem('sync_meta_user-a', JSON.stringify({ 'positions:AVGO': T2, 'positions:NVDA': T1, 'preferences:strategic_context': T1, 'preferences:ai_provider': T3 }));
      const client = fakeSupabase({
        tables: {
          positions: [posRow('AVGO', 120, 10, { updated_at: T1 }), posRow('NVDA', 55, 2, { updated_at: T2 })],
          preferences: [prefRow('strategic_context', 'cloud plan', { updated_at: T3 }), prefRow('ai_provider', 'anthropic', { updated_at: T1 })],
          chat_histories: [chatRow('AVGO', MSGS2, { updated_at: T3 })],
        },
      });
      const backend = new SupabaseBackend(local, U, client, { now: () => Date.parse(NOW) });
      assert.equal((await backend.hydrate()).status, 'conflict');
      const result = await backend.resolveConflict('merge');
      await settle();
      assert.deepEqual(result, { pushed: 2, pulled: 2, deleted: 0 });
      assert.deepEqual(upserted(client), ['chat_histories:AVGO', 'positions:AVGO'], 'only the copies that won here are uploaded');
      assert.equal(client.tables.positions.find((r) => r.ticker === 'AVGO').cost_basis, 100);
      assert.deepEqual(client.tables.chat_histories[0].messages, MSGS);
      assert.deepEqual(JSON.parse(storage.getItem('position_NVDA')), { costBasis: 55, shares: 2 }, "the account's newer copy applied here");
      assert.equal(storage.getItem('strategic_context'), JSON.stringify('cloud plan'));
      assert.equal(storage.getItem('ai_provider'), JSON.stringify('anthropic'));
      assert.deepEqual(metaOf(storage), {
        'positions:AVGO': NOW, 'chat_histories:AVGO': NOW, // uploaded: dated now
        'positions:NVDA': T2, 'preferences:strategic_context': T3, // applied: dated by the row
        'preferences:ai_provider': T1, // equal: the account's date
      });
    });
    await inBrowser(async ({ storage, SupabaseBackend, local }) => {
      local.setPosition('AVGO', { costBasis: 100, shares: 10 });
      storage.setItem('sync_meta_user-a', JSON.stringify({ 'positions:AVGO': T3 }));
      const client = fakeSupabase({ tables: { positions: [posRow('AVGO', 100, 10, { updated_at: T1 })] } });
      assert.equal((await new SupabaseBackend(local, U, client).hydrate()).status, 'in-sync', 'the same content dated differently is not a conflict');
      await settle();
      assert.equal(client.upserts.length, 0);
      assert.deepEqual(metaOf(storage), { 'positions:AVGO': T1 });
    });
  });

  await t('hydrate with tombstones only in the account (deleted items never count as its data: a first push) — one newer than this copy deletes it here, not re-uploaded; an older one, or an undated copy, loses: the copy is uploaded with deleted_at: null; one for an item not here is ignored', async () => {
    await inBrowser(async ({ storage, win, warnings, SupabaseBackend, local }) => {
      local.setPosition('AVGO', { costBasis: 100, shares: 10 }); // dated T1 here, deleted in the account at T2 → deleted here
      local.setPosition('NVDA', { costBasis: 50, shares: 2 }); // dated T3 here → wins, uploaded again
      local.setChatHistory('AVGO', MSGS); // undated here → wins
      local.setPreference('strategic_context', 'plan'); // no tombstone → uploaded
      storage.setItem('sync_meta_user-a', JSON.stringify({ 'positions:AVGO': T1, 'positions:NVDA': T3 }));
      const client = fakeSupabase({
        tables: {
          positions: [posRow('AVGO', null, null, { deleted_at: T2 }), posRow('NVDA', null, null, { deleted_at: T2 }), posRow('TSLA', null, null, { deleted_at: T2 })],
          chat_histories: [chatRow('AVGO', null, { deleted_at: T2 })],
        },
      });
      const report = await new SupabaseBackend(local, U, client, { now: () => Date.parse(NOW) }).hydrate();
      await settle();
      assert.deepEqual(report, { status: 'pushed', cloud: { positions: 0, prefs: 0, chats: 0 }, local: { positions: 2, prefs: 1, chats: 1 } });
      assert.equal(storage.getItem('position_AVGO'), null, 'deleted in the account after this copy last changed: deleted here');
      assert.deepEqual(upserted(client), ['chat_histories:AVGO', 'positions:NVDA', 'preferences:strategic_context'], 'AVGO is not uploaded again');
      assert.ok(client.upserts.every((u) => u.rows[0].deleted_at === null), 'an upload clears the tombstone');
      assert.deepEqual(live(client), ['chat_histories:AVGO', 'positions:NVDA', 'preferences:strategic_context']);
      assert.deepEqual(tombstoned(client), ['positions:AVGO', 'positions:TSLA']);
      assert.equal(storage.getItem('position_TSLA'), null, 'a tombstone for an item not here writes nothing');
      assert.equal(metaOf(storage)['positions:AVGO'], T2, 'the delete applied here is dated by the tombstone');
      assert.equal(Object.hasOwn(metaOf(storage), 'positions:TSLA'), false);
      assert.equal(storeEvents(win).length, 1, 'something changed here');
      assert.equal(client.deletes.length, 0);
      assert.deepEqual(warnings, []);
    });
  });

  await t('hydrate pulled / in-sync apply tombstones to layout too: one newer than this copy removes it here; a copy that changed here later is uploaded again', async () => {
    await inBrowser(async ({ storage, SupabaseBackend, local }) => {
      local.setPreference('sidebarWidth', 300); // dated T1, deleted in the account at T2 → removed here
      local.setPreference('section_charts', false); // dated T3 → wins, uploaded
      storage.setItem('sync_meta_user-a', JSON.stringify({ 'preferences:sidebarWidth': T1, 'preferences:section_charts': T3 }));
      const client = fakeSupabase({
        tables: {
          positions: [posRow('AVGO', 100, 10)],
          preferences: [prefRow('sidebarWidth', null, { deleted_at: T2 }), prefRow('section_charts', null, { deleted_at: T2 })],
        },
      });
      const report = await new SupabaseBackend(local, U, client, { now: () => Date.parse(NOW) }).hydrate();
      await settle();
      assert.equal(report.status, 'pulled');
      assert.equal(storage.getItem('chat_sidebar_w'), null);
      assert.equal(storage.getItem('section_charts'), 'false');
      assert.deepEqual(upserted(client), ['preferences:section_charts']);
      assert.deepEqual(JSON.parse(storage.getItem('position_AVGO')), { costBasis: 100, shares: 10 });
      assert.deepEqual(metaOf(storage), { 'preferences:sidebarWidth': T2, 'preferences:section_charts': NOW, 'positions:AVGO': AT });
    });
    await inBrowser(async ({ storage, win, SupabaseBackend, local }) => {
      local.setPosition('AVGO', { costBasis: 100, shares: 10 });
      local.setPreference('sidebarWidth', 300);
      storage.setItem('sync_meta_user-a', JSON.stringify({ 'preferences:sidebarWidth': T1 }));
      const client = fakeSupabase({ tables: { positions: [posRow('AVGO', 100, 10)], preferences: [prefRow('sidebarWidth', null, { deleted_at: T2 })] } });
      const report = await new SupabaseBackend(local, U, client).hydrate();
      await settle();
      assert.equal(report.status, 'in-sync');
      assert.equal(storage.getItem('chat_sidebar_w'), null, 'removed here');
      assert.equal(client.upserts.length, 0, 'and not uploaded again');
      assert.equal(storeEvents(win).length, 1);
    });
  });

  await t("resolveConflict settles tombstones: 'merge' deletes here what the account deleted later and uploads what changed here later; 'cloud' drops the copy (and writes queued during the prompt); 'local' brings it back", async () => {
    const seed = (storage, local, respond) => {
      local.setPosition('AVGO', { costBasis: 100, shares: 10 }); // dated T1 here, deleted in the account at T2
      local.setPosition('NVDA', { costBasis: 50, shares: 2 }); // dated T3 here, deleted at T2
      storage.setItem('sync_meta_user-a', JSON.stringify({ 'positions:AVGO': T1, 'positions:NVDA': T3 }));
      return fakeSupabase({
        tables: { positions: [posRow('AVGO', null, null, { deleted_at: T2 }), posRow('NVDA', null, null, { deleted_at: T2 }), posRow('TSLA', 1, 1)] },
        respond,
      });
    };
    await inBrowser(async ({ storage, SupabaseBackend, local }) => {
      const client = seed(storage, local);
      const backend = new SupabaseBackend(local, U, client, { now: () => Date.parse(NOW) });
      assert.equal((await backend.hydrate()).status, 'conflict');
      assert.deepEqual(await backend.resolveConflict('merge'), { pushed: 1, pulled: 2, deleted: 0 });
      await settle();
      assert.equal(storage.getItem('position_AVGO'), null);
      assert.deepEqual(JSON.parse(storage.getItem('position_NVDA')), { costBasis: 50, shares: 2 });
      assert.deepEqual(JSON.parse(storage.getItem('position_TSLA')), { costBasis: 1, shares: 1 });
      assert.deepEqual(upserted(client), ['positions:NVDA']);
      assert.deepEqual(live(client), ['positions:NVDA', 'positions:TSLA']);
      assert.deepEqual(tombstoned(client), ['positions:AVGO']);
      assert.equal(metaOf(storage)['positions:AVGO'], T2);
    });
    await inBrowser(async ({ storage, SupabaseBackend, local }) => {
      const clock = fakeClock(Date.parse(T3));
      let online = true;
      const client = seed(storage, local, () => (online ? undefined : NETWORK));
      const backend = new SupabaseBackend(local, U, client, onClock(clock));
      assert.equal((await backend.hydrate()).status, 'conflict');
      online = false;
      backend.setPreference('strategic_context', 'typed while the prompt was up');
      await settle();
      assert.equal(outboxOf(storage).length, 1);
      const attempts = client.upserts.length;
      assert.deepEqual(await backend.resolveConflict('cloud'), { pushed: 0, pulled: 1, deleted: 0 });
      assert.deepEqual(Object.keys(userData(storage)), ['position_TSLA']);
      assert.equal(outboxOf(storage), null, "the queued write is dropped: the account's copy was chosen");
      online = true;
      clock.advance(10 * 60 * 1000);
      await settle();
      assert.equal(client.upserts.length, attempts, 'nothing is uploaded later');
      assert.equal(client.deletes.length, 0);
      backend.dispose();
    });
    await inBrowser(async ({ storage, SupabaseBackend, local }) => {
      const client = seed(storage, local);
      const backend = new SupabaseBackend(local, U, client, { now: () => Date.parse(NOW) });
      await backend.hydrate();
      assert.deepEqual(await backend.resolveConflict('local'), { pushed: 2, pulled: 0, deleted: 1 });
      await settle();
      assert.deepEqual(live(client), ['positions:AVGO', 'positions:NVDA'], 'both come back');
      assert.deepEqual(tombstoned(client), ['positions:TSLA']);
      assert.ok(contentUpserts(client).every((u) => u.rows[0].deleted_at === null));
    });
  });

  await t('replaceCloud(snapshot): an upsert per imported item and a tombstone per live account item the import lacks, dated now; API keys, device flags and unknown names never sent; a failed read queues the upserts only (one warning); disposed → nothing', async () => {
    await inBrowser(async ({ storage, warnings, SupabaseBackend, local }) => {
      const client = fakeSupabase({
        tables: {
          positions: [posRow('AVGO', 120, 10), posRow('TSLA', 1, 1), posRow('GONE', null, null, { deleted_at: AT })],
          preferences: [prefRow('strategic_context', 'cloud plan'), prefRow('section_research', false), prefRow('ai_key_openai', 'sk-stray')],
          chat_histories: [chatRow('MSFT', MSGS2)],
        },
      });
      const backend = new SupabaseBackend(local, U, client, { now: () => Date.parse(NOW) });
      const result = await backend.replaceCloud({
        positions: { AVGO: { costBasis: 100, shares: 10 }, EMPTY: { costBasis: null, shares: null } },
        chatHistories: { AVGO: MSGS, NONE: [] },
        preferences: { strategic_context: 'imported plan', ai_key_anthropic: 'sk-file', auth_skipped: true, mystery: 1 },
      });
      await settle();
      assert.deepEqual(result, { pushed: 3, deleted: 3 });
      assert.deepEqual(contentUpserts(client).map(keyOf).sort(), ['chat_histories:AVGO', 'positions:AVGO', 'preferences:strategic_context']);
      assert.deepEqual(tombstonesSent(client), [
        tombRow('chat_histories', 'MSFT', NOW),
        tombRow('positions', 'TSLA', NOW),
        tombRow('preferences', 'section_research', NOW),
      ]);
      assert.equal(client.tables.positions.find((r) => r.ticker === 'AVGO').cost_basis, 100);
      assert.equal(client.tables.preferences.find((r) => r.key === 'ai_key_openai').value, 'sk-stray', 'rows under device names are never touched');
      const sent = JSON.stringify(client.upserts);
      for (const text of ['ai_key_anthropic', 'sk-file', 'auth_skipped', 'mystery', 'EMPTY', 'NONE', 'GONE']) {
        assert.ok(!sent.includes(text), `${text} is not sent`);
      }
      assert.deepEqual(Object.values(metaOf(storage)), Array(6).fill(NOW), 'every write dated now');
      assert.equal(client.deletes.length, 0);
      assert.deepEqual(warnings, []);
    });
    await inBrowser(async ({ warnings, SupabaseBackend, local }) => {
      const client = fakeSupabase({ tables: { positions: [posRow('TSLA', 1, 1)] }, readError: { chat_histories: { message: 'boom' } } });
      const result = await new SupabaseBackend(local, U, client).replaceCloud({ positions: { AVGO: { costBasis: 1, shares: 1 } }, chatHistories: {}, preferences: {} });
      await settle();
      assert.deepEqual(result, { pushed: 1, deleted: 0 });
      assert.deepEqual(live(client), ['positions:AVGO', 'positions:TSLA'], 'nothing is deleted without a read');
      assert.equal(warnings.length, 1);
    });
    await inBrowser(async ({ warnings, SupabaseBackend, local }) => {
      const snapshot = { positions: { AVGO: { costBasis: 1, shares: 1 } }, chatHistories: {}, preferences: {} };
      const client = fakeSupabase({ tables: { positions: [posRow('TSLA', 1, 1)] } });
      const disposed = new SupabaseBackend(local, U, client);
      disposed.dispose();
      assert.deepEqual(await disposed.replaceCloud(snapshot), { pushed: 0, deleted: 0 });
      let release;
      const gated = fakeSupabase({ tables: { positions: [posRow('TSLA', 1, 1)] }, gate: new Promise((resolve) => { release = resolve; }) });
      const reading = new SupabaseBackend(local, U, gated);
      const pending = reading.replaceCloud(snapshot);
      reading.dispose(); // signed out while reading
      release();
      assert.deepEqual(await pending, { pushed: 0, deleted: 0 });
      await settle();
      assert.equal(client.upserts.length + gated.upserts.length, 0);
      assert.deepEqual(warnings, []);
    });
  });

  await t("clearAll() on a SupabaseBackend empties this browser's copy, the outbox (a waiting write is dropped) and the sync dates, never the account; the backend stays usable", async () => {
    await inBrowser(async ({ storage, SupabaseBackend, local }) => {
      const clock = fakeClock(Date.parse(T1));
      let online = false;
      const client = fakeSupabase({ tables: { positions: [posRow('TSLA', 1, 1)] }, respond: () => (online ? undefined : NETWORK) });
      const backend = new SupabaseBackend(local, U, client, onClock(clock));
      backend.setPosition('AVGO', { costBasis: 100, shares: 10 });
      local.setPreference('ai_key_openai', 'sk');
      await settle();
      assert.deepEqual(syncKeys(storage), ['sync_meta_user-a', 'sync_outbox_user-a']);
      backend.clearAll({ keepSecrets: true });
      await tick();
      assert.deepEqual(Object.keys(contents(storage)), ['ai_key_openai'], 'no sync_outbox_* or sync_meta_* left');
      assert.ok(clock.pending().every((timer) => timer.every), 'the backoff retry is cancelled');
      online = true;
      clock.advance(10 * 60 * 1000);
      await settle();
      assert.deepEqual(client.upserts.map(keyOf), ['positions:AVGO'], 'only the attempt before clearAll(): the dropped write never goes out');
      assert.deepEqual(live(client), ['positions:TSLA'], 'the account is untouched');
      assert.equal(clock.queued, 0, 'the 60 s retry stopped once nothing waited');
      backend.setPosition('NVDA', { costBasis: 1, shares: 2 });
      await settle();
      assert.deepEqual(live(client), ['positions:NVDA', 'positions:TSLA'], 'still usable');
      backend.dispose();
    });
  });

  await t("a backend for one account removes other accounts' queued writes and sync dates (claimLocalData() already cleared their data; a queued write can hold chat text) and sends its own", async () => {
    await inBrowser(async ({ storage, SupabaseBackend, local }) => {
      storage.setItem('sync_outbox_user-b', JSON.stringify([{ table: 'chat_histories', key: 'AVGO', op: 'upsert', row: { ticker: 'AVGO', messages: MSGS }, ts: 1 }]));
      storage.setItem('sync_meta_user-b', JSON.stringify({ 'chat_histories:AVGO': T1 }));
      storage.setItem('sync_outbox_user-a', JSON.stringify([{ table: 'positions', key: 'AVGO', op: 'upsert', row: { ticker: 'AVGO', cost_basis: 100, shares: 10 }, ts: Date.parse(T1) }]));
      storage.setItem('sync_meta_user-a', JSON.stringify({ 'positions:AVGO': T1 }));
      const client = fakeSupabase();
      const backend = new SupabaseBackend(local, U, client);
      assert.deepEqual(syncKeys(storage), ['sync_meta_user-a', 'sync_outbox_user-a']);
      await settle();
      assert.deepEqual(client.upserts.map((u) => [keyOf(u), u.rows[0].user_id, u.rows[0].updated_at]), [['positions:AVGO', U, T1]], "only this account's own queued write is sent");
      assert.deepEqual(syncKeys(storage), ['sync_meta_user-a']);
      backend.dispose();
    });
  });

  await t('a saved queue is data, not trusted: an op for an API key, a device flag or another table is dropped with a warning and never sent; only the columns of the item go out, under this user', async () => {
    await inBrowser(async ({ storage, warnings, SupabaseBackend, local }) => {
      storage.setItem('sync_outbox_user-a', JSON.stringify([
        { table: 'preferences', key: 'ai_key_openai', op: 'upsert', row: { key: 'ai_key_openai', value: 'sk-secret' }, ts: 1 },
        { table: 'preferences', key: 'auth_skipped', op: 'delete', row: null, ts: 1 },
        { table: 'revoked_tokens', key: 'jti', op: 'upsert', row: { jti: 'jti' }, ts: 1 },
        { table: 'positions', key: 'AVGO', op: 'upsert', row: { ticker: 'OTHER', cost_basis: 1, shares: 2, user_id: 'user-b', is_admin: true }, ts: Date.parse(T1) },
      ]));
      const client = fakeSupabase();
      const backend = new SupabaseBackend(local, U, client);
      await settle();
      assert.deepEqual(client.upserts.map((u) => ({ table: u.table, row: u.rows[0] })), [
        { table: 'positions', row: { user_id: U, ticker: 'AVGO', cost_basis: 1, shares: 2, updated_at: T1, deleted_at: null } },
      ]);
      assert.equal(client.deletes.length, 0);
      assert.ok(!JSON.stringify(client.upserts).includes('sk-secret'));
      assert.equal(warnings.length, 3, 'one per dropped op');
      assert.equal(storage.getItem('sync_outbox_user-a'), null);
      backend.dispose();
    });
  });

  await t('hydrate after a reload sends the writes queued offline first: the edit is not taken for a difference (no conflict prompt), and the delete does not come back', async () => {
    await inBrowser(async ({ storage, win, store, SupabaseBackend, local }) => {
      local.setPosition('AVGO', { costBasis: 100, shares: 10 });
      local.setPosition('NVDA', { costBasis: 50, shares: 2 });
      const client = fakeSupabase({ tables: { positions: [posRow('AVGO', 100, 10), posRow('NVDA', 50, 2)] } });
      // The earlier page, offline: AVGO edited, NVDA deleted; both writes wait.
      const earlier = new SupabaseBackend(local, U, fakeSupabase({ respond: () => NETWORK }), onClock(fakeClock(Date.parse(T1))));
      earlier.setPosition('AVGO', { costBasis: 110, shares: 10 });
      earlier.deletePosition('NVDA');
      await settle();
      assert.deepEqual(outboxOf(storage).map((o) => `${o.key}:${o.op}`), ['AVGO:upsert', 'NVDA:delete']);
      // The reload, online.
      const backend = new SupabaseBackend(new store.LocalStorageBackend(), U, client);
      const report = await backend.hydrate();
      await settle();
      assert.equal(report.status, 'in-sync', 'the queued writes reached the account before the comparison');
      assert.deepEqual(client.tables.positions.map((r) => [r.ticker, r.cost_basis, r.deleted_at]), [['AVGO', 110, null], ['NVDA', null, T1]]);
      assert.deepEqual(JSON.parse(storage.getItem('position_AVGO')), { costBasis: 110, shares: 10 });
      assert.equal(storage.getItem('position_NVDA'), null, 'the delete made offline did not come back');
      assert.equal(storage.getItem('sync_outbox_user-a'), null);
      assert.equal(storeEvents(win).length, 0);
      earlier.dispose();
      backend.dispose();
    });
  });

  await t('hydrate waits at most 10 s for the queued writes: one that never answers (postgrest has no timeout) does not hold up sign-in', async () => {
    await inBrowser(async ({ storage, SupabaseBackend, local }) => {
      local.setPosition('AVGO', { costBasis: 1, shares: 1 });
      storage.setItem('sync_outbox_user-a', JSON.stringify([posOp('AVGO', { ts: Date.parse(T1) })]));
      const client = fakeSupabase({ tables: { positions: [posRow('AVGO', 1, 1)] } });
      const hanging = { from: (table) => ({ ...client.from(table), upsert: () => ({ then() {} }) }) };
      const clock = fakeClock(Date.parse(T1));
      const backend = new SupabaseBackend(local, U, hanging, onClock(clock));
      let report = null;
      backend.hydrate().then((r) => { report = r; });
      await settle();
      assert.equal(report, null, 'waiting for the queued write');
      assert.equal(client.reads.length, 0, 'the account is not read yet');
      clock.advance(9999);
      await settle();
      assert.equal(report, null);
      clock.advance(1);
      await settle();
      assert.equal(report?.status, 'in-sync', 'read after 10 s all the same');
      assert.equal(client.reads.length, 3);
      assert.equal(outboxOf(storage).length, 1, 'the write stays queued');
      backend.dispose();
    });
  });
}
