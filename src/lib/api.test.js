// src/lib/api.test.js — the client side of the function calls in api.js.
// askLLMStream end to end (LLM streaming, F6-F8, M7): the request it sends, text split anywhere in the stream
// (mid-JSON, a CRLF, a UTF-8 character, every third byte), provider errors, refusals, empty replies and abort. The SSE
// parser itself is in sse.test.js, the server side (output caps, the body timeout) in
// netlify/functions/__tests__/askLLM.test.js.
// The GET fetchers (fetchMarketData, fetchLiveQuote, fetchTickerContext, fetchModels) against the dom setup's MSW
// server: the query and key headers each sends, the Error each throws, dead-token clearing and abort forwarding.
// In the askLLMStream block the fetch recorder (test/helpers/fetch.js) goes over the dom setup's fetch before each test
// and answers with the streamed bodies built here, so no request reaches MSW and the recorded URL is the relative one
// api.js fetches. The fetchers block keeps the setup's fetch, which resolves those relative URLs against jsdom's origin
// for MSW. auth.js and store.js read the access token and the API keys from jsdom's localStorage, which the setup
// clears after each test. The abort tests run on real timers: never fake timers in this file.
import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { http, HttpResponse } from 'msw';
import * as api from './api.js';
import { AUTH_EVENT } from './auth.js';
import { STOP_REASON } from './sse.js';
import { setPreference } from './store.js';
import { server } from '../test/setup.js';
import { installFetchRecorder } from '../../test/helpers/fetch.js';

const encoder = new TextEncoder();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A streamed Response: each chunk (string or bytes) is enqueued on its own macrotask, as a network would. */
function sseResponse(chunks, { headers = {} } = {}) {
  let i = 0;
  let cancelled = false;
  const body = new ReadableStream({
    async pull(controller) {
      if (i > 0) await tick();
      if (cancelled) return;
      if (i >= chunks.length) { controller.close(); return; }
      const chunk = chunks[i++];
      controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
    },
    cancel() { cancelled = true; },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', ...headers } });
}

const PARAMS = { messages: [{ role: 'user', content: 'hi' }], financialContext: 'ctx', ticker: 'AVGO', provider: 'anthropic' };
const anthropicText = (text) => `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`;

describe('askLLMStream', () => {
  let rec;
  beforeEach(() => { rec = installFetchRecorder(); });
  afterEach(() => rec.uninstall());

  /** askLLMStream against a stubbed upstream; the text chunks are collected into `chunks`. */
  const stream = async (response, { params = PARAMS, signal = null, chunks = [] } = {}) => {
    try {
      rec.setFetch(async () => (typeof response === 'function' ? response() : response));
      const result = await api.askLLMStream(params, (c) => chunks.push(c), signal);
      return { result, chunks };
    } finally {
      rec.resetFetch();
    }
  };

  it('askLLMStream (anthropic): a line split mid-JSON is reassembled; resolves { stopReason, chars, requestId, provider }', async () => {
    try {
      localStorage.setItem('access_token', 'tok-1');
      rec.setFetch(async () => sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{}}\n\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","te',
        'xt":"Hel"}}\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      ], { headers: { 'X-Provider': 'anthropic', 'X-Request-Id': 'r1' } }));
      const controller = new AbortController();
      const chunks = [];
      const result = await api.askLLMStream(PARAMS, (c) => chunks.push(c), controller.signal);
      assert.deepEqual(chunks, ['Hel', 'lo']);
      assert.deepEqual(result, { stopReason: 'end', chars: 5, requestId: 'r1', provider: 'anthropic' });
      assert.equal(rec.calls.length, 1);
      assert.match(rec.calls[0].url, /\/\.netlify\/functions\/askLLM$/);
      const sent = JSON.parse(rec.calls[0].init.body);
      assert.equal(sent.stream, true); assert.equal(sent.ticker, 'AVGO'); assert.equal(sent.provider, 'anthropic');
      assert.equal(rec.calls[0].init.signal, controller.signal, 'the caller signal is passed to fetch');
      assert.equal(rec.calls[0].init.headers.Authorization, 'Bearer tok-1');
    } finally {
      rec.resetFetch();
    }
  });

  it('askLLMStream: a provider error mid-stream rejects STREAM_ERROR (partial, providerCode, requestId) after delivering the text', async () => {
    const chunks = [];
    await assert.rejects(stream(sseResponse([
      anthropicText('Partial'),
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
      anthropicText(' never delivered'),
    ], { headers: { 'X-Provider': 'anthropic', 'X-Request-Id': 'r2' } }), { chunks }), (err) => {
      assert.equal(err.code, 'STREAM_ERROR'); assert.equal(err.partial, true); assert.equal(err.providerCode, 'overloaded_error');
      assert.equal(err.requestId, 'r2'); assert.equal(err.message, 'Overloaded');
      return true;
    });
    assert.deepEqual(chunks, ['Partial']);
    // Before any text, and with no message: partial is false and the message names the provider.
    await assert.rejects(stream(sseResponse(['data: {"error":{"type":"server_error"}}\n\n'], { headers: { 'X-Provider': 'openai' } }),
      { params: { ...PARAMS, provider: 'openai' } }), (err) => {
      assert.equal(err.code, 'STREAM_ERROR'); assert.equal(err.partial, false); assert.equal(err.providerCode, 'server_error');
      assert.equal(err.requestId, null); assert.equal(err.message, 'The openai API reported an error');
      return true;
    });
  });

  it('askLLMStream: no text → EMPTY_RESPONSE; a refusal / block without text → REFUSED; text without a stop → stopReason null', async () => {
    const headers = { 'X-Provider': 'anthropic', 'X-Request-Id': 'r3' };
    await assert.rejects(stream(sseResponse(['event: message_start\ndata: {"type":"message_start","message":{}}\n\n', 'data: {"type":"message_stop"}\n\n'], { headers })),
      (err) => err.code === 'EMPTY_RESPONSE' && err.requestId === 'r3' && err.message === 'The model returned an empty response');
    await assert.rejects(stream(sseResponse(['data: {"type":"message_delta","delta":{"stop_reason":"refusal"}}\n\n'], { headers })), (err) => {
      assert.equal(err.code, 'REFUSED'); assert.equal(err.stopReason, STOP_REASON.REFUSAL); assert.equal(err.requestId, 'r3');
      assert.equal(err.message, 'The model declined to answer (refusal)');
      return true;
    });
    await assert.rejects(stream(sseResponse(['data: {"promptFeedback":{"blockReason":"SAFETY"}}\r\n\r\n'], { headers: { 'X-Provider': 'gemini' } }),
      { params: { ...PARAMS, provider: 'gemini' } }), (err) => err.code === 'REFUSED' && err.stopReason === STOP_REASON.PROMPT_BLOCKED && /SAFETY/.test(err.message));
    // max_tokens with no text is not a refusal
    await assert.rejects(stream(sseResponse(['data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n'], { headers })),
      (err) => err.code === 'EMPTY_RESPONSE' && err.stopReason === STOP_REASON.MAX_TOKENS);
    const { result } = await stream(sseResponse([anthropicText('Half an ans')], { headers }));
    assert.deepEqual(result, { stopReason: null, chars: 11, requestId: 'r3', provider: 'anthropic' });
    // A function error keeps the apiError shape (status, code, requestId).
    await assert.rejects(stream(new Response(JSON.stringify({ error: 'Too many requests', code: 'RATE_LIMITED', requestId: 'r4' }), { status: 429 })),
      (err) => err.status === 429 && err.code === 'RATE_LIMITED' && err.requestId === 'r4');
  });

  it('askLLMStream: abort mid-stream cancels the reader and rejects AbortError; an aborted signal never reads', async () => {
    let cancelledWith;
    const controller = new AbortController();
    const chunks = [];
    const pending = stream(() => new Response(new ReadableStream({
      start(c) { c.enqueue(encoder.encode(anthropicText('Hi'))); },
      pull() { return new Promise(() => {}); }, // the upstream goes quiet
      cancel(reason) { cancelledWith = reason ?? 'cancelled'; },
    }), { headers: { 'X-Provider': 'anthropic' } }), { signal: controller.signal, chunks });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (err) => err.name === 'AbortError');
    assert.deepEqual(chunks, ['Hi']);
    assert.ok(cancelledWith, 'the body reader was cancelled');
    assert.equal(cancelledWith?.name, 'AbortError', 'cancelled with the signal reason');

    let cancelled = false;
    const early = [];
    await assert.rejects(stream(() => new Response(new ReadableStream({
      start(c) { c.enqueue(encoder.encode(anthropicText('never'))); },
      cancel() { cancelled = true; },
    })), { signal: AbortSignal.abort(), chunks: early }), (err) => err.name === 'AbortError');
    assert.deepEqual(early, []);
    assert.equal(cancelled, true, 'the unread body is released');
  });

  it('askLLMStream (gemini): \\r\\n\\r\\n framing, no trailing newline, split UTF-8 character → text and stop still delivered', async () => {
    const tail = encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"€5"}],"role":"model"},"finishReason":"STOP"}]}');
    const cut = tail.indexOf(0xe2) + 1; // inside the 3-byte '€'
    const { result, chunks } = await stream(sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}],"role":"model"}}]}\r\n\r\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo "}],"role":"model"}}]}\r\n\r\n',
      tail.slice(0, cut), tail.slice(cut),
    ], { headers: { 'X-Provider': 'gemini', 'X-Request-Id': 'g1' } }), { params: { ...PARAMS, provider: 'gemini' } });
    assert.equal(chunks.join(''), 'Hello €5');
    assert.deepEqual(result, { stopReason: 'end', chars: 8, requestId: 'g1', provider: 'gemini' });
  });

  it('askLLMStream (anthropic): one stream cut in two at every third byte offset → the same deltas and stop each time', async () => {
    const bytes = encoder.encode([
      'event: message_start\ndata: {"type":"message_start","message":{}}\n\n',
      anthropicText('Hel'),
      anthropicText('lo €5'),
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    ].join(''));
    const euro = bytes.indexOf(0xe2); // the first of the 3 bytes of '€'
    let insideEuro = 0;
    for (let cut = 1; cut < bytes.length; cut += 3) {
      if (cut > euro && cut < euro + 3) insideEuro += 1;
      const { result, chunks } = await stream(sseResponse([bytes.slice(0, cut), bytes.slice(cut)],
        { headers: { 'X-Provider': 'anthropic', 'X-Request-Id': 'r5' } }));
      assert.deepEqual(chunks, ['Hel', 'lo €5'], `cut at byte ${cut}`);
      assert.deepEqual(result, { stopReason: 'end', chars: 8, requestId: 'r5', provider: 'anthropic' }, `cut at byte ${cut}`);
    }
    assert.ok(insideEuro > 0, 'a cut falls inside the €');
  });
});

// Where the setup's fetch sends api.js's relative /.netlify/functions URLs: jsdom's origin under Vitest.
const FN = 'http://localhost:3000/.netlify/functions';
/** The key headers a request can carry, all absent (Headers#get gives null). */
const NO_KEYS = { authorization: null, 'x-tradier-key': null, 'x-finnhub-key': null, 'x-api-key': null };

describe('fetchers (MSW)', () => {
  /** Every request the handlers saw, in order. */
  let requests;
  beforeEach(() => { requests = []; });

  /** A GET handler for one function: records the request, then answers with `respond()` (by default 200 `{ from: fn }`). */
  const route = (fn, respond = () => HttpResponse.json({ from: fn })) =>
    http.get(`${FN}/${fn}`, ({ request }) => { requests.push(request); return respond(); });

  /** What a recorded request carried: the function it called, its query and the key headers. */
  const sent = (request) => {
    const url = new URL(request.url);
    return {
      fn: url.pathname.slice('/.netlify/functions/'.length),
      query: Object.fromEntries(url.searchParams),
      ...Object.fromEntries(Object.keys(NO_KEYS).map((name) => [name, request.headers.get(name)])),
    };
  };

  it('fetchMarketData: GET getMarketData?ticker=, the Bearer token and x-tradier-key once stored (not before); resolves the JSON body', async () => {
    const body = { ticker: 'AVGO', provider: 'tradier', spotPrice: 412.5 };
    server.use(route('getMarketData', () => HttpResponse.json(body)));

    assert.deepEqual(await api.fetchMarketData('AVGO'), body);
    localStorage.setItem('access_token', 'tok-1');
    setPreference('data_tradier_key', 'trd-key');
    setPreference('data_finnhub_key', 'fh-key'); // another function's key
    assert.deepEqual(await api.fetchMarketData('AVGO', new AbortController().signal), body); // as useMarketData calls it

    assert.deepEqual(requests.map(sent), [
      { fn: 'getMarketData', query: { ticker: 'AVGO' }, ...NO_KEYS },
      { fn: 'getMarketData', query: { ticker: 'AVGO' }, ...NO_KEYS, authorization: 'Bearer tok-1', 'x-tradier-key': 'trd-key' },
    ]);
  });

  it('fetchLiveQuote and fetchTickerContext send x-finnhub-key (never the Tradier key); fetchModels sends x-api-key and ?provider=', async () => {
    server.use(route('getLiveQuote'), route('getTickerContext'), route('getModels'));

    await api.fetchLiveQuote('AVGO');
    await api.fetchTickerContext('AVGO');
    await api.fetchModels();
    localStorage.setItem('access_token', 'tok-1');
    setPreference('data_finnhub_key', 'fh-key');
    setPreference('data_tradier_key', 'trd-key');
    assert.deepEqual(await api.fetchLiveQuote('AVGO'), { from: 'getLiveQuote' });
    assert.deepEqual(await api.fetchTickerContext('AVGO'), { from: 'getTickerContext' });
    assert.deepEqual(await api.fetchModels('sk-user', 'openai'), { from: 'getModels' });

    const bearer = { authorization: 'Bearer tok-1' };
    assert.deepEqual(requests.map(sent), [
      { fn: 'getLiveQuote', query: { ticker: 'AVGO' }, ...NO_KEYS },
      { fn: 'getTickerContext', query: { ticker: 'AVGO' }, ...NO_KEYS },
      { fn: 'getModels', query: { provider: 'anthropic' }, ...NO_KEYS },
      { fn: 'getLiveQuote', query: { ticker: 'AVGO' }, ...NO_KEYS, ...bearer, 'x-finnhub-key': 'fh-key' },
      { fn: 'getTickerContext', query: { ticker: 'AVGO' }, ...NO_KEYS, ...bearer, 'x-finnhub-key': 'fh-key' },
      { fn: 'getModels', query: { provider: 'openai' }, ...NO_KEYS, ...bearer, 'x-api-key': 'sk-user' },
    ]);
  });

  it('a JSON error body (lib/http.js errorResponse) becomes the thrown Error: message, code, status and requestId', async () => {
    server.use(route('getMarketData', () => HttpResponse.json(
      { error: 'Failed to fetch market data for AVGO', code: 'UPSTREAM_ERROR', requestId: 'r1' }, { status: 502 })));
    await assert.rejects(api.fetchMarketData('AVGO'), (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'Failed to fetch market data for AVGO');
      assert.equal(err.code, 'UPSTREAM_ERROR');
      assert.equal(err.status, 502);
      assert.equal(err.requestId, 'r1');
      return true;
    });
  });

  it('401 TOKEN_EXPIRED: the stored token is removed and auth-changed dispatched once; no `error` → "Access token required"', async () => {
    let events = 0;
    const onAuthChanged = () => { events += 1; };
    window.addEventListener(AUTH_EVENT, onAuthChanged);
    try {
      localStorage.setItem('access_token', 'tok-old');
      server.use(route('getMarketData', () => HttpResponse.json({ code: 'TOKEN_EXPIRED' }, { status: 401 })));
      await assert.rejects(api.fetchMarketData('AVGO'), (err) => {
        assert.equal(err.message, 'Access token required'); // the body has no `error`
        assert.equal(err.code, 'TOKEN_EXPIRED');
        assert.equal(err.status, 401);
        return true;
      });
      assert.equal(requests[0].headers.get('authorization'), 'Bearer tok-old');
      assert.equal(localStorage.getItem('access_token'), null);
      assert.equal(events, 1);
    } finally {
      window.removeEventListener(AUTH_EVENT, onAuthChanged);
    }
  });

  it('a network failure rejects "Network error: <fetch message>" with the fetch error as cause and no status', async () => {
    // Only the three data fetchers wrap: fetchModels (and askLLMStream) reject with fetch's own TypeError.
    server.use(...['getMarketData', 'getLiveQuote', 'getTickerContext'].map((fn) => route(fn, () => HttpResponse.error())));
    for (const fetcher of [api.fetchMarketData, api.fetchLiveQuote, api.fetchTickerContext]) {
      await assert.rejects(fetcher('AVGO'), (err) => {
        assert.ok(err.cause instanceof Error, `${fetcher.name}: error.cause is the fetch error`);
        assert.equal(err.message, `Network error: ${err.cause.message}`);
        assert.equal(err.status, undefined);
        return true;
      });
    }
    assert.equal(requests.length, 3);
  });

  it('a non-JSON error body: the message is the status text, or without one (HTTP/2 has none) the status fallback', async () => {
    for (const [status, statusText, message] of [
      [429, 'Slow Down', 'Slow Down'], // HTTP/1.1 reason phrase: res.statusText
      [429, '', 'Too many requests'], // none: apiError's 429 text
      [502, '', 'API error: 502'], // none: apiError's `${fallback}: ${status}`
    ]) {
      server.use(route('getMarketData', () => new Response('<h1>not JSON</h1>', { status, statusText })));
      await assert.rejects(api.fetchMarketData('AVGO'), (err) => {
        assert.equal(err.message, message);
        assert.equal(err.status, status);
        assert.equal(err.code, null);
        assert.equal('requestId' in err, false);
        return true;
      });
    }
  });

  it('the caller signal reaches the request: aborting while the function holds it rejects the call and aborts request.signal', async () => {
    let arrived;
    const reached = new Promise((resolve) => { arrived = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    server.use(route('getMarketData', async () => { arrived(); await gate; return HttpResponse.json({ late: true }); }));
    const controller = new AbortController();
    try {
      const pending = api.fetchMarketData('AVGO', controller.signal);
      await reached;
      assert.equal(requests[0].signal.aborted, false);
      controller.abort();
      // Like any fetch rejection the abort is wrapped: the AbortError (the signal's reason) is the cause.
      await assert.rejects(pending, (err) => {
        assert.equal(err.cause, controller.signal.reason);
        assert.equal(err.cause.name, 'AbortError');
        assert.equal(err.message, `Network error: ${err.cause.message}`);
        return true;
      });
      assert.equal(requests[0].signal.aborted, true);
    } finally {
      release();
    }
  });
});
