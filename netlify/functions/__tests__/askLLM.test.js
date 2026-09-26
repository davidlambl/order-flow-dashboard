// netlify/functions/__tests__/askLLM.test.js — the LLM proxy. Access and cost control (roadmap Phase 1): payload
// limits, the model allowlist and output cap, the server key failing closed without TOKEN_SECRET, BYOK per provider
// with the key never in a URL, sanitized upstream errors, the upstream timeout, the rate limit and CORS. Streaming,
// server side (F6-F8, M7): per-model output caps, the OpenAI token parameter and system role per model family, the
// body timeout every provider call opts out of, the prompt's put/call bands and the default models.
import { describe, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import askLLM, { validatePayload, modelAllowed, maxOutputTokens } from '../askLLM.js';
import * as askLLMModule from '../askLLM.js'; // the streaming checks read the cap table and defaults off the module
import { rateLimit, fetchWithTimeout, isTimeoutError } from '../lib/http.js';
import { PUT_CALL } from '../../../shared/thresholds.js';
import { installFunctionHarness } from '../../../test/helpers/functions.js';

const { calls, setFetch, resetFetch, reset, req, json, mint, assert, SECRET } = installFunctionHarness();

const goodBody = { provider: 'anthropic', messages: [{ role: 'user', content: 'hi' }], stream: true, ticker: 'AVGO' };
const encoder = new TextEncoder();

describe('askLLM', () => {
  it('validatePayload enforces shape limits', async () => {
    assert.equal(validatePayload({ ...goodBody, provider: 'x' }).error.code, 'PROVIDER_REQUIRED');
    assert.equal(validatePayload({ ...goodBody, messages: [] }).error.code, 'MESSAGES_REQUIRED');
    assert.equal(validatePayload({ ...goodBody, messages: Array(41).fill({ role: 'user', content: 'x' }) }).error.code, 'TOO_MANY_MESSAGES');
    assert.equal(validatePayload({ ...goodBody, messages: [{ role: 'user', content: [{ type: 'image' }] }] }).error.code, 'INVALID_MESSAGE');
    assert.equal(validatePayload({ ...goodBody, messages: [{ role: 'user', content: 'x'.repeat(9000) }] }).error.code, 'MESSAGE_TOO_LONG');
    assert.equal(validatePayload({ ...goodBody, financialContext: 'x'.repeat(40000) }).error.code, 'CONTEXT_TOO_LONG');
    assert.equal(validatePayload({ ...goodBody, ticker: '../x' }).error.code, 'INVALID_TICKER');
    assert.equal(validatePayload({ ...goodBody, model: 'gpt 4o' }).error.code, 'INVALID_MODEL');
    assert.equal(validatePayload({ ...goodBody, userApiKey: 'sk-openai' }).error.code, 'KEY_PROVIDER_MISMATCH');
    assert.equal(validatePayload(goodBody).value.model, 'claude-opus-5');
  });
  it('model allowlist + output cap', async () => {
    assert.equal(modelAllowed('claude-opus-5'), true); assert.equal(modelAllowed('gpt-4o'), false);
    assert.equal(modelAllowed('claude-x', ['claude-haiku-4-5']), false);
    assert.equal(maxOutputTokens('claude-opus-5', 'server'), 4096); assert.equal(maxOutputTokens('claude-opus-5', 'user'), 16384);
    process.env.MAX_OUTPUT_TOKENS = '1000'; assert.equal(maxOutputTokens('claude-opus-5', 'server'), 1000); delete process.env.MAX_OUTPUT_TOKENS;
    assert.equal(maxOutputTokens('gpt-4-turbo', 'user'), 4096);
  });
  it('fails CLOSED: server key present, TOKEN_SECRET unset → 503, upstream never called', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-server';
    const r = await json(await askLLM(req('askLLM', { method: 'POST', body: goodBody })));
    assert.equal(r.status, 503); assert.equal(r.body.code, 'AUTH_NOT_CONFIGURED'); assert.equal(calls.length, 0);
  });
  it('server key without token → 401 TOKEN_REQUIRED', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-server'; process.env.TOKEN_SECRET = SECRET;
    const r = await json(await askLLM(req('askLLM', { method: 'POST', body: goodBody })));
    assert.equal(r.status, 401); assert.equal(r.body.code, 'TOKEN_REQUIRED'); assert.equal(calls.length, 0);
  });
  it('no server key, no user key → 400 KEY_REQUIRED', async () => {
    process.env.TOKEN_SECRET = SECRET;
    const r = await json(await askLLM(req('askLLM', { method: 'POST', body: goodBody })));
    assert.equal(r.status, 400); assert.equal(r.body.code, 'KEY_REQUIRED');
  });
  it('token + disallowed model → 403 MODEL_NOT_ALLOWED', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-server'; process.env.TOKEN_SECRET = SECRET;
    const r = await json(await askLLM(req('askLLM', { method: 'POST', body: { ...goodBody, model: 'claude-opus-5' }, headers: { authorization: `Bearer ${mint()}` } })));
    assert.equal(r.status, 200, JSON.stringify(r.body)); // sanity: allowed by default
    reset(); process.env.ANTHROPIC_API_KEY = 'sk-ant-server'; process.env.TOKEN_SECRET = SECRET; process.env.ALLOWED_MODELS = 'claude-haiku-4-5';
    const r2 = await json(await askLLM(req('askLLM', { method: 'POST', body: { ...goodBody, model: 'claude-opus-5' }, headers: { authorization: `Bearer ${mint()}` } })));
    assert.equal(r2.status, 403); assert.equal(r2.body.code, 'MODEL_NOT_ALLOWED');
  });
  it('token + server key streams through with capped max_tokens and X-Provider', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-server'; process.env.TOKEN_SECRET = SECRET;
    setFetch(async () => new Response('data: {"type":"content_block_delta"}\n', { status: 200 }));
    const res = await askLLM(req('askLLM', { method: 'POST', body: goodBody, headers: { authorization: `Bearer ${mint()}` } }));
    assert.equal(res.status, 200); assert.equal(res.headers.get('x-provider'), 'anthropic'); assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(calls.length, 1); const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.max_tokens, 4096); assert.equal(sent.model, 'claude-opus-5'); assert.equal(calls[0].init.headers['x-api-key'], 'sk-ant-server');
    assert.ok(calls[0].init.signal instanceof AbortSignal, 'timeout signal attached');
    resetFetch();
  });
  it('BYOK openai: no token needed, key goes to OpenAI, no key-source leak', async () => {
    process.env.TOKEN_SECRET = SECRET;
    setFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), { status: 200 }));
    const r = await json(await askLLM(req('askLLM', { method: 'POST', body: { ...goodBody, stream: false, provider: 'openai', userApiKey: 'sk-user-openai', model: 'gpt-4o' } })));
    assert.equal(r.status, 200); assert.equal(r.body.message, 'hello');
    assert.match(calls[0].url, /api\.openai\.com/); assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-user-openai');
    resetFetch();
  });
  it('BYOK gemini: key in header not URL, model encoded', async () => {
    setFetch(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'g' }] } }] }), { status: 200 }));
    const r = await json(await askLLM(req('askLLM', { method: 'POST', body: { ...goodBody, stream: false, provider: 'gemini', userApiKey: 'AIzaXYZ', model: 'gemini-2.0-flash' } })));
    assert.equal(r.status, 200); assert.ok(!calls[0].url.includes('AIzaXYZ'), 'key must not be in URL'); assert.equal(calls[0].init.headers['x-goog-api-key'], 'AIzaXYZ');
    resetFetch();
  });
  it('upstream 401 → sanitized message, no detail leak, requestId present', async () => {
    setFetch(async () => new Response(JSON.stringify({ error: { message: 'SECRET-DETAIL' } }), { status: 401 }));
    const r = await json(await askLLM(req('askLLM', { method: 'POST', body: { ...goodBody, provider: 'openai', userApiKey: 'sk-u', model: 'gpt-4o' } })));
    assert.equal(r.status, 401); assert.ok(!JSON.stringify(r.body).includes('SECRET-DETAIL')); assert.ok(r.body.requestId);
    resetFetch();
  });
  it('upstream timeout → 504', async () => {
    setFetch(async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; });
    const r = await json(await askLLM(req('askLLM', { method: 'POST', body: { ...goodBody, provider: 'openai', userApiKey: 'sk-u', model: 'gpt-4o' } })));
    assert.equal(r.status, 504); assert.equal(r.body.code, 'UPSTREAM_TIMEOUT');
    resetFetch();
  });
  it('rate limit → 429 with Retry-After', async () => {
    for (let i = 0; i < 30; i++) rateLimit('askLLM:unknown', { limit: 30, windowMs: 60000 });
    const r = await json(await askLLM(req('askLLM', { method: 'POST', body: goodBody })));
    assert.equal(r.status, 429); assert.ok(r.headers['retry-after']);
  });
});

describe('CORS', () => {
  it('no ACAO header for unknown origin; echoed for SITE_ORIGIN', async () => {
    const r1 = await askLLM(req('askLLM', { method: 'OPTIONS', headers: { origin: 'https://evil.test' } }));
    assert.equal(r1.status, 204); assert.equal(r1.headers.get('access-control-allow-origin'), null);
    process.env.SITE_ORIGIN = 'https://dash.test, http://localhost:5173';
    const r2 = await askLLM(req('askLLM', { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } }));
    assert.equal(r2.headers.get('access-control-allow-origin'), 'http://localhost:5173'); assert.match(r2.headers.get('vary'), /Origin/);
  });
});

// The server half of the LLM streaming checks; the client half runs src/lib/sse.js and src/lib/api.js.
describe('sse', () => {
  it('output caps: longest-prefix model limits, BYOK ceiling 16384, server cap 4096 / MAX_OUTPUT_TOKENS', async () => {
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

  it('askLLM (openai BYOK): gpt-5.x / o-series send max_completion_tokens + developer role; gpt-4o sends max_tokens + system', async () => {
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

  it('fetchWithTimeout: bodyTimeout false bounds only time-to-headers; the default also bounds the body', async () => {
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
      const src = await readFile(new URL('../askLLM.js', import.meta.url), 'utf8');
      const providerCalls = (src.match(/\bfetchWithTimeout\(/g) || []).length;
      assert.equal(providerCalls, 3, 'one fetchWithTimeout call per provider');
      assert.equal((src.match(/\{ bodyTimeout: false \}\);/g) || []).length, providerCalls, 'each provider call passes { bodyTimeout: false }');
    } finally {
      resetFetch();
    }
  });

  it('askLLM: the system prompt takes its put/call bands from shared/thresholds.js', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-server'; process.env.TOKEN_SECRET = SECRET;
    try {
      setFetch(async () => new Response('data: {"type":"message_stop"}\n\n', { status: 200 }));
      const res = await askLLM(req('askLLM', { method: 'POST', body: {
        provider: 'anthropic', messages: [{ role: 'user', content: 'hi' }], stream: true, ticker: 'AVGO',
      }, headers: { authorization: `Bearer ${mint()}` } }));
      assert.equal(res.status, 200);
      const { system } = JSON.parse(calls[0].init.body);
      assert.ok(system.includes('<0.7') && system.includes('>1'), 'P/C bands in the prompt');
      assert.ok(system.includes(`<${PUT_CALL.bullishBelow} is bullish, ${PUT_CALL.bullishBelow}-${PUT_CALL.bearishAbove} neutral, >${PUT_CALL.bearishAbove} bearish`));
      await res.body?.cancel();
    } finally {
      resetFetch();
    }
  });

  it('askLLM: default models are claude-opus-5 / gpt-5.1 / gemini-3.8-flash', async () => {
    const base = { messages: [{ role: 'user', content: 'hi' }] };
    assert.equal(askLLMModule.validatePayload({ ...base, provider: 'anthropic' }).value.model, 'claude-opus-5');
    assert.equal(askLLMModule.validatePayload({ ...base, provider: 'openai' }).value.model, 'gpt-5.1');
    assert.equal(askLLMModule.validatePayload({ ...base, provider: 'gemini' }).value.model, 'gemini-3.8-flash');
  });
});
