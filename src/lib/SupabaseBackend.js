// src/lib/SupabaseBackend.js
// Offline-first backend: localStorage for reads, Supabase for durable sync.
// Wraps LocalStorageBackend with write-through async sync to Supabase.
// Secret keys (API keys) are NEVER sent to Supabase.
// NOTE: No user scoping — this is a single-user/small-team tool.

import { supabase } from './supabase';
import { SECRET_KEYS } from './store';

export class SupabaseBackend {
  constructor(localBackend) {
    this.local = localBackend;
    this._syncQueue = [];
    this._flushing = false;
  }

  // ── Positions ──────────────────────────────────────────────────────────────

  getPosition(ticker) {
    return this.local.getPosition(ticker);
  }

  setPosition(ticker, data) {
    this.local.setPosition(ticker, data);
    if (data.costBasis != null || data.shares != null) {
      this._enqueue(() =>
        supabase.from('positions').upsert(
          { ticker, cost_basis: data.costBasis, shares: data.shares, updated_at: new Date().toISOString() },
          { onConflict: 'ticker' }
        )
      );
    } else {
      this._enqueue(() => supabase.from('positions').delete().eq('ticker', ticker));
    }
  }

  deletePosition(ticker) {
    this.local.deletePosition(ticker);
    this._enqueue(() => supabase.from('positions').delete().eq('ticker', ticker));
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
        ? supabase.from('preferences').upsert(
            { key: name, value, updated_at: new Date().toISOString() },
            { onConflict: 'key' }
          )
        : supabase.from('preferences').delete().eq('key', name)
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
        ? supabase.from('chat_histories').upsert(
            { ticker, messages, updated_at: new Date().toISOString() },
            { onConflict: 'ticker' }
          )
        : supabase.from('chat_histories').delete().eq('ticker', ticker)
    );
  }

  deleteChatHistory(ticker) {
    this.local.deleteChatHistory(ticker);
    this._enqueue(() => supabase.from('chat_histories').delete().eq('ticker', ticker));
  }

  getAllChatHistories() {
    return this.local.getAllChatHistories();
  }

  // ── Clear ──────────────────────────────────────────────────────────────────

  clearAll() {
    this.local.clearAll();
    // Don't clear Supabase — that's a destructive cloud operation
    // that should require explicit user action.
  }

  // ── Background Sync Queue ──────────────────────────────────────────────────

  _enqueue(fn) {
    if (!supabase) return;
    this._syncQueue.push(fn);
    this._flush();
  }

  async _flush() {
    if (this._flushing) return;
    this._flushing = true;
    while (this._syncQueue.length > 0) {
      const op = this._syncQueue.shift();
      try {
        const { error } = await op();
        if (error) console.warn('Supabase sync error:', error.message);
      } catch (err) {
        console.warn('Supabase sync failed:', err.message);
      }
    }
    this._flushing = false;
  }

  // ── Initial Hydration ──────────────────────────────────────────────────────
  // Pull from Supabase into localStorage for keys missing locally (local wins).

  async hydrate() {
    if (!supabase) return;

    try {
      const { data: positions } = await supabase.from('positions').select('*');
      if (positions) {
        for (const row of positions) {
          const existing = this.local.getPosition(row.ticker);
          if (existing.costBasis == null && existing.shares == null) {
            this.local.setPosition(row.ticker, {
              costBasis: row.cost_basis,
              shares: row.shares,
            });
          }
        }
      }

      const { data: prefs } = await supabase.from('preferences').select('*');
      if (prefs) {
        for (const row of prefs) {
          if (SECRET_KEYS.has(row.key)) continue;
          const existing = this.local.getPreference(row.key);
          if (existing == null) {
            this.local.setPreference(row.key, row.value);
          }
        }
      }

      const { data: chats } = await supabase.from('chat_histories').select('*');
      if (chats) {
        for (const row of chats) {
          const existing = this.local.getChatHistory(row.ticker);
          if (!existing || existing.length === 0) {
            const msgs = typeof row.messages === 'string' ? JSON.parse(row.messages) : row.messages;
            if (Array.isArray(msgs)) this.local.setChatHistory(row.ticker, msgs);
          }
        }
      }

      window.dispatchEvent(new CustomEvent('store-changed'));
    } catch (err) {
      console.warn('Supabase hydration failed (non-fatal):', err.message);
    }

    // After pulling cloud data, push any local data that's missing from Supabase.
    // This ensures pre-existing localStorage data gets synced on first run.
    this._pushLocal();
  }

  async _pushLocal() {
    if (!supabase) return;

    try {
      // Push positions
      const positions = this.local.getAllPositions();
      const posRows = Object.entries(positions)
        .filter(([, p]) => p.costBasis != null || p.shares != null)
        .map(([ticker, p]) => ({ ticker, cost_basis: p.costBasis, shares: p.shares, updated_at: new Date().toISOString() }));
      if (posRows.length > 0) {
        const { error } = await supabase.from('positions').upsert(posRows, { onConflict: 'ticker', ignoreDuplicates: true });
        if (error) console.warn('Push positions error:', error.message);
      }

      // Push non-secret preferences
      const prefs = this.local.getAllPreferences();
      const prefRows = Object.entries(prefs)
        .filter(([key]) => !SECRET_KEYS.has(key))
        .map(([key, value]) => ({ key, value, updated_at: new Date().toISOString() }));
      if (prefRows.length > 0) {
        const { error } = await supabase.from('preferences').upsert(prefRows, { onConflict: 'key', ignoreDuplicates: true });
        if (error) console.warn('Push preferences error:', error.message);
      }

      // Push chat histories
      const chats = this.local.getAllChatHistories();
      const chatRows = Object.entries(chats)
        .filter(([, msgs]) => msgs?.length > 0)
        .map(([ticker, msgs]) => ({ ticker, messages: msgs, updated_at: new Date().toISOString() }));
      if (chatRows.length > 0) {
        const { error } = await supabase.from('chat_histories').upsert(chatRows, { onConflict: 'ticker', ignoreDuplicates: true });
        if (error) console.warn('Push chat_histories error:', error.message);
      }
    } catch (err) {
      console.warn('Push local data failed (non-fatal):', err.message);
    }
  }
}
