// src/lib/sse.test.js — LLM streaming (F6-F8, M7), the parsing side: SSE framing (drainSSEBuffer) and each
// provider's text, error and stop events (parseSSEEvents). askLLMStream end to end is in api.test.js, the server
// side (output caps, the body timeout) in netlify/functions/__tests__/askLLM.test.js.
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as sse from './sse.js';
import * as api from './api.js';

// Not new URL('./sse.js', import.meta.url): in the dom project Vite rewrites that into the served asset URL
// (http://localhost:3000/src/lib/sse.js), which readFile cannot open.
const SSE_PATH = join(import.meta.dirname, 'sse.js');
const HOST_GLOBALS = /\b(?:console|process|window|document|navigator|globalThis|fetch|require|localStorage|sessionStorage|Buffer)\b/g;

const { STOP_REASON } = sse;

describe('sse', () => {
  it('modules load; src/lib/sse.js is import-free and pure (no host globals)', async () => {
    assert.equal(typeof sse.drainSSEBuffer, 'function');
    assert.equal(typeof sse.parseSSEEvents, 'function');
    assert.equal(typeof api.askLLMStream, 'function');
    assert.deepEqual({ ...sse.STOP_REASON }, {
      END: 'end', MAX_TOKENS: 'max_tokens', REFUSAL: 'refusal', SAFETY: 'safety', PROMPT_BLOCKED: 'prompt_blocked', OTHER: 'other',
    });
    assert.ok(Object.isFrozen(sse.STOP_REASON));
    // Strip comments (keeping string literals, so a '//' inside a string is not taken for one).
    const src = await readFile(SSE_PATH, 'utf8');
    const code = src.replace(/('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_, str) => str ?? '');
    assert.doesNotMatch(code, /^\s*import\b|\bimport\s*\(/m, 'sse.js must stay import-free');
    assert.deepEqual(code.match(HOST_GLOBALS), null, 'sse.js must stay pure');
  });

  it('drainSSEBuffer: data lines only ([DONE], event:, id:, retry:, comments dropped); partial tail kept; CRLF; final flush', async () => {
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

  it('parseSSEEvents (anthropic, the default): text_delta, error, message_delta stop reasons; other events and garbage ignored', async () => {
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

  it('parseSSEEvents (openai): content, finish_reason (text before stop in one chunk), top-level error', async () => {
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

  it('parseSSEEvents (gemini): parts + finishReason together, safety family, promptFeedback block, error body', async () => {
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
});
