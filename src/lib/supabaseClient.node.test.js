// src/lib/supabaseClient.node.test.js — pins three behaviours of the real @supabase/supabase-js that Phase 3's
// sync code is built on, so a dependency bump that changes one fails here instead of in a user's browser:
//  - A write whose request fails resolves (it does not throw) with { data: null, error: { code: '' },
//    status: 0 }. src/lib/syncOutbox.js retries exactly that shape (isRetryable), which is what keeps an edit
//    made offline instead of dropping it on its first attempt.
//  - An auth request that fails resolves with an AuthRetryableFetchError of status 0. src/App.jsx recognises a
//    failed session check by that error name and shows the sign-in notice instead of treating it as signed out.
//  - The session is stored under sb-<project ref>-auth-token, a key the store does not own: clearAll, the
//    sign-out's local clear and the cross-tab listener (describeStorageKey) leave it to supabase-js, and the
//    store and sync checks stand it in as 'sb-project-auth-token'.
// No network: Node's fetch refuses port 1 (a "bad port" in the Fetch standard) before it connects, so every
// request to http://127.0.0.1:1 fails at once, the same way on every machine, with no server or open port.
// supabase-js >= 2.102 retries idempotent PostgREST reads (GET/HEAD) itself, after 1 s, 2 s and 4 s, so a
// failing select would take seven seconds: the pins use a write (never retried) and auth.getUser, never a select.
import { describe, expect, it } from 'vitest';
import { AuthRetryableFetchError, createClient, isAuthRetryableFetchError } from '@supabase/supabase-js';
import { isRetryable } from './syncOutbox.js';
import { describeStorageKey } from './store.js';

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
