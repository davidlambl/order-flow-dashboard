// test/helpers/fakeSupabase.js — the recording fake supabase-js client the sync tests (src/lib/sync.node.test.js)
// run SupabaseBackend, the outbox and session.js against.

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
