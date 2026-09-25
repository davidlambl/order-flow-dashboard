// scripts/verify/sync.mjs — Phase 3 checks; loaded by scripts/verify-functions.mjs with its helpers.
// SupabaseBackend (hydrate decisions, conflict resolution, the write path) and session.js against a
// recording fake Supabase client: nothing here touches the network or a real project.
import { memoryStorage, withGlobals, settle } from './helpers.mjs';

const BACKEND_URL = new URL('../../src/lib/SupabaseBackend.js', import.meta.url);
const STORE_URL = new URL('../../src/lib/store.js', import.meta.url);
const SUPABASE_URL = new URL('../../src/lib/supabase.js', import.meta.url);

const KEY_COLUMN = { positions: 'ticker', preferences: 'key', chat_histories: 'ticker' };
const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * Fake supabase-js client. `from(table)` returns a thenable query builder: select/eq/is chain,
 * upsert(rows, opts) and delete() too, and awaiting the builder runs the query against the
 * in-memory `tables` (rows are plain objects with user_id + key column). Every read, upsert and
 * delete is recorded. Options:
 *   tables      – initial rows per table
 *   readError   – { [table]: error } → that table's select resolves { data: null, error, status: 500 }
 *   respond     – ({ table, op, rows, filters }) => { error, status } | undefined; a returned value is
 *                 the write's response and the write is NOT applied (simulates RLS / network failures)
 *   signOutError – returned by auth.signOut()
 */
export function fakeSupabase({ tables = {}, readError = {}, respond = () => undefined, signOutError = null } = {}) {
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
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); },
    };
    return b;
  }

  return {
    ...state,
    get tables() { return state.tables; },
    from: (table) => builder(table),
    auth: {
      async signOut() { state.signOuts++; return { error: signOutError }; },
    },
    _state: state,
  };
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
}
