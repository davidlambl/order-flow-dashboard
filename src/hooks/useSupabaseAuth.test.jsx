// src/hooks/useSupabaseAuth.test.jsx — the Supabase sign-in and the account-keyed backend as App uses them: the
// screen in every state (the check, the sign-in screen with and without its notice, a skip, a session), one backend
// per account under StrictMode, a new session of the same account building nothing, an account switch, hydrate's three
// outcomes and SyncChoice's choices, the 'online' retry and where it is dropped, the sign-out, and the identities App's
// memos depend on. The fake client (test/helpers/fakeSupabase.js, timed like supabase-js) is created once outside the
// render callback and injected; nothing mocks the client module, whose client is null under Vitest, so a path that
// drops the injected client shows. The real SupabaseBackend runs over jsdom's localStorage. The store's backend is
// module state, so each test ends by putting a LocalStorageBackend back while the hook is still mounted (this file's
// afterEach runs before setup.js's cleanup); the next test would otherwise write through this one's backend and
// client. Real timers: the fake answers in microtasks, and settle() lets them land inside act.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { AuthRetryableFetchError } from '@supabase/supabase-js';
import { fakeSupabase, sessionFor } from '../../test/helpers/fakeSupabase.js';
import { SupabaseBackend } from '../lib/SupabaseBackend.js';
import {
  getPosition, getPreference, LocalStorageBackend, setBackend, setPosition, setPreference,
} from '../lib/store.js';
import { supabase } from '../lib/supabase.js';
import { useSupabaseAuth } from './useSupabaseAuth.js';

const A = 'user-a';
const B = 'user-b';
const AUTH_CHECK_FAILED = 'Could not check your sign-in status. You can retry or continue without signing in.';
const CHECK_WARNING = 'Could not check the sign-in status:';
const SWITCH_WARNING =
  "Signed-in account changed: removing the previous account's data from this browser (API keys kept).";
const EMPTY = { costBasis: null, shares: null };
const READ_FAILED = { message: 'TypeError: Failed to fetch', code: '' };

/** A positions row as the account holds it. */
const posRow = (userId, ticker, costBasis, shares) => ({
  user_id: userId, ticker, cost_basis: costBasis, shares, updated_at: '2026-09-20T00:00:00.000Z', deleted_at: null,
});

/** The hook as App calls it, under StrictMode as main.jsx renders App; the flush is a prop that a rerender can swap. */
const hook = (client, flushPendingEdits = vi.fn()) => renderHook(
  ({ flush }) => useSupabaseAuth({ flushPendingEdits: flush, client }),
  { initialProps: { flush: flushPendingEdits }, wrapper: StrictMode },
);

/** Lets the fake's answers, a hydrate and the outbox's sends land, inside act. */
const settle = () => act(async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
});

/** An auth event from elsewhere (another tab's sign-in or sign-out, a token refresh, a focus), then settle. */
async function emit(client, event, session = null) {
  act(() => { client.emitAuth(event, session); });
  await settle();
}

/** The browser coming back online, then settle. */
const online = async () => {
  await act(async () => { window.dispatchEvent(new Event('online')); });
  await settle();
};

/** Reads of one account's tables: a hydrate reads three. */
const readsFor = (client, userId) => client.reads
  .filter((read) => read.filters.some(([column, value]) => column === 'user_id' && value === userId)).length;

/** The positions upserted, as [user, ticker, cost basis, shares] (a tombstone's are null). */
const positionUpserts = (client) => client.upserts.filter((u) => u.table === 'positions')
  .map((u) => [u.rows[0].user_id, u.rows[0].ticker, u.rows[0].cost_basis, u.rows[0].shares]);

/** Runs of the backend effect: each starts with the sessionStorage migration, whose first read is 'ai_provider'. */
const effectRuns = (getItem) => getItem.mock.calls
  .filter((call, i) => getItem.mock.contexts[i] === window.sessionStorage && call[0] === 'ai_provider').length;

/** This browser holds AVGO 100×10, A's account AVGO 120×10 (and `more`): A's hydrate reports a conflict. */
function conflictFor(more = [], options = {}) {
  localStorage.setItem('position_AVGO', JSON.stringify({ costBasis: 100, shares: 10 }));
  return fakeSupabase({
    session: sessionFor(A), tables: { positions: [posRow(A, 'AVGO', 120, 10), ...more] }, ...options,
  });
}

describe('useSupabaseAuth', () => {
  let warn;
  let error;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error');
  });

  afterEach(() => {
    setBackend(new LocalStorageBackend());
    vi.useRealTimers();
    expect(error).not.toHaveBeenCalled(); // no React warning either, such as an update outside act
  });

  describe('the screen', () => {
    it.each([
      ['no client', null],
      ['the client left out (the module client, null under Vitest)', undefined],
    ])('with %s: the dashboard at once, signed out, with nothing to sign in to', (_label, client) => {
      expect(supabase).toBeNull();
      const { result } = hook(client);
      expect(result.current).toMatchObject({
        screen: 'app', notice: null, accountKey: 'local', signedIn: false, userEmail: undefined, configured: false,
        conflict: null, syncBusy: false,
      });
    });

    it('checks for a session first, then shows the sign-in screen when there is none', async () => {
      const client = fakeSupabase();
      const { result } = hook(client);
      expect(result.current).toMatchObject({ screen: 'checking', configured: true, signedIn: false });

      await settle();
      expect(result.current).toMatchObject({
        screen: 'sign-in', notice: null, accountKey: 'local', signedIn: false, userEmail: undefined, configured: true,
      });
    });

    it('shows the dashboard for a session, signed in as its account', async () => {
      const { result } = hook(fakeSupabase({ session: sessionFor(A) }));
      await settle();
      expect(result.current).toMatchObject({
        screen: 'app', notice: null, accountKey: A, signedIn: true, userEmail: 'user-a@example.com', configured: true,
      });
    });

    it('remembers a skip on this browser, and showSignIn brings the sign-in screen back', async () => {
      const client = fakeSupabase();
      const first = hook(client);
      await settle();
      act(() => first.result.current.skipSignIn());
      expect(first.result.current.screen).toBe('app');
      expect(localStorage.getItem('auth_skipped')).toBe('1');
      first.unmount();

      const reload = hook(client);
      await settle();
      expect(reload.result.current).toMatchObject({ screen: 'app', signedIn: false });
      act(() => reload.result.current.showSignIn());
      expect(reload.result.current.screen).toBe('sign-in');
      expect(localStorage.getItem('auth_skipped')).toBeNull();
    });

    it.each([
      [
        'a refresh that failed at the network',
        { sessionError: new AuthRetryableFetchError('Failed to fetch', 0) },
        'Failed to fetch',
      ],
      ['a check that throws', { sessionReject: new Error('storage blocked') }, 'storage blocked'],
    ])('after %s: the sign-in screen with the notice, until a session arrives', async (_label, options, message) => {
      const client = fakeSupabase(options);
      const { result } = hook(client);
      await settle();
      expect(result.current).toMatchObject({ screen: 'sign-in', notice: AUTH_CHECK_FAILED, signedIn: false });
      expect(warn).toHaveBeenCalledWith(CHECK_WARNING, message);
      expect(warn.mock.calls.every(([first]) => first === CHECK_WARNING)).toBe(true);

      // supabase-js keeps the stored session and refreshes it later: the event's session signs the user back in.
      await emit(client, 'TOKEN_REFRESHED', sessionFor(A));
      expect(result.current).toMatchObject({ screen: 'app', notice: null, accountKey: A, signedIn: true });
    });

    it('shows no notice when the check fails for another reason than the network', async () => {
      const sessionError = { name: 'AuthApiError', message: 'Invalid Refresh Token', status: 400 };
      const { result } = hook(fakeSupabase({ sessionError }));
      await settle();
      expect(result.current).toMatchObject({ screen: 'sign-in', notice: null });
      expect(warn).not.toHaveBeenCalled();
    });

    it('showSignIn clears the notice of a failed check that was skipped', async () => {
      const { result } = hook(fakeSupabase({ sessionError: new AuthRetryableFetchError('Failed to fetch', 0) }));
      await settle();
      act(() => result.current.skipSignIn());
      expect(result.current.screen).toBe('app');

      act(() => result.current.showSignIn());
      expect(result.current).toMatchObject({ screen: 'sign-in', notice: null });
      expect(localStorage.getItem('auth_skipped')).toBeNull();
    });

    it('a session clears a skip, so the sign-in screen shows once that session ends elsewhere', async () => {
      localStorage.setItem('auth_skipped', '1');
      const client = fakeSupabase();
      const { result } = hook(client);
      await settle();
      expect(result.current.screen).toBe('app');

      await emit(client, 'SIGNED_IN', sessionFor(A)); // a magic link opened in another tab
      expect(result.current).toMatchObject({ screen: 'app', signedIn: true });
      expect(localStorage.getItem('auth_skipped')).toBeNull();

      await emit(client, 'SIGNED_OUT'); // revoked on another device: this browser's storage untouched
      expect(result.current).toMatchObject({ screen: 'sign-in', signedIn: false, accountKey: 'local' });
    });
  });

  describe('the backend, one per account', () => {
    it('moves the old sessionStorage settings to localStorage at mount, signed out too', () => {
      sessionStorage.setItem('ai_provider', 'openai');
      hook(null);
      expect(getPreference('ai_provider')).toBe('openai');
      expect(sessionStorage.getItem('ai_provider')).toBeNull();
    });

    it('builds one under StrictMode: one subscription, one hydrate, through the injected client', async () => {
      const hydrate = vi.spyOn(SupabaseBackend.prototype, 'hydrate');
      const client = fakeSupabase({ session: sessionFor(A) });
      const { result, unmount } = hook(client);
      await settle();
      expect(result.current.accountKey).toBe(A);
      expect(client.subscribers).toBe(1);
      expect(hydrate).toHaveBeenCalledTimes(1);
      expect(client.reads).toHaveLength(3);
      expect(readsFor(client, A)).toBe(3);

      unmount();
      expect(client.subscribers).toBe(0);
    });

    it('builds nothing for a new session of the same account (a token refresh, a tab focus)', async () => {
      const getItem = vi.spyOn(Storage.prototype, 'getItem');
      const hydrate = vi.spyOn(SupabaseBackend.prototype, 'hydrate');
      const flushPendingEdits = vi.fn();
      const client = fakeSupabase({ session: sessionFor(A) });
      const { result } = hook(client, flushPendingEdits);
      await settle();
      expect(flushPendingEdits).toHaveBeenCalledTimes(1);
      const runs = effectRuns(getItem);

      await emit(client, 'TOKEN_REFRESHED', sessionFor(A));
      await emit(client, 'SIGNED_IN', sessionFor(A));
      // Each event's session is applied (a new object, so the effect runs), and the effect finds the same account.
      expect(effectRuns(getItem)).toBe(runs + 2);
      expect(flushPendingEdits).toHaveBeenCalledTimes(1);
      expect(hydrate).toHaveBeenCalledTimes(1);
      expect(client.reads).toHaveLength(3);
      expect(result.current).toMatchObject({ accountKey: A, signedIn: true });
    });

    it("at an account switch: flushes first, clears the old account's data (keys kept), moves the mark", async () => {
      const owners = [];
      const flushPendingEdits = vi.fn(() => { owners.push(localStorage.getItem('local_data_owner')); });
      const client = fakeSupabase({ session: sessionFor(A), tables: { positions: [posRow(A, 'AVGO', 120, 3)] } });
      const { result } = hook(client, flushPendingEdits);
      await settle();
      expect(getPosition('AVGO')).toEqual({ costBasis: 120, shares: 3 });
      setPreference('ai_key_anthropic', 'sk-keep');
      const details = [];
      const onStoreChanged = (e) => { details.push(e.detail ?? null); };
      window.addEventListener('store-changed', onStoreChanged);

      await emit(client, 'SIGNED_IN', sessionFor(B)); // another tab signed in as B
      window.removeEventListener('store-changed', onStoreChanged);
      expect(owners).toEqual([null, A]); // each flush ran before its account's claim
      expect(getPosition('AVGO')).toEqual(EMPTY);
      expect(getPreference('ai_key_anthropic')).toBe('sk-keep');
      expect(localStorage.getItem('local_data_owner')).toBe(B);
      expect(details).toEqual([null]); // the readers re-read the cleared store
      expect(warn).toHaveBeenCalledWith(SWITCH_WARNING);
      expect(readsFor(client, B)).toBe(3);
      expect(result.current).toMatchObject({ accountKey: B, userEmail: 'user-b@example.com', conflict: null });
    });

    it("clears the old account's data at a switch even when the owner mark is gone", async () => {
      const client = fakeSupabase({ session: sessionFor(A), tables: { positions: [posRow(A, 'AVGO', 120, 3)] } });
      hook(client);
      await settle();
      localStorage.removeItem('local_data_owner'); // this tab still knows whose data it holds

      await emit(client, 'SIGNED_IN', sessionFor(B));
      expect(getPosition('AVGO')).toEqual(EMPTY);
      expect(positionUpserts(client)).toEqual([]);
      expect(localStorage.getItem('local_data_owner')).toBe(B);
    });

    it('Pin (known): an edit inside its debounce at an account switch reaches neither account', async () => {
      const written = vi.spyOn(SupabaseBackend.prototype, 'setPosition');
      let pending = null;
      const flushPendingEdits = vi.fn(() => {
        if (pending) setPosition('AVGO', pending);
        pending = null;
      });
      const client = fakeSupabase({ session: sessionFor(A) });
      hook(client, flushPendingEdits);
      await settle();
      pending = { costBasis: 95, shares: null };

      await emit(client, 'SIGNED_IN', sessionFor(B));
      // Written through A's backend, then cleared with A's queued writes by B's claim before it was sent: the client
      // already held B's session.
      expect(written.mock.contexts.map((backend) => backend.userId)).toEqual([A]);
      expect(client.upserts).toEqual([]);
      expect(localStorage.getItem('position_AVGO')).toBeNull();
      expect(localStorage.getItem('sync_outbox_user-a')).toBeNull();
      expect(localStorage.getItem('sync_meta_user-a')).toBeNull();
      expect(localStorage.getItem('local_data_owner')).toBe(B);
    });

    it('when the session ends elsewhere: keeps the data for that account and sends nothing after', async () => {
      const client = fakeSupabase({ session: sessionFor(A), tables: { positions: [posRow(A, 'AVGO', 120, 3)] } });
      const { result } = hook(client);
      await settle();

      await emit(client, 'SIGNED_OUT'); // revoked on another device: this browser's storage untouched
      expect(result.current).toMatchObject({ screen: 'sign-in', signedIn: false });
      expect(getPosition('AVGO')).toEqual({ costBasis: 120, shares: 3 });
      expect(localStorage.getItem('local_data_owner')).toBe(A);
      setPosition('NVDA', { costBasis: 1, shares: 1 });
      await settle();
      expect(client.upserts).toEqual([]);
    });
  });

  describe("hydrate's report", () => {
    it('pulls the account into an empty browser, with no conflict', async () => {
      const client = fakeSupabase({ session: sessionFor(A), tables: { positions: [posRow(A, 'AVGO', 120, 3)] } });
      const { result } = hook(client);
      await settle();
      expect(getPosition('AVGO')).toEqual({ costBasis: 120, shares: 3 });
      expect(client.upserts).toEqual([]);
      expect(result.current.conflict).toBeNull();
    });

    it("pushes this browser's data into an empty account, with no conflict", async () => {
      localStorage.setItem('position_NVDA', JSON.stringify({ costBasis: 50, shares: 2 })); // used without signing in
      const client = fakeSupabase({ session: sessionFor(A) });
      const details = [];
      const onStoreChanged = (e) => { details.push(e.detail ?? null); };
      window.addEventListener('store-changed', onStoreChanged);
      const { result } = hook(client);
      await settle();
      window.removeEventListener('store-changed', onStoreChanged);
      expect(positionUpserts(client)).toEqual([[A, 'NVDA', 50, 2]]);
      expect(localStorage.getItem('local_data_owner')).toBe(A);
      expect(result.current.conflict).toBeNull();
      expect(details).toEqual([]); // nothing was cleared, so the readers are not told to re-read
    });

    it.each([
      ['another account signs in', 'SIGNED_IN', B],
      ['the session ends elsewhere', 'SIGNED_OUT', null],
    ])('reports a conflict while its account is signed in, writing nothing; hidden once %s', async (_, event, next) => {
      const client = conflictFor();
      const { result } = hook(client);
      await settle();
      expect(result.current.conflict).toEqual({
        status: 'conflict', cloud: { positions: 1, prefs: 0, chats: 0 }, local: { positions: 1, prefs: 0, chats: 0 },
      });
      expect(client.upserts).toEqual([]);
      expect(getPosition('AVGO')).toEqual({ costBasis: 100, shares: 10 });

      await emit(client, event, next && sessionFor(next));
      expect(result.current.conflict).toBeNull();
    });
  });

  describe('resolveConflict', () => {
    /** A's conflict, with NVDA only in the account: the three choices leave different data. */
    async function conflicted() {
      const client = conflictFor([posRow(A, 'NVDA', 50, 1)]);
      const view = hook(client);
      await settle();
      expect(view.result.current.conflict).not.toBeNull();
      return { client, ...view };
    }

    it.each([
      // An item both hold whose copy here nothing dates stays this browser's; one only the account holds comes here.
      ['merge', { AVGO: { costBasis: 100, shares: 10 }, NVDA: { costBasis: 50, shares: 1 } }, [[A, 'AVGO', 100, 10]]],
      ['cloud', { AVGO: { costBasis: 120, shares: 10 }, NVDA: { costBasis: 50, shares: 1 } }, []],
      ['local', { AVGO: { costBasis: 100, shares: 10 }, NVDA: EMPTY }, [[A, 'AVGO', 100, 10], [A, 'NVDA', null, null]]],
    ])("'%s' is applied by the signed-in account's backend, and the prompt closes", async (choice, positions, sent) => {
      const resolve = vi.spyOn(SupabaseBackend.prototype, 'resolveConflict');
      const { client, result } = await conflicted();

      await act(async () => { await result.current.resolveConflict(choice); });
      await settle();
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith(choice);
      expect(resolve.mock.contexts[0].userId).toBe(A);
      expect({ AVGO: getPosition('AVGO'), NVDA: getPosition('NVDA') }).toEqual(positions);
      expect(positionUpserts(client)).toEqual(sent);
      expect(result.current).toMatchObject({ conflict: null, syncBusy: false });
    });

    it('is busy while the choice is applied, with the prompt up until it is done', async () => {
      let release;
      vi.spyOn(SupabaseBackend.prototype, 'resolveConflict')
        .mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
      const { result } = await conflicted();

      let pending;
      act(() => { pending = result.current.resolveConflict('merge'); });
      expect(result.current.syncBusy).toBe(true);
      expect(result.current.conflict).not.toBeNull();

      await act(async () => {
        release({ pushed: 1, pulled: 1, deleted: 0 });
        await pending;
      });
      expect(result.current).toMatchObject({ syncBusy: false, conflict: null });
    });

    it.each([
      ['an Error', new Error('boom'), 'boom'],
      ['an object with a message', { message: 'refused' }, 'refused'],
      ['anything else', 'nope', 'nope'],
    ])('closes the prompt when the choice fails with %s, and logs why', async (_label, thrown, logged) => {
      vi.spyOn(SupabaseBackend.prototype, 'resolveConflict').mockRejectedValueOnce(thrown);
      const { result } = await conflicted();

      await act(async () => { await result.current.resolveConflict('merge'); });
      expect(result.current).toMatchObject({ syncBusy: false, conflict: null });
      expect(warn).toHaveBeenCalledWith('Sync: could not apply the choice:', logged);
    });
  });

  describe("the 'online' retry", () => {
    it('hydrates once more when the browser is next online, and handles that report the same way', async () => {
      const readError = { positions: READ_FAILED }; // read live by the fake: deleting the entry lets the retry read
      const client = conflictFor([], { readError });
      const { result } = hook(client);
      await settle();
      expect(readsFor(client, A)).toBe(3);
      expect(result.current.conflict).toBeNull(); // nothing was compared

      delete readError.positions;
      await online();
      expect(readsFor(client, A)).toBe(6);
      expect(result.current.conflict).toMatchObject({ status: 'conflict' });
    });

    it('retries once only', async () => {
      const hydrate = vi.spyOn(SupabaseBackend.prototype, 'hydrate');
      const client = fakeSupabase({ session: sessionFor(A), readError: { positions: READ_FAILED } });
      hook(client);
      await settle();

      await online();
      await online();
      expect(hydrate).toHaveBeenCalledTimes(2);
      expect(readsFor(client, A)).toBe(6);
    });

    // A disposed backend's hydrate reads nothing, so only the spy shows a retry left armed for the old account.
    it.each([
      ['another account signs in', (client) => emit(client, 'SIGNED_IN', sessionFor(B)), 2],
      ['the user signs out', async (_client, result) => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        await act(async () => { await result.current.signOut(); });
      }, 1],
      ['the session ends elsewhere', (client) => emit(client, 'SIGNED_OUT'), 1],
    ])('drops a retry still waiting when %s', async (_label, end, hydrates) => {
      const readError = { positions: READ_FAILED };
      const hydrate = vi.spyOn(SupabaseBackend.prototype, 'hydrate');
      const client = fakeSupabase({ session: sessionFor(A), readError });
      const { result } = hook(client);
      await settle();
      delete readError.positions; // a next account's hydrate reads, and arms no retry of its own

      await end(client, result);
      await online();
      expect(hydrate).toHaveBeenCalledTimes(hydrates);
    });

    it('drops a retry still waiting at an unmount', async () => {
      const hydrate = vi.spyOn(SupabaseBackend.prototype, 'hydrate');
      const client = fakeSupabase({ session: sessionFor(A), readError: { positions: READ_FAILED } });
      const { unmount } = hook(client);
      await settle();

      unmount();
      await online();
      expect(hydrate).toHaveBeenCalledTimes(1);
      expect(client.reads).toHaveLength(3);
    });

    it('arms nothing for the report of an account that is no longer signed in', async () => {
      let release;
      const hydrate = vi.spyOn(SupabaseBackend.prototype, 'hydrate');
      const client = fakeSupabase({ session: sessionFor(A), gate: new Promise((resolve) => { release = resolve; }) });
      hook(client);
      await settle();
      expect(hydrate).toHaveBeenCalledTimes(1); // its reads are held

      await emit(client, 'SIGNED_OUT');
      await act(async () => { release(); });
      await settle(); // the disposed backend reports 'offline'
      await online();
      expect(hydrate).toHaveBeenCalledTimes(1);
    });
  });

  describe('signOut', () => {
    /** A signed in, with AVGO pulled; the flushes, the confirm and the client's sign-out are logged in order. */
    async function signedIn(confirmed) {
      const log = [];
      const client = fakeSupabase({ session: sessionFor(A), tables: { positions: [posRow(A, 'AVGO', 120, 3)] } });
      const endSession = client.auth.signOut;
      client.auth.signOut = () => { log.push('auth.signOut'); return endSession(); };
      vi.spyOn(window, 'confirm').mockImplementation(() => { log.push('confirm'); return confirmed; });
      const view = hook(client, vi.fn(() => { log.push('flush'); }));
      await settle();
      log.length = 0;
      return { client, log, ...view };
    }

    it('saves a pending edit first, then asks; declined, it stays signed in with the data kept', async () => {
      const { client, log, result } = await signedIn(false);

      await act(async () => { await result.current.signOut(); });
      expect(log).toEqual(['flush', 'confirm']);
      expect(client.signOuts).toBe(0);
      expect(result.current).toMatchObject({ screen: 'app', signedIn: true, accountKey: A });
      expect(getPosition('AVGO')).toEqual({ costBasis: 120, shares: 3 });
      expect(localStorage.getItem('local_data_owner')).toBe(A);
    });

    it('confirmed: ends the session through the injected client and clears this browser', async () => {
      const { client, log, result } = await signedIn(true);
      setPreference('ai_key_anthropic', 'sk-a');
      localStorage.setItem('access_token', 'a-token');

      await act(async () => { await result.current.signOut(); });
      // Its own flush, the confirm, the client's sign-out, then the backend effect's flush at the session's end.
      expect(log).toEqual(['flush', 'confirm', 'auth.signOut', 'flush']);
      expect(client.signOuts).toBe(1);
      expect(result.current).toMatchObject({ screen: 'sign-in', signedIn: false, accountKey: 'local', conflict: null });
      expect(Object.keys(localStorage)).toEqual([]);
    });

    it('signs this tab out when the request throws and no SIGNED_OUT arrives', async () => {
      const { client, result } = await signedIn(true);
      client.auth.signOut = async () => { throw new Error('fetch failed'); };

      await act(async () => { await result.current.signOut(); });
      expect(result.current).toMatchObject({ screen: 'sign-in', signedIn: false, accountKey: 'local' });
      expect(warn).toHaveBeenCalledWith('Supabase sign-out failed; clearing this browser anyway:', 'fetch failed');
      expect(getPosition('AVGO')).toEqual(EMPTY);
    });

    it('closes a conflict, so the account signing in here again sees none', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const client = conflictFor();
      const { result } = hook(client);
      await settle();
      expect(result.current.conflict).not.toBeNull();

      await act(async () => { await result.current.signOut(); });
      await emit(client, 'SIGNED_IN', sessionFor(A));
      expect(result.current.conflict).toBeNull();
      expect(getPosition('AVGO')).toEqual({ costBasis: 120, shares: 10 }); // pulled into the emptied browser
    });
  });

  describe('identities', () => {
    it('keeps the four callbacks across renders, a conflict and an account switch', async () => {
      const flushPendingEdits = vi.fn();
      const client = conflictFor();
      const { result, rerender } = hook(client, flushPendingEdits);
      const callbacks = ({ skipSignIn, showSignIn, signOut, resolveConflict }) => (
        { skipSignIn, showSignIn, signOut, resolveConflict });
      const first = callbacks(result.current);
      await settle();
      expect(result.current.conflict).not.toBeNull();

      rerender({ flush: flushPendingEdits });
      await emit(client, 'SIGNED_IN', sessionFor(B));
      const last = callbacks(result.current);
      for (const name of Object.keys(first)) expect(last[name], name).toBe(first[name]);
    });

    it('runs the backend effect on a rerender only when flushPendingEdits changes identity', async () => {
      const getItem = vi.spyOn(Storage.prototype, 'getItem');
      const flushPendingEdits = vi.fn();
      const { result, rerender } = hook(fakeSupabase({ session: sessionFor(A) }), flushPendingEdits);
      await settle();
      const runs = effectRuns(getItem);
      for (let i = 0; i < 3; i += 1) rerender({ flush: flushPendingEdits });
      expect(effectRuns(getItem)).toBe(runs);

      // An unstable one costs a run on every render (it returns at the same account) and a new signOut each time.
      const { signOut } = result.current;
      for (let i = 0; i < 3; i += 1) rerender({ flush: vi.fn() });
      expect(effectRuns(getItem)).toBe(runs + 3);
      expect(result.current.signOut).not.toBe(signOut);
    });
  });
});

// A conflict is what one hydrate found between this browser and its account. Once the session has left that account,
// the report describes a browser and a backend that are gone: when the account signs in here again, its next hydrate
// decides afresh, and the old report must not come back with the session (choosing on it could only fail).
describe('useSupabaseAuth: a conflict once the session has left its account', () => {
  let warn;
  let error;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error');
  });

  afterEach(() => {
    setBackend(new LocalStorageBackend());
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    // That tab's sign-out emptied the storage both tabs share, so the account's next hydrate here pulls.
    ['another tab signs the account out', async (client) => {
      localStorage.clear();
      await emit(client, 'SIGNED_OUT');
    }],
    ['another account signs in', (client) => emit(client, 'SIGNED_IN', sessionFor(B))],
  ])('is dropped when %s: the account signing in again gets no old report, before or after its hydrate', async (_label, leave) => {
    const client = conflictFor();
    const { result } = hook(client);
    await settle();
    expect(result.current.conflict).toMatchObject({ status: 'conflict' });

    await leave(client);
    act(() => { client.emitAuth('SIGNED_IN', sessionFor(A)); }); // a magic link for the account, opened in another tab
    expect(result.current).toMatchObject({ accountKey: A, conflict: null }); // its hydrate has read nothing yet

    await settle();
    expect(getPosition('AVGO')).toEqual({ costBasis: 120, shares: 10 }); // pulled into the emptied browser
    expect(result.current.conflict).toBeNull();
  });

  it.each([
    ['a token refresh', 'TOKEN_REFRESHED'],
    ['a tab focus', 'SIGNED_IN'],
  ])('Pin: %s for the same account keeps a live conflict', async (_label, event) => {
    const client = conflictFor();
    const { result } = hook(client);
    await settle();
    const report = result.current.conflict;
    expect(report).toMatchObject({ status: 'conflict' });

    await emit(client, event, sessionFor(A)); // a new session object for the same account
    expect(result.current.conflict).toBe(report);
  });

  // The account's reads answer after the event that signs another account in, before that event has rendered: the
  // report is stored for the account that was signed in when it landed, and shown for that account only.
  it("Pin: a report that lands as the session leaves its account never shows over the next account's", async () => {
    let release;
    const hydrate = vi.spyOn(SupabaseBackend.prototype, 'hydrate');
    const client = conflictFor([], { gate: new Promise((resolve) => { release = resolve; }) });
    const { result } = hook(client);
    await settle();
    expect(hydrate).toHaveBeenCalledTimes(1); // its reads held

    await act(async () => {
      client.emitAuth('SIGNED_IN', sessionFor(B));
      release();
      await hydrate.mock.results[0].value;
    });
    await settle();
    expect(result.current).toMatchObject({ accountKey: B, conflict: null });
  });

  // Revoked on another device: this browser's storage is untouched and still marked as the account's, so the account's
  // next hydrate here compares the same two copies.
  it("Pin: the account's own conflict, found again when it signs back in, shows until a choice settles it", async () => {
    const client = conflictFor();
    const { result } = hook(client);
    await settle();
    const first = result.current.conflict;
    expect(first).toMatchObject({ status: 'conflict' });

    await emit(client, 'SIGNED_OUT');
    expect(result.current.conflict).toBeNull();
    await emit(client, 'SIGNED_IN', sessionFor(A));
    expect(result.current.conflict).toEqual(first);
    await emit(client, 'TOKEN_REFRESHED', sessionFor(A));
    expect(result.current.conflict).toEqual(first);

    await act(async () => { await result.current.resolveConflict('cloud'); });
    expect(result.current.conflict).toBeNull();
    expect(getPosition('AVGO')).toEqual({ costBasis: 120, shares: 10 });
    expect(warn).not.toHaveBeenCalledWith('Sync: could not apply the choice:', expect.anything());
  });

  it('Pin: a sign-out whose request fails drops the conflict too, though no SIGNED_OUT arrives', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const client = conflictFor();
    client.auth.signOut = async () => { throw new Error('fetch failed'); };
    const { result } = hook(client);
    await settle();
    expect(result.current.conflict).toMatchObject({ status: 'conflict' });

    await act(async () => { await result.current.signOut(); });
    act(() => { client.emitAuth('SIGNED_IN', sessionFor(A)); });
    expect(result.current).toMatchObject({ accountKey: A, conflict: null });
    await settle();
    expect(result.current.conflict).toBeNull();
  });
});
