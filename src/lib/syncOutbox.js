// src/lib/syncOutbox.js
// The cloud backend's write queue (roadmap D5): it survives a reload, keeps one op per item, and retries
// what can still succeed.
//
// Why each part:
//  - supabase-js resolves a failed request with `{ error }` instead of throwing, and a network failure is
//    one of those (postgrest-js reports it as `{ error: { code: '' }, status: 0 }`). The queue this replaces
//    retried only on a throw, so an edit made offline was dropped on its first attempt. Here a returned
//    error without a Postgres / PostgREST code, a status of 0 or 5xx (or 401, 408, 429), no response at all,
//    and a throw are retried: the op stays at the head and the next attempt waits
//    backoffSeconds(2, failures, 300) seconds (4 s, 8 s, 16 s, ... at most 5 min).
//  - Any other error (RLS 42501, bad input 22P02, a unique violation 23505, PGRST..., another 4xx) comes
//    back the same way every time: that op is dropped with one warning, so it never blocks the writes
//    queued behind it.
//  - The old queue lived in memory, so a reload lost whatever was still waiting. This one is saved in
//    storage under sync_outbox_<userId> after every change (once per synchronous burst of changes; the key
//    is removed when the queue is empty) and read back when the outbox is created.
//  - Every op carries the item's whole row, so only the latest op for an item matters: it replaces an
//    earlier one for the same (table, key) and moves to the tail. A burst of edits is one request, and a
//    delete never races the edit it follows.
//
// Pure: imports only ./retry.js and reads no browser global at import time. Storage, timers, clock and
// warn are injectable, so scripts/verify/sync.mjs drives it under Node with a fake clock; nothing waits.
import { backoffSeconds } from './retry.js';

/** Storage key prefix of a user's saved queue: `${OUTBOX_PREFIX}${userId}`. */
export const OUTBOX_PREFIX = 'sync_outbox_';

const OPS = new Set(['upsert', 'delete']);
// Statuses worth retrying although the body carries a code: an expired session (the auth client refreshes
// it, and a sign-out disposes the outbox first), a request timeout, rate limiting.
const RETRY_STATUSES = new Set([401, 408, 429]);

/**
 * @typedef {object} OutboxOp
 * @property {string} table the table written
 * @property {string} key the item's key in that table (a ticker, a preference name)
 * @property {'upsert'|'delete'} op
 * @property {object|null} row an upsert's row (without user_id and times); null for a delete
 * @property {number} ts when the op was made, in ms since the epoch (enqueue() fills it in when missing)
 */

/**
 * @typedef {object} Outbox
 * @property {(op: OutboxOp) => void} enqueue Queue an op (it replaces a queued op for the same table and
 *   key, and goes to the tail), save the queue (in a microtask), then flush(). Does nothing once disposed.
 * @property {(opts?: { force?: boolean }) => Promise<void>} flush Send the queue from the head, one op at a
 *   time. While a retry waits for its backoff this does nothing unless `force`, which cancels the wait and
 *   tries now; a flush already running is joined, and ops queued meanwhile are sent before it ends.
 *   Resolves when the queue is empty, a retry is scheduled or the outbox is disposed; never rejects.
 * @property {() => number} size How many ops are waiting.
 * @property {() => void} clear Drop every op, the saved copy and a pending retry; the outbox stays usable.
 * @property {() => void} dispose Cancel a pending retry and stop: later enqueue() and flush() calls do
 *   nothing, and an op in flight is left queued. The saved queue stays for this user's next outbox.
 */

/**
 * Whether a send() outcome may succeed later: a throw or no response at all, a returned error without a
 * code (postgrest-js's network failure), or a status of 0, 5xx, 401, 408 or 429. A success is not.
 * @param {unknown} response what send() resolved to
 * @returns {boolean}
 */
export function isRetryable(response) {
  if (response == null || typeof response !== 'object') return true;
  const { error, status } = response;
  if (!error) return false;
  if (!error.code) return true;
  return status === 0 || status >= 500 || RETRY_STATUSES.has(status);
}

function isOp(value) {
  return value != null && typeof value === 'object'
    && typeof value.table === 'string' && value.table !== ''
    && typeof value.key === 'string' && value.key !== ''
    && OPS.has(value.op);
}

/** Put `op` at the tail, removing a queued op for the same item. */
function coalesce(queue, op) {
  const i = queue.findIndex((queued) => queued.table === op.table && queued.key === op.key);
  if (i !== -1) queue.splice(i, 1);
  queue.push(op);
}

/**
 * Create the outbox of one user.
 * @param {object} options
 * @param {string} options.userId whose writes these are; names the storage key
 * @param {(op: OutboxOp) => Promise<{ error?: object|null, status?: number }>} options.send performs one op
 *   and resolves to the postgrest response; it may also throw (retried)
 * @param {Storage|null} [options.storage] where the queue is saved; without one it lives in memory only
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimeout]
 * @param {(id: unknown) => void} [options.clearTimeout]
 * @param {() => number} [options.now] ms since the epoch, for an op enqueued without `ts`
 * @param {(...args: unknown[]) => void} [options.warn] reports a dropped op and a queue that cannot be saved
 * @returns {Outbox}
 */
export function createOutbox({
  userId,
  send,
  storage = globalThis.localStorage,
  setTimeout = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout = (id) => globalThis.clearTimeout(id),
  now = () => Date.now(),
  warn = console.warn,
} = {}) {
  if (typeof userId !== 'string' || userId === '') throw new TypeError('createOutbox: a userId is required');
  if (typeof send !== 'function') throw new TypeError('createOutbox: a send function is required');

  const storageKey = OUTBOX_PREFIX + userId;
  let queue = load();
  let failures = 0; // consecutive retryable failures; the backoff grows with it
  let retry = null; // { id } while a retry waits for its backoff
  let running = null; // the promise of the flush in progress
  let again = false; // ops were queued, or a wait was cut short, while a flush was winding down
  let disposed = false;
  let storageWarned = false;
  let saveQueued = false;

  // Only the fields of an op are kept, whatever else a caller or a stored copy carried.
  function entryOf(op) {
    return { table: op.table, key: op.key, op: op.op, row: op.row ?? null, ts: Number.isFinite(op.ts) ? op.ts : now() };
  }

  function load() {
    let saved = [];
    try {
      const raw = storage?.getItem(storageKey);
      if (raw) saved = JSON.parse(raw);
    } catch { /* unreadable or corrupted: start empty */ }
    const ops = [];
    if (Array.isArray(saved)) {
      for (const op of saved) {
        if (isOp(op)) coalesce(ops, entryOf(op));
      }
    }
    return ops;
  }

  // Saved once per burst: the changes made in one synchronous run (an import queues dozens of chats) are
  // written by a single save in a microtask, which still runs before the event loop moves on (so before
  // the page can unload). It writes the queue as it is then.
  function persist() {
    if (!storage || saveQueued) return;
    saveQueued = true;
    Promise.resolve().then(save);
  }

  function save() {
    saveQueued = false;
    try {
      if (queue.length > 0) storage.setItem(storageKey, JSON.stringify(queue));
      else storage.removeItem(storageKey);
    } catch (err) {
      if (storageWarned) return;
      storageWarned = true;
      warn('Sync outbox: could not save the queue; writes still waiting will not survive a reload:', err?.message ?? err);
    }
  }

  function stopRetry() {
    if (retry) clearTimeout(retry.id);
    retry = null;
  }

  function scheduleRetry() {
    stopRetry();
    const timer = { id: null };
    timer.id = setTimeout(() => {
      if (retry !== timer) return;
      retry = null;
      flush();
    }, backoffSeconds(2, failures, 300) * 1000);
    retry = timer;
  }

  // One pass: send from the head until the queue is empty, a retryable failure schedules the next
  // attempt, or the outbox is disposed.
  async function pass() {
    while (!disposed && !retry && queue.length > 0) {
      const op = queue[0];
      let response;
      let threw = false;
      try {
        response = await send(op);
      } catch {
        threw = true;
      }
      if (disposed) return; // the op stays queued (and saved) for this user's next outbox
      if (threw || isRetryable(response)) {
        failures++;
        if (queue.length > 0) scheduleRetry();
        return;
      }
      if (response.error) {
        const { code, message } = response.error;
        warn(`Sync: the server rejected a write to ${op.table} "${op.key}" (${code}); it was dropped:`, message ?? '');
      } else {
        failures = 0;
      }
      // clear(), or a newer op for the same item, may have taken it out of the queue meanwhile.
      const i = queue.indexOf(op);
      if (i !== -1) {
        queue.splice(i, 1);
        persist();
      }
    }
  }

  async function drain() {
    try {
      do {
        again = false;
        await pass();
      } while (again && !disposed && !retry && queue.length > 0);
    } catch (err) {
      warn('Sync outbox: unexpected error while sending:', err?.message ?? err);
    } finally {
      running = null;
    }
  }

  function flush({ force = false } = {}) {
    if (disposed) return Promise.resolve();
    if (retry) {
      if (!force) return running ?? Promise.resolve();
      stopRetry();
      if (running) again = true; // the flush that scheduled the retry is still returning: go round again
    }
    if (running) return running;
    if (queue.length === 0) return Promise.resolve();
    running = Promise.resolve().then(drain); // assigned before drain() can run (and clear it)
    return running;
  }

  function enqueue(op) {
    if (disposed) return;
    if (!isOp(op)) throw new TypeError('enqueue: an op needs a table, a key and op "upsert" or "delete"');
    coalesce(queue, entryOf(op));
    persist();
    if (running) again = true;
    flush();
  }

  return {
    enqueue,
    flush,
    size: () => queue.length,
    clear() {
      queue = [];
      failures = 0;
      stopRetry();
      persist();
    },
    dispose() {
      disposed = true;
      stopRetry();
    },
  };
}
