// src/hooks/useAIModels.test.jsx — the AI tab's model list: one request per (provider, saved key), none while a
// provider that needs the user's key has none, the 5 min cache, no committed render with another provider's list, the
// reply's own sentence or the failure's message (a failure blanks the list, as the dialog's catch did), refresh() on
// the key saved by the next render, and a token set or cleared dropping every cached list. MSW answers getModels with
// a list named after the request's provider and key, and `requests` keeps every Request it saw; a gated reply holds
// its request until release(). Fake timers run with shouldAdvanceTime (waitFor and MSW keep working); setSystemTime
// ages the cache. src/test/setup.js clears the TanStack cache, the handlers and localStorage after each test.
import { StrictMode, useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../test/setup.js';
import { clearToken, setToken } from '../lib/auth.js';
import { queryClient } from '../lib/queryClient.js';
import { getPreference } from '../lib/store.js';
import { savePreference } from '../lib/storeEvents.js';
import { useStoreValue } from './useStoreValue.js';
import { useAIModels } from './useAIModels.js';

const FN = 'http://localhost:3000/.netlify/functions';

const providerOf = (request) => new URL(request.url).searchParams.get('provider');
const keyOf = (request) => request.headers.get('x-api-key');
const authOf = (request) => request.headers.get('authorization');

/** A getModels body: two models named after the provider and the key the request carried ('server' for none). */
function listFor(provider, key) {
  const tag = `${provider}:${key ?? 'server'}`;
  return {
    models: [{ id: `${tag}:1`, name: `${tag} one`, provider }, { id: `${tag}:2`, name: `${tag} two`, provider }],
    provider,
    requestId: 'r1',
  };
}

const KEY_REQUIRED = {
  models: [], provider: 'anthropic', requestId: 'r2',
  error: 'No API key provided for anthropic. Add your key in Settings.', code: 'KEY_REQUIRED',
};
const UPSTREAM_ERROR = { error: 'Could not list gemini models', code: 'UPSTREAM_ERROR', requestId: 'r3' };

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

/** Render with `provider` / `apiKey` as props, so a rerender can change either. */
const renderModels = (provider, apiKey) => renderHook(
  (props) => useAIModels(props.provider, props.apiKey),
  { initialProps: { provider, apiKey } },
);

/** Render the hook and wait until its first request has settled. */
async function renderLoaded(provider, apiKey) {
  const hook = renderModels(provider, apiKey);
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

/** The hook on the key stored under `pref`, read from the store as the AI tab reads it (its autosave writes it). */
const renderOnSavedKey = (provider, pref) => renderHook(
  () => useAIModels(provider, useStoreValue(() => getPreference(pref))),
);

describe('useAIModels', () => {
  beforeEach(() => {
    requests = [];
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads the provider\'s models with the saved key and the stored access token', async () => {
    localStorage.setItem('access_token', 'tok-123');
    serveModels();
    const { result } = renderModels('gemini', 'AIza-1');
    expect(result.current).toMatchObject({ models: [], loading: true, error: null });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ models: listFor('gemini', 'AIza-1').models, error: null });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe('/.netlify/functions/getModels');
    expect(providerOf(requests[0])).toBe('gemini');
    expect(keyOf(requests[0])).toBe('AIza-1');
    expect(authOf(requests[0])).toBe('Bearer tok-123');
  });

  it('sends one request per (provider, key): two hooks under StrictMode share it, a cached key shows at once', async () => {
    serveModels();
    const { result, rerender } = renderHook(
      ({ provider, apiKey }) => [useAIModels(provider, apiKey), useAIModels(provider, apiKey)],
      { initialProps: { provider: 'anthropic', apiKey: null }, wrapper: StrictMode },
    );
    await waitFor(() => expect(result.current[0].loading).toBe(false));
    expect(result.current[1].models).toEqual(listFor('anthropic', null).models);
    expect(requests).toHaveLength(1);
    expect(keyOf(requests[0])).toBeNull();

    rerender({ provider: 'anthropic', apiKey: '' }); // the same key as null: none
    rerender({ provider: 'anthropic', apiKey: 'sk-ant-1' });
    await waitFor(() => expect(result.current[0].loading).toBe(false));
    expect(requests.map(keyOf)).toEqual([null, 'sk-ant-1']);

    rerender({ provider: 'anthropic', apiKey: null });
    expect(result.current[0]).toMatchObject({ models: listFor('anthropic', null).models, loading: false, error: null });
    await advance(1_000);
    expect(requests).toHaveLength(2);
  });

  it('a provider that needs the user\'s key fetches nothing without one, and says so', async () => {
    serveModels();
    const { result, rerender } = renderModels('gemini', null);
    await advance(1_000);
    expect(result.current).toMatchObject({
      models: [], loading: false, error: 'Enter your Gemini API key to load models.',
    });

    act(() => { result.current.refresh(); });
    rerender({ provider: 'openai', apiKey: '' });
    await advance(1_000);
    expect(result.current).toMatchObject({
      models: [], loading: false, error: 'Enter your OpenAI API key to load models.',
    });
    expect(requests).toHaveLength(0);
  });

  it('the cache serves a list for 5 min, the function\'s own max-age; an older one is fetched again', async () => {
    serveModels();
    (await renderLoaded('anthropic', null)).unmount();
    const written = Date.now(); // a few ms after the cache write at most

    vi.setSystemTime(written + 4 * 60_000);
    const fresh = renderModels('anthropic', null);
    expect(fresh.result.current).toMatchObject({ models: listFor('anthropic', null).models, loading: false });
    fresh.unmount();
    await advance(0);
    expect(requests).toHaveLength(1);

    vi.setSystemTime(written + 6 * 60_000);
    const { result } = renderModels('anthropic', null);
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(requests).toHaveLength(2);
  });

  it('a provider switch never shows another provider\'s list: not while the new one loads, nor a late reply', async () => {
    const slow = gated(ok);
    serveModels((request) => (providerOf(request) === 'openai' ? slow.reply(request) : ok(request)));
    // Record what each committed render shows: a render React throws away is never on screen.
    const shown = [];
    const { result, rerender } = renderHook(({ provider, apiKey }) => {
      const state = useAIModels(provider, apiKey);
      useLayoutEffect(() => { shown.push({ provider, models: state.models }); });
      return state;
    }, { initialProps: { provider: 'gemini', apiKey: 'AIza-1' } });
    await waitFor(() => expect(result.current.models).toEqual(listFor('gemini', 'AIza-1').models));

    // OpenAI's request is held in flight: its renders show no list, never Gemini's.
    rerender({ provider: 'openai', apiKey: 'sk-1' });
    expect(result.current).toMatchObject({ models: [], loading: true });
    await waitFor(() => expect(requests).toHaveLength(2));
    // Anthropic's lands first; OpenAI's reply lands after the switch away from it, in its own entry.
    rerender({ provider: 'anthropic', apiKey: null });
    await waitFor(() => expect(result.current.loading).toBe(false));
    slow.release();
    await advance(1_000);
    expect(result.current).toMatchObject({ models: listFor('anthropic', null).models, loading: false, error: null });
    expect(new Set(shown.map((entry) => entry.provider))).toEqual(new Set(['gemini', 'openai', 'anthropic']));
    for (const entry of shown) expect(entry.models.every((m) => m.provider === entry.provider)).toBe(true);
    expect(requests.map(providerOf)).toEqual(['gemini', 'openai', 'anthropic']);

    // Switching back to OpenAI shows that late reply without a request.
    rerender({ provider: 'openai', apiKey: 'sk-1' });
    expect(result.current).toMatchObject({ models: listFor('openai', 'sk-1').models, loading: false });
    await advance(0);
    expect(requests).toHaveLength(3);
  });

  it('a reply that lists no models shows its own sentence, or "No models returned."', async () => {
    serveModels(() => HttpResponse.json(KEY_REQUIRED));
    const keyless = await renderLoaded('anthropic', null);
    expect(keyless.result.current).toMatchObject({ models: [], error: KEY_REQUIRED.error });

    serveModels(() => HttpResponse.json({ models: [], provider: 'openai', requestId: 'r4' }));
    const empty = await renderLoaded('openai', 'sk-1');
    expect(empty.result.current).toMatchObject({ models: [], error: 'No models returned.' });
  });

  it('a failed request shows its message, or "Failed to fetch models." without one', async () => {
    serveModels(() => HttpResponse.json(UPSTREAM_ERROR, { status: 502 }));
    const failed = await renderLoaded('gemini', 'AIza-1');
    expect(failed.result.current).toMatchObject({ models: [], error: UPSTREAM_ERROR.error });

    serveModels(() => HttpResponse.error());
    const offline = await renderLoaded('gemini', 'AIza-2');
    expect(offline.result.current).toMatchObject({ models: [], error: 'Failed to fetch' });

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError(''));
    const silent = await renderLoaded('gemini', 'AIza-3');
    expect(silent.result.current).toMatchObject({ models: [], error: 'Failed to fetch models.' });
  });

  it('refresh() refetches the list in use, which stays shown meanwhile', async () => {
    const later = gated(ok);
    serveModels((request) => (requests.length === 1 ? ok(request) : later.reply(request)));
    const { result } = await renderLoaded('anthropic', 'sk-ant-1');

    act(() => { result.current.refresh(); });
    expect(result.current).toMatchObject({ models: listFor('anthropic', 'sk-ant-1').models, loading: true, error: null });
    await waitFor(() => expect(requests).toHaveLength(2));
    later.release();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(requests.map(keyOf)).toEqual(['sk-ant-1', 'sk-ant-1']);
  });

  it('a failed refresh blanks the list and shows the error, as the dialog\'s catch did; the next restores it', async () => {
    serveModels((request) => (requests.length === 2
      ? HttpResponse.json(UPSTREAM_ERROR, { status: 502 })
      : ok(request)));
    const { result } = await renderLoaded('gemini', 'AIza-1');

    act(() => { result.current.refresh(); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ models: [], error: UPSTREAM_ERROR.error });

    act(() => { result.current.refresh(); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ models: listFor('gemini', 'AIza-1').models, error: null });
    expect(requests).toHaveLength(3);
  });

  it('refresh(key) in the handler that saves a key fetches the saved key, even one whose list is cached, and never the key it replaces', async () => {
    serveModels();
    // Gemini without a key: the AI tab's "Refresh models" saves the pasted draft (flush) and refreshes at once.
    const gemini = renderOnSavedKey('gemini', 'ai_key_gemini');
    act(() => {
      savePreference('ai_key_gemini', 'AIza-1');
      gemini.result.current.refresh('AIza-1');
    });
    await waitFor(() => expect(gemini.result.current.models).toEqual(listFor('gemini', 'AIza-1').models));
    await advance(1_000);
    expect(requests.map(keyOf)).toEqual(['AIza-1']);

    // A key whose list is cached and fresh is fetched again, and the key it replaces is not: refresh(key) refetches the
    // saved key's entry and only marks the rest of the provider's stale (the replaced key's query is still the one
    // observed when the handler runs, and a refetch of it would be a request for a key the user has just replaced).
    const anthropic = renderOnSavedKey('anthropic', 'ai_key_anthropic');
    act(() => { savePreference('ai_key_anthropic', 'sk-ant-1'); });
    await waitFor(() => expect(anthropic.result.current.models).toEqual(listFor('anthropic', 'sk-ant-1').models));
    act(() => { savePreference('ai_key_anthropic', 'sk-ant-2'); });
    await waitFor(() => expect(anthropic.result.current.models).toEqual(listFor('anthropic', 'sk-ant-2').models));
    act(() => {
      savePreference('ai_key_anthropic', 'sk-ant-1');
      anthropic.result.current.refresh('sk-ant-1');
    });
    expect(anthropic.result.current.loading).toBe(true);
    await waitFor(() => expect(anthropic.result.current.loading).toBe(false));
    expect(anthropic.result.current.models).toEqual(listFor('anthropic', 'sk-ant-1').models);
    expect(requests.filter((request) => keyOf(request) === 'sk-ant-1')).toHaveLength(2);
    expect(requests.filter((request) => keyOf(request) === 'sk-ant-2')).toHaveLength(1);
  });

  it('a token set or cleared drops every cached list, so the next mount fetches again', async () => {
    serveModels();
    (await renderLoaded('anthropic', null)).unmount();
    (await renderLoaded('gemini', 'AIza-1')).unmount();

    act(() => { setToken('tok-1'); });
    // Removed, not reset: a reset entry no hook observes would never be collected.
    expect(queryClient.getQueryCache().findAll({ queryKey: ['models'] })).toHaveLength(0);
    for (const [provider, apiKey] of [['anthropic', null], ['gemini', 'AIza-1']]) {
      const { result, unmount } = renderModels(provider, apiKey);
      expect(result.current).toMatchObject({ models: [], loading: true });
      await waitFor(() => expect(result.current.loading).toBe(false));
      unmount();
    }
    expect(requests.map(authOf)).toEqual([null, null, 'Bearer tok-1', 'Bearer tok-1']);

    act(() => { clearToken(); });
    const { result } = renderModels('anthropic', null);
    expect(result.current).toMatchObject({ models: [], loading: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(requests).toHaveLength(5);
    expect(authOf(requests[4])).toBeNull();
  });

  it('a token set while a list is shown fetches it again with the token', async () => {
    serveModels();
    const { result } = await renderLoaded('anthropic', null);

    act(() => { setToken('tok-1'); });
    expect(result.current).toMatchObject({ models: [], loading: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ models: listFor('anthropic', null).models, error: null });
    expect(requests.map(authOf)).toEqual([null, 'Bearer tok-1']);
  });

  it('a dead-token reply clears the token, and the list is fetched again without it', async () => {
    localStorage.setItem('access_token', 'tok-dead');
    serveModels((request) => HttpResponse.json(authOf(request)
      ? { error: 'Access token has expired', code: 'TOKEN_EXPIRED', models: [], provider: 'anthropic', requestId: 'r5' }
      : { error: 'Access token required', code: 'TOKEN_REQUIRED', models: [], provider: 'anthropic', requestId: 'r6' },
    { status: 401 }));
    const { result } = renderModels('anthropic', null);
    await waitFor(() => expect(requests).toHaveLength(2));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(localStorage.getItem('access_token')).toBeNull();
    expect(requests.map(authOf)).toEqual(['Bearer tok-dead', null]);
    expect(result.current).toMatchObject({ models: [], error: 'Access token required' });
  });
});
