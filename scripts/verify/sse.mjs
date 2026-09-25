// scripts/verify/sse.mjs — Phase 2 checks; loaded by scripts/verify-functions.mjs with its helpers.
// LLM streaming (F6-F8, M7): SSE framing, per-provider events, askLLMStream end-to-end, server output caps and body timeout.
// The client modules (src/lib/sse.js, src/lib/api.js) run under Node against the runner's fetch stub;
// api.js reads the access token through auth.js, so those checks stub localStorage for their duration.
import { readFile } from 'node:fs/promises';

const SSE_URL = new URL('../../src/lib/sse.js', import.meta.url);
const API_URL = new URL('../../src/lib/api.js', import.meta.url);
const THRESHOLDS_URL = new URL('../../shared/thresholds.js', import.meta.url);
const HOST_GLOBALS = /\b(?:console|process|window|document|navigator|globalThis|fetch|require|localStorage|sessionStorage|Buffer)\b/g;

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

/** Install a Map-backed localStorage (auth.js reads the access token from it); returns the restore function. */
function stubLocalStorage() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => { map.set(String(k), String(v)); },
    removeItem: (k) => { map.delete(String(k)); },
    clear: () => { map.clear(); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  };
}

const PARAMS = { messages: [{ role: 'user', content: 'hi' }], financialContext: 'ctx', ticker: 'AVGO', provider: 'anthropic' };
const anthropicText = (text) => `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`;

export default async function run(ctx) {
  const { t, assert, req, json, mint, calls, ROOT, SECRET, setFetch, resetFetch } = ctx;
  console.log('sse');

  let sse = null;
  let api = null;
  const askLLMModule = await import(ROOT + 'askLLM.js');
  const askLLM = askLLMModule.default;
  const { fetchWithTimeout, isTimeoutError } = await import(ROOT + 'lib/http.js');

  /** askLLMStream against a stubbed upstream and localStorage; the text chunks are collected into `chunks`. */
  const stream = async (response, { params = PARAMS, signal = null, chunks = [] } = {}) => {
    const restore = stubLocalStorage();
    try {
      setFetch(async () => (typeof response === 'function' ? response() : response));
      const result = await api.askLLMStream(params, (c) => chunks.push(c), signal);
      return { result, chunks };
    } finally {
      resetFetch();
      restore();
    }
  };

  await t('modules load; src/lib/sse.js is import-free and pure (no host globals)', async () => {
    sse = await import(SSE_URL);
    api = await import(API_URL);
    assert.equal(typeof sse.drainSSEBuffer, 'function');
    assert.equal(typeof sse.parseSSEEvents, 'function');
    assert.equal(typeof api.askLLMStream, 'function');
    assert.deepEqual({ ...sse.STOP_REASON }, {
      END: 'end', MAX_TOKENS: 'max_tokens', REFUSAL: 'refusal', SAFETY: 'safety', PROMPT_BLOCKED: 'prompt_blocked', OTHER: 'other',
    });
    assert.ok(Object.isFrozen(sse.STOP_REASON));
    // Strip comments (keeping string literals, so a '//' inside a string is not taken for one).
    const src = await readFile(SSE_URL, 'utf8');
    const code = src.replace(/('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_, str) => str ?? '');
    assert.doesNotMatch(code, /^\s*import\b|\bimport\s*\(/m, 'sse.js must stay import-free');
    assert.deepEqual(code.match(HOST_GLOBALS), null, 'sse.js must stay pure');
  });
  if (!sse || !api) return; // every later check would only repeat the load failure
  const { STOP_REASON } = sse;

  await t('drainSSEBuffer: data lines only ([DONE], event:, id:, retry:, comments dropped); partial tail kept; CRLF; final flush', async () => {
    assert.deepEqual(sse.drainSSEBuffer('data: {"a":1}\nevent: x\n: comment\ndata: [DONE]\n\ndata: {"b"'), { payloads: ['{"a":1}'], rest: 'data: {"b"' });
    assert.deepEqual(sse.drainSSEBuffer('event: message\r\ndata: {"a":1}\r\n\r\nid: 7\r\nretry: 100\r\ndata: {"b":2}\r\n\r\n'), { payloads: ['{"a":1}', '{"b":2}'], rest: '' });
    // A CRLF split between chunks: the '\r' waits in `rest` until its '\n' arrives.
    const first = sse.drainSSEBuffer('data: {"a":1}\r');
    assert.deepEqual(first, { payloads: [], rest: 'data: {"a":1}\r' });
    assert.deepEqual(sse.drainSSEBuffer(`${first.rest}\n`), { payloads: ['{"a":1}'], rest: '' });
    // final: every line is consumed, including one with no trailing newline.
    assert.deepEqual(sse.drainSSEBuffer('data: {"a":1}\n\ndata: {"b":2}', { final: true }), { payloads: ['{"a":1}', '{"b":2}'], rest: '' });
    assert.deepEqual(sse.drainSSEBuffer('data:{"a":1}\ndata:   \ndata:\n', { final: true }), { payloads: ['{"a":1}'], rest: '' });
    assert.deepEqual(sse.drainSSEBuffer(''), { payloads: [], rest: '' });
  });

  await t('parseSSEEvents (anthropic, the default): text_delta, error, message_delta stop reasons; other events and garbage ignored', async () => {
    const P = (event, provider = 'anthropic') => sse.parseSSEEvents(JSON.stringify(event), provider);
    assert.deepEqual(P({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }), [{ type: 'text', text: 'Hi' }]);
    assert.deepEqual(P({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }, undefined), [{ type: 'text', text: 'Hi' }]);
    assert.deepEqual(P({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
      [{ type: 'error', message: 'Overloaded', code: 'overloaded_error' }]);
    const stop = (raw) => P({ type: 'message_delta', delta: { stop_reason: raw }, usage: { output_tokens: 12 } });
    assert.deepEqual(stop('end_turn'), [{ type: 'stop', reason: STOP_REASON.END, raw: 'end_turn' }]);
    assert.deepEqual(stop('stop_sequence'), [{ type: 'stop', reason: STOP_REASON.END, raw: 'stop_sequence' }]);
    assert.deepEqual(stop('max_tokens'), [{ type: 'stop', reason: STOP_REASON.MAX_TOKENS, raw: 'max_tokens' }]);
    assert.deepEqual(stop('refusal'), [{ type: 'stop', reason: STOP_REASON.REFUSAL, raw: 'refusal' }]);
    assert.deepEqual(stop('pause_turn'), [{ type: 'stop', reason: STOP_REASON.OTHER, raw: 'pause_turn' }]);
    assert.deepEqual(stop('toString'), [{ type: 'stop', reason: STOP_REASON.OTHER, raw: 'toString' }], 'no prototype lookups');
    for (const event of [
      { type: 'message_start', message: { id: 'msg_1' } }, { type: 'ping' }, { type: 'message_stop' },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
      { type: 'message_delta', delta: { stop_reason: null } },
    ]) assert.deepEqual(P(event), [], JSON.stringify(event));
    for (const garbage of ['{"type":', 'not json', 'null', '42', '"text"']) assert.deepEqual(sse.parseSSEEvents(garbage, 'anthropic'), [], garbage);
  });

  await t('parseSSEEvents (openai): content, finish_reason (text before stop in one chunk), top-level error', async () => {
    const P = (event) => sse.parseSSEEvents(JSON.stringify(event), 'openai');
    const chunk = (delta, finish = null) => ({ id: 'c1', choices: [{ index: 0, delta, finish_reason: finish }] });
    assert.deepEqual(P(chunk({ content: 'Hel' })), [{ type: 'text', text: 'Hel' }]);
    assert.deepEqual(P(chunk({ content: 'lo' }, 'length')), [{ type: 'text', text: 'lo' }, { type: 'stop', reason: STOP_REASON.MAX_TOKENS, raw: 'length' }]);
    assert.deepEqual(P(chunk({}, 'stop')), [{ type: 'stop', reason: STOP_REASON.END, raw: 'stop' }]);
    assert.deepEqual(P(chunk({}, 'content_filter')), [{ type: 'stop', reason: STOP_REASON.SAFETY, raw: 'content_filter' }]);
    assert.deepEqual(P(chunk({}, 'tool_calls')), [{ type: 'stop', reason: STOP_REASON.OTHER, raw: 'tool_calls' }]);
    assert.deepEqual(P(chunk({ role: 'assistant', content: '' })), []);
    assert.deepEqual(P({ id: 'c1', choices: [], usage: { completion_tokens: 3 } }), []);
    assert.deepEqual(P({ error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } }),
      [{ type: 'error', message: 'Rate limit reached', code: 'rate_limit_exceeded' }]);
    assert.deepEqual(P({ error: { message: 'boom', type: 'server_error', code: null } }), [{ type: 'error', message: 'boom', code: 'server_error' }]);
  });

  await t('parseSSEEvents (gemini): parts + finishReason together, safety family, promptFeedback block, error body', async () => {
    const P = (event) => sse.parseSSEEvents(JSON.stringify(event), 'gemini');
    const candidate = (parts, finishReason) => ({ candidates: [{ content: { parts, role: 'model' }, ...(finishReason ? { finishReason } : {}) }] });
    assert.deepEqual(P(candidate([{ text: 'Hel' }, { text: 'lo' }])), [{ type: 'text', text: 'Hello' }]);
    assert.deepEqual(P(candidate([{ text: 'Done.' }], 'STOP')), [{ type: 'text', text: 'Done.' }, { type: 'stop', reason: STOP_REASON.END, raw: 'STOP' }]);
    assert.deepEqual(P(candidate([{ text: 'Cut' }], 'MAX_TOKENS')), [{ type: 'text', text: 'Cut' }, { type: 'stop', reason: STOP_REASON.MAX_TOKENS, raw: 'MAX_TOKENS' }]);
    for (const raw of ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']) {
      assert.deepEqual(P({ candidates: [{ finishReason: raw, safetyRatings: [] }] }), [{ type: 'stop', reason: STOP_REASON.SAFETY, raw }], raw);
    }
    assert.deepEqual(P({ candidates: [{ finishReason: 'OTHER' }] }), [{ type: 'stop', reason: STOP_REASON.OTHER, raw: 'OTHER' }]);
    assert.deepEqual(P({ promptFeedback: { blockReason: 'SAFETY' } }), [{ type: 'stop', reason: STOP_REASON.PROMPT_BLOCKED, raw: 'SAFETY' }]);
    assert.deepEqual(P({ error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } }),
      [{ type: 'error', message: 'Resource has been exhausted', code: 'RESOURCE_EXHAUSTED' }]);
    assert.deepEqual(P({ candidates: [{ content: { parts: 'not-an-array' } }] }), []);
  });

  await t('askLLMStream (anthropic): a line split mid-JSON is reassembled; resolves { stopReason, chars, requestId, provider }', async () => {
    const restore = stubLocalStorage();
    try {
      localStorage.setItem('access_token', 'tok-1');
      setFetch(async () => sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{}}\n\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","te',
        'xt":"Hel"}}\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      ], { headers: { 'X-Provider': 'anthropic', 'X-Request-Id': 'r1' } }));
      const controller = new AbortController();
      const chunks = [];
      const result = await api.askLLMStream(PARAMS, (c) => chunks.push(c), controller.signal);
      assert.deepEqual(chunks, ['Hel', 'lo']);
      assert.deepEqual(result, { stopReason: 'end', chars: 5, requestId: 'r1', provider: 'anthropic' });
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/\.netlify\/functions\/askLLM$/);
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.stream, true); assert.equal(sent.ticker, 'AVGO'); assert.equal(sent.provider, 'anthropic');
      assert.equal(calls[0].init.signal, controller.signal, 'the caller signal is passed to fetch');
      assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-1');
    } finally {
      resetFetch();
      restore();
    }
  });

  await t('askLLMStream: a provider error mid-stream rejects STREAM_ERROR (partial, providerCode, requestId) after delivering the text', async () => {
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

  await t('askLLMStream: no text → EMPTY_RESPONSE; a refusal / block without text → REFUSED; text without a stop → stopReason null', async () => {
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

  await t('askLLMStream: abort mid-stream cancels the reader and rejects AbortError; an aborted signal never reads', async () => {
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

  await t('askLLMStream (gemini): \\r\\n\\r\\n framing, no trailing newline, split UTF-8 character → text and stop still delivered', async () => {
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

  await t('output caps: longest-prefix model limits, BYOK ceiling 16384, server cap 4096 / MAX_OUTPUT_TOKENS', async () => {
    const { maxOutputTokens, providerOutputCap, PROVIDER_OUTPUT_CAPS, DEFAULT_OUTPUT_CAP, BYOK_OUTPUT_CAP } = askLLMModule;
    try {
      assert.equal(DEFAULT_OUTPUT_CAP, 16384); assert.equal(BYOK_OUTPUT_CAP, 16384);
      for (const [model, cap] of [
        ['claude-opus-5', 16384], ['claude-3-haiku-20240307', 4096], ['gpt-4', 8192], ['gpt-4o', 16384],
        ['gemini-2.0-flash', 8192], ['gemini-2.5-flash', 16384], ['gpt-5.1', 16384], ['claude-3-5-haiku-20241022', 8192],
      ]) assert.equal(maxOutputTokens(model, 'user'), cap, `user cap for ${model}`);
      for (const [model, cap] of [
        ['claude-opus-5', 128000], ['claude-fable-5-1', 128000], ['claude-mythos-5-1', 128000], ['claude-sonnet-4-5', 64000],
        ['claude-sonnet-4-5-20250929', 64000], ['claude-haiku-4-5', 64000], ['claude-opus-4-1-20250805', 32000],
        ['claude-sonnet-4-20250514', 64000], ['claude-opus-4-20250514', 32000], ['gpt-5.1', 128000], ['o3-mini', 100000],
        ['gpt-4-turbo-2024-04-09', 4096], ['gpt-4o-mini', 16384], ['gpt-4.1-mini', 32768], ['gemini-3.8-flash', 65536],
        ['unknown-model', 16384],
      ]) assert.equal(providerOutputCap(model), cap, `model limit for ${model}`);
      const prefixes = PROVIDER_OUTPUT_CAPS.map(([prefix]) => prefix);
      assert.equal(new Set(prefixes).size, prefixes.length, 'prefixes are unique');
      for (const [prefix, cap] of PROVIDER_OUTPUT_CAPS) {
        assert.ok(Number.isInteger(cap) && cap > 0, `${prefix}: positive integer cap`);
        assert.equal(providerOutputCap(prefix), cap, `${prefix} resolves to its own cap`);
      }
      assert.equal(maxOutputTokens('claude-opus-5', 'server'), 4096);
      assert.equal(maxOutputTokens('claude-3-haiku-20240307', 'server'), 4096);
      process.env.MAX_OUTPUT_TOKENS = '1000';
      assert.equal(maxOutputTokens('claude-opus-5', 'server'), 1000);
      process.env.MAX_OUTPUT_TOKENS = '100000';
      assert.equal(maxOutputTokens('claude-3-5-haiku-20241022', 'server'), 8192, 'never above the model limit');
    } finally {
      delete process.env.MAX_OUTPUT_TOKENS;
    }
  });

  await t('askLLM (openai BYOK): gpt-5.x / o-series send max_completion_tokens + developer role; gpt-4o sends max_tokens + system', async () => {
    process.env.TOKEN_SECRET = SECRET;
    try {
      setFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
      const sentFor = async (model) => {
        calls.length = 0;
        const r = await json(await askLLM(req('askLLM', { method: 'POST', body: {
          provider: 'openai', userApiKey: 'sk-user', model, messages: [{ role: 'user', content: 'hi' }], stream: false,
        } })));
        assert.equal(r.status, 200, JSON.stringify(r.body));
        return JSON.parse(calls[0].init.body);
      };
      for (const model of ['gpt-5.1', 'o3-mini']) {
        const sent = await sentFor(model);
        assert.equal(sent.max_completion_tokens, 16384, model); assert.equal('max_tokens' in sent, false, model);
        assert.equal(sent.messages[0].role, 'developer', model);
      }
      const sent = await sentFor('gpt-4o');
      assert.equal(sent.max_tokens, 16384); assert.equal('max_completion_tokens' in sent, false);
      assert.equal(sent.messages[0].role, 'system');
    } finally {
      resetFetch();
    }
  });

  await t('fetchWithTimeout: bodyTimeout false bounds only time-to-headers; the default also bounds the body', async () => {
    // Mimics fetch: headers at once, body 80 ms later, and the request signal errors the body.
    const lateBody = async (url, init) => {
      let ctl;
      const body = new ReadableStream({
        start(c) {
          ctl = c;
          setTimeout(() => { try { c.enqueue(encoder.encode('late')); c.close(); } catch { /* already errored */ } }, 80);
        },
      });
      init.signal?.addEventListener('abort', () => { try { ctl.error(init.signal.reason); } catch { /* closed */ } });
      return new Response(body);
    };
    try {
      setFetch(lateBody);
      const res = await fetchWithTimeout('https://x.test/', {}, 30, null, { bodyTimeout: false });
      assert.equal(await res.text(), 'late', 'the 30 ms timer was cleared when the headers arrived');
      assert.equal(calls[0].init.signal.aborted, false);

      const res2 = await fetchWithTimeout('https://x.test/', {}, 30);
      await assert.rejects(res2.text(), (err) => err.name === 'TimeoutError', 'default: the timeout covers the body');
      setFetch(async () => new Response('ok'));
      assert.equal(await (await fetchWithTimeout('https://x.test/', {}, 1000)).text(), 'ok');

      // No headers in time: rejects with a TimeoutError that askLLM maps to 504.
      setFetch((url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      }));
      await assert.rejects(fetchWithTimeout('https://x.test/', {}, 30, null, { bodyTimeout: false }), (err) => {
        assert.equal(err.name, 'TimeoutError'); assert.equal(isTimeoutError(err), true); assert.match(err.message, /30 ms/);
        return true;
      });
      // The parent (client) signal still aborts the upstream.
      const parent = new AbortController();
      const pending = fetchWithTimeout('https://x.test/', {}, 1000, parent.signal, { bodyTimeout: false });
      parent.abort();
      await assert.rejects(pending, (err) => err.name === 'AbortError' && isTimeoutError(err));

      // askLLM streams: every provider call opts out of the body timeout.
      const src = await readFile(new URL(ROOT + 'askLLM.js'), 'utf8');
      const providerCalls = (src.match(/\bfetchWithTimeout\(/g) || []).length;
      assert.equal(providerCalls, 3, 'one fetchWithTimeout call per provider');
      assert.equal((src.match(/\{ bodyTimeout: false \}\);/g) || []).length, providerCalls, 'each provider call passes { bodyTimeout: false }');
    } finally {
      resetFetch();
    }
  });

  await t('askLLM: the system prompt takes its put/call bands from shared/thresholds.js', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-server'; process.env.TOKEN_SECRET = SECRET;
    try {
      setFetch(async () => new Response('data: {"type":"message_stop"}\n\n', { status: 200 }));
      const res = await askLLM(req('askLLM', { method: 'POST', body: {
        provider: 'anthropic', messages: [{ role: 'user', content: 'hi' }], stream: true, ticker: 'AVGO',
      }, headers: { authorization: `Bearer ${mint()}` } }));
      assert.equal(res.status, 200);
      const { system } = JSON.parse(calls[0].init.body);
      const { PUT_CALL } = await import(THRESHOLDS_URL);
      assert.ok(system.includes('<0.7') && system.includes('>1'), 'P/C bands in the prompt');
      assert.ok(system.includes(`<${PUT_CALL.bullishBelow} is bullish, ${PUT_CALL.bullishBelow}-${PUT_CALL.bearishAbove} neutral, >${PUT_CALL.bearishAbove} bearish`));
      await res.body?.cancel();
    } finally {
      resetFetch();
    }
  });

  await t('askLLM: default models are claude-opus-5 / gpt-5.1 / gemini-3.8-flash', async () => {
    const base = { messages: [{ role: 'user', content: 'hi' }] };
    assert.equal(askLLMModule.validatePayload({ ...base, provider: 'anthropic' }).value.model, 'claude-opus-5');
    assert.equal(askLLMModule.validatePayload({ ...base, provider: 'openai' }).value.model, 'gpt-5.1');
    assert.equal(askLLMModule.validatePayload({ ...base, provider: 'gemini' }).value.model, 'gemini-3.8-flash');
  });
}
