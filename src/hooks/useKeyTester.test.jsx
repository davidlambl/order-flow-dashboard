// src/hooks/useKeyTester.test.jsx — the AI tab's "Test" button: one request with the trimmed key, the outcome as a
// status and a sentence (the dialog's two when the reply has none), the list seeded under the trimmed key so the models
// hook on the saved key sends nothing more, and a reply dropped once a newer test or reset() supersedes it. MSW answers
// getModels with a list named after the request's provider and key, and `requests` keeps every Request it saw; a gated
// reply holds its request until release(). Fake timers run with shouldAdvanceTime (waitFor and MSW keep working).
// src/test/setup.js clears the TanStack cache, the handlers and localStorage after each test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../test/setup.js';
import { queryClient } from '../lib/queryClient.js';
import { useAIModels } from './useAIModels.js';
import { useKeyTester } from './useKeyTester.js';

const FN = 'http://localhost:3000/.netlify/functions';

const providerOf = (request) => new URL(request.url).searchParams.get('provider');
const keyOf = (request) => request.headers.get('x-api-key');

/** A getModels body: two models named after the provider and the key the request carried. */
function listFor(provider, key) {
  const tag = `${provider}:${key ?? 'server'}`;
  return {
    models: [{ id: `${tag}:1`, name: `${tag} one`, provider }, { id: `${tag}:2`, name: `${tag} two`, provider }],
    provider,
    requestId: 'r1',
  };
}

const REJECTED = { error: 'The gemini API rejected the API key', code: 'UPSTREAM_KEY_REJECTED', requestId: 'r2' };

let requests;

const ok = (request) => HttpResponse.json(listFor(providerOf(request), keyOf(request)));

/** Answer getModels with reply(request), recording every request; a later serveModels() takes precedence. */
function serveModels(reply = ok) {
  server.use(http.get(`${FN}/getModels`, ({ request }) => {
    requests.push(request);
    return reply(request);
  }));
}

/** A reply held until release(), so the request stays in flight. */
function gated(reply) {
  let release;
  const open = new Promise((resolve) => { release = resolve; });
  return { reply: async (request) => { await open; return reply(request); }, release };
}

/** Move the fake clock inside act, yielding to the real event loop so fetches can land. */
const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/** Start a test inside act and return its promise (the button's click). */
function startTest(tester, provider, key) {
  let done;
  act(() => { done = tester.result.current.test(provider, key); });
  return done;
}

/** Run a test to its end inside act; resolves to what test() resolved. */
async function runTest(tester, provider, key) {
  let outcome;
  await act(async () => { outcome = await tester.result.current.test(provider, key); });
  return outcome;
}

describe('useKeyTester', () => {
  beforeEach(() => {
    requests = [];
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a key that lists models reads success and seeds its list: the models hook on that key sends nothing', async () => {
    serveModels();
    const tester = renderHook(() => useKeyTester());
    // The AI tab's list on the saved key, still none for Gemini.
    const models = renderHook(({ apiKey }) => useAIModels('gemini', apiKey), { initialProps: { apiKey: null } });
    expect(tester.result.current).toMatchObject({ status: 'idle', error: '' });

    const done = startTest(tester, 'gemini', 'AIza-1');
    expect(tester.result.current).toMatchObject({ status: 'testing', error: '' });
    await waitFor(() => expect(tester.result.current.status).toBe('success'));
    expect(await done).toBe(true);
    expect(tester.result.current.error).toBe('');
    expect(requests).toHaveLength(1);
    expect(providerOf(requests[0])).toBe('gemini');
    expect(keyOf(requests[0])).toBe('AIza-1');

    // The tab saves the key on success; the list it then reads is the seed.
    models.rerender({ apiKey: 'AIza-1' });
    expect(models.result.current).toMatchObject({
      models: listFor('gemini', 'AIza-1').models, loading: false, error: null,
    });
    await advance(1_000);
    expect(requests).toHaveLength(1);
  });

  it('tests and seeds the trimmed key, the one the autosave stores; a blank key tests nothing', async () => {
    serveModels();
    const tester = renderHook(() => useKeyTester());
    expect(await runTest(tester, 'gemini', ' \t ')).toBe(false);
    expect(tester.result.current).toMatchObject({ status: 'idle', error: '' });
    expect(requests).toHaveLength(0);

    expect(await runTest(tester, 'gemini', '  AIza-1 \n')).toBe(true);
    expect(tester.result.current.status).toBe('success');
    expect(queryClient.getQueryData(['models', 'gemini', 'AIza-1'])).toEqual(listFor('gemini', 'AIza-1'));
    expect(queryClient.getQueryData(['models', 'gemini', '  AIza-1 \n'])).toBeUndefined();

    const models = renderHook(() => useAIModels('gemini', 'AIza-1'));
    expect(models.result.current).toMatchObject({ models: listFor('gemini', 'AIza-1').models, loading: false });
    await advance(1_000);
    expect(requests).toHaveLength(1);
  });

  it('a second test supersedes one in flight: the first reply changes nothing when it lands', async () => {
    const first = gated(ok);
    serveModels((request) => (keyOf(request) === 'AIza-1'
      ? first.reply(request)
      : HttpResponse.json(REJECTED, { status: 401 })));
    const tester = renderHook(() => useKeyTester());
    const firstDone = startTest(tester, 'gemini', 'AIza-1');
    await waitFor(() => expect(requests).toHaveLength(1));

    expect(await runTest(tester, 'gemini', 'AIza-2')).toBe(false);
    expect(tester.result.current).toMatchObject({ status: 'error', error: REJECTED.error });

    first.release();
    await act(async () => { expect(await firstDone).toBe(false); });
    expect(tester.result.current).toMatchObject({ status: 'error', error: REJECTED.error });
    expect(queryClient.getQueryData(['models', 'gemini', 'AIza-1'])).toBeUndefined();
  });

  it('reset() returns to idle and drops the reply of a test in flight', async () => {
    const gate = gated(ok);
    serveModels(gate.reply);
    const tester = renderHook(() => useKeyTester());
    const done = startTest(tester, 'gemini', 'AIza-1');
    expect(tester.result.current.status).toBe('testing');

    act(() => { tester.result.current.reset(); });
    expect(tester.result.current).toMatchObject({ status: 'idle', error: '' });
    gate.release();
    await act(async () => { expect(await done).toBe(false); });
    expect(tester.result.current).toMatchObject({ status: 'idle', error: '' });
    expect(queryClient.getQueryData(['models', 'gemini', 'AIza-1'])).toBeUndefined();
  });

  it('a failed test shows the reply\'s sentence, else one of the dialog\'s two', async () => {
    const tester = renderHook(() => useKeyTester());

    serveModels(() => HttpResponse.json(REJECTED, { status: 401 }));
    expect(await runTest(tester, 'gemini', 'AIza-1')).toBe(false);
    expect(tester.result.current).toMatchObject({ status: 'error', error: REJECTED.error });

    const keyRequired = 'No API key provided for gemini. Add your key in Settings.';
    serveModels(() => HttpResponse.json({
      models: [], provider: 'gemini', requestId: 'r3', error: keyRequired, code: 'KEY_REQUIRED',
    }));
    expect(await runTest(tester, 'gemini', 'AIza-2')).toBe(false);
    expect(tester.result.current).toMatchObject({ status: 'error', error: keyRequired });

    serveModels(() => HttpResponse.json({ models: [], provider: 'gemini', requestId: 'r4' }));
    expect(await runTest(tester, 'gemini', 'AIza-3')).toBe(false);
    expect(tester.result.current).toMatchObject({
      status: 'error', error: 'Key returned no models — check that it is valid.',
    });

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError(''));
    expect(await runTest(tester, 'gemini', 'AIza-4')).toBe(false);
    expect(tester.result.current).toMatchObject({
      status: 'error', error: 'Could not validate key. Check the format and try again.',
    });

    expect(queryClient.getQueryCache().findAll({ queryKey: ['models'] })).toHaveLength(0);
  });
});
