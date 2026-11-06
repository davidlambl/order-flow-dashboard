// src/hooks/useSupabaseAuth.ts
// The Supabase sign-in and the storage backend keyed on it (roadmap D1, D6, D11): the session state, the effect that
// builds one SupabaseBackend per account, the sync conflict SyncChoice settles and the one sign-out. App renders from
// `screen` (the spinner, LoginForm or the dashboard), keys the dashboard on `accountKey` and shows SyncChoice while
// `conflict` is set; AuthContext carries `signedIn`, `userEmail` and `signOut`.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase.js';
import { SupabaseBackend } from '../lib/SupabaseBackend.js';
import { clearAll, emitStoreChanged, LocalStorageBackend, migrateSessionToLocal, setBackend } from '../lib/store.js';
import {
  claimLocalData, isAuthSkipped, LOCAL_OWNER_KEY, setAuthSkipped as persistAuthSkipped, signOut as endSession,
} from '../lib/session.js';

/** hydrate()'s report, as SupabaseBackend types it. */
type HydrateReport = Awaited<ReturnType<SupabaseBackend['hydrate']>>;

/** SyncChoice's three answers, as resolveConflict() takes them. */
export type SyncChoiceId = Parameters<SupabaseBackend['resolveConflict']>[0];

/** hydrate()'s 'conflict' report: it compared both sides, so both counts are there for SyncChoice to show. */
export type ConflictReport = HydrateReport & {
  status: 'conflict';
  cloud: NonNullable<HydrateReport['cloud']>;
  local: NonNullable<HydrateReport['local']>;
};

const isConflict = (report: HydrateReport): report is ConflictReport => report?.status === 'conflict';

const AUTH_CHECK_FAILED = 'Could not check your sign-in status. You can retry or continue without signing in.';

/** The account this browser's data belongs to, as session.js marks it; null when it is nobody's (or unreadable). */
function readLocalOwner(): string | null {
  try {
    return localStorage.getItem(LOCAL_OWNER_KEY);
  } catch {
    return null;
  }
}

/** What App shows: the spinner while the session is checked, the sign-in screen (LoginForm), or the dashboard. */
export type AuthScreen = 'checking' | 'sign-in' | 'app';

export interface SupabaseAuthOptions {
  /** Writes an edit still inside its debounce (the position draft's flush). Must keep one identity. */
  flushPendingEdits: () => void;
  /** The Supabase client: the app's own (null when cloud sign-in is not configured) unless a test injects one. */
  client?: SupabaseClient | null;
}

/** What useSupabaseAuth returns. */
export interface SupabaseAuth {
  screen: AuthScreen;
  /** For the sign-in screen: the session could not be checked. Null otherwise. */
  notice: string | null;
  /** The signed-in account's id, 'local' without one: what App keys the dashboard on. */
  accountKey: string;
  signedIn: boolean;
  /** The signed-in account's e-mail; undefined without a session. */
  userEmail: string | undefined;
  /** A Supabase client exists, so there is a cloud account to sign in to. */
  configured: boolean;
  /** "Continue without signing in", remembered on this browser. Stable. */
  skipSignIn: () => void;
  /** The Account tab's "Sign in": back to the sign-in screen, which can still be skipped. Stable. */
  showSignIn: () => void;
  /** The one sign-out, for the Header's icon and the Account tab's button. Stable while flushPendingEdits and client are. */
  signOut: () => Promise<void>;
  /** The signed-in account's sync conflict, for SyncChoice; null when there is none to settle. */
  conflict: ConflictReport | null;
  /** A choice is being applied. */
  syncBusy: boolean;
  /** Applies SyncChoice's answer through the account's backend and closes the prompt, failed or not. Stable. */
  resolveConflict: (choice: SyncChoiceId) => Promise<void>;
}

/**
 * The session, the screen it decides, and the store's backend keyed on the signed-in account.
 *
 * - The backend switch is a passive effect of App's fiber. In the commit that changes the account, React runs the
 *   passive cleanups of the subtree the account key removes before this effect, so their unmount saves (a reply still
 *   streaming, an autosave) go through the backend of the account they were made in. A layout effect, a backend picked
 *   during render or a flushSync would send them through the next account's.
 * - `flushPendingEdits` and `client` must keep one identity. The backend effect depends on both, so a new one re-runs
 *   it on every render (a run for the same account builds nothing, but repeats the sessionStorage migration), and it
 *   gives `signOut`, and with it AuthContext's value, a new identity.
 * - No effect sets state in its own body: only the session check's promise, the auth subscription and the hydrate
 *   report do. The lint does not catch a set-state call placed after the backend effect's guarded return.
 */
export function useSupabaseAuth({ flushPendingEdits, client = supabase }: SupabaseAuthOptions): SupabaseAuth {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(Boolean(client)); // only loading if Supabase is configured
  // "Continue without signing in" is remembered on this browser (session.js), so a reload goes straight to the app; a
  // sign-in, the Account tab's "Sign in" button and a sign-out clear it (D11).
  const [skipped, setSkipped] = useState(() => isAuthSkipped());
  const [notice, setNotice] = useState<string | null>(null); // on the sign-in screen: the session check failed
  // The conflict SyncChoice settles, with the account whose hydrate found it. Declared before the session effect, whose
  // auth subscription drops it.
  const [syncConflict, setSyncConflict] = useState<{ userId: string; report: ConflictReport } | null>(null);

  // Check for an existing session and follow the auth events (a magic link's callback, a refresh, a sign-out). A failed
  // check must not leave the spinner up: the sign-in screen shows with a notice and the skip button (F10).
  useEffect(() => {
    if (!client) return;
    client.auth.getSession()
      .then(({ data, error }) => {
        const next = data?.session ?? null;
        // A network failure while refreshing an expired session resolves with this error and no session; the stored
        // session is kept, and a later refresh signs the user back in.
        if (!next && error?.name === 'AuthRetryableFetchError') {
          console.warn('Could not check the sign-in status:', error.message);
          setNotice(AUTH_CHECK_FAILED);
        }
        setSession(next);
        setLoading(false);
      })
      .catch((err) => {
        console.warn('Could not check the sign-in status:', err?.message ?? err);
        setNotice(AUTH_CHECK_FAILED);
        setLoading(false);
      });
    // Every event's session is applied, whatever the event: TOKEN_REFRESHED is what signs the user back in after a
    // failed check, and INITIAL_SESSION what clears a skip at load.
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      // A conflict is what one hydrate found for its account. Once the session has left that account (another tab's
      // sign-out, another account's sign-in), the report is stale and the backend that compared it is gone: should the
      // account sign back in here, its next hydrate decides afresh, and the old report must not come back with it.
      setSyncConflict((conflict) => (conflict && conflict.userId !== next?.user?.id ? null : conflict));
      if (next) {
        setNotice(null);
        // In step with the stored flag (the backend effect clears it): should this session end elsewhere, the sign-in
        // screen shows rather than the app in local mode.
        setSkipped(false);
      }
    });
    return () => subscription.unsubscribe();
  }, [client]);

  // ── The storage backend, keyed on the signed-in account ──────────────────
  // One SupabaseBackend per account, built when the account changes (StrictMode's second effect run finds the same
  // account and builds nothing); a plain LocalStorageBackend when signed out. Data here that belongs to another account
  // is cleared before the new account's backend exists, and hydrate() never merges on its own: a conflict waits for the
  // user's choice in SyncChoice (roadmap D1, D6).
  const activeUserIdRef = useRef<string | undefined>(undefined);
  const backendRef = useRef<SupabaseBackend | null>(null);
  const stopHydrateRetryRef = useRef<(() => void) | null>(null); // removes the 'online' listener of a hydrate retry
  const [syncBusy, setSyncBusy] = useState(false);
  useEffect(() => {
    migrateSessionToLocal();
    const userId = session?.user?.id;
    if (activeUserIdRef.current === userId) return;
    // An edit still inside its debounce was typed against the backend in use: it is written through that backend,
    // never the next account's. At an account switch claimLocalData below then clears it, with that account's queued
    // writes, before it is sent: the client already holds the new session, so the old account's write would be refused
    // (RLS). When the session is revoked elsewhere, it waits in that account's queue until the account next signs in
    // here; after a sign-out, here or in another tab, the branch below clears it again.
    flushPendingEdits();
    stopHydrateRetryRef.current?.(); // a retry still waiting for the previous account
    stopHydrateRetryRef.current = null;
    const previous = activeUserIdRef.current;
    activeUserIdRef.current = userId;
    if (!client || !userId) {
      backendRef.current = null;
      // A sign-out removes this browser's copy and the mark of whose it is. When this tab finds the mark gone as the
      // session ends, whatever it wrote since that clear (the edit flushed above or at the sign-out's store-changed, the
      // unmount saves of the dashboard the session's end removed, the account's cloud copy pulled by a hydrate that was
      // still reading) belongs to nobody, and the next account to sign in here would take it as this browser's: it is
      // cleared again, through the backend still in use, so the account's queued writes and sync dates that backend
      // re-created go with it, and the store's readers re-read (the draft drops an edit it still shows).
      // A session revoked elsewhere leaves the mark in place; a skip means the browser has been in use without an
      // account since a sign-out this tab hears of late. Either way the data is someone's, and stays.
      // KNOWN GAP: this covers a sign-out in THIS tab. Another tab's sign-out reaches a real browser's other tabs as
      // SIGNED_OUT before their view of the storage shows that tab's clear, so the mark still reads as set here, the
      // end looks like a revoke and nothing is cleared (App.signout.test.jsx pins it).
      const unowned = Boolean(previous) && readLocalOwner() === null && !isAuthSkipped();
      if (unowned) clearAll();
      setBackend(new LocalStorageBackend());
      if (unowned) emitStoreChanged();
      return;
    }
    persistAuthSkipped(false); // signed in: after a sign-out the sign-in screen shows again
    // The account changed without a sign-out (a magic link for another user opened in this browser), or this browser
    // still holds the data of an account whose session ended elsewhere: that data must never reach this account, so it
    // is cleared (API keys kept) before this account's backend exists.
    const cleared = claimLocalData(userId, { previousUserId: previous });
    const backend = new SupabaseBackend(new LocalStorageBackend(), userId, client);
    setBackend(backend);
    backendRef.current = backend;
    if (cleared) emitStoreChanged();
    // 'offline': the account could not be read and nothing was synced. hydrate() runs once more when the browser is
    // next online, and that report is handled the same way.
    const handleReport = (report: HydrateReport, retryWhenOnline: boolean): void => {
      if (activeUserIdRef.current !== userId) return; // signed out or switched while hydrating
      if (isConflict(report)) {
        setSyncConflict({ userId, report });
      } else if (report?.status === 'offline' && retryWhenOnline) {
        const retry = () => {
          window.removeEventListener('online', retry);
          stopHydrateRetryRef.current = null;
          backend.hydrate().then((next) => handleReport(next, false));
        };
        window.addEventListener('online', retry);
        stopHydrateRetryRef.current = () => window.removeEventListener('online', retry);
      }
    };
    backend.hydrate().then((report) => handleReport(report, true));
  }, [session, flushPendingEdits, client]);

  // Unmounting drops a hydrate retry still waiting for the network.
  useEffect(() => () => stopHydrateRetryRef.current?.(), []);

  const resolveConflict = useCallback(async (choice: SyncChoiceId) => {
    setSyncBusy(true);
    try {
      await backendRef.current?.resolveConflict(choice);
    } catch (err) {
      const message = typeof err === 'object' && err !== null && 'message' in err ? err.message : err;
      console.warn('Sync: could not apply the choice:', message);
    }
    setSyncBusy(false);
    setSyncConflict(null);
  }, []);

  // One sign-out for both logins: the Supabase session, the access token and this browser's copy of the data. The
  // Header's icon and the Account tab's button both call it. An edit still inside its debounce is saved first, while
  // the account's backend is still the one in use.
  const signOut = useCallback(async () => {
    flushPendingEdits();
    const { signedOut } = await endSession({ client });
    if (!signedOut) return;
    setSyncConflict(null);
    setSession(null);
    setSkipped(false);
  }, [flushPendingEdits, client]);

  // "Continue without signing in", remembered on this browser.
  const skipSignIn = useCallback(() => {
    persistAuthSkipped(true);
    setSkipped(true);
  }, []);

  // The Account tab's "Sign in": back to the sign-in screen (which can still be skipped). App closes Settings in the
  // same handler, so both land in one render.
  const showSignIn = useCallback(() => {
    persistAuthSkipped(false);
    setNotice(null);
    setSkipped(false);
  }, []);

  // The spinner while the session is checked; the sign-in screen while cloud sign-in exists and nobody is signed in or
  // has skipped it; the dashboard otherwise.
  const screen: AuthScreen = loading ? 'checking' : client && !session && !skipped ? 'sign-in' : 'app';
  return {
    screen,
    notice,
    accountKey: session?.user?.id ?? 'local',
    // Primitives, for AuthContext's memo: a refreshed session is a new object for the same account.
    signedIn: Boolean(session),
    userEmail: session?.user?.email,
    configured: Boolean(client),
    skipSignIn,
    showSignIn,
    signOut,
    // Sign-in found different data here and in the account: nothing syncs until the user picks. Only the signed-in
    // account's conflict is shown.
    conflict: syncConflict && syncConflict.userId === session?.user?.id ? syncConflict.report : null,
    syncBusy,
    resolveConflict,
  };
}
