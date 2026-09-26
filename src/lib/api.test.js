// src/lib/api.test.js — askLLMStream end to end (LLM streaming, F6-F8, M7): the request it sends, text split
// anywhere in the stream (mid-JSON, a CRLF, a UTF-8 character), provider errors, refusals, empty replies and abort.
// The SSE parser itself is in sse.test.js, the server side (output caps, the body timeout) in
// netlify/functions/__tests__/askLLM.test.js.
// Before each test the fetch recorder (test/helpers/fetch.js) goes over the dom setup's fetch and answers with the
// streamed bodies built here, so no request reaches MSW and the recorded URL is the relative one api.js fetches.
// auth.js reads the access token from jsdom's localStorage, which the setup clears after each test. The abort test
// runs on real timers: never fake timers in this file.
import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import * as api from './api.js';
import { STOP_REASON } from './sse.js';
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
});
