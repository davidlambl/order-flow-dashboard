// test/helpers/fakeSupabase.js — the recording fake supabase-js client the sync tests (src/lib/sync.node.test.js)
// run SupabaseBackend, the outbox and session.js against, and whose `auth` the App tests (App.auth.test.jsx,
// App.signout.test.jsx) and the hook's own (useSupabaseAuth.test.jsx) drive App and useSupabaseAuth with.

const KEY_COLUMN = { positions: 'ticker', preferences: 'key', chat_histories: 'ticker' };
const clone = (v) => JSON.parse(JSON.stringify(v));
// supabase-js 2.118 settles getSession() and delivers INITIAL_SESSION a few microtasks after the call, before any
// macrotask (four, measured on the real client; src/lib/supabaseClient.node.test.js pins the order); the fake waits
// as long.
const ticks = async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); };

/** A signed-in session for `id`, in supabase-js's Session shape (the access token is not a real JWT). */
export const sessionFor = (id) => ({
  access_token: `at-${id}`, refresh_token: `rt-${id}`, expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer',
  user: { id, email: `${id}@example.com`, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} },
});

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
 *   session     – the session the auth client holds (supabase-js's Session shape; null: signed out)
 *   sessionError – auth.getSession() resolves { data: { session: null }, error: sessionError } and INITIAL_SESSION
 *                 carries null (supabase-js: a refresh that failed at the network, an AuthRetryableFetchError)
 *   sessionReject – auth.getSession() rejects with it
 *   otpError    – returned by auth.signInWithOtp()
 * The auth part, as supabase-js 2.118 behaves (measured): every getSession() and every event carries a fresh copy
 * of the session; onAuthStateChange(cb) returns { data: { subscription: { id, callback, unsubscribe } } } and
 * delivers INITIAL_SESSION a few microtasks later, unless the callback was unsubscribed by then; signOut() delivers
 * SIGNED_OUT to every subscriber BEFORE it resolves, whatever it returns. emitAuth(event, session) delivers an
 * event from elsewhere (SIGNED_IN on a tab focus or another tab's sign-in, TOKEN_REFRESHED, SIGNED_OUT) to every
 * subscriber at once; `authCalls` lists the auth calls in order, `otps` the signInWithOtp arguments,
 * `subscribers` how many callbacks are subscribed.
 */
export function fakeSupabase({
  tables = {}, readError = {}, respond = () => undefined, signOutError = null, gate = null,
  session = null, sessionError = null, sessionReject = null, otpError = null,
} = {}) {
  const state = {
    tables: { positions: [], preferences: [], chat_histories: [], ...clone(tables) },
    reads: [], upserts: [], deletes: [], signOuts: 0,
    session: session ? clone(session) : null, authCalls: [], otps: [],
  };
  const subscribers = new Map();
  let nextId = 0;
  const current = () => (state.session ? clone(state.session) : null);
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

  const deliver = (event, s) => Promise.all([...subscribers.values()].map(async (callback) => callback(event, s ? clone(s) : null)));

  return {
    get tables() { return state.tables; },
    get reads() { return state.reads; },
    get upserts() { return state.upserts; },
    get deletes() { return state.deletes; },
    get signOuts() { return state.signOuts; },
    get session() { return state.session; },
    get authCalls() { return state.authCalls; },
    get otps() { return state.otps; },
    get subscribers() { return subscribers.size; },
    from: (table) => builder(table),
    auth: {
      async getSession() {
        state.authCalls.push('getSession');
        await ticks();
        if (sessionReject) throw sessionReject;
        if (sessionError) return { data: { session: null }, error: sessionError };
        return { data: { session: current() }, error: null };
      },
      onAuthStateChange(callback) {
        const id = `sub-${++nextId}`;
        state.authCalls.push('onAuthStateChange');
        subscribers.set(id, callback);
        void ticks().then(() => {
          if (subscribers.get(id) === callback) callback('INITIAL_SESSION', sessionError || sessionReject ? null : current());
        });
        const unsubscribe = () => { state.authCalls.push('unsubscribe'); subscribers.delete(id); };
        return { data: { subscription: { id, callback, unsubscribe } } };
      },
      async signInWithOtp(credentials) {
        state.authCalls.push('signInWithOtp');
        state.otps.push(clone(credentials));
        await ticks();
        return { data: { user: null, session: null }, error: otpError };
      },
      async signOut() {
        state.signOuts++;
        state.authCalls.push('signOut');
        await ticks();
        state.session = null;
        await deliver('SIGNED_OUT', null);
        return { error: signOutError };
      },
    },
    /** An auth event from elsewhere, delivered at once to every subscriber (wrap it in act()). */
    emitAuth(event, s = null) {
      state.session = s ? clone(s) : null;
      for (const callback of [...subscribers.values()]) callback(event, s ? clone(s) : null);
    },
    _state: state,
  };
}
