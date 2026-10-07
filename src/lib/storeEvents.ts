// src/lib/storeEvents.ts
// The UI's side of the `store-changed` bus (the event contract is at the top of store.ts): one window listener for
// the page's life, attached by the first subscribeStore() and never detached, which counts every event and fans it
// out to the subscribers (the useSyncExternalStore hooks in src/hooks/useStoreValue.ts).
//
// The versions are scoped by the event's detail. A no-detail event (an import, a hydrate, a sign-out, another tab
// rewriting several items) moves every version; a detail moves its kind's and its item's, so a reader following one
// position never re-reads for a preference save. With one global counter every savePreference (a section toggle, a
// sidebar mouseup, each AppSettings autosave) re-rendered the whole App, which today does not render for any of them.
//
// Attaching the listener bumps the versions once. React subscribes in a passive effect and checks the snapshot right
// after; an event dispatched between a subscriber's first render and that subscribe (an effect declared before the
// store hooks that writes and emits) was not counted and left it stale, so the bump makes every first subscriber
// re-read once instead.
//
// setPreference() stays silent (the sync and import paths pin what they emit); a UI writer calls savePreference(),
// which always carries the item's detail: ChatBot treats a no-detail event as "everything changed" and aborts a
// streaming reply. Other tabs' writes arrive here too, through store.ts's subscribeCrossTab(). Node-loadable: the
// window is first touched by a subscriber, and without one nothing is attached and the versions stay 0.

import { STORE_CHANGED, emitStoreChanged, setPreference } from './store.js';
import type { PrefName, PreferenceValues, StoreChangeDetail } from './store.js';

/** The item kinds a `store-changed` detail names. */
export type StoreKind = StoreChangeDetail['kind'];
/** Called on every `store-changed` with its detail, or null when the whole store may have changed. */
export type StoreListener = (detail: StoreChangeDetail | null) => void;

const listeners = new Set<StoreListener>();
let attached = false;

// What getStoreVersion() reads: every event; the events without a detail; those with one, by kind and by item.
let total = 0;
let whole = 0;
const byKind: Record<StoreKind, number> = { position: 0, chat: 0, pref: 0 };
const byItem = new Map<string, number>();

const itemKey = (kind: StoreKind, id: string): string => `${kind}\n${id}`;

function onStoreChanged(event: Event): void {
  // A plain Event (a hand-dispatched one, CollapsibleSection's test) has no detail at all.
  const detail = (event as CustomEvent<StoreChangeDetail | null>).detail ?? null;
  total += 1;
  if (detail === null) {
    whole += 1;
  } else {
    // A kind outside the three (a JS caller's; TS rejects it) gets a counter of its own, as an item does.
    byKind[detail.kind] = (byKind[detail.kind] ?? 0) + 1;
    const key = itemKey(detail.kind, detail.id);
    byItem.set(key, (byItem.get(key) ?? 0) + 1);
  }
  // Over a copy: a listener may unsubscribe others, or itself, while this runs; one removed earlier in the same
  // dispatch does not run.
  for (const listener of [...listeners]) {
    if (listeners.has(listener)) listener(detail);
  }
}

/**
 * Follow `store-changed`: `listener` gets every event's detail (null for a whole-store change) until it unsubscribes.
 * The first call attaches the window listener, for good, and bumps every version; without a window nothing is
 * attached and the returned function does nothing.
 * @returns unsubscribe (idempotent)
 */
export function subscribeStore(listener: StoreListener): () => void {
  if (typeof window === 'undefined') return () => {};
  if (!attached) {
    attached = true;
    window.addEventListener(STORE_CHANGED, onStoreChanged);
    total += 1;
    whole += 1;
  }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * How many changes a reader has to follow: every event, one kind's (with the whole-store events), or one item's. A
 * useSyncExternalStore snapshot: the reader re-reads when its number moves. Always a number: a kind outside the three (a
 * JS caller's) reads like one without events instead of NaN, which would make a kind-scoped useStoreObject re-read
 * until React throws.
 */
export function getStoreVersion(kind?: StoreKind, id?: string): number {
  if (kind === undefined) return total;
  if (id === undefined) return whole + (byKind[kind] ?? 0);
  return whole + (byItem.get(itemKey(kind, id)) ?? 0);
}

/** Write a preference and tell its readers: setPreference plus `store-changed` with `{ kind: 'pref', id: name }`. */
export function savePreference<K extends PrefName>(name: K, value: PreferenceValues[K] | null): void;
/** Any string is a name too, as for setPreference. */
export function savePreference(name: string, value: unknown): void;
export function savePreference(name: string, value: unknown): void {
  setPreference(name, value);
  emitStoreChanged({ kind: 'pref', id: name });
}
