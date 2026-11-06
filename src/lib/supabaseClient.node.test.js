// src/lib/supabaseClient.node.test.js — pins four behaviours of the real @supabase/supabase-js that Phase 3's
// sync code is built on, so a dependency bump that changes one fails here instead of in a user's browser:
//  - A write whose request fails resolves (it does not throw) with { data: null, error: { code: '' },
//    status: 0 }. src/lib/syncOutbox.js retries exactly that shape (isRetryable), which is what keeps an edit
//    made offline instead of dropping it on its first attempt.
//  - An auth request that fails resolves with an AuthRetryableFetchError of status 0. src/App.jsx recognises a
//    failed session check by that error name and shows the sign-in notice instead of treating it as signed out.
//  - The session is stored under sb-<project ref>-auth-token, a key the store does not own: clearAll, the
//    sign-out's local clear and the cross-tab listener (describeStorageKey) leave it to supabase-js, and the
//    store and sync checks stand it in as 'sb-project-auth-token'.
//  - The auth events' timing, which the fake client's `auth` (test/helpers/fakeSupabase.js) models for the App
//    and hook tests: INITIAL_SESSION reaches a subscriber a few microtasks after it subscribes, before any
//    macrotask, and never a callback unsubscribed by then (StrictMode's first subscription); every getSession()
//    returns a new session object; signOut() delivers SIGNED_OUT before its promise resolves.
// No network: Node's fetch refuses port 1 (a "bad port" in the Fetch standard) before it connects, so every
// request to http://127.0.0.1:1 fails at once, the same way on every machine, with no server or open port.
// supabase-js >= 2.102 retries idempotent PostgREST reads (GET/HEAD) itself, after 1 s, 2 s and 4 s, so a
// failing select would take seven seconds: the pins use a write (never retried) and auth.getUser, never a select.
import { describe, expect, it } from 'vitest';
import { AuthRetryableFetchError, createClient, isAuthRetryableFetchError } from '@supabase/supabase-js';
import { isRetryable } from './syncOutbox.js';
import { describeStorageKey } from './store.js';
import { memoryStorage } from '../../test/helpers/globals.js';

const UNREACHABLE = 'http://127.0.0.1:1';
const OPTIONS = { auth: { persistSession: false, autoRefreshToken: false } };
const NETWORK = { timeout: 10_000 };

describe('supabase-js when the request fails', () => {
  it('resolves a write with status 0 and an empty error code, which the outbox retries', NETWORK, async () => {
    const client = createClient(UNREACHABLE, 'anon-key', OPTIONS);
    const result = await client.from('positions').upsert({ user_id: 'u', ticker: 'AVGO' });
    expect(result.status).toBe(0);
    expect(result.error.code).toBe('');
    expect(result.data).toBeNull();
    expect(isRetryable(result)).toBe(true);
    expect(isRetryable({ error: null, status: 201 })).toBe(false);
  });

  it('resolves an auth request with an AuthRetryableFetchError of status 0', NETWORK, async () => {
    const client = createClient(UNREACHABLE, 'anon-key', OPTIONS);
    const { data, error } = await client.auth.getUser('not-a-jwt');
    expect(error.name).toBe('AuthRetryableFetchError');
    expect(error.status).toBe(0);
    expect(error).toBeInstanceOf(AuthRetryableFetchError);
    expect(isAuthRetryableFetchError(error)).toBe(true);
    expect(data.user).toBeNull();
  });
});

describe('supabase-js session storage key', () => {
  it('is sb-<project ref>-auth-token, a key the store does not own', () => {
    const client = createClient('https://abcdefgh.supabase.co', 'k', { auth: { persistSession: false } });
    expect(client.auth.storageKey).toBe('sb-abcdefgh-auth-token');
    expect(describeStorageKey(client.auth.storageKey)).toBeNull();
  });
});

describe('supabase-js auth events (what the fake client models)', () => {
  const KEY = 'sb-127-auth-token';
  const session = (id) => ({
    access_token: `at-${id}`, refresh_token: `rt-${id}`, expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user: { id, email: `${id}@example.com` },
  });
  const signedIn = (id, fetch) => {
    const storage = memoryStorage();
    storage.setItem(KEY, JSON.stringify(session(id)));
    const client = createClient(UNREACHABLE, 'anon-key', {
      auth: { storage, autoRefreshToken: false, persistSession: true, detectSessionInUrl: false },
      ...(fetch ? { global: { fetch } } : {}),
    });
    return { client, storage };
  };
  const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('delivers INITIAL_SESSION a few microtasks after subscribing, never to a callback unsubscribed by then', async () => {
    const { client } = signedIn('u1');
    await macrotask(); // the client has read its stored session
    const seen = [];
    client.auth.onAuthStateChange((event, s) => seen.push(`first:${event}:${s?.user?.id}`)).data.subscription.unsubscribe();
    client.auth.onAuthStateChange((event, s) => seen.push(`second:${event}:${s?.user?.id}`));
    let macro = false;
    setTimeout(() => { macro = true; }, 0);
    for (let i = 0; i < 10 && seen.length === 0; i += 1) await Promise.resolve();
    expect(macro).toBe(false);
    expect(seen).toEqual(['second:INITIAL_SESSION:u1']);
    const [a, b] = [await client.auth.getSession(), await client.auth.getSession()];
    expect(a.data.session.user.id).toBe('u1');
    expect(a.data.session).not.toBe(b.data.session);
  });

  it('delivers SIGNED_OUT before signOut() resolves', async () => {
    const { client, storage } = signedIn('u1', async () => new Response(null, { status: 204 }));
    await macrotask();
    const log = [];
    client.auth.onAuthStateChange((event) => log.push(event));
    await macrotask();
    log.length = 0;
    const result = await client.auth.signOut();
    log.push('resolved');
    expect(log).toEqual(['SIGNED_OUT', 'resolved']);
    expect(result).toEqual({ error: null });
    expect(storage.getItem(KEY)).toBeNull();
  });
});
