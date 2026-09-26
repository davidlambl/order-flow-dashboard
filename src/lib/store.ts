// src/lib/store.ts
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
} as const;

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

// PREF_MAP for any string: getPreference/setPreference also take a name outside it, which is then its own
// localStorage key.
const STORAGE_KEY_OF: Readonly<Record<string, string | undefined>> = PREF_MAP;

// localStorage key → preference name (a Map, so keys like 'constructor' are not found on a prototype).
const PREF_NAME_BY_STORAGE_KEY = new Map<string, string>(Object.entries(PREF_MAP).map(([name, key]) => [key, name]));

/** What the user holds in one ticker; null where unset (a position with neither is deleted). */
export interface Position {
  costBasis: number | null;
  shares: number | null;
}

/**
 * A chat message as ChatBot holds it. `pending` marks the reply still streaming; it and the `error` bubbles are
 * shown but never stored (ChatBot's storableMessages drops them before it saves a history).
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'error';
  content: string;
  pending?: boolean;
}

/** A preference name the store knows: a key of PREF_MAP. */
export type PrefName = keyof typeof PREF_MAP;

/**
 * The value each preference holds, as its writers store it. Writing null deletes a preference, so null is never
 * a stored value.
 */
export interface PreferenceValues {
  sidebarWidth: number;
  section_position: boolean;
  section_research: boolean;
  section_charts: boolean;
  strategic_context: string;
  ai_provider: string;
  ai_model: string;
  ai_model_name: string;
  ai_key_anthropic: string;
  ai_key_openai: string;
  ai_key_gemini: string;
  data_tradier_key: string;
  data_finnhub_key: string;
}

/** The `store-changed` detail: the one item that changed (see the event contract at the top). */
export interface StoreChangeDetail {
  kind: 'position' | 'chat' | 'pref';
  /** The ticker, or the preference name. */
  id: string;
}

/** What an import wrote, by ticker or preference name: what a backend's replaceCloud() makes the account hold. */
export interface StoreSnapshot {
  positions: Record<string, Position>;
  chatHistories: Record<string, ChatMessage[]>;
  preferences: Partial<PreferenceValues>;
}

/** A backup as exportAll() makes it: no API keys and no device flags. */
export interface Backup {
  version: number;
  exportedAt: string;
  positions: Record<string, Position>;
  chatHistories: Record<string, ChatMessage[]>;
  preferences: Partial<PreferenceValues>;
}

/** What importAll() did: how many items it wrote, and the preference names in the file it did not import. */
export interface ImportResult {
  imported: { positions: number; chats: number; prefs: number };
  skipped: string[];
}

/**
 * A storage backend: LocalStorageBackend (this browser), or SupabaseBackend, which wraps one and also sends every
 * write to the account. The optional members are a cloud backend's; the store checks for each before calling it.
 */
export interface StoreBackend {
  getPosition(ticker: string): Position;
  setPosition(ticker: string, data: Position): void;
  deletePosition(ticker: string): void;
  getAllPositions(): Record<string, Position>;
  getChatHistory(ticker: string): ChatMessage[];
  setChatHistory(ticker: string, messages: ChatMessage[]): void;
  deleteChatHistory(ticker: string): void;
  getAllChatHistories(): Record<string, ChatMessage[]>;
  /** The stored value, JSON-parsed (the raw string when it is not JSON); null when there is none. */
  getPreference(name: string): unknown;
  /** null or undefined removes the preference. */
  setPreference(name: string, value: unknown): void;
  getAllPreferences(opts?: { includeSecrets?: boolean }): Partial<PreferenceValues>;
  clearAll(opts?: { keepSecrets?: boolean }): void;
  /** Send the writes still queued for the account; resolves to how many are still waiting. */
  flushPendingWrites?(opts?: { timeoutMs?: number }): Promise<number>;
  /** Make the account's copy match `snapshot` (an import); nothing waits for it. */
  replaceCloud?(snapshot: StoreSnapshot): Promise<unknown> | void;
  /** Stop acting for this backend's account; setBackend() calls it on the backend it replaces. */
  dispose?(): void;
}

// Browsers disagree on how a full store reports itself: QuotaExceededError (code 22)
// in most engines, NS_ERROR_DOM_QUOTA_REACHED (code 1014) in older Firefox.
function isQuotaError(e: unknown): boolean {
  if (!e) return false;
  const err: { name?: unknown; code?: unknown } = e; // whatever was thrown: a DOMException, an Error, anything else
  return (
    err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    err.code === 22 || err.code === 1014
  );
}

/**
 * localStorage.setItem that never throws: a full (or unavailable) store logs one
 * warning naming the caller and the key instead of breaking the UI mid-edit.
 * @returns true when the value was written
 */
function safeSetItem(key: string, value: string, what: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn(`${what}: ${isQuotaError(e) ? 'localStorage quota exceeded' : 'localStorage error'} for`, key, e);
    return false;
  }
}

class LocalStorageBackend implements StoreBackend {
  getPosition(ticker: string): Position {
    if (!ticker) return { costBasis: null, shares: null };
    try {
      const raw = localStorage.getItem(POSITION_PREFIX + ticker);
      if (raw) return JSON.parse(raw);
    } catch { /* corrupted */ }
    return { costBasis: null, shares: null };
  }

  setPosition(ticker: string, { costBasis, shares }: Position): void {
    if (!ticker) return;
    if (costBasis != null || shares != null) {
      safeSetItem(POSITION_PREFIX + ticker, JSON.stringify({ costBasis, shares }), 'setPosition');
    } else {
      this.deletePosition(ticker);
    }
  }

  deletePosition(ticker: string): void {
    if (ticker) localStorage.removeItem(POSITION_PREFIX + ticker);
  }

  getAllPositions(): Record<string, Position> {
    const result: Record<string, Position> = {};
    for (let i = 0; i < localStorage.length; i++) {
      // key(i) below length, and getItem() of a key it returned, are typed nullable but never null: `?.` only
      // narrows the type, and `?? 'null'` parses to the same null JSON.parse(null) did.
      const key = localStorage.key(i);
      if (key?.startsWith(POSITION_PREFIX)) {
        try {
          result[key.slice(POSITION_PREFIX.length)] = JSON.parse(localStorage.getItem(key) ?? 'null');
        } catch { /* skip corrupted entries */ }
      }
    }
    return result;
  }

  getChatHistory(ticker: string): ChatMessage[] {
    if (!ticker) return [];
    try {
      const raw = localStorage.getItem(CHAT_PREFIX + ticker);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  setChatHistory(ticker: string, messages: ChatMessage[]): void {
    if (!ticker) return;
    if (messages?.length) {
      safeSetItem(CHAT_PREFIX + ticker, JSON.stringify(messages), 'setChatHistory');
    } else {
      this.deleteChatHistory(ticker);
    }
  }

  deleteChatHistory(ticker: string): void {
    if (ticker) localStorage.removeItem(CHAT_PREFIX + ticker);
  }

  getAllChatHistories(): Record<string, ChatMessage[]> {
    const result: Record<string, ChatMessage[]> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(CHAT_PREFIX)) {
        try {
          result[key.slice(CHAT_PREFIX.length)] = JSON.parse(localStorage.getItem(key) ?? 'null');
        } catch { /* skip */ }
      }
    }
    return result;
  }

  getPreference(name: string): unknown {
    const key = STORAGE_KEY_OF[name] || name;
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  }

  setPreference(name: string, value: unknown): void {
    const key = STORAGE_KEY_OF[name] || name;
    if (value != null) {
      safeSetItem(key, JSON.stringify(value), 'setPreference');
    } else {
      localStorage.removeItem(key);
    }
  }

  getAllPreferences({ includeSecrets = false }: { includeSecrets?: boolean } = {}): Partial<PreferenceValues> {
    const result: Record<string, unknown> = {};
    for (const name of Object.keys(PREF_MAP)) {
      if (!includeSecrets && SECRET_KEYS.has(name)) continue;
      const val = this.getPreference(name);
      if (val != null) result[name] = val;
    }
    return result;
  }

  /**
   * Remove every position, chat history and preference from this browser.
   * @param opts keepSecrets: leave the SECRET_KEYS preferences
   *   (the user's own API keys) in place, e.g. when replacing the data with a cloud copy.
   */
  clearAll({ keepSecrets = false }: { keepSecrets?: boolean } = {}): void {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(POSITION_PREFIX) || key?.startsWith(CHAT_PREFIX)) {
        toRemove.push(key);
      }
    }
    for (const [name, key] of Object.entries(PREF_MAP)) {
      if (!(keepSecrets && SECRET_KEYS.has(name))) toRemove.push(key);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  }
}

let backend: StoreBackend = new LocalStorageBackend();

/** Dispatch `store-changed` on window (no-op without one); see the event contract at the top. */
export function emitStoreChanged(detail?: StoreChangeDetail | null): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(STORE_CHANGED, detail == null ? undefined : { detail }));
}

/**
 * What a localStorage key holds, in `store-changed` detail form.
 * @returns null for keys the store does not own
 */
export function describeStorageKey(key: string | null): StoreChangeDetail | null;
/** Anything that is not a string is not a key either: null. */
export function describeStorageKey(key: unknown): StoreChangeDetail | null;
export function describeStorageKey(key: unknown): StoreChangeDetail | null {
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
function isLocalStorageArea(area: Storage | null): boolean {
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
 * @returns unsubscribe (also drops an event still waiting to be dispatched)
 */
export function subscribeCrossTab(): () => void {
  if (typeof window === 'undefined') return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: StoreChangeDetail | null | undefined; // undefined: nothing yet; a detail: one item so far; null: several items or cleared

  const dispatch = () => {
    const detail = pending;
    timer = null;
    pending = undefined;
    emitStoreChanged(detail);
  };

  const onStorage = (e: StorageEvent) => {
    if (!isLocalStorageArea(e.storageArea)) return;
    let detail: StoreChangeDetail | null = null;
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

export function getPosition(ticker: string): Position { return backend.getPosition(ticker); }
export function setPosition(ticker: string, data: Position): void { backend.setPosition(ticker, data); }
export function deletePosition(ticker: string): void { backend.deletePosition(ticker); }

export function getChatHistory(ticker: string): ChatMessage[] { return backend.getChatHistory(ticker); }
// No ticker, no write, whatever the backend: ChatBot saves the previous ticker's chat on every ticker change,
// and the first one (market data arriving, from no ticker to the first) must reach neither storage nor the cloud.
export function setChatHistory(ticker: string | null | undefined, messages: ChatMessage[]): void {
  if (ticker) backend.setChatHistory(ticker, messages);
}
export function deleteChatHistory(ticker: string | null | undefined): void {
  if (ticker) backend.deleteChatHistory(ticker);
}

// A known name is typed by its value. Any string is still accepted with an unknown value (a name built at run
// time, a JS caller), so a known name with a value of another type also gets through that second form.
export function getPreference<K extends PrefName>(name: K): PreferenceValues[K] | null;
export function getPreference(name: string): unknown;
export function getPreference(name: string): unknown { return backend.getPreference(name); }
export function setPreference<K extends PrefName>(name: K, value: PreferenceValues[K] | null): void;
export function setPreference(name: string, value: unknown): void;
export function setPreference(name: string, value?: unknown): void { backend.setPreference(name, value); }

/**
 * Clear this browser's copy of the user data through the current backend (never the cloud copy).
 * @param opts see LocalStorageBackend#clearAll
 */
export function clearAll(opts?: { keepSecrets?: boolean }): void { backend.clearAll(opts); }

/**
 * Send the cloud writes still queued for the signed-in account (SupabaseBackend#flushPendingWrites),
 * waiting at most `opts.timeoutMs`. Resolves to how many are still waiting; 0 on a local-only backend.
 */
export async function flushPendingWrites(opts?: { timeoutMs?: number }): Promise<number> {
  return typeof backend.flushPendingWrites === 'function' ? backend.flushPendingWrites(opts) : 0;
}

export function exportAll(): Backup {
  return {
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    positions: backend.getAllPositions(),
    chatHistories: backend.getAllChatHistories(),
    preferences: backend.getAllPreferences(),
  };
}

/**
 * A parsed backup whose schema version is a number: exportAll()'s shape, but read from a file, so a section may be
 * missing (an older export) or malformed (a hand edit). importAll() checks a section before it reads it; the
 * sections are read-only so that those checks, kept in consts, still narrow them where they are read.
 */
interface ParsedBackup {
  version: number;
  readonly positions?: unknown;
  readonly chatHistories?: unknown;
  readonly preferences?: unknown;
}

/** importAll()'s schema version check, as a type guard: it makes the parsed file a ParsedBackup. */
function hasSchemaVersion(data: { version?: unknown }): data is ParsedBackup {
  return typeof data.version === 'number';
}

function migrate(data: ParsedBackup): ParsedBackup {
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
export function migrateSessionToLocal(): void {
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

/** Dispatch a plain CustomEvent on window (no-op without one). */
function emitWindowEvent(type: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(type));
}

/**
 * Whether `target` keeps a cloud copy it can replace (SupabaseBackend#replaceCloud). A type guard, so that the
 * check still holds inside the Promise executor below (a typeof check on the method itself would not reach it).
 */
function keepsCloudCopy(target: StoreBackend): target is StoreBackend & Required<Pick<StoreBackend, 'replaceCloud'>> {
  return typeof target?.replaceCloud === 'function';
}

/**
 * Ask `target` to make the cloud copy match `snapshot`, when it keeps one (SupabaseBackend#replaceCloud).
 * In the background: the import does not wait for the network, and a failure is only a warning (this browser
 * already holds the imported data).
 */
function replaceCloudCopy(target: StoreBackend, snapshot: StoreSnapshot): void {
  if (!keepsCloudCopy(target)) return;
  // Called inside the executor, so a synchronous throw ends up in .catch() like a rejection.
  new Promise((resolve) => { resolve(target.replaceCloud(snapshot)); })
    .catch((e) => console.warn('importAll: could not replace the cloud copy:', e?.message ?? e));
}

/**
 * Replace this browser's positions, chats and preferences with a backup made by exportAll().
 *
 * Why it works this way (roadmap D8). The import used to clear with clearAll(), which also removed the API
 * keys an export never contains, so restoring a backup wiped them; it wrote any preference name found in the
 * file (an unknown one became a raw localStorage key); it told only `store-changed` listeners, so the AI
 * settings and the data-source hooks kept their old values; and on a SupabaseBackend the cloud copy kept
 * everything the file did not have, which came back with the next hydrate. Now:
 *   - the file is checked before anything changes (a throw leaves this browser as it was), and the current
 *     data is backed up under `_import_backup` until the import is written;
 *   - positions, chats and preferences are cleared with the API keys kept, then the file's are written;
 *   - a preference is taken only under a known name (PREF_MAP) that is not a device key: API keys and
 *     per-browser flags in a file are never applied (exports never contain them, and a hand-edited file must
 *     not replace this device's keys); every other name is reported in `skipped`;
 *   - a backend with replaceCloud() is asked to make the cloud copy match what was imported (not awaited);
 *   - `store-changed` (no detail), `ai-settings-changed` and `data-source-changed` are dispatched, so every
 *     view, the AI settings and the market-data hooks re-read.
 * Asking the user first is the caller's job (AppSettings).
 *
 * @param data a parsed backup: { version, positions?, chatHistories?, preferences? }
 * @returns how many items were written, and the preference names in the file that were not imported (file
 *   order, once each)
 * @throws {Error} when `data` is not a backup this version can read; nothing has changed then
 */
export function importAll(data: unknown): ImportResult {
  if (!data || typeof data !== 'object') throw new Error('Invalid data format.');
  if (!hasSchemaVersion(data)) throw new Error('Missing schema version.');
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

  backend.clearAll({ keepSecrets: true });

  // What is written, as [key, value] entries: the counts and the cloud snapshot come from these. An item the
  // backend would not store (a position with neither field, an empty chat, a null preference) is left out.
  const positions: [string, Position][] = [];
  const chats: [string, ChatMessage[]][] = [];
  const prefs: [string, unknown][] = [];
  const skipped = new Set<string>();
  if (hasPositions) {
    for (const [ticker, pos] of Object.entries(migrated.positions)) {
      if (!ticker || pos == null || typeof pos !== 'object' || Array.isArray(pos)) continue;
      const value: Position = { costBasis: pos.costBasis ?? null, shares: pos.shares ?? null };
      if (value.costBasis == null && value.shares == null) continue;
      backend.setPosition(ticker, value);
      positions.push([ticker, value]);
    }
  }
  if (hasChats) {
    for (const [ticker, msgs] of Object.entries(migrated.chatHistories)) {
      if (!ticker || !Array.isArray(msgs) || msgs.length === 0) continue;
      backend.setChatHistory(ticker, msgs);
      chats.push([ticker, msgs]);
    }
  }
  if (hasPrefs) {
    for (const [name, value] of Object.entries(migrated.preferences)) {
      if (!Object.hasOwn(PREF_MAP, name) || DEVICE_KEYS.has(name)) {
        skipped.add(name);
        continue;
      }
      if (value == null) continue;
      backend.setPreference(name, value);
      prefs.push([name, value]);
    }
  }

  // Clean up backup after successful import
  try { localStorage.removeItem('_import_backup'); } catch { /* ignore */ }

  // Object.fromEntries defines own properties, so no ticker or name can reach a prototype.
  replaceCloudCopy(backend, {
    positions: Object.fromEntries(positions),
    chatHistories: Object.fromEntries(chats),
    preferences: Object.fromEntries(prefs),
  });

  emitStoreChanged();
  emitWindowEvent('ai-settings-changed'); // AppSettings and ChatBot re-read the provider and model
  emitWindowEvent('data-source-changed'); // App and the market-data, quote and research hooks re-read

  return {
    imported: { positions: positions.length, chats: chats.length, prefs: prefs.length },
    skipped: [...skipped],
  };
}

/**
 * Route every store call to `newBackend`. The backend it replaces is disposed (when it has a
 * dispose()): a SupabaseBackend swapped out by a sign-out or an account switch must not apply a
 * hydrate still in flight to what is now another account's (or nobody's) browser.
 */
export function setBackend(newBackend: StoreBackend): void {
  if (backend !== newBackend) backend?.dispose?.();
  backend = newBackend;
}
export { LocalStorageBackend, SECRET_KEYS, DEVICE_KEYS, LAYOUT_KEYS, PREF_NAMES };
