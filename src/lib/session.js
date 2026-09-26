// src/lib/session.js
// Whose data this browser holds, and signing out of it.
//
// The app has two logins (roadmap D11): the Supabase account that syncs positions, chats and settings,
// and the premium access token (a JWT in localStorage). Both belong to the person at this browser, so one
// sign-out ends both and removes this browser's copy of everything, API keys included (D1). Before this,
// sign-out only swapped the storage backend: the data, the keys and the token stayed, and the next account
// to sign in here had them uploaded into it. The account's cloud copy is kept; signing in again pulls it.
//
// A session can also end without this sign-out (signed out on another device, which revokes every
// session; an expired refresh token), and the next person may then sign in with another account. So the
// account whose data this browser holds is recorded (LOCAL_OWNER_KEY), and claimLocalData() clears data
// that belongs to a different account before that account's backend is built.
//
// Node-loadable (src/lib/sync.node.test.js drives it with a fake client): no top-level browser access.
import { supabase } from './supabase.js';
import { clearAll, emitStoreChanged, flushPendingWrites, setBackend, LocalStorageBackend } from './store.js';
import { clearToken } from './auth.js';

export const SIGN_OUT_CONFIRM = "Sign out and remove this browser's copy of your data? Positions, chats, settings, API keys and the access token on this device are removed; your account's cloud copy is kept.";

/** How long a sign-out waits for writes still queued for the account to be sent. */
const SIGN_OUT_FLUSH_MS = 5000;

/** localStorage key: the id of the account whose data this browser holds (absent: nobody's). */
export const LOCAL_OWNER_KEY = 'local_data_owner';

/**
 * localStorage key: the user chose "Continue without signing in" on this browser, so the sign-in
 * screen stays out of the way on reload (roadmap D11). A device flag like the owner mark, never a
 * synced preference (it is in DEVICE_KEYS as a guard); a sign-in, the Account tab's "Sign in"
 * button and signOut() clear it.
 */
export const AUTH_SKIPPED_KEY = 'auth_skipped';

export function isAuthSkipped() {
  try {
    return localStorage.getItem(AUTH_SKIPPED_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAuthSkipped(skipped) {
  try {
    if (skipped) localStorage.setItem(AUTH_SKIPPED_KEY, '1');
    else localStorage.removeItem(AUTH_SKIPPED_KEY);
  } catch { /* storage unavailable: the choice lasts for this page load only */ }
}

function readOwner() {
  try {
    return localStorage.getItem(LOCAL_OWNER_KEY);
  } catch {
    return null;
  }
}

function writeOwner(userId) {
  try {
    if (userId) localStorage.setItem(LOCAL_OWNER_KEY, userId);
    else localStorage.removeItem(LOCAL_OWNER_KEY);
  } catch { /* storage unavailable: nothing to protect either */ }
}

/**
 * Call when `userId` becomes the signed-in account, before its backend is built. When this browser's
 * data belongs to a different account (the one this tab had signed in, `previousUserId`, or the one
 * recorded by the last sign-in here) it is cleared, API keys kept, so none of it can reach this account.
 * Data with no owner (used without signing in, or after a sign-out here) is kept: hydrate treats it as
 * this browser's copy. Records `userId` as the owner.
 * @param {string} userId
 * @param {{ previousUserId?: string }} [opts]
 * @returns {boolean} true when the data was cleared
 */
export function claimLocalData(userId, { previousUserId } = {}) {
  const owner = readOwner();
  const foreign = [previousUserId, owner].some((id) => id && id !== userId);
  if (foreign) {
    console.warn('Signed-in account changed: removing the previous account\'s data from this browser (API keys kept).');
    clearAll({ keepSecrets: true });
  }
  writeOwner(userId);
  return foreign;
}

/**
 * Sign out of Supabase and remove this browser's copy of the user's data after the user confirms.
 * A failed Supabase sign-out still clears this browser: the session may come back on reload, which
 * then pulls the cloud copy (safe).
 * @param {object} [opts]
 * @param {object|null} [opts.client] Supabase client (null: no cloud account, only clear)
 * @param {(message: string) => boolean} [opts.confirm]
 * @returns {Promise<{ signedOut: boolean, error: Error|null }>}
 */
export async function signOut({ client = supabase, confirm = (message) => globalThis.confirm(message) } = {}) {
  if (!confirm(SIGN_OUT_CONFIRM)) return { signedOut: false, error: null };

  // Writes still queued for the account (made offline, or a moment ago) go out first, so its copy really
  // is kept. A network that is down or a request that hangs holds the sign-out for at most a few seconds;
  // whatever could not be sent is dropped with the rest of this browser's copy below.
  let unsent = 0;
  try {
    unsent = await flushPendingWrites({ timeoutMs: SIGN_OUT_FLUSH_MS });
  } catch { /* best effort */ }
  if (unsent > 0) console.warn(`Sign-out: ${unsent} change(s) could not be sent to the account and were dropped.`);

  let error = null;
  if (client) {
    try {
      const result = await client.auth.signOut();
      if (result?.error) error = result.error;
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
    }
    if (error) console.warn('Supabase sign-out failed; clearing this browser anyway:', error.message ?? error);
  }

  try {
    clearAll(); // positions, chats and every preference, API keys included
  } catch (err) {
    console.warn('Sign-out: could not clear local data:', err?.message ?? err);
  }
  clearToken();
  try { localStorage.removeItem('_import_backup'); } catch { /* storage unavailable */ }
  writeOwner(null);
  setAuthSkipped(false); // the sign-in screen comes back after a sign-out
  setBackend(new LocalStorageBackend());
  emitStoreChanged();
  return { signedOut: true, error };
}
