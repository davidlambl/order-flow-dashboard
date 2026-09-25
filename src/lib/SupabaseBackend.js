// src/lib/SupabaseBackend.js
// Offline-first backend: localStorage for reads, Supabase for durable sync.
// Wraps LocalStorageBackend with write-through async sync to Supabase.
// Secret keys (API keys) are NEVER sent to Supabase.
// All queries are scoped to the authenticated user via user_id.
// The client is injectable (tests pass a fake); the default is the app's client.
//
// Sign-in (hydrate) never merges on its own (roadmap D1, D6): it pushes this browser's data only into
// an account with nothing in it, pulls the account's data only into a browser with nothing in it, and
// otherwise reports a conflict and writes nothing until the user picks merge / cloud / local
// (resolveConflict). Before this, hydrate filled local gaps and then upserted every local row, so
// whatever the previous user left in this browser went into the next account that signed in.

import { supabase } from './supabase.js';
import { SECRET_KEYS, DEVICE_KEYS, LAYOUT_KEYS, PREF_NAMES, emitStoreChanged } from './store.js';
import { deepEqual } from './deepEqual.js';

// A snapshot is { positions, prefs, chats }, each a Map of key → value; these are its tables.
const SECTIONS = ['positions', 'prefs', 'chats'];
const TABLE = { positions: 'positions', prefs: 'preferences', chats: 'chat_histories' };
const KEY_COLUMN = { positions: 'ticker', prefs: 'key', chats: 'ticker' };
const CHOICES = new Set(['merge', 'cloud', 'local']);

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

/** Cloud rows (one array per table) → snapshot. Tombstoned rows (`deleted_at`) do not count. */
function cloudSnapshot(positionRows, prefRows, chatRows) {
  const snap = { positions: new Map(), prefs: new Map(), chats: new Map() };
  const live = (row) => row && typeof row === 'object' && !row.deleted_at;
  for (const row of positionRows) {
    if (!live(row) || typeof row.ticker !== 'string' || !row.ticker) continue;
    const pos = positionOf(row.cost_basis, row.shares);
    if (pos) snap.positions.set(row.ticker, pos);
  }
  for (const row of prefRows) {
    if (!live(row) || !isSyncedPref(row.key) || row.value == null) continue;
    snap.prefs.set(row.key, row.value);
  }
  for (const row of chatRows) {
    if (!live(row) || typeof row.ticker !== 'string' || !row.ticker) continue;
    const msgs = messagesOf(row.messages);
    if (msgs) snap.chats.set(row.ticker, msgs);
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

export class SupabaseBackend {
  constructor(localBackend, userId, client = supabase) {
    this.local = localBackend;
    this.userId = userId;
    this.client = client;
    this._syncQueue = [];
    this._flushing = false;
    this._cloud = null; // the cloud snapshot of a hydrate() 'conflict', for resolveConflict()
    this._disposed = false;
  }

  /**
   * Stop acting for this user: a hydrate() still reading, or a resolveConflict() after this, writes
   * nothing (this browser may already hold another account's data). store.setBackend() calls it on
   * the backend it replaces. Writes already queued still go out, under this backend's user_id.
   */
  dispose() {
    this._disposed = true;
  }

  // ── Positions ──────────────────────────────────────────────────────────────

  getPosition(ticker) {
    return this.local.getPosition(ticker);
  }

  setPosition(ticker, data) {
    this.local.setPosition(ticker, data);
    if (data.costBasis != null || data.shares != null) {
      this._enqueue(() =>
        this.client.from('positions').upsert(
          { user_id: this.userId, ticker, cost_basis: data.costBasis, shares: data.shares, updated_at: new Date().toISOString() },
          { onConflict: 'user_id,ticker' }
        )
      );
    } else {
      this._enqueue(() => this.client.from('positions').delete().eq('user_id', this.userId).eq('ticker', ticker));
    }
  }

  deletePosition(ticker) {
    this.local.deletePosition(ticker);
    this._enqueue(() => this.client.from('positions').delete().eq('user_id', this.userId).eq('ticker', ticker));
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
    if (SECRET_KEYS.has(name)) return; // Never sync secrets
    this._enqueue(() =>
      value != null
        ? this.client.from('preferences').upsert(
            { user_id: this.userId, key: name, value, updated_at: new Date().toISOString() },
            { onConflict: 'user_id,key' }
          )
        : this.client.from('preferences').delete().eq('user_id', this.userId).eq('key', name)
    );
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
    this._enqueue(() =>
      messages?.length
        ? this.client.from('chat_histories').upsert(
            { user_id: this.userId, ticker, messages, updated_at: new Date().toISOString() },
            { onConflict: 'user_id,ticker' }
          )
        : this.client.from('chat_histories').delete().eq('user_id', this.userId).eq('ticker', ticker)
    );
  }

  deleteChatHistory(ticker) {
    this.local.deleteChatHistory(ticker);
    this._enqueue(() => this.client.from('chat_histories').delete().eq('user_id', this.userId).eq('ticker', ticker));
  }

  getAllChatHistories() {
    return this.local.getAllChatHistories();
  }

  // ── Clear ──────────────────────────────────────────────────────────────────

  clearAll(opts) {
    this.local.clearAll(opts);
    // Don't clear Supabase — that's a destructive cloud operation
    // that should require explicit user action.
  }

  // ── Background Sync Queue ──────────────────────────────────────────────────

  _enqueue(fn) {
    if (!this.client) return;
    this._syncQueue.push(fn);
    this._flush();
  }

  async _flush() {
    if (this._flushing) return;
    this._flushing = true;
    let retries = 0;
    while (this._syncQueue.length > 0) {
      const op = this._syncQueue[0];
      try {
        const { error } = await op();
        // Always shift on resolved promise — returned errors (RLS, constraint)
        // are deterministic and retrying won't help. Only thrown errors (network)
        // are retried via the catch block below.
        this._syncQueue.shift();
        retries = 0;
        if (error) console.warn('Supabase sync error:', error.message);
      } catch (err) {
        retries++;
        if (retries >= 3) {
          this._syncQueue.shift(); // drop after 3 retries
          retries = 0;
          console.warn('Supabase sync failed after 3 retries:', err.message);
        } else {
          console.warn(`Supabase sync retry ${retries}/3:`, err.message);
          await new Promise((r) => setTimeout(r, 1000 * retries));
        }
      }
    }
    this._flushing = false;
  }

  // ── Sign-in sync ───────────────────────────────────────────────────────────

  /**
   * Compare this browser with the account and write only where nothing can be lost:
   *   'pushed'   – the account has nothing worth asking about: this browser's data is uploaded
   *                (a first sign-in);
   *   'pulled'   – this browser has nothing worth asking about: the account's data, layout included,
   *                is applied here;
   *   'in-sync'  – both hold the same data; layout preferences are then reconciled (this browser's
   *                value is uploaded, one only in the cloud is applied here);
   *   'conflict' – both hold different data: nothing is written until resolveConflict();
   *   'offline'  – the account could not be read, or this backend was disposed while reading:
   *                nothing is written.
   * "Worth asking about": positions with a cost basis or shares, chats with a message, and
   * preferences outside LAYOUT_KEYS and DEVICE_KEYS. Never rejects.
   * @returns {Promise<{ status: 'pushed'|'pulled'|'in-sync'|'conflict'|'offline',
   *   cloud: { positions: number, prefs: number, chats: number } | null,
   *   local: { positions: number, prefs: number, chats: number } | null }>}
   *   those items' counts per side; cloud is null when it was not read, both are null once disposed
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
    if (!this.client || !this.userId) return offline();

    let cloud;
    try {
      const results = await Promise.all(SECTIONS.map((s) =>
        this.client.from(TABLE[s]).select('*').eq('user_id', this.userId)));
      // A missing response is a failed read, never an empty account.
      for (const r of results) {
        if (!r || r.error) throw new Error(r?.error?.message || 'no response');
      }
      cloud = cloudSnapshot(...results.map((r) => (Array.isArray(r.data) ? r.data : [])));
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
    const report = (status) => ({ status, cloud: countsOf(cloudPart), local: countsOf(localPart) });

    if (isEmptyPart(cloudPart)) {
      this.pushLocal();
      return report('pushed');
    }
    if (isEmptyPart(localPart)) {
      this._applySnapshot(cloud);
      emitStoreChanged();
      return report('pulled');
    }
    if (!SECTIONS.every((s) => sameMap(cloudPart[s], localPart[s]))) {
      this._cloud = cloud; // kept (it can hold every chat) only until resolveConflict() uses it
      return report('conflict');
    }

    // Same data on both sides. Layout is never worth a prompt: this browser's value wins, and a
    // value only the cloud has is applied here.
    let applied = 0;
    for (const name of LAYOUT_KEYS) {
      const here = local.prefs.has(name);
      const there = cloud.prefs.has(name);
      if (here && !(there && deepEqual(local.prefs.get(name), cloud.prefs.get(name)))) {
        this._pushItem('prefs', name, local.prefs.get(name));
      } else if (!here && there) {
        this._applyItem('prefs', name, cloud.prefs.get(name));
        applied++;
      }
    }
    if (applied > 0) emitStoreChanged();
    return report('in-sync');
  }

  /**
   * Settle a hydrate() 'conflict' the way the user chose (SyncChoice), against the cloud snapshot
   * that hydrate() read:
   *   'merge' – keep both: items only here are uploaded, items only in the cloud are applied here,
   *             and where both have an item this browser's copy wins (uploaded);
   *   'cloud' – this browser's data (API keys aside) is replaced by the cloud copy;
   *   'local' – the cloud copy is replaced by this browser's: everything here is uploaded and
   *             cloud-only items are deleted.
   * Dispatches store-changed. One resolution per hydrate(): the snapshot is used up.
   * @param {'merge'|'cloud'|'local'} choice
   * @returns {Promise<{ pushed: number, pulled: number, deleted: number }>} uploads queued, items
   *   applied here, cloud deletes queued
   */
  async resolveConflict(choice) {
    if (!CHOICES.has(choice)) throw new TypeError(`resolveConflict: unknown choice "${choice}"`);
    const cloud = this._cloud;
    if (!cloud) throw new Error('resolveConflict: no conflict to resolve; hydrate() first');
    const result = { pushed: 0, pulled: 0, deleted: 0 };
    if (this._disposed) return result;
    this._cloud = null;

    if (choice === 'cloud') {
      this.local.clearAll({ keepSecrets: true });
      result.pulled = this._applySnapshot(cloud);
    } else {
      const local = this._localSnapshot();
      result.pushed = this.pushLocal();
      for (const s of SECTIONS) {
        for (const [key, value] of cloud[s]) {
          if (local[s].has(key)) continue;
          if (choice === 'merge') {
            this._applyItem(s, key, value);
            result.pulled++;
          } else {
            this._deleteItem(s, key);
            result.deleted++;
          }
        }
      }
    }
    emitStoreChanged();
    return result;
  }

  /**
   * Upload this browser's data through the write queue: one upsert per position with a value, per
   * synced preference (never DEVICE_KEYS) and per chat with a message. A full upsert, not
   * ignoreDuplicates: the row in the cloud becomes this browser's copy.
   * @returns {number} how many upserts were queued
   */
  pushLocal() {
    if (!this.client || !this.userId || this._disposed) return 0;
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

  /** This browser's data as a snapshot (same shape and rules as the cloud one). */
  _localSnapshot() {
    const snap = { positions: new Map(), prefs: new Map(), chats: new Map() };
    for (const [ticker, p] of Object.entries(this.local.getAllPositions())) {
      const pos = p && typeof p === 'object' ? positionOf(p.costBasis, p.shares) : null;
      if (pos) snap.positions.set(ticker, pos);
    }
    for (const [name, value] of Object.entries(this.local.getAllPreferences())) {
      if (isSyncedPref(name) && value != null) snap.prefs.set(name, value);
    }
    for (const [ticker, msgs] of Object.entries(this.local.getAllChatHistories())) {
      if (Array.isArray(msgs) && msgs.length > 0) snap.chats.set(ticker, msgs);
    }
    return snap;
  }

  /** Apply every item of a snapshot here; returns how many. */
  _applySnapshot(snap) {
    let n = 0;
    for (const s of SECTIONS) {
      for (const [key, value] of snap[s]) {
        this._applyItem(s, key, value);
        n++;
      }
    }
    return n;
  }

  // Cloud data goes straight to this.local: this.setPosition() and friends would queue an upload
  // of the cloud's own rows back to it.
  _applyItem(section, key, value) {
    if (section === 'positions') this.local.setPosition(key, value);
    else if (section === 'prefs') this.local.setPreference(key, value);
    else this.local.setChatHistory(key, value);
  }

  _pushItem(section, key, value) {
    const row = section === 'positions' ? { ticker: key, cost_basis: value.costBasis, shares: value.shares }
      : section === 'prefs' ? { key, value }
        : { ticker: key, messages: value };
    this._enqueue(() =>
      this.client.from(TABLE[section]).upsert(
        { user_id: this.userId, ...row, updated_at: new Date().toISOString() },
        { onConflict: `user_id,${KEY_COLUMN[section]}` }
      )
    );
  }

  _deleteItem(section, key) {
    this._enqueue(() =>
      this.client.from(TABLE[section]).delete().eq('user_id', this.userId).eq(KEY_COLUMN[section], key)
    );
  }
}
