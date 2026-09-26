// src/lib/SupabaseBackend.js
// Offline-first backend: localStorage for reads, Supabase for durable sync.
// Wraps LocalStorageBackend: every write lands in this browser first, then goes to the account.
// Secret keys and per-device flags (DEVICE_KEYS) are NEVER sent to Supabase.
// All queries are scoped to the authenticated user via user_id.
// The client is injectable (tests pass a fake); the default is the app's client.
//
// Sign-in (hydrate) never merges on its own (roadmap D1, D6): it pushes this browser's data only into
// an account with nothing in it, pulls the account's data only into a browser with nothing in it, and
// otherwise reports a conflict and writes nothing until the user picks merge / cloud / local
// (resolveConflict). Before this, hydrate filled local gaps and then upserted every local row, so
// whatever the previous user left in this browser went into the next account that signed in.
//
// Writes (roadmap D5, D6):
//  - Every write is an op in this user's outbox (syncOutbox.js, saved as sync_outbox_<userId>). A network
//    failure is retried with backoff instead of dropped, the queue survives a reload, and only the latest
//    op per item goes out. In a browser the queue is also retried at once when the browser comes back
//    online or the tab becomes visible, and every 60 s while something waits.
//  - A delete is a tombstone: an upsert that nulls the content and sets deleted_at (migration 005). The row
//    stays, so a device that still holds the item learns that it was deleted, and when. A hard delete left
//    no trace, and that device's next upload brought the item back. Without 005 a delete falls back to a
//    hard delete (one warning).
//  - Last writer wins, per item. sync_meta_<userId> dates this browser's copy of each item: a write or a
//    delete here stamps now, a cloud row applied here its updated_at (kept by the 004 trigger), a tombstone
//    applied here its deleted_at. Where the account and this browser hold different copies, the more
//    recently changed one wins; a copy nothing here dates (older than this, or edited while signed out) is
//    kept and uploaded, never dropped.

import { supabase } from './supabase.js';
import { DEVICE_KEYS, LAYOUT_KEYS, PREF_NAMES, emitStoreChanged } from './store.js';
import { deepEqual } from './deepEqual.js';
import { createOutbox, OUTBOX_PREFIX } from './syncOutbox.js';

// A snapshot is { positions, prefs, chats }, each a Map of key → value; these are its tables.
const SECTIONS = ['positions', 'prefs', 'chats'];
const TABLE = { positions: 'positions', prefs: 'preferences', chats: 'chat_histories' };
const SECTION_OF_TABLE = { positions: 'positions', preferences: 'prefs', chat_histories: 'chats' };
const KEY_COLUMN = { positions: 'ticker', prefs: 'key', chats: 'ticker' };
// The content columns of each table: what an upsert sends, and what a tombstone nulls.
const CONTENT = { positions: ['cost_basis', 'shares'], prefs: ['value'], chats: ['messages'] };
const CHOICES = new Set(['merge', 'cloud', 'local']);

/** localStorage key prefix of the per-item sync dates: `${META_PREFIX}${userId}` → { "<table>:<key>": ISO }. */
const META_PREFIX = 'sync_meta_';
const RETRY_EVERY_MS = 60 * 1000;
const HYDRATE_WAITS_FOR_OUTBOX_MS = 10 * 1000;
// The date of a copy whose time the account did not say: any dated change elsewhere is newer.
const EPOCH = new Date(0).toISOString();

const isKey = (value) => typeof value === 'string' && value !== '';
const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const entriesOf = (value) => (isObject(value) ? Object.entries(value) : []);
const sections = () => ({ positions: new Map(), prefs: new Map(), chats: new Map() });

/** Milliseconds of an ISO time, NaN when there is none. */
const msOf = (iso) => (typeof iso === 'string' ? Date.parse(iso) : NaN);

/** An ISO time in toISOString() form, or null when it does not parse. */
function isoOf(value) {
  const ms = msOf(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** localStorage, or null where there is none (Node) or the browser blocks it. */
function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** A stored position, or null when neither field is set (nothing worth keeping). */
function positionOf(costBasis, shares) {
  const pos = { costBasis: costBasis ?? null, shares: shares ?? null };
  return pos.costBasis != null || pos.shares != null ? pos : null;
}

/** A chat history with at least one message, or null. JSONB may arrive as a string. */
function messagesOf(raw) {
  let msgs = raw;
  if (typeof msgs === 'string') {
    try { msgs = JSON.parse(msgs); } catch { return null; }
  }
  return Array.isArray(msgs) && msgs.length > 0 ? msgs : null;
}

/** Preferences that sync: known names only, never secrets or per-device flags. */
function isSyncedPref(name) {
  return PREF_NAMES.has(name) && !DEVICE_KEYS.has(name);
}

/**
 * Data in the export shape ({ positions, chatHistories, preferences }, objects keyed by ticker or name) →
 * a snapshot of what is worth keeping: positions with a cost basis or shares, chats with a message and
 * synced preferences with a value. This browser's data and an import are read the same way.
 */
function snapshotOf(data) {
  const { positions, chatHistories, preferences } = isObject(data) ? data : {};
  const snap = sections();
  for (const [ticker, p] of entriesOf(positions)) {
    const pos = isObject(p) ? positionOf(p.costBasis, p.shares) : null;
    if (isKey(ticker) && pos) snap.positions.set(ticker, pos);
  }
  for (const [name, value] of entriesOf(preferences)) {
    if (isSyncedPref(name) && value != null) snap.prefs.set(name, value);
  }
  for (const [ticker, msgs] of entriesOf(chatHistories)) {
    if (isKey(ticker) && Array.isArray(msgs) && msgs.length > 0) snap.chats.set(ticker, msgs);
  }
  return snap;
}

/**
 * Cloud rows (one array per table) → snapshot of the live items, plus when each item changed: `at[section]`
 * maps a live item's key to its updated_at, `tombs[section]` a deleted item's key to its deleted_at.
 * Tombstoned rows (`deleted_at` set) never count as content.
 */
function cloudSnapshot(positionRows, prefRows, chatRows) {
  const snap = { ...sections(), at: sections(), tombs: sections() };
  const add = (section, key, row, value) => {
    if (row.deleted_at) {
      snap.tombs[section].set(key, row.deleted_at);
    } else if (value != null) {
      snap[section].set(key, value);
      snap.at[section].set(key, row.updated_at);
    }
  };
  for (const row of positionRows) {
    if (isObject(row) && isKey(row.ticker)) add('positions', row.ticker, row, positionOf(row.cost_basis, row.shares));
  }
  for (const row of prefRows) {
    if (isObject(row) && isSyncedPref(row.key)) add('prefs', row.key, row, row.value);
  }
  for (const row of chatRows) {
    if (isObject(row) && isKey(row.ticker)) add('chats', row.ticker, row, messagesOf(row.messages));
  }
  return snap;
}

/** The part of a snapshot worth asking about: everything but layout preferences. */
function relevantPart(snap) {
  const prefs = new Map([...snap.prefs].filter(([name]) => !LAYOUT_KEYS.has(name)));
  return { positions: snap.positions, prefs, chats: snap.chats };
}

function countsOf(part) {
  return { positions: part.positions.size, prefs: part.prefs.size, chats: part.chats.size };
}

const isEmptyPart = (part) => SECTIONS.every((s) => part[s].size === 0);

/** Same keys and deepEqual values (JSONB reorders object keys; deepEqual ignores key order). */
function sameMap(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (!b.has(key) || !deepEqual(value, b.get(key))) return false;
  }
  return true;
}

/** The row (without user_id and times) that holds a snapshot value. */
function rowOf(section, key, value) {
  if (section === 'positions') return { ticker: key, cost_basis: value?.costBasis ?? null, shares: value?.shares ?? null };
  if (section === 'prefs') return { key, value };
  return { ticker: key, messages: value };
}

export class SupabaseBackend {
  /**
   * @param {object} localBackend a LocalStorageBackend: every read, and every write first
   * @param {string} userId the signed-in account
   * @param {object|null} [client] a supabase-js client; without one nothing leaves this browser
   * @param {object} [options] injectable for tests: `now` (ms), `storage` (for the outbox and the sync
   *   dates; localStorage by default), `setTimeout` / `clearTimeout` (the outbox's backoff, hydrate's
   *   wait for it) and `setInterval` / `clearInterval` (the 60 s retry)
   */
  constructor(localBackend, userId, client = supabase, options = {}) {
    this.local = localBackend;
    this.userId = userId;
    this.client = client;
    this._cloud = null; // the cloud snapshot of a hydrate() 'conflict', for resolveConflict()
    this._disposed = false;
    this._now = options.now ?? (() => Date.now());
    this._storage = 'storage' in options ? options.storage : defaultStorage();
    this._setTimeout = options.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this._clearTimeout = options.clearTimeout ?? ((id) => globalThis.clearTimeout(id));
    this._setInterval = options.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
    this._clearInterval = options.clearInterval ?? ((id) => globalThis.clearInterval(id));
    this._interval = null; // { id } of the 60 s retry while writes wait
    this._inBrowser = false;
    this._detachBrowser = null;
    this._migrationWarned = false;
    this._outbox = null;
    if (!client || !isKey(userId)) return;

    this._purgeOtherAccounts();
    this._outbox = createOutbox({
      userId,
      send: (op) => this._send(op),
      storage: this._storage,
      setTimeout: this._setTimeout,
      clearTimeout: this._clearTimeout,
      now: this._now,
      warn: (...args) => console.warn(...args),
    });
    this._attachBrowser();
    // Writes an earlier page load could not send (made offline, then a reload) go out now.
    if (this._outbox.size() > 0) this._flushOutbox();
  }

  /**
   * Stop acting for this user: a hydrate() still reading, or a resolveConflict() after this, writes
   * nothing (this browser may already hold another account's data). store.setBackend() calls it on
   * the backend it replaces. The outbox stops too (listeners, the 60 s retry and the backoff timer go):
   * writes still queued stay saved under this user and go out when this account's backend is next built
   * here (a reload, signing in again), unless clearAll() (a sign-out) dropped them first.
   */
  dispose() {
    this._disposed = true;
    this._detachBrowser?.();
    this._detachBrowser = null;
    if (this._interval) this._clearInterval(this._interval.id);
    this._interval = null;
    this._outbox?.dispose();
  }

  // ── Positions ──────────────────────────────────────────────────────────────

  getPosition(ticker) {
    return this.local.getPosition(ticker);
  }

  setPosition(ticker, data) {
    this.local.setPosition(ticker, data);
    const pos = positionOf(data?.costBasis, data?.shares);
    if (pos) this._pushItem('positions', ticker, pos);
    else this._deleteItem('positions', ticker);
  }

  deletePosition(ticker) {
    this.local.deletePosition(ticker);
    this._deleteItem('positions', ticker);
  }

  getAllPositions() {
    return this.local.getAllPositions();
  }

  // ── Preferences ────────────────────────────────────────────────────────────

  getPreference(name) {
    return this.local.getPreference(name);
  }

  setPreference(name, value) {
    this.local.setPreference(name, value);
    if (!isSyncedPref(name)) return; // secrets, device flags and unknown names never leave this browser
    if (value != null) this._pushItem('prefs', name, value);
    else this._deleteItem('prefs', name);
  }

  getAllPreferences(opts) {
    return this.local.getAllPreferences(opts);
  }

  // ── Chat Histories ─────────────────────────────────────────────────────────

  getChatHistory(ticker) {
    return this.local.getChatHistory(ticker);
  }

  setChatHistory(ticker, messages) {
    this.local.setChatHistory(ticker, messages);
    if (messages?.length) this._pushItem('chats', ticker, messages);
    else this._deleteItem('chats', ticker);
  }

  deleteChatHistory(ticker) {
    this.local.deleteChatHistory(ticker);
    this._deleteItem('chats', ticker);
  }

  getAllChatHistories() {
    return this.local.getAllChatHistories();
  }

  // ── Clear / replace ────────────────────────────────────────────────────────

  /**
   * Clear this browser's copy (LocalStorageBackend#clearAll with `opts`), this account's queued writes and
   * its sync dates. Never the cloud copy: that takes replaceCloud() or a delete per item. The backend stays
   * usable (an import clears, writes, then calls replaceCloud()).
   * @param {{ keepSecrets?: boolean }} [opts]
   */
  clearAll(opts) {
    this.local.clearAll(opts);
    this._outbox?.clear();
    if (!this._storage || !isKey(this.userId)) return;
    try {
      this._storage.removeItem(META_PREFIX + this.userId);
    } catch { /* storage unavailable: nothing was saved either */ }
  }

  /**
   * Make the account hold exactly `snapshot` (an import): an upsert per item in it, and a tombstone per item
   * the account has that it lacks. Items are read like this browser's (positions with a value, chats with a
   * message, synced preferences with a value; API keys and device flags are never sent), and a section the
   * snapshot lacks counts as empty. The writes are dated now and go through the outbox. When the account
   * cannot be read, only the upserts are queued (one warning).
   * @param {{ positions?: object, chatHistories?: object, preferences?: object }} snapshot the export shape
   * @returns {Promise<{ pushed: number, deleted: number }>} upserts and tombstones queued (0 once disposed)
   */
  async replaceCloud(snapshot) {
    const result = { pushed: 0, deleted: 0 };
    if (this._disposed || !this._outbox) return result;
    const wanted = snapshotOf(snapshot);
    let cloud = null;
    try {
      cloud = await this._readCloud();
    } catch (err) {
      if (!this._disposed) {
        console.warn('Supabase replaceCloud: could not read the account; items missing from the import stay in it:', err?.message ?? err);
      }
    }
    if (this._disposed) return result;
    for (const s of SECTIONS) {
      for (const [key, value] of wanted[s]) {
        this._pushItem(s, key, value);
        result.pushed++;
      }
      for (const key of cloud?.[s].keys() ?? []) {
        if (wanted[s].has(key)) continue;
        this._deleteItem(s, key);
        result.deleted++;
      }
    }
    return result;
  }

  // ── Sign-in sync ───────────────────────────────────────────────────────────

  /**
   * Compare this browser with the account and write only where nothing can be lost:
   *   'pushed'   – the account has nothing worth asking about: this browser's data is uploaded
   *                (a first sign-in);
   *   'pulled'   – this browser has nothing worth asking about: the account's data, layout included,
   *                is applied here;
   *   'in-sync'  – both hold the same data: this browser's copies are dated by the account's, and layout
   *                preferences are reconciled (this browser's value is uploaded, one only in the cloud is
   *                applied here);
   *   'conflict' – both hold different data: nothing is written until resolveConflict();
   *   'offline'  – the account could not be read, or this backend was disposed while reading:
   *                nothing is written.
   * Writes this account queued earlier are sent before the account is read (waited for up to 10 s, then
   * they carry on in the background). Deleted items (tombstones) never count as the account's data; in
   * the first three cases an item the account deleted after this browser's copy last changed is deleted
   * here, and one that changed here later (or that nothing here dates) is uploaded again. In a conflict,
   * resolveConflict() settles them.
   * "Worth asking about": positions with a cost basis or shares, chats with a message, and
   * preferences outside LAYOUT_KEYS and DEVICE_KEYS. Never rejects.
   * @returns {Promise<{ status: 'pushed'|'pulled'|'in-sync'|'conflict'|'offline',
   *   cloud: { positions: number, prefs: number, chats: number } | null,
   *   local: { positions: number, prefs: number, chats: number } | null }>}
   *   those items' counts per side as compared (before anything is applied); cloud is null when it was
   *   not read, both are null once disposed
   */
  async hydrate() {
    try {
      return await this._hydrate();
    } catch (err) {
      console.warn('Supabase hydrate failed (non-fatal):', err?.message ?? err);
      return { status: 'offline', cloud: null, local: null };
    }
  }

  async _hydrate() {
    const disposed = () => ({ status: 'offline', cloud: null, local: null });
    const offline = () => ({ status: 'offline', cloud: null, local: countsOf(relevantPart(this._localSnapshot())) });
    this._cloud = null;
    if (this._disposed) return disposed();
    if (!this._outbox) return offline();

    // An edit made offline and still queued (then a reload) goes out first, so the comparison below
    // finds it in the account instead of asking about it. Bounded: a request that hangs (postgrest has
    // no timeout) must not hold up sign-in; the outbox keeps sending in the background.
    await this._outboxSettled(HYDRATE_WAITS_FOR_OUTBOX_MS);
    if (this._disposed) return disposed();

    let cloud;
    try {
      cloud = await this._readCloud();
    } catch (err) {
      if (this._disposed) return disposed();
      console.warn('Supabase hydrate: could not read the account, nothing synced:', err?.message ?? err);
      return offline();
    }
    // Signed out or switched account while reading: this browser is no longer this user's.
    if (this._disposed) return disposed();

    const local = this._localSnapshot();
    const cloudPart = relevantPart(cloud);
    const localPart = relevantPart(local);
    const counts = { cloud: countsOf(cloudPart), local: countsOf(localPart) }; // before a tombstone removes anything
    const report = (status) => ({ status, ...counts });

    if (isEmptyPart(cloudPart)) {
      const removed = this._applyTombstones(cloud, local, { push: false }); // pushLocal() uploads the rest
      this.pushLocal();
      if (removed > 0) emitStoreChanged();
      return report('pushed');
    }
    if (isEmptyPart(localPart)) {
      this._applyTombstones(cloud, local, { push: true });
      this._applySnapshot(cloud);
      emitStoreChanged();
      return report('pulled');
    }
    if (!SECTIONS.every((s) => sameMap(cloudPart[s], localPart[s]))) {
      this._cloud = cloud; // kept (it can hold every chat) only until resolveConflict() uses it
      return report('conflict');
    }

    // Same data on both sides. This browser's copies take the account's dates, so a later edit or delete
    // elsewhere is recognized as newer. Layout is never worth a prompt: this browser's value wins, and a
    // value only the cloud has is applied here.
    const removed = this._applyTombstones(cloud, local, { push: false }); // layout only: the rest is equal
    this._stampSame(cloud, local);
    let applied = 0;
    for (const name of LAYOUT_KEYS) {
      const here = local.prefs.has(name);
      const there = cloud.prefs.has(name);
      if (here && !(there && deepEqual(local.prefs.get(name), cloud.prefs.get(name)))) {
        this._pushItem('prefs', name, local.prefs.get(name));
      } else if (!here && there) {
        this._applyItem('prefs', name, cloud.prefs.get(name), cloud.at.prefs.get(name));
        applied++;
      }
    }
    if (applied + removed > 0) emitStoreChanged();
    return report('in-sync');
  }

  /**
   * Settle a hydrate() 'conflict' the way the user chose (SyncChoice), against the cloud snapshot
   * that hydrate() read:
   *   'merge' – keep both: items only here are uploaded, items only in the cloud are applied here, and
   *             where both hold different copies the most recently changed copy wins (this browser's
   *             when nothing here dates it); equal copies stay as they are. An item the account deleted
   *             after this browser's copy last changed is deleted here; otherwise this copy is uploaded;
   *   'cloud' – this browser's data (API keys aside) and its queued writes are replaced by the cloud copy;
   *   'local' – the cloud copy is replaced by this browser's: everything here is uploaded (an item the
   *             account deleted comes back) and cloud-only items get tombstones.
   * Dispatches store-changed. One resolution per hydrate(): the snapshot is used up.
   * @param {'merge'|'cloud'|'local'} choice
   * @returns {Promise<{ pushed: number, pulled: number, deleted: number }>} uploads queued, account
   *   changes applied here (a delete included), cloud tombstones queued
   */
  async resolveConflict(choice) {
    if (!CHOICES.has(choice)) throw new TypeError(`resolveConflict: unknown choice "${choice}"`);
    const cloud = this._cloud;
    if (!cloud) throw new Error('resolveConflict: no conflict to resolve; hydrate() first');
    const result = { pushed: 0, pulled: 0, deleted: 0 };
    if (this._disposed) return result;
    this._cloud = null;

    if (choice === 'cloud') {
      this.clearAll({ keepSecrets: true }); // with the queued writes and the dates: the account's copy wins
      result.pulled = this._applySnapshot(cloud);
    } else if (choice === 'local') {
      const local = this._localSnapshot();
      result.pushed = this.pushLocal();
      for (const s of SECTIONS) {
        for (const key of cloud[s].keys()) {
          if (local[s].has(key)) continue;
          this._deleteItem(s, key);
          result.deleted++;
        }
      }
    } else {
      Object.assign(result, this._merge(cloud));
    }
    emitStoreChanged();
    return result;
  }

  /** resolveConflict('merge'): per item, the most recently changed copy wins. */
  _merge(cloud) {
    const local = this._localSnapshot();
    const result = { pushed: 0, pulled: 0, deleted: 0 };
    for (const s of SECTIONS) {
      for (const [key, value] of local[s]) {
        if (cloud[s].has(key)) {
          const at = cloud.at[s].get(key);
          if (deepEqual(value, cloud[s].get(key))) {
            this._stamp(s, key, isoOf(at) ?? EPOCH); // the same copy on both sides: nothing moves
          } else if (this._cloudWins(s, key, at)) {
            this._applyItem(s, key, cloud[s].get(key), at);
            result.pulled++;
          } else {
            this._pushItem(s, key, value);
            result.pushed++;
          }
        } else if (cloud.tombs[s].has(key) && this._cloudWins(s, key, cloud.tombs[s].get(key))) {
          this._removeLocal(s, key, isoOf(cloud.tombs[s].get(key)));
          result.pulled++;
        } else {
          this._pushItem(s, key, value); // only here (or deleted in the account before it changed here)
          result.pushed++;
        }
      }
      for (const [key, value] of cloud[s]) {
        if (local[s].has(key)) continue;
        this._applyItem(s, key, value, cloud.at[s].get(key));
        result.pulled++;
      }
    }
    return result;
  }

  /**
   * Upload this browser's data through the outbox: one upsert per position with a value, per synced
   * preference (never DEVICE_KEYS) and per chat with a message. A full upsert, not ignoreDuplicates:
   * the row in the cloud becomes this browser's copy (and a tombstone is cleared).
   * @returns {number} how many upserts were queued
   */
  pushLocal() {
    if (!this._outbox || this._disposed) return 0;
    const local = this._localSnapshot();
    let ops = 0;
    for (const s of SECTIONS) {
      for (const [key, value] of local[s]) {
        this._pushItem(s, key, value);
        ops++;
      }
    }
    return ops;
  }

  /** Read the account's three tables → a cloud snapshot. Throws when any read fails. */
  async _readCloud() {
    const results = await Promise.all(SECTIONS.map((s) =>
      this.client.from(TABLE[s]).select('*').eq('user_id', this.userId)));
    // A missing response is a failed read, never an empty account.
    for (const r of results) {
      if (!r || r.error) throw new Error(r?.error?.message || 'no response');
    }
    return cloudSnapshot(...results.map((r) => (Array.isArray(r.data) ? r.data : [])));
  }

  /** This browser's data as a snapshot (same shape and rules as the cloud one). */
  _localSnapshot() {
    return snapshotOf({
      positions: this.local.getAllPositions(),
      chatHistories: this.local.getAllChatHistories(),
      preferences: this.local.getAllPreferences(),
    });
  }

  /** Apply every item of a cloud snapshot here; returns how many. */
  _applySnapshot(snap) {
    let n = 0;
    for (const s of SECTIONS) {
      for (const [key, value] of snap[s]) {
        this._applyItem(s, key, value, snap.at?.[s].get(key));
        n++;
      }
    }
    return n;
  }

  /**
   * The account's tombstones against this browser's copies. An item deleted in the account after this
   * browser's copy last changed is deleted here (and not uploaded again); a copy that changed here later,
   * or that nothing here dates, wins and, with `push`, is uploaded again (clearing deleted_at). A tombstone
   * for an item this browser does not hold is ignored. Removed items are taken out of `local` too.
   * @returns {number} how many items were deleted here
   */
  _applyTombstones(cloud, local, { push }) {
    let removed = 0;
    for (const s of SECTIONS) {
      for (const [key, deletedAt] of cloud.tombs[s]) {
        if (!local[s].has(key)) continue;
        if (this._cloudWins(s, key, deletedAt)) {
          this._removeLocal(s, key, isoOf(deletedAt));
          local[s].delete(key);
          removed++;
        } else if (push) {
          this._pushItem(s, key, local[s].get(key));
        }
      }
    }
    return removed;
  }

  /** Date this browser's copies that equal the account's with the account's updated_at. */
  _stampSame(cloud, local) {
    for (const s of SECTIONS) {
      for (const [key, value] of cloud[s]) {
        if (local[s].has(key) && deepEqual(local[s].get(key), value)) {
          this._stamp(s, key, isoOf(cloud.at[s].get(key)) ?? EPOCH);
        }
      }
    }
  }

  // Cloud data goes straight to this.local: this.setPosition() and friends would queue an upload
  // of the cloud's own rows back to it. It is dated by the row (the epoch when the row has no time).
  _applyItem(section, key, value, updatedAt) {
    if (section === 'positions') this.local.setPosition(key, value);
    else if (section === 'prefs') this.local.setPreference(key, value);
    else this.local.setChatHistory(key, value);
    this._stamp(section, key, isoOf(updatedAt) ?? EPOCH);
  }

  // A delete from the account, applied the same way; dated by the tombstone.
  _removeLocal(section, key, deletedAt) {
    if (section === 'positions') this.local.deletePosition(key);
    else if (section === 'prefs') this.local.setPreference(key, null);
    else this.local.deleteChatHistory(key);
    this._stamp(section, key, deletedAt ?? EPOCH);
  }

  /** Upload this browser's copy of an item (an upsert, which also clears a tombstone), dated now. */
  _pushItem(section, key, value) {
    this._write(section, key, 'upsert', rowOf(section, key, value));
  }

  /** Delete an item in the account (a tombstone), dated now. */
  _deleteItem(section, key) {
    this._write(section, key, 'delete', null);
  }

  _write(section, key, op, row) {
    if (!isKey(key)) return;
    const ts = this._now();
    this._stamp(section, key, new Date(ts).toISOString());
    if (!this._outbox || this._disposed) return;
    this._outbox.enqueue({ table: TABLE[section], key, op, row, ts });
    this._flushOutbox(); // joins the flush enqueue() started; afterwards the 60 s retry follows the queue
  }

  // ── Sync dates (last writer wins) ──────────────────────────────────────────

  _readMeta() {
    if (!this._storage || !isKey(this.userId)) return {};
    try {
      const meta = JSON.parse(this._storage.getItem(META_PREFIX + this.userId) ?? '{}');
      return isObject(meta) ? meta : {};
    } catch {
      return {};
    }
  }

  /** When this browser's copy of an item last changed (ISO), or null when nothing here dates it. */
  _stampOf(section, key) {
    const meta = this._readMeta();
    const id = `${TABLE[section]}:${key}`;
    return Object.hasOwn(meta, id) && typeof meta[id] === 'string' ? meta[id] : null;
  }

  /** Date this browser's copy of an item (read and written each time: other tabs stamp too). */
  _stamp(section, key, iso) {
    if (this._disposed || !this._storage || !isKey(this.userId)) return;
    const meta = this._readMeta();
    meta[`${TABLE[section]}:${key}`] = iso;
    try {
      this._storage.setItem(META_PREFIX + this.userId, JSON.stringify(meta));
    } catch { /* full or blocked: the item counts as undated here, so this browser's copy is kept */ }
  }

  /**
   * Whether the account's change at `time` (a row's updated_at, a tombstone's deleted_at) is newer than
   * this browser's copy of the item. A copy nothing here dates is never older: it wins.
   */
  _cloudWins(section, key, time) {
    const here = msOf(this._stampOf(section, key));
    return Number.isFinite(here) && msOf(time) > here;
  }

  // ── Outbox ─────────────────────────────────────────────────────────────────

  /** Flush the outbox (forced: now, even while a retry waits), then keep the 60 s retry in step. */
  _flushOutbox(force = false) {
    if (!this._outbox || this._disposed) return Promise.resolve();
    return this._outbox.flush({ force }).then(() => this._syncInterval());
  }

  /**
   * Send the writes still queued for this account now (a retry waiting for its backoff goes at once),
   * waiting at most `timeoutMs`: for a sign-out, whose confirm says the account's copy is kept. A network
   * that is down ends the wait as soon as the retry is rescheduled; a request that hangs ends it at the
   * timeout. Never rejects.
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<number>} how many writes are still waiting afterwards (0 without an outbox)
   */
  async flushPendingWrites({ timeoutMs = 5000 } = {}) {
    if (!this._outbox || this._disposed) return 0;
    await this._outboxSettled(timeoutMs);
    return this._disposed ? 0 : this._outbox.size();
  }

  /** A forced flush, waited for at most `ms`. */
  _outboxSettled(ms) {
    let timer;
    const timeUp = new Promise((resolve) => { timer = this._setTimeout(resolve, ms); });
    return Promise.race([this._flushOutbox(true), timeUp]).finally(() => this._clearTimeout(timer));
  }

  /** The 60 s retry runs while writes wait (browser only). */
  _syncInterval() {
    if (!this._inBrowser || this._disposed || !this._outbox) return;
    const waiting = this._outbox.size() > 0;
    if (waiting && !this._interval) {
      this._interval = { id: this._setInterval(() => { this._flushOutbox(true); }, RETRY_EVERY_MS) };
    } else if (!waiting && this._interval) {
      this._clearInterval(this._interval.id);
      this._interval = null;
    }
  }

  /** In a browser: retry at once when it comes back online, and when the tab becomes visible. */
  _attachBrowser() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const win = window;
    const doc = typeof document !== 'undefined' && typeof document.addEventListener === 'function' ? document : null;
    const onOnline = () => { this._flushOutbox(true); };
    const onVisibility = () => { if (doc.visibilityState === 'visible') this._flushOutbox(true); };
    win.addEventListener('online', onOnline);
    doc?.addEventListener('visibilitychange', onVisibility);
    this._inBrowser = true;
    this._detachBrowser = () => {
      win.removeEventListener('online', onOnline);
      doc?.removeEventListener('visibilitychange', onVisibility);
    };
  }

  /**
   * Perform one outbox op; resolves to the postgrest response, whose `error` and `status` the outbox reads.
   * An upsert sends the item's row with deleted_at: null (a write clears a tombstone). A delete is a
   * tombstone: the content nulled, deleted_at and updated_at set to the time of the delete. Before
   * migration 005 (PGRST204: no deleted_at column; 23502: content still NOT NULL) an upsert is sent again
   * without deleted_at and a delete becomes a hard delete, with one warning per backend.
   */
  async _send(op) {
    const section = SECTION_OF_TABLE[op.table];
    // Only the three tables, and never a preference that must stay on this device (a saved queue is data).
    if (!section || !isKey(op.key) || (section === 'prefs' && !isSyncedPref(op.key))) {
      return { error: { code: 'NOT_SYNCED', message: 'not an item this app syncs' }, status: 400 };
    }
    const at = new Date(Number.isFinite(op.ts) ? op.ts : this._now()).toISOString();
    const keyColumn = KEY_COLUMN[section];
    const onConflict = `user_id,${keyColumn}`;
    const table = () => this.client.from(TABLE[section]);
    const content = {};
    for (const column of CONTENT[section]) content[column] = op.op === 'upsert' ? (op.row?.[column] ?? null) : null;

    if (op.op === 'upsert') {
      const row = { user_id: this.userId, [keyColumn]: op.key, ...content, updated_at: at, deleted_at: null };
      const response = await table().upsert(row, { onConflict });
      if (response?.error?.code !== 'PGRST204') return response;
      this._warnMigration();
      const legacy = { ...row };
      delete legacy.deleted_at;
      return table().upsert(legacy, { onConflict });
    }

    const response = await table().upsert(
      { user_id: this.userId, [keyColumn]: op.key, ...content, deleted_at: at, updated_at: at },
      { onConflict }
    );
    const code = response?.error?.code;
    if (code !== 'PGRST204' && code !== '23502') return response;
    this._warnMigration();
    return table().delete().eq('user_id', this.userId).eq(keyColumn, op.key);
  }

  _warnMigration() {
    if (this._migrationWarned) return;
    this._migrationWarned = true;
    console.warn('Supabase sync: migration 005 has not run (no deleted_at column, or content still NOT NULL), so deletes are hard deletes that another device can bring back; run supabase/migrations/005_sync_tombstones.sql.');
  }

  /**
   * Remove other accounts' queued writes and sync dates. This browser now holds this account's data
   * (claimLocalData() cleared the previous account's before this backend was built), and a queued write
   * can carry chat text.
   */
  _purgeOtherAccounts() {
    const storage = this._storage;
    if (!storage) return;
    const mine = new Set([OUTBOX_PREFIX + this.userId, META_PREFIX + this.userId]);
    try {
      const stale = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (typeof key !== 'string' || mine.has(key)) continue;
        if (key.startsWith(OUTBOX_PREFIX) || key.startsWith(META_PREFIX)) stale.push(key);
      }
      stale.forEach((key) => storage.removeItem(key));
    } catch { /* storage unavailable: nothing saved to remove */ }
  }
}
