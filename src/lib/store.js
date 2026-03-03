// src/lib/store.js
// Storage abstraction layer for all persistent user data.
// Backed by localStorage today; swap backend for Supabase (or other) via setBackend().

const SCHEMA_VERSION = 1;

const POSITION_PREFIX = 'position_';
const CHAT_PREFIX = 'chat_history_';

const PREF_MAP = {
  sidebarWidth: 'chat_sidebar_w',
  section_position: 'section_position',
  section_research: 'section_research',
  section_charts: 'section_charts',
  strategic_context: 'strategic_context',
};

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
      localStorage.setItem(POSITION_PREFIX + ticker, JSON.stringify({ costBasis, shares }));
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
    try {
      if (messages?.length) {
        localStorage.setItem(CHAT_PREFIX + ticker, JSON.stringify(messages));
      } else {
        this.deleteChatHistory(ticker);
      }
    } catch { /* quota exceeded */ }
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
      localStorage.setItem(key, JSON.stringify(value));
    } else {
      localStorage.removeItem(key);
    }
  }

  getAllPreferences() {
    const result = {};
    for (const name of Object.keys(PREF_MAP)) {
      const val = this.getPreference(name);
      if (val != null) result[name] = val;
    }
    return result;
  }

  clearAll() {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith(POSITION_PREFIX) || key.startsWith(CHAT_PREFIX)) {
        toRemove.push(key);
      }
    }
    for (const key of Object.values(PREF_MAP)) toRemove.push(key);
    toRemove.forEach((k) => localStorage.removeItem(k));
  }
}

let backend = new LocalStorageBackend();

export function getPosition(ticker) { return backend.getPosition(ticker); }
export function setPosition(ticker, data) { backend.setPosition(ticker, data); }
export function deletePosition(ticker) { backend.deletePosition(ticker); }

export function getChatHistory(ticker) { return backend.getChatHistory(ticker); }
export function setChatHistory(ticker, messages) { backend.setChatHistory(ticker, messages); }
export function deleteChatHistory(ticker) { backend.deleteChatHistory(ticker); }

export function getPreference(key) { return backend.getPreference(key); }
export function setPreference(key, value) { backend.setPreference(key, value); }

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
  // Future schema migrations:
  // if (data.version < 2) { ... data.version = 2; }
  return data;
}

export function importAll(data) {
  if (!data || typeof data !== 'object') throw new Error('Invalid data format.');
  if (typeof data.version !== 'number') throw new Error('Missing schema version.');
  if (data.version > SCHEMA_VERSION) {
    throw new Error(`Unsupported schema v${data.version} — update the app first.`);
  }

  const migrated = migrate(data);

  // Validate importable sections before clearing to avoid data loss on malformed input
  const hasPositions = migrated.positions && typeof migrated.positions === 'object';
  const hasChats = migrated.chatHistories && typeof migrated.chatHistories === 'object';
  const hasPrefs = migrated.preferences && typeof migrated.preferences === 'object';
  if (!hasPositions && !hasChats && !hasPrefs) {
    throw new Error('Import data contains no valid sections.');
  }

  backend.clearAll();

  if (hasPositions) {
    for (const [ticker, pos] of Object.entries(migrated.positions)) {
      backend.setPosition(ticker, pos);
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

  window.dispatchEvent(new CustomEvent('store-changed'));
}

export function setBackend(newBackend) { backend = newBackend; }
