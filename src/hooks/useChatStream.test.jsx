// src/hooks/useChatStream.test.jsx — the chat's stream machine through renderHook, with sinks that record every call
// in order. One reply at a time: a second start() is refused before anything is appended or sent, and a detached reply
// holds the guard until its request has ended. The text goes up once per frame, the buffered rest before any settle or
// fail. A reply ends settled with its stop marker, stopped (the signal decides, whatever the request rejects with),
// failed with its request id, or detached, which hands back the buffered text and leaves nothing to follow. live()
// reports the chat's ticker (StartRequest.ticker), never the params'; the five functions keep one identity for the hook's life; and the
// module, read from disk, registers no effect. The fetch recorder (test/helpers/fetch.js) answers askLLM with a body
// the test drives chunk by chunk, and requestAnimationFrame is a queue the test runs, so the text between two frames
// is deterministic. Real timers throughout: the body's reads are microtasks, and one macrotask inside act lets a
// request run as far as it can.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { installFetchRecorder } from '../../test/helpers/fetch.js';
import { useChatStream } from './useChatStream.js';

const encoder = new TextEncoder();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const anthropicText = (text) => `data: ${JSON.stringify({
  type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text },
})}\n\n`;
const HEADERS = { 'Content-Type': 'text/event-stream', 'X-Provider': 'anthropic', 'X-Request-Id': 'q1' };
/** The same response without its X-Request-Id: askLLMStream's stream errors then carry `requestId: null`. */
const NO_REQUEST_ID = { 'Content-Type': 'text/event-stream', 'X-Provider': 'anthropic' };

/**
 * An askLLM body the test drives chunk by chunk, answered under `headers`; close() ends it with no stop reason.
 * `state.cancelled` is set once the reader releases it.
 */
function controlledStream(headers = HEADERS) {
  let ctl;
  const state = { cancelled: null };
  const body = new ReadableStream({
    start(c) { ctl = c; },
    cancel(reason) { state.cancelled = reason ?? 'cancelled'; },
  });
  const push = (frame) => ctl.enqueue(encoder.encode(frame));
  return {
    state,
    response: () => new Response(body, { status: 200, headers }),
    text: (t) => push(anthropicText(t)),
    end: (reason = 'end_turn') => {
      push(`data: {"type":"message_delta","delta":{"stop_reason":"${reason}"}}\n\n`);
      ctl.close();
    },
    close: () => ctl.close(),
    providerError: (msg) => push(`event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"${msg}"}}\n\n`),
  };
}

/** requestAnimationFrame as a queue the test runs; restoreMocks undoes the spies before the next test. */
function manualFrames() {
  const frames = new Map();
  let next = 1;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
    const id = next++;
    frames.set(id, cb);
    return id;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
  return {
    pending: () => frames.size,
    run: () => act(() => {
      const due = [...frames.values()];
      frames.clear();
      for (const cb of due) cb(performance.now());
    }),
  };
}

/** Sinks that record every call in order, as [sink, argument]. */
function recordingSinks() {
  const calls = [];
  return {
    calls,
    sinks: {
      placeholder: (lead) => { calls.push(['placeholder', lead]); },
      append: (text) => { calls.push(['append', text]); },
      settle: (marker) => { calls.push(['settle', marker]); },
      fail: (content) => { calls.push(['fail', content]); },
    },
  };
}

const PARAMS = {
  messages: [{ role: 'user', content: 'q' }],
  financialContext: 'TICKER: AVGO',
  ticker: 'AVGO',
  userApiKey: null,
  model: '',
  provider: 'anthropic',
};
const LEAD = [{ role: 'user', content: 'q' }];

/** A send's start() request: AVGO's chat, PARAMS, the analysis prefix, the question as the lead. */
const request = (sinks, overrides = {}) => ({
  ticker: 'AVGO', buildParams: () => PARAMS, failPrefix: 'Failed to get analysis', lead: LEAD, sinks, ...overrides,
});

/** start() inside act, as a click calls it; returns what start() returned. */
function startIn(result, req) {
  let accepted;
  act(() => { accepted = result.current.start(req); });
  return accepted;
}

/** One macrotask inside act: the request runs as far as it can (the recorder answers at once, reads are microtasks). */
const turn = () => act(async () => { await tick(); });

/** Pushes into the body (chunks, an end, an error) and lets the reader take it, inside act. */
const deliver = (push) => act(async () => { push(); await tick(); });

describe('useChatStream', () => {
  let rec;
  let streams;
  let frames;

  /** Answers each askLLM request with a fresh driven body under `headers`, kept in `streams` in request order. */
  const answerWith = (headers) => rec.setFetch(() => {
    const s = controlledStream(headers);
    streams.push(s);
    return Promise.resolve(s.response());
  });

  beforeEach(() => {
    streams = [];
    rec = installFetchRecorder();
    answerWith(HEADERS);
    frames = manualFrames();
  });

  afterEach(() => rec.uninstall());

  it('start() sends one request; a second start in the same act is refused with nothing appended or sent', async () => {
    const { result } = renderHook(() => useChatStream());
    const first = recordingSinks();
    const second = recordingSinks();
    let accepted;
    act(() => {
      accepted = [
        result.current.start(request(first.sinks)),
        result.current.start(request(second.sinks, { lead: [{ role: 'user', content: 'again' }] })),
      ];
    });
    expect(accepted).toEqual([true, false]);
    expect(first.calls).toEqual([['placeholder', LEAD]]);
    expect(first.calls[0][1]).toBe(LEAD);
    expect(second.calls).toEqual([]);
    expect(result.current.sending).toBe(true);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].url).toMatch(/\/\.netlify\/functions\/askLLM$/);
    expect(JSON.parse(rec.calls[0].init.body)).toEqual({ ...PARAMS, stream: true });
    expect(rec.calls[0].init.signal.aborted).toBe(false);

    // Refused while the reply streams; accepted again once its request has ended.
    await turn();
    expect(startIn(result, request(second.sinks))).toBe(false);
    await deliver(() => { streams[0].text('Hi'); streams[0].end(); });
    expect(first.calls).toEqual([['placeholder', LEAD], ['append', 'Hi'], ['settle', '']]);
    expect(result.current.sending).toBe(false);
    expect(second.calls).toEqual([]);
    expect(startIn(result, request(second.sinks))).toBe(true);
    expect(rec.calls).toHaveLength(2);
    await deliver(() => { streams[1].text('Again'); streams[1].end(); });
    expect(second.calls).toEqual([['placeholder', LEAD], ['append', 'Again'], ['settle', '']]);
  });

  it('hands the text on once per frame; bufferedText() reads what the next frame will take, in place', async () => {
    const { result } = renderHook(() => useChatStream());
    const { calls, sinks } = recordingSinks();
    startIn(result, request(sinks));
    await turn();
    await deliver(() => { streams[0].text('A'); streams[0].text('B'); });
    expect(frames.pending()).toBe(1);
    expect(calls).toEqual([['placeholder', LEAD]]);
    expect(result.current.bufferedText()).toBe('AB');
    expect(result.current.bufferedText()).toBe('AB');

    frames.run();
    expect(calls).toEqual([['placeholder', LEAD], ['append', 'AB']]);
    expect(result.current.bufferedText()).toBe('');
    expect(frames.pending()).toBe(0);

    await deliver(() => streams[0].text('C'));
    expect(frames.pending()).toBe(1);
    frames.run();
    await deliver(() => streams[0].end());
    expect(calls).toEqual([['placeholder', LEAD], ['append', 'AB'], ['append', 'C'], ['settle', '']]);
  });

  it.each([
    ['end_turn', 'end_turn', ''],
    ['max_tokens', 'max_tokens', '*(cut off at the token limit)*'],
    ['no stop reason', null, '*(response ended early)*'],
    ["pause_turn ('other')", 'pause_turn', '*(the model stopped here: other)*'],
  ])('settles a reply that ends with %s: the marker after the buffered text, no frame left', async (_label, reason, marker) => {
    const { result } = renderHook(() => useChatStream());
    const { calls, sinks } = recordingSinks();
    startIn(result, request(sinks));
    await turn();
    // The last text and the end in one tick: the text is still buffered, its frame pending, when the request ends.
    await deliver(() => {
      streams[0].text('Hi');
      if (reason) streams[0].end(reason);
      else streams[0].close();
    });
    expect(calls).toEqual([['placeholder', LEAD], ['append', 'Hi'], ['settle', marker]]);
    expect(frames.pending()).toBe(0);
    expect(result.current.sending).toBe(false);
    expect(result.current.live()).toBeNull();
  });

  it("stop(): the buffered text, then '*(stopped)*', and the body is released", async () => {
    const { result } = renderHook(() => useChatStream());
    const { calls, sinks } = recordingSinks();
    startIn(result, request(sinks));
    await turn();
    await deliver(() => streams[0].text('A'));
    frames.run();
    await deliver(() => streams[0].text('B'));
    expect(frames.pending()).toBe(1);

    await act(async () => { result.current.stop(); await tick(); });
    expect(calls).toEqual([['placeholder', LEAD], ['append', 'A'], ['append', 'B'], ['settle', '*(stopped)*']]);
    expect(frames.pending()).toBe(0);
    expect(rec.calls[0].init.signal.aborted).toBe(true);
    expect(streams[0].state.cancelled).toBeTruthy();
    expect(result.current.sending).toBe(false);
    expect(result.current.live()).toBeNull();
  });

  it('stop() while idle, a second stop() and a stop() after the settle change nothing', async () => {
    const { result } = renderHook(() => useChatStream());
    act(() => { result.current.stop(); });
    expect(result.current.sending).toBe(false);
    expect(rec.calls).toHaveLength(0);

    const { calls, sinks } = recordingSinks();
    startIn(result, request(sinks));
    await turn();
    await deliver(() => streams[0].text('A'));
    await act(async () => {
      result.current.stop();
      result.current.stop();
      await tick();
    });
    act(() => { result.current.stop(); });
    await turn();
    expect(calls).toEqual([['placeholder', LEAD], ['append', 'A'], ['settle', '*(stopped)*']]);
    expect(result.current.sending).toBe(false);
    expect(rec.calls).toHaveLength(1);
  });

  it.each([
    ['the abort reason', (signal) => signal.reason],
    ['an error that is not an abort', () => new TypeError('Failed to fetch')],
  ])('a Stop before the headers settles as stopped whatever the request rejects with: %s', async (_label, rejection) => {
    rec.setFetch((url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(rejection(init.signal)), { once: true });
    }));
    const { result } = renderHook(() => useChatStream());
    const { calls, sinks } = recordingSinks();
    startIn(result, request(sinks));
    await turn();
    expect(result.current.sending).toBe(true);

    await act(async () => { result.current.stop(); await tick(); });
    expect(calls).toEqual([['placeholder', LEAD], ['settle', '*(stopped)*']]);
    expect(result.current.sending).toBe(false);
  });

  it.each([
    ["the stream's ref", HEADERS, 'Failed to get analysis: Overloaded (ref q1)'],
    ['no ref (a response without X-Request-Id: requestId null)', NO_REQUEST_ID, 'Failed to get analysis: Overloaded'],
  ])('a provider error mid-stream: the text so far, then the error line with %s', async (_label, headers, line) => {
    answerWith(headers);
    const { result } = renderHook(() => useChatStream());
    const { calls, sinks } = recordingSinks();
    startIn(result, request(sinks));
    await turn();
    await deliver(() => { streams[0].text('Part'); streams[0].providerError('Overloaded'); });
    expect(calls).toEqual([['placeholder', LEAD], ['append', 'Part'], ['fail', line]]);
    expect(frames.pending()).toBe(0);
    expect(result.current.sending).toBe(false);
  });

  it('a reply with no text fails as empty, with nothing appended and no ref (a response without X-Request-Id)', async () => {
    answerWith(NO_REQUEST_ID);
    const { result } = renderHook(() => useChatStream());
    const { calls, sinks } = recordingSinks();
    startIn(result, request(sinks));
    await turn();
    await deliver(() => streams[0].end());
    expect(calls).toEqual([
      ['placeholder', LEAD],
      ['fail', 'Failed to get analysis: The model returned an empty response'],
    ]);
    expect(frames.pending()).toBe(0);
    expect(result.current.sending).toBe(false);
  });

  it("a function error carries its body's request id under the request's prefix; no id, no ref", async () => {
    rec.setFetch(async () => new Response(
      JSON.stringify({ error: 'Too many requests', code: 'RATE_LIMITED', requestId: 'r4' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    ));
    const { result } = renderHook(() => useChatStream());
    const { calls, sinks } = recordingSinks();
    startIn(result, request(sinks, { failPrefix: 'Failed to get suggestions', lead: [] }));
    await turn();
    expect(calls).toEqual([['placeholder', []], ['fail', 'Failed to get suggestions: Too many requests (ref r4)']]);
    expect(result.current.sending).toBe(false);

    rec.setFetch(async () => { throw new TypeError('Failed to fetch'); });
    startIn(result, request(sinks));
    await turn();
    expect(calls.slice(2)).toEqual([['placeholder', LEAD], ['fail', 'Failed to get analysis: Failed to fetch']]);
    expect(result.current.sending).toBe(false);
  });

  it('buildParams() runs inside the run: a throw fails the reply, sends nothing and releases the guard', async () => {
    const { result } = renderHook(() => useChatStream());
    const { calls, sinks } = recordingSinks();
    const message = "Cannot read properties of undefined (reading 'toLocaleString')";
    const buildParams = () => { throw new TypeError(message); };
    expect(startIn(result, request(sinks, { buildParams }))).toBe(true);
    expect(calls).toEqual([['placeholder', LEAD], ['fail', `Failed to get analysis: ${message}`]]);
    expect(rec.calls).toHaveLength(0);
    expect(result.current.sending).toBe(false);
    expect(result.current.live()).toBeNull();

    const next = recordingSinks();
    expect(startIn(result, request(next.sinks))).toBe(true);
    expect(rec.calls).toHaveLength(1);
    await turn();
    await deliver(() => { streams[0].text('ok'); streams[0].end(); });
    expect(next.calls).toEqual([['placeholder', LEAD], ['append', 'ok'], ['settle', '']]);
  });

  it('detach() returns the buffered text and ends the reply there; the guard holds until the request has ended', async () => {
    const { result } = renderHook(() => useChatStream());
    const { calls, sinks } = recordingSinks();
    const late = recordingSinks();
    startIn(result, request(sinks));
    await turn();
    await deliver(() => streams[0].text('A'));
    frames.run();
    await deliver(() => streams[0].text('B'));
    expect(frames.pending()).toBe(1);

    let buffered;
    let refused;
    act(() => {
      buffered = result.current.detach('ticker');
      refused = result.current.start(request(late.sinks));
    });
    expect(buffered).toBe('B');
    expect(frames.pending()).toBe(0);
    expect(result.current.bufferedText()).toBe('');
    expect(result.current.live()).toBeNull();
    expect(result.current.detach('reset')).toBe('');
    expect(refused).toBe(false);
    expect(late.calls).toEqual([]);
    expect(result.current.sending).toBe(true);
    expect(rec.calls[0].init.signal.aborted).toBe(true);

    // The request ends: no settle and no fail for a detached reply, and the guard drops.
    await turn();
    expect(result.current.sending).toBe(false);
    expect(calls).toEqual([['placeholder', LEAD], ['append', 'A']]);
    expect(streams[0].state.cancelled).toBeTruthy();
    expect(rec.calls).toHaveLength(1);
  });

  it("detach() while idle, as the history's StrictMode mount cleanup calls it, returns '' and leaves no trace", async () => {
    const { result } = renderHook(() => useChatStream());
    let buffered;
    act(() => { buffered = result.current.detach('unmount'); });
    expect(buffered).toBe('');
    expect(globalThis.cancelAnimationFrame).not.toHaveBeenCalled();
    expect(result.current.sending).toBe(false);
    expect(result.current.live()).toBeNull();
    expect(rec.calls).toHaveLength(0);

    const { calls, sinks } = recordingSinks();
    expect(startIn(result, request(sinks))).toBe(true);
    expect(result.current.live()).toEqual({ ticker: 'AVGO' });
    await turn();
    await deliver(() => { streams[0].text('Hello'); streams[0].end(); });
    expect(calls).toEqual([['placeholder', LEAD], ['append', 'Hello'], ['settle', '']]);
  });

  it('keeps one identity for each function across renders and across a sending flip', async () => {
    const { result, rerender } = renderHook(() => useChatStream());
    expect(Object.keys(result.current).sort()).toEqual(['bufferedText', 'detach', 'live', 'sending', 'start', 'stop']);
    const first = result.current;
    const expectSameFunctions = () => {
      for (const name of ['start', 'stop', 'detach', 'live', 'bufferedText']) {
        expect(result.current[name], name).toBe(first[name]);
      }
    };

    rerender();
    expect(result.current.sending).toBe(false);
    expectSameFunctions();
    startIn(result, request(recordingSinks().sinks));
    expect(result.current.sending).toBe(true);
    expectSameFunctions();
    await turn();
    await deliver(() => { streams[0].text('Hi'); streams[0].end(); });
    expect(result.current.sending).toBe(false);
    expectSameFunctions();
  });

  it("live() reports the request's ticker, not the params': undefined before market data, the request's UNKNOWN", async () => {
    const { result } = renderHook(() => useChatStream());
    expect(result.current.live()).toBeNull();
    const early = { ticker: undefined, buildParams: () => ({ ...PARAMS, ticker: 'UNKNOWN' }) };
    startIn(result, request(recordingSinks().sinks, early));
    expect(JSON.parse(rec.calls[0].init.body).ticker).toBe('UNKNOWN');
    expect(result.current.live()).toStrictEqual({ ticker: undefined });
    await turn();
    await deliver(() => { streams[0].text('Hi'); streams[0].end(); });
    expect(result.current.live()).toBeNull();

    startIn(result, request(recordingSinks().sinks));
    expect(result.current.live()).toStrictEqual({ ticker: 'AVGO' });
    await turn();
    await deliver(() => { streams[1].text('Hi'); streams[1].end(); });
    expect(result.current.live()).toBeNull();
  });

  it("registers no effect: its cleanup would run before the history's, which saves the reply before detaching it", async () => {
    const source = await readFile(path.join(import.meta.dirname, 'useChatStream.ts'), 'utf8');
    expect(source).toMatch(/export function useChatStream\(\)/);
    expect(source).not.toMatch(/\buse(?:Layout|Insertion)?Effect\b/);
  });
});
