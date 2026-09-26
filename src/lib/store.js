// src/lib/store.js
// Storage abstraction layer for all persistent user data.
// Backed by localStorage today; swap backend for Supabase (or other) via setBackend().
//
// `store-changed` (a CustomEvent on window) tells the UI to re-read the store:
//   - no `detail`: everything may have changed (import, hydrate, conflict resolution, sign-out,
//     another tab clearing or rewriting several items);
//   - `detail = { kind: 'position' | 'chat' | 'pref', id }`: one item changed (id is the ticker or
//     the preference name), so a listener showing something else can ignore it.
// Dispatch it with emitStoreChanged(); subscribeCrossTab() turns other tabs' localStorage writes
// into it.

const SCHEMA_VERSION = 2;
const STORE_CHANGED = 'store-changed';

const POSITION_PREFIX = 'position_';
const CHAT_PREFIX = 'chat_history_';

const PREF_MAP = {
  sidebarWidth: 'chat_sidebar_w',
  section_position: 'section_position',
  section_research: 'section_research',
  section_charts: 'section_charts',
  strategic_context: 'strategic_context',
  // AI settings (v2 — migrated from sessionStorage)
  ai_provider: 'ai_provider',
  ai_model: 'ai_model',
  ai_model_name: 'ai_model_name',
  ai_key_anthropic: 'ai_key_anthropic',
  ai_key_openai: 'ai_key_openai',
  ai_key_gemini: 'ai_key_gemini',
  // Data source keys (v2 — migrated from sessionStorage)
  data_tradier_key: 'data_tradier_key',
  data_finnhub_key: 'data_finnhub_key',
};

// Keys that contain secrets — excluded from export for security.
const SECRET_KEYS = new Set([
  'ai_key_anthropic', 'ai_key_openai', 'ai_key_gemini',
  'data_tradier_key', 'data_finnhub_key',
]);

// Keys that never leave this device: the secrets above plus per-browser flags.
// Not synced to the cloud, not exported, not accepted from an import.
const DEVICE_KEYS = new Set([...SECRET_KEYS, 'auth_skipped']);

// Layout preferences: synced and exported like the rest, but a difference between
// this browser and the cloud copy is not worth asking the user which one to keep.
const LAYOUT_KEYS = new Set(['sidebarWidth', 'section_position', 'section_research', 'section_charts']);

// Every preference name the app reads or writes. A cloud row under any other name is not applied
// here: it would otherwise land in an arbitrary localStorage key.
const PREF_NAMES = new Set(Object.keys(PREF_MAP));

// localStorage key → preference name (a Map, so keys like 'constructor' are not found on a prototype).
const PREF_NAME_BY_STORAGE_KEY = new Map(Object.entries(PREF_MAP).map(([name, key]) => [key, name]));

// Browsers disagree on how a full store reports itself: QuotaExceededError (code 22)
// in most engines, NS_ERROR_DOM_QUOTA_REACHED (code 1014) in older Firefox.
function isQuotaError(e) {
  return !!e && (
    e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    e.code === 22 || e.code === 1014
  );
}

/**
 * localStorage.setItem that never throws: a full (or unavailable) store logs one
 * warning naming the caller and the key instead of breaking the UI mid-edit.
 * @returns {boolean} true when the value was written
 */
function safeSetItem(key, value, what) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn(`${what}: ${isQuotaError(e) ? 'localStorage quota exceeded' : 'localStorage error'} for`, key, e);
    return false;
  }
}

class LocalStorageBackend {
  getPosition(ticker) {
    if (!ticker) return { costBasis: null, shares: null };
    try {
      const raw = localStorage.getItem(POSITION_PREFIX + ticker);
      if (raw) return JSON.parse(raw);
    } catch { /* corrupted */ }
    return { costBasis: null, shares: null };
  }

  setPosition(ticker, { costBasis, shares }) {
    if (!ticker) return;
    if (costBasis != null || shares != null) {
      safeSetItem(POSITION_PREFIX + ticker, JSON.stringify({ costBasis, shares }), 'setPosition');
    } else {
      this.deletePosition(ticker);
    }
  }

  deletePosition(ticker) {
    if (ticker) localStorage.removeItem(POSITION_PREFIX + ticker);
  }

  getAllPositions() {
    const result = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith(POSITION_PREFIX)) {
        try {
          result[key.slice(POSITION_PREFIX.length)] = JSON.parse(localStorage.getItem(key));
        } catch { /* skip corrupted entries */ }
      }
    }
    return result;
  }

  getChatHistory(ticker) {
    if (!ticker) return [];
    try {
      const raw = localStorage.getItem(CHAT_PREFIX + ticker);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  setChatHistory(ticker, messages) {
    if (!ticker) return;
    if (messages?.length) {
      safeSetItem(CHAT_PREFIX + ticker, JSON.stringify(messages), 'setChatHistory');
    } else {
      this.deleteChatHistory(ticker);
    }
  }

  deleteChatHistory(ticker) {
    if (ticker) localStorage.removeItem(CHAT_PREFIX + ticker);
  }

  getAllChatHistories() {
    const result = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith(CHAT_PREFIX)) {
        try {
          result[key.slice(CHAT_PREFIX.length)] = JSON.parse(localStorage.getItem(key));
        } catch { /* skip */ }
      }
    }
    return result;
  }

  getPreference(name) {
    const key = PREF_MAP[name] || name;
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  }

  setPreference(name, value) {
    const key = PREF_MAP[name] || name;
    if (value != null) {
      safeSetItem(key, JSON.stringify(value), 'setPreference');
    } else {
      localStorage.removeItem(key);
    }
  }

  getAllPreferences({ includeSecrets = false } = {}) {
    const result = {};
    for (const name of Object.keys(PREF_MAP)) {
      if (!includeSecrets && SECRET_KEYS.has(name)) continue;
      const val = this.getPreference(name);
      if (val != null) result[name] = val;
    }
    return result;
  }

  /**
   * Remove every position, chat history and preference from this browser.
   * @param {{ keepSecrets?: boolean }} [opts] keepSecrets: leave the SECRET_KEYS preferences
   *   (the user's own API keys) in place, e.g. when replacing the data with a cloud copy.
   */
  clearAll({ keepSecrets = false } = {}) {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith(POSITION_PREFIX) || key.startsWith(CHAT_PREFIX)) {
        toRemove.push(key);
      }
    }
    for (const [name, key] of Object.entries(PREF_MAP)) {
      if (!(keepSecrets && SECRET_KEYS.has(name))) toRemove.push(key);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  }
}

let backend = new LocalStorageBackend();

/** Dispatch `store-changed` on window (no-op without one); see the event contract at the top. */
export function emitStoreChanged(detail) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(STORE_CHANGED, detail == null ? undefined : { detail }));
}

/**
 * What a localStorage key holds, in `store-changed` detail form.
 * @param {string|null} key
 * @returns {{ kind: 'position'|'chat'|'pref', id: string } | null} null for keys the store does not own
 */
export function describeStorageKey(key) {
  if (typeof key !== 'string') return null;
  if (key.startsWith(POSITION_PREFIX) && key.length > POSITION_PREFIX.length) {
    return { kind: 'position', id: key.slice(POSITION_PREFIX.length) };
  }
  if (key.startsWith(CHAT_PREFIX) && key.length > CHAT_PREFIX.length) {
    return { kind: 'chat', id: key.slice(CHAT_PREFIX.length) };
  }
  const name = PREF_NAME_BY_STORAGE_KEY.get(key);
  return name ? { kind: 'pref', id: name } : null;
}

// A `storage` event for sessionStorage says nothing about the store (it only ever uses localStorage).
function isLocalStorageArea(area) {
  if (area == null) return true; // synthetic events carry none
  try {
    return area === globalThis.localStorage;
  } catch {
    return true; // storage access blocked: cannot tell, so assume it is ours
  }
}

/**
 * Re-dispatch other tabs' localStorage writes as `store-changed`, so an edit in one tab shows in the
 * others. A burst of writes (an import, a hydrate) becomes one event per macrotask: with the item's
 * detail when exactly one store key changed, without detail when several did or the storage was
 * cleared (`key === null`). Keys the store does not own are ignored.
 * @returns {() => void} unsubscribe (also drops an event still waiting to be dispatched)
 */
export function subscribeCrossTab() {
  if (typeof window === 'undefined') return () => {};
  let timer = null;
  let pending; // undefined: nothing yet; a detail: one item so far; null: several items or cleared

  const dispatch = () => {
    const detail = pending;
    timer = null;
    pending = undefined;
    emitStoreChanged(detail);
  };

  const onStorage = (e) => {
    if (!isLocalStorageArea(e.storageArea)) return;
    let detail = null;
    if (e.key !== null) {
      detail = describeStorageKey(e.key);
      if (!detail) return;
    }
    if (pending === undefined) pending = detail;
    else if (pending && !(detail && detail.kind === pending.kind && detail.id === pending.id)) pending = null;
    if (timer === null) timer = setTimeout(dispatch, 0);
  };

  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener('storage', onStorage);
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = undefined;
  };
}

export function getPosition(ticker) { return backend.getPosition(ticker); }
export function setPosition(ticker, data) { backend.setPosition(ticker, data); }
export function deletePosition(ticker) { backend.deletePosition(ticker); }

export function getChatHistory(ticker) { return backend.getChatHistory(ticker); }
export function setChatHistory(ticker, messages) { backend.setChatHistory(ticker, messages); }
export function deleteChatHistory(ticker) { backend.deleteChatHistory(ticker); }

export function getPreference(key) { return backend.getPreference(key); }
export function setPreference(key, value) { backend.setPreference(key, value); }

/**
 * Clear this browser's copy of the user data through the current backend (never the cloud copy).
 * @param {{ keepSecrets?: boolean }} [opts] see LocalStorageBackend#clearAll
 */
export function clearAll(opts) { backend.clearAll(opts); }

export function exportAll() {
  return {
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    positions: backend.getAllPositions(),
    chatHistories: backend.getAllChatHistories(),
    preferences: backend.getAllPreferences(),
  };
}

function migrate(data) {
  if (data.version < 2) {
    // v2: AI/data keys moved from sessionStorage to preferences — no import-level
    // migration needed since old exports never contained these keys.
    data.version = 2;
  }
  return data;
}

/**
 * One-time migration: move AI/data settings from sessionStorage to localStorage.
 * Safe to call multiple times — only migrates keys that exist in sessionStorage
 * and don't already exist in localStorage.
 */
export function migrateSessionToLocal() {
  if (typeof window === 'undefined') return;
  try {
    const sessionKeys = [
      'ai_provider', 'ai_model', 'ai_model_name',
      'ai_key_anthropic', 'ai_key_openai', 'ai_key_gemini',
      'data_tradier_key', 'data_finnhub_key',
    ];
    // Also migrate legacy key names from the very first version
    const legacyMap = {
      anthropic_api_key: 'ai_key_anthropic',
      anthropic_model: 'ai_model',
    };

    for (const key of sessionKeys) {
      const val = sessionStorage.getItem(key);
      const local = backend.getPreference(key);
      if (val != null && (local == null || local === '')) {
        backend.setPreference(key, val);
      }
      sessionStorage.removeItem(key);
    }
    for (const [oldKey, newKey] of Object.entries(legacyMap)) {
      const val = sessionStorage.getItem(oldKey);
      const local = backend.getPreference(newKey);
      if (val != null && (local == null || local === '')) {
        backend.setPreference(newKey, val);
      }
      sessionStorage.removeItem(oldKey);
    }
  } catch { /* sessionStorage unavailable — skip migration */ }
}

export function importAll(data) {
  if (!data || typeof data !== 'object') throw new Error('Invalid data format.');
  if (typeof data.version !== 'number') throw new Error('Missing schema version.');
  if (data.version > SCHEMA_VERSION) {
    throw new Error(`Unsupported schema v${data.version} — update the app first.`);
  }

  const migrated = migrate(data);

  // Validate importable sections before clearing to avoid data loss on malformed input
  const hasPositions = migrated.positions != null &&
                       !Array.isArray(migrated.positions) &&
                       typeof migrated.positions === 'object';
  const hasChats = migrated.chatHistories != null &&
                   !Array.isArray(migrated.chatHistories) &&
                   typeof migrated.chatHistories === 'object';
  const hasPrefs = migrated.preferences != null &&
                   !Array.isArray(migrated.preferences) &&
                   typeof migrated.preferences === 'object';
  if (!hasPositions && !hasChats && !hasPrefs) {
    throw new Error('Import data contains no valid sections.');
  }

  // Backup current data before clearing — stored under a recovery key so a
  // failed import can be manually recovered from localStorage.
  try {
    const backup = JSON.stringify({
      positions: backend.getAllPositions(),
      chatHistories: backend.getAllChatHistories(),
      preferences: backend.getAllPreferences({ includeSecrets: true }),
    });
    localStorage.setItem('_import_backup', backup);
  } catch (e) {
    console.warn('importAll: backup failed', e);
  }

  backend.clearAll();

  if (hasPositions) {
    for (const [ticker, pos] of Object.entries(migrated.positions)) {
      if (pos != null && typeof pos === 'object' && !Array.isArray(pos)) {
        backend.setPosition(ticker, pos);
      }
    }
  }
  if (hasChats) {
    for (const [ticker, msgs] of Object.entries(migrated.chatHistories)) {
      if (Array.isArray(msgs)) backend.setChatHistory(ticker, msgs);
    }
  }
  if (hasPrefs) {
    for (const [key, val] of Object.entries(migrated.preferences)) {
      backend.setPreference(key, val);
    }
  }

  // Clean up backup after successful import
  try { localStorage.removeItem('_import_backup'); } catch { /* ignore */ }

  emitStoreChanged();
}

/**
 * Route every store call to `newBackend`. The backend it replaces is disposed (when it has a
 * dispose()): a SupabaseBackend swapped out by a sign-out or an account switch must not apply a
 * hydrate still in flight to what is now another account's (or nobody's) browser.
 */
export function setBackend(newBackend) {
  if (backend !== newBackend) backend?.dispose?.();
  backend = newBackend;
}
export { LocalStorageBackend, SECRET_KEYS, DEVICE_KEYS, LAYOUT_KEYS, PREF_NAMES };
