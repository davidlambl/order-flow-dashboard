// src/hooks/useStoreValue.ts
// Reading the store from a component: useSyncExternalStore over storeEvents.ts's one `store-changed` subscription,
// in place of a window listener plus setState in an effect. A primitive (or a stable reference) is read straight from
// the store; a value the store builds per call (a position, a chat history) goes through a scoped version counter, so
// its reference only changes when its own item, or the whole store, did.

import { useCallback, useState, useSyncExternalStore } from 'react';
import { getPreference } from '../lib/store.js';
import type { PrefName, PreferenceValues } from '../lib/store.js';
import { getStoreVersion, savePreference, subscribeStore } from '../lib/storeEvents.js';
import type { StoreKind } from '../lib/storeEvents.js';

/**
 * `read()` on every render and again on every `store-changed`; React re-renders only when the value differs
 * (Object.is), so `read` must return a primitive or a stable reference. A fresh object per call re-renders until React
 * throws ("Maximum update depth exceeded"): such a read goes through useStoreObject. A read over getPreference coerces
 * to a primitive itself, as usePreference does: an import or a cloud row can store any JSON under a known name.
 */
export function useStoreValue<T>(read: () => T): T {
  return useSyncExternalStore(subscribeStore, read);
}

/** The scoped store version (getStoreVersion) as a tracked snapshot: every event's, one kind's or one item's. */
export function useStoreVersion(kind?: StoreKind, id?: string): number {
  const getSnapshot = useCallback(() => getStoreVersion(kind, id), [kind, id]);
  return useSyncExternalStore(subscribeStore, getSnapshot);
}

/**
 * A value the store builds per call (getPosition, getChatHistory): re-read when its scoped version or `key` (what
 * `read` reads, e.g. the ticker) changes, the same reference in between. Scope it to the item it reads; a no-detail
 * event re-reads everything anyway. `read` runs once per change (twice under StrictMode's double render), and a
 * re-read costs two body invocations of the component by construction: the snapshot is adjusted during render
 * (React's "adjust state when a prop changes", as useTickerContext does), not memoised, because
 * `useMemo(read, [key, version])` is a react-hooks/use-memo error and the inline form warns about its unused
 * dependencies, and the lint baseline is zero warnings.
 */
export function useStoreObject<T>(read: () => T, key: string, kind?: StoreKind, id?: string): T {
  const version = useStoreVersion(kind, id);
  const [snap, setSnap] = useState(() => ({ version, key, value: read() }));
  if (snap.version !== version || snap.key !== key) {
    const next = { version, key, value: read() };
    setSnap(next);
    return next.value;
  }
  return snap.value;
}

/**
 * A preference as a component reads and writes it: `[value, write]`, `value` null while unset and `write(null)`
 * removing it. For PREF_MAP's primitives: a non-primitive stored value (a hand-edited import, a cloud row) counts as
 * unset, so a caller's `saved ?? default` applies; getPreference parses it to a fresh object per read, which would
 * loop useSyncExternalStore. The write is savePreference's, so every reader of the name follows it.
 */
export function usePreference<K extends PrefName>(
  name: K,
): [PreferenceValues[K] | null, (value: PreferenceValues[K] | null) => void];
export function usePreference(name: string): [unknown, (value: unknown) => void];
export function usePreference(name: string): [unknown, (value: unknown) => void] {
  // Memoised per name: a new getSnapshot each render costs React a passive effect to re-check it.
  const read = useCallback(() => {
    const v = getPreference(name);
    return v !== null && typeof v === 'object' ? null : v;
  }, [name]);
  const value = useStoreValue(read);
  const write = useCallback((v: unknown) => savePreference(name, v), [name]);
  return [value, write];
}
